//! Capture sessions: microphone or system audio, delivered as 16 kHz mono f32
//! and written to disk.
//!
//! Audio never travels over the JSON channel. A session writes raw
//! little-endian f32 samples to a file and tells the parent about it:
//!
//! * `rotate_ms == 0`: one file at `path`, finished by `capture.stop`.
//! * `rotate_ms > 0`: a new file `<path>.<seq>` roughly every `rotate_ms`; each
//!   finished file is announced with a `capture.chunk` event and owned by the
//!   parent from then on (it deletes it once consumed), so a long meeting never
//!   piles up on disk. The last, partial chunk is announced before `capture.stop`
//!   replies.
//!
//! `capture.level` events (0..1) are pushed about 20 times a second.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;

use crate::audio::{SAMPLE_RATE, level};
use crate::mic::MicCapture;
use crate::rpc::Emitter;
use crate::system::SystemAudioCapture;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Mic,
    System,
}

#[derive(Debug, Deserialize)]
pub struct StartParams {
    pub id: String,
    pub source: Source,
    /// Input device name for the mic; the default device when absent.
    pub device: Option<String>,
    pub path: PathBuf,
    #[serde(default)]
    pub rotate_ms: u64,
}

/// Writes captured samples to the current file and announces finished chunks.
struct Sink {
    id: String,
    base: PathBuf,
    rotate_samples: usize,
    seq: u64,
    file: Option<BufWriter<File>>,
    in_file: usize,
    total: u64,
    last_level: Instant,
    emitter: Emitter,
    scratch: Vec<u8>,
    error: Option<String>,
}

impl Sink {
    fn file_path(&self) -> PathBuf {
        if self.rotate_samples == 0 {
            self.base.clone()
        } else {
            let mut name = self.base.as_os_str().to_owned();
            name.push(format!(".{}", self.seq));
            PathBuf::from(name)
        }
    }

    fn open(&mut self) -> Result<()> {
        let path = self.file_path();
        let f = File::create(&path).map_err(|e| anyhow!("cannot write {}: {e}", path.display()))?;
        self.file = Some(BufWriter::with_capacity(1 << 16, f));
        self.in_file = 0;
        Ok(())
    }

    /// Close the current file and, when rotating, announce it.
    fn close_chunk(&mut self) {
        let Some(mut f) = self.file.take() else { return };
        if let Err(e) = f.flush() {
            self.error.get_or_insert(format!("writing audio failed: {e}"));
        }
        drop(f);
        if self.rotate_samples > 0 {
            if self.in_file > 0 {
                self.emitter.emit(
                    "capture.chunk",
                    json!({"id": self.id, "seq": self.seq, "path": self.file_path(), "samples": self.in_file}),
                );
            } else {
                let _ = std::fs::remove_file(self.file_path());
            }
            self.seq += 1;
        }
    }

    fn push(&mut self, pcm: &[f32]) {
        if self.error.is_some() || pcm.is_empty() {
            return;
        }
        if self.file.is_none()
            && let Err(e) = self.open()
        {
            self.error = Some(format!("{e:#}"));
            return;
        }
        self.scratch.clear();
        self.scratch.extend(pcm.iter().flat_map(|s| s.to_le_bytes()));
        if let Some(f) = self.file.as_mut()
            && let Err(e) = f.write_all(&self.scratch)
        {
            self.error = Some(format!("writing audio failed: {e}"));
            return;
        }
        self.in_file += pcm.len();
        self.total += pcm.len() as u64;
        if self.rotate_samples > 0 && self.in_file >= self.rotate_samples {
            self.close_chunk();
        }
        if self.last_level.elapsed() >= Duration::from_millis(45) {
            self.last_level = Instant::now();
            self.emitter.emit("capture.level", json!({"id": self.id, "level": level(pcm)}));
        }
    }
}

enum Backend {
    Mic(MicCapture),
    System(SystemAudioCapture),
}

