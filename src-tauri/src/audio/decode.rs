//! Decode media files to 16 kHz mono f32. Uses Symphonia in-process for common
//! audio formats and falls back to `ffmpeg` (if installed) for video and
//! anything Symphonia can't handle. `yt-dlp` handles URL imports.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Context, Result, anyhow, bail};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

use crate::shell_env;
use crate::stt::SAMPLE_RATE;

const SYMPHONIA_EXTS: &[&str] = &["wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "aiff", "aif", "caf"];

pub const MEDIA_EXTS: &[&str] = &[
    "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "caf", "wma", "amr", "webm", "mp4", "m4v",
    "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp",
];

pub const VIDEO_EXTS: &[&str] = &["mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "webm"];

pub fn is_video(path: &Path) -> bool {
    ext(path).map(|e| VIDEO_EXTS.contains(&e.as_str())).unwrap_or(false)
}

fn ext(path: &Path) -> Option<String> {
    path.extension().map(|e| e.to_string_lossy().to_lowercase())
}

pub fn ffmpeg_available() -> bool {
    shell_env::which("ffmpeg").is_some()
}

/// Longest media we decode. The whole file is held as 16 kHz f32 mono
/// (~230 MB per hour), so anything longer is refused rather than risking memory.
pub const MAX_DURATION_SECS: usize = 4 * 3600;
const MAX_SAMPLES: usize = MAX_DURATION_SECS * SAMPLE_RATE as usize;
/// Largest file a direct link may download.
const MAX_DOWNLOAD_BYTES: u64 = 4 << 30;

#[derive(Debug)]
struct TooLong;

impl std::fmt::Display for TooLong {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "This file is longer than {} hours, which Hush can't transcribe yet", MAX_DURATION_SECS / 3600)
    }
}

impl std::error::Error for TooLong {}

fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) { Err(anyhow!("Cancelled")) } else { Ok(()) }
}

/// Decode any supported media file to 16 kHz mono samples. `cancel` is polled
/// while decoding so a cancelled job stops promptly (and stops ffmpeg).
pub fn decode_file(path: &Path, cancel: &AtomicBool) -> Result<Vec<f32>> {
    let e = ext(path).unwrap_or_default();
    if SYMPHONIA_EXTS.contains(&e.as_str()) {
        match decode_symphonia(path, cancel) {
            Ok(pcm) if !pcm.is_empty() => return Ok(pcm),
            Ok(_) => log::warn!("symphonia produced no audio for {}", path.display()),
            Err(err) => {
                check_cancel(cancel)?;
                if err.is::<TooLong>() {
                    return Err(err);
                }
                log::warn!("symphonia failed for {}: {err:#}", path.display())
            }
        }
    }
    decode_ffmpeg(path, cancel)
}

fn decode_symphonia(path: &Path, cancel: &AtomicBool) -> Result<Vec<f32>> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(e) = ext(path) {
        hint.with_extension(&e);
    }
    let mut format =
        symphonia::default::get_probe().probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())?;
    let track = format.default_track(TrackType::Audio).ok_or_else(|| anyhow!("no audio track"))?;
    let track_id = track.id;
    let params = track.codec_params.as_ref().and_then(|p| p.audio()).ok_or_else(|| anyhow!("no audio track"))?;
    let rate = params.sample_rate.ok_or_else(|| anyhow!("unknown sample rate"))?;
    let mut decoder = symphonia::default::get_codecs().make_audio_decoder(params, &AudioDecoderOptions::default())?;

    // Resample as we go so the native-rate audio is never held in full.
    let mut resampler = super::Resampler::new(rate);
    let mut out: Vec<f32> = Vec::new();
    let mut buf: Vec<f32> = Vec::new();
    loop {
        check_cancel(cancel)?;
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let channels = decoded.spec().channels().count().max(1);
        decoded.copy_to_vec_interleaved(&mut buf);
        out.extend(resampler.process(&super::to_mono(&buf, channels)));
        if out.len() > MAX_SAMPLES {
            bail!(TooLong);
        }
    }
    out.extend(resampler.finish());
    Ok(out)
}

