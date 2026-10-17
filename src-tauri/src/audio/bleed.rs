//! Speaker bleed: the microphone picking up what the system audio is playing
//! (a call on laptop speakers). Bleed is a delayed, quieter copy of the system
//! signal, so its loudness envelope tracks the system envelope closely at some
//! small lag, while the user's own voice is unrelated to it. We compare the
//! two envelopes in 30 ms frames and silence the mic frames that follow the
//! system audio, before they reach transcription.

use std::collections::VecDeque;

use crate::stt::SAMPLE_RATE;

pub const FRAME: usize = (SAMPLE_RATE as usize) * 30 / 1000; // 30 ms
pub const FRAME_MS: i64 = 30;
/// How far the mic may trail the system audio (output + acoustic + input
/// latency, plus alignment error between the two capture clocks).
pub const MAX_LAG: usize = 20; // 600 ms
/// How far the mic may appear to lead it (alignment error the other way).
pub const MAX_LEAD: usize = 10; // 300 ms
/// Correlation window around each frame.
const HALF_WINDOW: usize = 16; // ~1 s total
/// Envelope correlation above which a mic frame counts as bleed.
const THRESHOLD: f32 = 0.6;
/// System frames quieter than this are treated as silence (nothing to bleed).
const SYS_ACTIVE: f32 = 0.002;
/// System history kept for live meetings, comfortably above the longest
/// utterance plus transcription queueing.
const HISTORY_FRAMES: usize = 3 * 60 * 1000 / FRAME_MS as usize;