impl Backend {
    fn stop(&mut self) {
        match self {
            Backend::Mic(m) => m.stop(),
            Backend::System(s) => s.stop(),
        }
    }
}

struct Session {
    backend: Backend,
    sink: Arc<Mutex<Sink>>,
}

#[derive(Default)]
pub struct Captures {
    sessions: Mutex<HashMap<String, Session>>,
}

impl Captures {
    /// Start a session. Returns once the device is running, which for the
    /// system tap can take as long as the permission prompt stays open.
    pub fn start(&self, p: StartParams, emitter: &Emitter) -> Result<serde_json::Value> {
        if self.sessions.lock().contains_key(&p.id) {
            return Err(anyhow!("capture {} is already running", p.id));
        }
        let mut sink = Sink {
            id: p.id.clone(),
            base: p.path,
            rotate_samples: (p.rotate_ms as usize) * SAMPLE_RATE as usize / 1000,
            seq: 0,
            file: None,
            in_file: 0,
            total: 0,
            last_level: Instant::now() - Duration::from_secs(1),
            emitter: emitter.clone(),
            scratch: Vec::new(),
            error: None,
        };
        sink.open()?;
        let sink = Arc::new(Mutex::new(sink));
        let s2 = sink.clone();
        let on_audio = Box::new(move |pcm: &[f32]| s2.lock().push(pcm));
        let (backend, device) = match p.source {
            Source::Mic => {
                let m = MicCapture::start(p.device.as_deref(), on_audio)?;
                let name = m.device_name.clone();
                (Backend::Mic(m), Some(name))
            }
            Source::System => (Backend::System(SystemAudioCapture::start(on_audio)?), None),
        };
        self.sessions.lock().insert(p.id, Session { backend, sink });
        Ok(json!({"device": device, "sample_rate": SAMPLE_RATE}))
    }

    /// Stop a session and wait until every captured sample is on disk.
    pub fn stop(&self, id: &str) -> Result<serde_json::Value> {
        let mut session = self.sessions.lock().remove(id).ok_or_else(|| anyhow!("no capture named {id}"))?;
        // Joins the capture thread, which delivers the resampler tail first.
        session.backend.stop();
        let mut sink = session.sink.lock();
        sink.close_chunk();
        if let Some(e) = sink.error.take() {
            return Err(anyhow!(e));
        }
        Ok(json!({"samples": sink.total}))
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.stop(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink(dir: &std::path::Path, rotate_samples: usize) -> Sink {
        Sink {
            id: "t".into(),
            base: dir.join("t.f32"),
            rotate_samples,
            seq: 0,
            file: None,
            in_file: 0,
            total: 0,
            last_level: Instant::now(),
            emitter: Emitter::new(std::io::sink()),
            scratch: Vec::new(),
            error: None,
        }
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hush-native-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn single_file_holds_every_sample() {
        let d = dir("single");
        let mut s = sink(&d, 0);
        s.open().unwrap();
        s.push(&[0.5, -0.5]);
        s.push(&[0.25]);
        s.close_chunk();
        let bytes = std::fs::read(d.join("t.f32")).unwrap();
        let samples: Vec<f32> = bytes.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
        assert_eq!(samples, vec![0.5, -0.5, 0.25]);
        assert_eq!(s.total, 3);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn rotation_splits_into_numbered_chunks() {
        let d = dir("rotate");
        let mut s = sink(&d, 4);
        s.open().unwrap();
        s.push(&[1.0, 2.0, 3.0]);
        s.push(&[4.0, 5.0]);
        s.push(&[6.0]);
        s.close_chunk();
        assert_eq!(s.total, 6);
        assert_eq!(std::fs::metadata(d.join("t.f32.0")).unwrap().len(), 5 * 4);
        assert_eq!(std::fs::metadata(d.join("t.f32.1")).unwrap().len(), 4);
        // The empty trailing chunk is not left behind.
        assert!(!d.join("t.f32.2").exists());
        std::fs::remove_dir_all(d).unwrap();
    }
}
