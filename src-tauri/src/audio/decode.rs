//! Decode media files to 16 kHz mono f32. Uses Symphonia in-process for common
//! audio formats and falls back to `ffmpeg` (if installed) for video and
//! anything Symphonia can't handle. `yt-dlp` handles URL imports.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow, bail};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::shell_env;
use crate::stt::SAMPLE_RATE;

const SYMPHONIA_EXTS: &[&str] = &["wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "aiff", "aif", "caf"];

pub const MEDIA_EXTS: &[&str] = &[
    "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "caf", "wma", "amr", "webm", "mp4",
    "m4v", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp",
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

/// Decode any supported media file to 16 kHz mono samples.
pub fn decode_file(path: &Path) -> Result<Vec<f32>> {
    let e = ext(path).unwrap_or_default();
    if SYMPHONIA_EXTS.contains(&e.as_str()) {
        match decode_symphonia(path) {
            Ok(pcm) if !pcm.is_empty() => return Ok(pcm),
            Ok(_) => log::warn!("symphonia produced no audio for {}", path.display()),
            Err(err) => log::warn!("symphonia failed for {}: {err:#}", path.display()),
        }
    }
    decode_ffmpeg(path)
}

fn decode_symphonia(path: &Path) -> Result<Vec<f32>> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(e) = ext(path) {
        hint.with_extension(&e);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("no audio track"))?;
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.ok_or_else(|| anyhow!("unknown sample rate"))?;
    let mut decoder = symphonia::default::get_codecs().make(&track.codec_params, &DecoderOptions::default())?;

    let mut mono: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(symphonia::core::errors::Error::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let sb = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if sb.capacity() < decoded.capacity() * channels {
            *sb = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        sb.copy_interleaved_ref(decoded);
        mono.extend(super::to_mono(sb.samples(), channels));
    }
    Ok(super::resample(&mono, rate))
}

fn decode_ffmpeg(path: &Path) -> Result<Vec<f32>> {
    let ffmpeg = shell_env::which("ffmpeg")
        .ok_or_else(|| anyhow!("This format needs ffmpeg. Install it with `brew install ffmpeg`."))?;
    let out = std::process::Command::new(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .arg("-")
        .stdin(Stdio::null())
        .output()
        .context("running ffmpeg")?;
    if !out.status.success() {
        bail!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

pub struct Downloaded {
    pub path: PathBuf,
    pub title: String,
}

/// Download the audio track of a URL (YouTube, podcasts, …) with yt-dlp.
pub async fn download_url(url: &str, dest_dir: &Path) -> Result<Downloaded> {
    // Direct links to media files don't need yt-dlp.
    let lower = url.to_lowercase();
    let path_part = lower.split(['?', '#']).next().unwrap_or("");
    if let Some(e) = MEDIA_EXTS.iter().find(|e| path_part.ends_with(&format!(".{e}"))) {
        let resp = reqwest::get(url).await?.error_for_status()?;
        let name = path_part.rsplit('/').next().unwrap_or("download").to_string();
        let dest = dest_dir.join(format!("{}.{e}", uuid::Uuid::new_v4()));
        tokio::fs::write(&dest, resp.bytes().await?).await?;
        return Ok(Downloaded { path: dest, title: name });
    }

    let ytdlp = shell_env::which("yt-dlp")
        .ok_or_else(|| anyhow!("Importing from links needs yt-dlp. Install it with `brew install yt-dlp`."))?;
    let template = dest_dir.join(format!("{}.%(ext)s", uuid::Uuid::new_v4()));
    let out = tokio::process::Command::new(ytdlp)
        .args(["--no-playlist", "--no-progress", "-f", "bestaudio/best", "--print", "title", "--print", "after_move:filepath", "-o"])
        .arg(&template)
        .arg(url)
        .env("PATH", shell_env::path())
        .stdin(Stdio::null())
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
    Ok(Downloaded { path, title })
}