/// RMS of each 30 ms frame (a trailing partial frame counts as a frame).
pub fn frame_rms(pcm: &[f32]) -> Vec<f32> {
    pcm.chunks(FRAME).map(|f| (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt()).collect()
}

/// System-audio frame levels indexed by frame on the meeting timeline.
#[derive(Default)]
pub struct SysEnvelope {
    start: i64,
    rms: VecDeque<f32>,
    bounded: bool,
}

impl SysEnvelope {
    /// Rolling history for a live meeting.
    pub fn live() -> Self {
        Self { bounded: true, ..Default::default() }
    }

    /// The whole system track of a recorded meeting.
    pub fn from_pcm(pcm: &[f32]) -> Self {
        Self { start: 0, rms: frame_rms(pcm).into(), bounded: false }
    }

    pub fn push(&mut self, frame: i64, rms: f32) {
        if self.rms.is_empty() {
            self.start = frame;
        }
        let end = self.start + self.rms.len() as i64;
        if frame < self.start {
            return;
        }
        if frame < end {
            self.rms[(frame - self.start) as usize] = rms;
        } else {
            // Gaps (dropped callbacks) read as silence.
            for _ in end..frame {
                self.rms.push_back(0.0);
            }
            self.rms.push_back(rms);
        }
        if self.bounded {
            while self.rms.len() > HISTORY_FRAMES {
                self.rms.pop_front();
                self.start += 1;
            }
        }
    }

    /// Levels for frames `from..to`, zero where unknown.
    fn range(&self, from: i64, to: i64) -> Vec<f32> {
        (from..to)
            .map(|f| f - self.start)
            .map(|i| if i >= 0 { self.rms.get(i as usize).copied().unwrap_or(0.0) } else { 0.0 })
            .collect()
    }

    /// Silence the frames of `mic` (starting at timeline frame `start`) that
    /// are bleed. Returns the per-frame bleed mask.
    pub fn suppress(&self, mic: &mut [f32], start: i64) -> Vec<bool> {
        let mic_rms = frame_rms(mic);
        let sys = self.range(start - MAX_LAG as i64, start + mic_rms.len() as i64 + MAX_LEAD as i64);
        let m = mask(&mic_rms, &sys);
        for (frame, bleed) in mic.chunks_mut(FRAME).zip(&m) {
            if *bleed {
                frame.fill(0.0);
            }
        }
        m
    }

    /// Offline version of [`suppress`](Self::suppress) for a whole recorded
    /// mic track, in blocks so the best lag can follow clock drift.
    pub fn suppress_all(&self, mic: &mut [f32]) -> usize {
        // A whole number of frames, so every block stays on the system track's frame grid.
        const BLOCK: usize = FRAME * (20_000 / FRAME_MS as usize); // ~20 s
        let mut silenced = 0;
        for (i, block) in mic.chunks_mut(BLOCK).enumerate() {
            let start = (i * BLOCK / FRAME) as i64;
            silenced += self.suppress(block, start).iter().filter(|b| **b).count();
        }
        silenced
    }
}

fn db(rms: f32) -> f32 {
    20.0 * rms.max(1e-4).log10()
}

fn pearson(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    if a.len() < 4 {
        return 0.0;
    }
    let (ma, mb) = (a.iter().sum::<f32>() / n, b.iter().sum::<f32>() / n);
    let (mut cov, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        let (dx, dy) = (x - ma, y - mb);
        cov += dx * dy;
        va += dx * dx;
        vb += dy * dy;
    }
    // A flat envelope (silence, steady noise) correlates with nothing.
    if va < 1.0 || vb < 1.0 { 0.0 } else { cov / (va * vb).sqrt() }
}

/// Per-frame bleed mask. `sys` covers the mic frames padded by `MAX_LAG`
/// frames before and `MAX_LEAD` after, so `sys[i + MAX_LAG]` is simultaneous
/// with `mic[i]`.
pub fn mask(mic: &[f32], sys: &[f32]) -> Vec<bool> {
    let n = mic.len();
    let mut out = vec![false; n];
    if n == 0 || sys.len() != n + MAX_LAG + MAX_LEAD || !sys.iter().any(|&s| s > SYS_ACTIVE) {
        return out;
    }
    let m: Vec<f32> = mic.iter().copied().map(db).collect();
    let s: Vec<f32> = sys.iter().copied().map(db).collect();
    // `lag` = how many frames the mic trails the system audio, offset by MAX_LEAD.
    let at = |lag: usize, i: usize| i + MAX_LAG + MAX_LEAD - lag;
    let shifted = |lag: usize, a: usize, b: usize| (a..b).map(|i| s[at(lag, i)]).collect::<Vec<_>>();

    let (lag, best) = (0..=MAX_LAG + MAX_LEAD)
        .map(|lag| (lag, pearson(&m, &shifted(lag, 0, n))))
        .fold((0, f32::MIN), |acc, x| if x.1 > acc.1 { x } else { acc });
    // Whole-chunk correlation is a cheap early out for chunks with no bleed
    // at all; a chunk that is partly bleed still correlates noticeably.
    if best < THRESHOLD / 3.0 {
        return out;
    }
    for (i, o) in out.iter_mut().enumerate() {
        let (a, b) = (i.saturating_sub(HALF_WINDOW), (i + HALF_WINDOW + 1).min(n));
        let sw = shifted(lag, a, b);
        *o = sw.iter().any(|&x| x > db(SYS_ACTIVE)) && pearson(&m[a..b], &sw) > THRESHOLD;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic noise with a syllable-like loudness envelope.
    fn speechy(seed: u64, secs: f32) -> Vec<f32> {
        let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let mut env_phase = (seed % 97) as f32;
        let n = (SAMPLE_RATE as f32 * secs) as usize;
        (0..n)
            .map(|i| {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let noise = ((x >> 33) as f32 / (1u64 << 31) as f32) - 0.5;
                if i % FRAME == 0 {
                    env_phase += 0.37 + ((x >> 40) % 7) as f32 * 0.11;
                }
                let env = (env_phase.sin() * 0.5 + 0.5).powi(3);
                noise * 0.4 * env
            })
            .collect()
    }

    fn delayed(src: &[f32], frames: usize, gain: f32) -> Vec<f32> {
        let d = frames * FRAME;
        (0..src.len()).map(|i| if i >= d { src[i - d] * gain } else { 0.0 }).collect()
    }

    #[test]
    fn detects_delayed_copy_of_system_audio() {
        let sys = speechy(1, 8.0);
        let mut mic = delayed(&sys, 4, 0.15);
        let room = speechy(9, 8.0);
        for (m, r) in mic.iter_mut().zip(&room) {
            *m += r * 0.01;
        }
        let env = SysEnvelope::from_pcm(&sys);
        let m = env.suppress(&mut mic, 0);
        let frac = m.iter().filter(|b| **b).count() as f32 / m.len() as f32;
        assert!(frac > 0.9, "bleed fraction {frac}");
    }

    #[test]
    fn keeps_own_voice() {
        let sys = speechy(1, 8.0);
        let mut mic = speechy(42, 8.0);
        let env = SysEnvelope::from_pcm(&sys);
        let m = env.suppress(&mut mic, 0);
        let frac = m.iter().filter(|b| **b).count() as f32 / m.len() as f32;
        assert!(frac < 0.05, "bleed fraction {frac}");
    }

    #[test]
    fn keeps_voice_when_system_is_silent() {
        let mut mic = speechy(42, 4.0);
        let env = SysEnvelope::from_pcm(&vec![0.0; mic.len()]);
        assert!(!env.suppress(&mut mic, 0).iter().any(|b| *b));
    }

    #[test]
    fn keeps_own_voice_after_bleed() {
        // 6 s of bleed, then 6 s of the user talking while the call is quiet.
        let sys: Vec<f32> = speechy(1, 6.0).into_iter().chain(std::iter::repeat_n(0.0, FRAME * 200)).collect();
        let mut mic = delayed(&sys, 3, 0.2);
        let own = speechy(7, 6.0);
        let off = FRAME * 200;
        for (i, s) in own.iter().enumerate() {
            mic[off + i] += s;
        }
        let env = SysEnvelope::from_pcm(&sys);
        let m = env.suppress_all(&mut mic);
        let first = frame_rms(&mic[..off]);
        let second = frame_rms(&mic[off + FRAME * 20..]);
        assert!(m > 150, "silenced {m}");
        assert!(first.iter().filter(|r| **r > 0.0).count() < first.len() / 5);
        assert!(second.iter().filter(|r| **r > 0.0).count() > second.len() * 9 / 10);
    }

    #[test]
    fn suppresses_bleed_across_blocks() {
        // Longer than two offline blocks, so later blocks must stay frame-aligned.
        let sys = speechy(3, 50.0);
        let mut mic = delayed(&sys, 2, 0.15);
        let silenced = SysEnvelope::from_pcm(&sys).suppress_all(&mut mic);
        let frames = mic.len().div_ceil(FRAME);
        assert!(silenced * 10 > frames * 9, "silenced {silenced} of {frames}");
        let tail = frame_rms(&mic[mic.len() - FRAME * 600..]);
        assert!(tail.iter().filter(|r| **r > 0.0).count() < tail.len() / 10);
    }

    #[test]
    fn live_history_is_bounded_and_aligned() {
        let mut env = SysEnvelope::live();
        for f in 100..100 + HISTORY_FRAMES as i64 + 50 {
            env.push(f, f as f32);
        }
        assert_eq!(env.rms.len(), HISTORY_FRAMES);
        let r = env.range(150 + HISTORY_FRAMES as i64 - 2, 152 + HISTORY_FRAMES as i64);
        assert_eq!(r, vec![(148 + HISTORY_FRAMES) as f32, (149 + HISTORY_FRAMES) as f32, 0.0, 0.0]);
        assert_eq!(env.range(10, 12), vec![0.0, 0.0]);
    }
}