/// Kills the child process on drop unless it already exited.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn decode_ffmpeg(path: &Path, cancel: &AtomicBool) -> Result<Vec<f32>> {
    use std::io::Read;
    let ffmpeg = shell_env::which("ffmpeg")
        .ok_or_else(|| anyhow!("This format needs ffmpeg. Install it with `brew install ffmpeg`."))?;
    let child = std::process::Command::new(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .arg("-")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("running ffmpeg")?;
    let mut child = KillOnDrop(child);
    // Drain stderr on its own thread so a chatty ffmpeg can't block on a full pipe.
    let mut stderr = child.0.stderr.take().expect("piped stderr");
    let stderr = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    // Read on another thread so this loop can notice a cancel even while
    // ffmpeg is stalled (say, on an unreachable network volume): dropping
    // `child` then kills it, which ends the reader too.
    let mut stdout = child.0.stdout.take().expect("piped stdout");
    let (tx, rx) = std::sync::mpsc::sync_channel::<std::io::Result<Vec<u8>>>(16);
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 1 << 16];
        loop {
            let res = match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => Ok(buf[..n].to_vec()),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => Err(e),
            };
            let failed = res.is_err();
            if tx.send(res).is_err() || failed {
                break;
            }
        }
    });
    let mut out: Vec<f32> = Vec::new();
    let mut carry: Vec<u8> = Vec::with_capacity(4);
    loop {
        check_cancel(cancel)?;
        let bytes = match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(r) => r.context("reading ffmpeg output")?,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        };
        carry.extend_from_slice(&bytes);
        let (whole, rest) = carry.as_chunks::<4>();
        out.extend(whole.iter().map(|b| f32::from_le_bytes(*b)));
        carry = rest.to_vec();
        if out.len() > MAX_SAMPLES {
            bail!(TooLong);
        }
    }
    let status = loop {
        check_cancel(cancel)?;
        if let Some(status) = child.0.try_wait().context("waiting for ffmpeg")? {
            break status;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    };
    if !status.success() {
        let err = stderr.join().unwrap_or_default();
        bail!("ffmpeg failed: {}", err.trim());
    }
    Ok(out)
}

pub struct Downloaded {
    pub path: PathBuf,
    pub title: String,
}

/// Removes every file in `dir` named `<stem>.*` on drop unless disarmed, so
/// failed or cancelled downloads don't leave partial files behind.
struct PartialFiles<'a> {
    dir: &'a Path,
    stem: String,
    armed: bool,
}

