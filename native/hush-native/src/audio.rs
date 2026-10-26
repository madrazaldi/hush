//! Sample-rate conversion and level metering shared by the capture backends.

/// Every capture stream is delivered at this rate, mono.
pub const SAMPLE_RATE: u32 = 16_000;

/// Downmix interleaved frames to mono.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved.chunks_exact(channels).map(|f| f.iter().sum::<f32>() / channels as f32).collect()
}

/// Receives captured 16 kHz mono audio on a capture worker thread.
pub type AudioCallback = Box<dyn FnMut(&[f32]) + Send + 'static>;

/// Streaming mono resampler to 16 kHz. Feed arbitrary-sized blocks.
///
/// Output is aligned with the input: the filter delay is trimmed from the
/// start, and `finish` flushes the tail so the total length matches the
/// input duration exactly.
pub struct Resampler {
    inner: Option<rubato::Fft<f32>>,
    /// Input carried over until a full block is available (always < `chunk`).
    pending: Vec<f32>,
    chunk: usize,
    from_rate: u32,
    in_total: u64,
    out_total: u64,
    /// Leading output samples still to drop (filter delay).
    skip: usize,
}

impl Resampler {
    pub fn new(from_rate: u32) -> Self {
        if from_rate == SAMPLE_RATE {
            return Self { inner: None, pending: Vec::new(), chunk: 0, from_rate, in_total: 0, out_total: 0, skip: 0 };
        }
        use rubato::Resampler as _;
        let chunk = 1024;
        let inner =
            rubato::Fft::<f32>::new(from_rate as usize, SAMPLE_RATE as usize, chunk, 1, rubato::FixedSync::Input)
                .expect("resampler");
        let skip = inner.output_delay();
        Self {
            inner: Some(inner),
            pending: Vec::with_capacity(chunk),
            chunk,
            from_rate,
            in_total: 0,
            out_total: 0,
            skip,
        }
    }

    fn push_out(&mut self, mut res: Vec<f32>, out: &mut Vec<f32>) {
        let drop = self.skip.min(res.len());
        self.skip -= drop;
        res.drain(..drop);
        self.out_total += res.len() as u64;
        out.extend_from_slice(&res);
    }

    /// Resample one block. `partial` marks a final block shorter than `chunk`
    /// (zero-padded by rubato); an empty partial block flushes the filter tail.
    fn run(&mut self, block: &[f32], partial: bool, out: &mut Vec<f32>) -> rubato::ResampleResult<()> {
        use rubato::Resampler as _;
        use rubato::audioadapter_buffers::direct::InterleavedSlice;
        let Some(r) = self.inner.as_mut() else { return Ok(()) };
        let mut res = vec![0.0; r.output_frames_next()];
        let n = res.len();
        let input = InterleavedSlice::new(block, 1, block.len()).expect("mono input");
        let mut output = InterleavedSlice::new_mut(&mut res, 1, n).expect("mono output");
        let indexing = partial.then(|| rubato::Indexing::new().partial_len(block.len()));
        let (_, written) = r.process_into_buffer(&input, &mut output, indexing.as_ref())?;
        res.truncate(written);
        self.push_out(res, out);
        Ok(())
    }

    pub fn process(&mut self, mut input: &[f32]) -> Vec<f32> {
        if self.inner.is_none() {
            return input.to_vec();
        }
        self.in_total += input.len() as u64;
        let mut out = Vec::with_capacity(input.len() * SAMPLE_RATE as usize / self.from_rate as usize + 16);
        if !self.pending.is_empty() {
            let take = (self.chunk - self.pending.len()).min(input.len());
            self.pending.extend_from_slice(&input[..take]);
            input = &input[take..];
            if self.pending.len() < self.chunk {
                return out;
            }
            let block = std::mem::take(&mut self.pending);
            let _ = self.run(&block, false, &mut out);
            self.pending = block;
            self.pending.clear();
        }
        let full = input.len() - input.len() % self.chunk;
        for block in input[..full].chunks(self.chunk) {
            let _ = self.run(block, false, &mut out);
        }
        self.pending.extend_from_slice(&input[full..]);
        out
    }

    /// Flush buffered input and the filter tail.
    pub fn finish(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        if self.inner.is_none() {
            return out;
        }
        let target = (self.in_total as f64 * SAMPLE_RATE as f64 / self.from_rate as f64).round() as u64;
        let pending = std::mem::take(&mut self.pending);
        if !pending.is_empty() {
            let _ = self.run(&pending, true, &mut out);
        }
        // Feed silence until the delayed tail has come out.
        for _ in 0..8 {
            if self.out_total >= target || self.run(&[], true, &mut out).is_err() {
                break;
            }
        }
        let extra = self.out_total.saturating_sub(target) as usize;
        out.truncate(out.len().saturating_sub(extra));
        self.out_total -= extra as u64;
        out
    }
}

/// One-shot resample of a full mono buffer.
pub fn resample(pcm: &[f32], from_rate: u32) -> Vec<f32> {
    let mut r = Resampler::new(from_rate);
    let mut out = r.process(pcm);
    out.extend(r.finish());
    out
}

/// RMS level in 0..1 (roughly perceptual, for meters).
pub fn level(pcm: &[f32]) -> f32 {
    if pcm.is_empty() {
        return 0.0;
    }
    let rms = (pcm.iter().map(|s| s * s).sum::<f32>() / pcm.len() as f32).sqrt();
    // Map roughly -60 dB..0 dB to 0..1.
    let db = 20.0 * rms.max(1e-6).log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, secs: f64, hz: f64) -> Vec<f32> {
        (0..(rate as f64 * secs) as usize)
            .map(|i| (i as f64 * hz * std::f64::consts::TAU / rate as f64).sin() as f32 * 0.5)
            .collect()
    }

    #[test]
    fn resample_preserves_length_in_odd_blocks() {
        for rate in [44_100, 48_000, 22_050] {
            let input = tone(rate, 3.7, 440.0);
            let mut r = Resampler::new(rate);
            let mut out = Vec::new();
            for block in input.chunks(777) {
                out.extend(r.process(block));
            }
            out.extend(r.finish());
            let expected = (input.len() as f64 * SAMPLE_RATE as f64 / rate as f64).round() as usize;
            assert_eq!(out.len(), expected, "rate {rate}");
        }
    }

    #[test]
    fn resample_is_time_aligned() {
        // A click at 1.0 s must land at 1.0 s after resampling (delay trimmed).
        let rate = 48_000;
        let mut input = vec![0.0f32; rate as usize * 2];
        input[rate as usize] = 1.0;
        let out = resample(&input, rate);
        let peak = out.iter().enumerate().max_by(|a, b| a.1.abs().total_cmp(&b.1.abs())).unwrap().0;
        assert!((peak as i64 - SAMPLE_RATE as i64).abs() <= 2, "peak at {peak}");
    }

    #[test]
    fn resample_handles_short_input() {
        let out = resample(&tone(44_100, 0.01, 440.0), 44_100);
        assert_eq!(out.len(), 160);
    }
}
