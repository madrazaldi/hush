//! Audio utilities shared across capture, decoding and transcription.

pub mod decode;
pub mod mic;
#[cfg(target_os = "macos")]
pub mod system_macos;

use std::io::Cursor;
use std::path::Path;

use anyhow::Result;

use crate::stt::SAMPLE_RATE;

/// Downmix interleaved frames to mono.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Streaming mono resampler to 16 kHz. Feed arbitrary-sized blocks.
pub struct Resampler {
    inner: Option<rubato::FftFixedIn<f32>>,
    pending: Vec<f32>,
    chunk: usize,
}

impl Resampler {
    pub fn new(from_rate: u32) -> Self {
        if from_rate == SAMPLE_RATE {
            return Self { inner: None, pending: Vec::new(), chunk: 0 };
        }
        let chunk = 1024;
        let inner = rubato::FftFixedIn::<f32>::new(from_rate as usize, SAMPLE_RATE as usize, chunk, 2, 1)
            .expect("resampler");
        Self { inner: Some(inner), pending: Vec::new(), chunk }
    }

    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        use rubato::Resampler as _;
        let Some(r) = self.inner.as_mut() else { return input.to_vec() };
        self.pending.extend_from_slice(input);
        let mut out = Vec::new();
        while self.pending.len() >= self.chunk {
            let block: Vec<f32> = self.pending.drain(..self.chunk).collect();
            if let Ok(res) = r.process(&[block], None) {
                out.extend_from_slice(&res[0]);
            }
        }
        out
    }

    /// Flush the remaining partial block (zero-padded).
    pub fn finish(&mut self) -> Vec<f32> {
        use rubato::Resampler as _;
        let Some(r) = self.inner.as_mut() else { return Vec::new() };
        if self.pending.is_empty() {
            return Vec::new();
        }
        let n = self.pending.len();
        let mut block = std::mem::take(&mut self.pending);
        block.resize(self.chunk, 0.0);
        match r.process(&[block], None) {
            Ok(res) => {
                let keep = ((n as f64 / self.chunk as f64) * res[0].len() as f64).round() as usize;
                res[0][..keep.min(res[0].len())].to_vec()
            }
            Err(_) => Vec::new(),
        }
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

/// Encode 16 kHz mono f32 PCM as 16-bit PCM WAV bytes.
pub fn wav_bytes(pcm: &[f32], rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut cur = Cursor::new(Vec::with_capacity(pcm.len() * 2 + 44));
    {
        let mut w = hound::WavWriter::new(&mut cur, spec).expect("wav writer");
        for s in pcm {
            let _ = w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
        }
        let _ = w.finalize();
    }
    cur.into_inner()
}

pub fn write_wav(path: &Path, pcm: &[f32], rate: u32) -> Result<()> {
    std::fs::write(path, wav_bytes(pcm, rate))?;
    Ok(())
}

/// Incremental WAV writer for long recordings.
pub struct WavSink {
    writer: hound::WavWriter<std::io::BufWriter<std::fs::File>>,
}

impl WavSink {
    pub fn create(path: &Path, rate: u32, channels: u16) -> Result<Self> {
        let spec = hound::WavSpec { channels, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        Ok(Self { writer: hound::WavWriter::create(path, spec)? })
    }
    pub fn write(&mut self, pcm: &[f32]) {
        for s in pcm {
            let _ = self.writer.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
        }
    }
    pub fn finish(self) -> Result<()> {
        self.writer.finalize()?;
        Ok(())
    }
}

/// Split audio into chunks no longer than `max_samples`, preferring to cut in
/// the quietest 20 ms window within the last 25% of each chunk. Returns
/// `(start_sample, slice)` pairs covering the whole input.
pub fn split_at_silences(pcm: &[f32], max_samples: usize) -> Vec<(usize, &[f32])> {
    if pcm.len() <= max_samples || max_samples == 0 {
        return vec![(0, pcm)];
    }
    const WIN: usize = (SAMPLE_RATE as usize) / 50; // 20 ms
    let mut out = Vec::new();
    let mut start = 0;
    while start < pcm.len() {
        let remaining = pcm.len() - start;
        if remaining <= max_samples {
            out.push((start, &pcm[start..]));
            break;
        }
        let search_from = start + max_samples * 3 / 4;
        let search_to = start + max_samples;
        let mut best = search_to;
        let mut best_energy = f32::MAX;
        let mut i = search_from;
        while i + WIN <= search_to {
            let e: f32 = pcm[i..i + WIN].iter().map(|s| s * s).sum();
            if e < best_energy {
                best_energy = e;
                best = i + WIN / 2;
            }
            i += WIN / 2;
        }
        out.push((start, &pcm[start..best]));
        start = best;
    }
    out
}

/// Trim leading/trailing near-silence (keeps a small margin). Used for dictation.
pub fn trim_silence(pcm: &[f32]) -> &[f32] {
    const WIN: usize = (SAMPLE_RATE as usize) / 50;
    const MARGIN: usize = (SAMPLE_RATE as usize) / 5; // 200 ms
    let thresh = 0.004f32; // ~ -48 dBFS RMS
    let rms = |w: &[f32]| (w.iter().map(|s| s * s).sum::<f32>() / w.len().max(1) as f32).sqrt();
    let n = pcm.len();
    let mut first = None;
    let mut last = 0;
    let mut i = 0;
    while i + WIN <= n {
        if rms(&pcm[i..i + WIN]) > thresh {
            first.get_or_insert(i);
            last = i + WIN;
        }
        i += WIN;
    }
    match first {
        Some(f) => &pcm[f.saturating_sub(MARGIN)..(last + MARGIN).min(n)],
        None => &pcm[0..0],
    }
}

/// True if the buffer contains any meaningful speech-level energy.
pub fn has_voice(pcm: &[f32]) -> bool {
    !trim_silence(pcm).is_empty() && pcm.len() > SAMPLE_RATE as usize / 4
}