impl Drop for PartialFiles<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let prefix = format!("{}.", self.stem);
        for e in std::fs::read_dir(self.dir).into_iter().flatten().flatten() {
            if e.file_name().to_string_lossy().starts_with(&prefix) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Download the audio track of a URL (YouTube, podcasts, …) with yt-dlp.
pub async fn download_url(url: &str, dest_dir: &Path) -> Result<Downloaded> {
    let mut partial = PartialFiles { dir: dest_dir, stem: uuid::Uuid::new_v4().to_string(), armed: true };
    // Direct links to media files don't need yt-dlp.
    let lower = url.to_lowercase();
    let path_part = lower.split(['?', '#']).next().unwrap_or("");
    if let Some(e) = MEDIA_EXTS.iter().find(|e| path_part.ends_with(&format!(".{e}"))) {
        use tokio::io::AsyncWriteExt;
        let mut resp = reqwest::get(url).await?.error_for_status()?;
        if resp.content_length().is_some_and(|n| n > MAX_DOWNLOAD_BYTES) {
            bail!("This file is too large to download (over {} GB)", MAX_DOWNLOAD_BYTES >> 30);
        }
        let name = path_part.rsplit('/').next().unwrap_or("download").to_string();
        let dest = dest_dir.join(format!("{}.{e}", partial.stem));
        // Stream to disk rather than buffering the whole body in memory.
        let mut file = tokio::fs::File::create(&dest).await?;
        let mut written = 0u64;
        while let Some(chunk) = resp.chunk().await? {
            written += chunk.len() as u64;
            if written > MAX_DOWNLOAD_BYTES {
                bail!("This file is too large to download (over {} GB)", MAX_DOWNLOAD_BYTES >> 30);
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        partial.armed = false;
        return Ok(Downloaded { path: dest, title: name });
    }

    let ytdlp = shell_env::which("yt-dlp")
        .ok_or_else(|| anyhow!("Importing from links needs yt-dlp. Install it with `brew install yt-dlp`."))?;
    let template = dest_dir.join(format!("{}.%(ext)s", partial.stem));
    let out = tokio::process::Command::new(ytdlp)
        .args([
            "--no-playlist",
            "--no-progress",
            "--max-filesize",
            "4G",
            "-f",
            "bestaudio/best",
            "--print",
            "title",
            "--print",
            "after_move:filepath",
            "-o",
        ])
        .arg(&template)
        // `--` so a URL can never be parsed as an option.
        .arg("--")
        .arg(url)
        .env("PATH", shell_env::path())
        .stdin(Stdio::null())
        // Cancelling the job drops this future; take yt-dlp down with it.
        .kill_on_drop(true)
        .output()
        .await
        .context("running yt-dlp")?;
    if !out.status.success() {
        bail!("yt-dlp failed: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("unknown error"));
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
    let path = lines.last().map(|p| PathBuf::from(p.trim())).ok_or_else(|| anyhow!("yt-dlp gave no file"))?;
    let title = if lines.len() >= 2 { lines[0].trim().to_string() } else { url.to_string() };
    partial.armed = false;
    Ok(Downloaded { path, title })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ffmpeg_decode_and_cancel() {
        let Some(ffmpeg) = shell_env::which("ffmpeg") else { return };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tone.opus");
        let ok = std::process::Command::new(ffmpeg)
            .args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3"])
            .arg(&path)
            .status()
            .unwrap()
            .success();
        assert!(ok);

        let pcm = decode_file(&path, &AtomicBool::new(false)).unwrap();
        let secs = pcm.len() as f64 / SAMPLE_RATE as f64;
        assert!((secs - 3.0).abs() < 0.1, "decoded {secs} s");

        let err = decode_file(&path, &AtomicBool::new(true)).unwrap_err();
        assert_eq!(err.to_string(), "Cancelled");
    }

    #[test]
    fn symphonia_decodes_and_resamples() {
        let dir = tempfile::tempdir().unwrap();
        let wav = dir.path().join("tone.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&wav, spec).unwrap();
        for i in 0..44_100 * 2 {
            let v = ((i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin() * 0.5 * i16::MAX as f32) as i16;
            w.write_sample(v).unwrap();
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();

        let mut inputs = vec![wav.clone()];
        // AAC in MP4 as well, when the system encoder is around (macOS).
        let m4a = dir.path().join("tone.m4a");
        if std::process::Command::new("afconvert")
            .args(["-f", "m4af", "-d", "aac"])
            .arg(&wav)
            .arg(&m4a)
            .status()
            .is_ok_and(|s| s.success())
        {
            inputs.push(m4a);
        }
        for path in inputs {
            let pcm = decode_symphonia(&path, &AtomicBool::new(false)).unwrap();
            let secs = pcm.len() as f64 / SAMPLE_RATE as f64;
            // AAC priming/padding is not trimmed, so allow ~70 ms extra.
            assert!((secs - 2.0).abs() < 0.1, "{}: decoded {secs} s", path.display());
            let mid = &pcm[SAMPLE_RATE as usize / 2..SAMPLE_RATE as usize * 3 / 2];
            let rms = (mid.iter().map(|x| x * x).sum::<f32>() / mid.len() as f32).sqrt();
            assert!((rms - 0.5 / 2f32.sqrt()).abs() < 0.02, "{}: rms {rms}", path.display());
        }
    }
}
