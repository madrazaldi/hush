//! Meetings: record mic ("Me") and system audio ("Them") as separate streams,
//! transcribe them live in short VAD-cut chunks, then turn the user's notes +
//! transcript into enhanced notes (Granola-style).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::ai;
use crate::audio::{WavSink, mic::MicCapture};
use crate::db::{self, Recording};
use crate::llm;
use crate::state;
use crate::stt::{self, SAMPLE_RATE, Segment, SttOptions};

pub const ME: &str = "Me";
pub const THEM: &str = "Them";
const FRAME: usize = (SAMPLE_RATE as usize) * 30 / 1000; // 30 ms
const PREROLL_FRAMES: usize = 10; // 300 ms
const END_SILENCE_FRAMES: usize = 24; // 720 ms
const MIN_UTTERANCE: usize = SAMPLE_RATE as usize; // 1 s
const MAX_UTTERANCE: usize = SAMPLE_RATE as usize * 25;
/// Speech waiting for transcription is kept in memory up to ~5 minutes; past
/// that (slow provider, busy local model) further chunks are spooled to disk.
const MAX_QUEUED_SAMPLES: usize = SAMPLE_RATE as usize * 300;
/// If spooling fails too (disk full), speech beyond this backlog is skipped
/// rather than growing memory without bound. The recording itself is unaffected.
const HARD_MAX_QUEUED_SAMPLES: usize = MAX_QUEUED_SAMPLES * 2;

enum Pcm {
    Mem(Vec<f32>),
    Spooled(PathBuf),
}

/// A chunk of speech from one stream, timestamped on the meeting timeline.
struct Chunk {
    speaker: &'static str,
    start_ms: i64,
    pcm: Pcm,
}

/// Sending side of the transcription queue, shared by both streams.
#[derive(Clone)]
struct ChunkQueue {
    id: String,
    tx: mpsc::UnboundedSender<Chunk>,
    queued: Arc<AtomicUsize>,
    /// Session-owned temp dir (not the recording dir), removed when the
    /// session ends and swept on launch, so raw speech never lingers there.
    spool_dir: PathBuf,
    seq: Arc<AtomicUsize>,
    warned: Arc<AtomicBool>,
}

impl ChunkQueue {
    fn send(&self, speaker: &'static str, start_ms: i64, pcm: Vec<f32>) {
        let len = pcm.len();
        let queued = self.queued.load(Ordering::Relaxed);
        let pcm = if queued + len > MAX_QUEUED_SAMPLES {
            let path = self.spool_dir.join(format!("pending-{}.wav", self.seq.fetch_add(1, Ordering::Relaxed)));
            let spooled = std::fs::create_dir_all(&self.spool_dir)
                .map_err(anyhow::Error::from)
                .and_then(|_| crate::audio::write_wav(&path, &pcm, SAMPLE_RATE));
            match spooled {
                Ok(()) => Pcm::Spooled(path),
                Err(e) if queued + len > HARD_MAX_QUEUED_SAMPLES => {
                    log::error!("transcription backlog full and spooling failed, skipping speech: {e:#}");
                    if !self.warned.swap(true, Ordering::Relaxed) {
                        state::get().emit(
                            "meeting:error",
                            serde_json::json!({"id": self.id, "error": "Transcription fell behind and some speech was skipped"}),
                        );
                    }
                    return;
                }
                Err(e) => {
                    log::warn!("spooling meeting audio failed: {e:#}");
                    self.queued.fetch_add(len, Ordering::Relaxed);
                    Pcm::Mem(pcm)
                }
            }
        } else {
            self.queued.fetch_add(len, Ordering::Relaxed);
            Pcm::Mem(pcm)
        };
        let _ = self.tx.send(Chunk { speaker, start_ms, pcm });
    }

    /// Take a chunk's audio back, releasing its share of the memory budget.
    fn load(queued: &AtomicUsize, pcm: Pcm) -> Vec<f32> {
        match pcm {
            Pcm::Mem(v) => {
                queued.fetch_sub(v.len(), Ordering::Relaxed);
                v
            }
            Pcm::Spooled(path) => {
                let v = hound::WavReader::open(&path)
                    .map(|r| {
                        r.into_samples::<i16>().filter_map(|s| s.ok()).map(|s| s as f32 / i16::MAX as f32).collect()
                    })
                    .unwrap_or_else(|e| {
                        log::warn!("reading spooled meeting audio failed: {e}");
                        Vec::new()
                    });
                let _ = std::fs::remove_file(&path);
                v
            }
        }
    }
}

/// Energy-based utterance segmenter with an adaptive noise floor.
struct Segmenter {
    speaker: &'static str,
    offset_ms: i64,
    pos: usize,
    frame: Vec<f32>,
    preroll: std::collections::VecDeque<Vec<f32>>,
    buf: Vec<f32>,
    buf_start: usize,
    in_speech: bool,
    silence: usize,
    noise: f32,
    /// Dropped by `finish`, which is what ends the transcription worker.
    queue: Option<ChunkQueue>,
    wav: Option<WavSink>,
    level: f32,
}

impl Segmenter {
    fn new(speaker: &'static str, offset_ms: i64, queue: ChunkQueue, wav: Option<WavSink>) -> Self {
        Self {
            speaker,
            offset_ms,
            pos: 0,
            frame: Vec::with_capacity(FRAME),
            preroll: Default::default(),
            buf: Vec::new(),
            buf_start: 0,
            in_speech: false,
            silence: 0,
            noise: 0.003,
            queue: Some(queue),
            wav,
            level: 0.0,
        }
    }

    fn push(&mut self, pcm: &[f32]) {
        if let Some(w) = self.wav.as_mut() {
            w.write(pcm);
        }
        for &s in pcm {
            self.frame.push(s);
            if self.frame.len() == FRAME {
                let f = std::mem::replace(&mut self.frame, Vec::with_capacity(FRAME));
                self.on_frame(f);
            }
        }
    }

    fn on_frame(&mut self, f: Vec<f32>) {
        let rms = (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt();
        self.level = crate::audio::level(&f);
        // Noise floor: fast down, slow up.
        self.noise = if rms < self.noise { rms.max(1e-5) } else { self.noise * 0.998 + rms * 0.002 };
        let speech = rms > (self.noise * 3.0).max(0.006);
        let n = f.len();

        if !self.in_speech {
            if speech {
                self.in_speech = true;
                self.silence = 0;
                let pre: usize = self.preroll.iter().map(Vec::len).sum();
                self.buf_start = self.pos - pre;
                self.buf.clear();
                for p in self.preroll.drain(..) {
                    self.buf.extend(p);
                }
                self.buf.extend(&f);
            } else {
                self.preroll.push_back(f);
                if self.preroll.len() > PREROLL_FRAMES {
                    self.preroll.pop_front();
                }
            }
        } else {
            self.buf.extend(&f);
            self.silence = if speech { 0 } else { self.silence + 1 };
            if self.silence >= END_SILENCE_FRAMES {
                if self.buf.len() >= MIN_UTTERANCE {
                    self.emit();
                } else {
                    self.buf.clear();
                }
                self.in_speech = false;
            } else if self.buf.len() >= MAX_UTTERANCE {
                self.emit();
                self.buf_start = self.pos + n;
            }
        }
        self.pos += n;
    }

    fn emit(&mut self) {
        let pcm = std::mem::take(&mut self.buf);
        let start_ms = self.offset_ms + (self.buf_start as i64) * 1000 / SAMPLE_RATE as i64;
        if let Some(q) = &self.queue {
            q.send(self.speaker, start_ms, pcm);
        }
    }

    fn finish(&mut self) -> Option<WavSink> {
        if self.in_speech && self.buf.len() >= SAMPLE_RATE as usize / 2 {
            self.emit();
        }
        self.queue = None;
        self.wav.take()
    }

    fn duration_ms(&self) -> i64 {
        self.offset_ms + self.pos as i64 * 1000 / SAMPLE_RATE as i64
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MeetingStatus {
    pub id: String,
    pub elapsed_ms: i64,
    pub paused: bool,
    pub mic: bool,
    pub system: bool,
    pub system_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Levels {
    me: f32,
    them: f32,
}

/// Queue and WAV path waiting for the first system audio (see `Active::them_init`).
type ThemInit = Arc<Mutex<Option<(ChunkQueue, Option<PathBuf>)>>>;

#[cfg(target_os = "macos")]
type SystemSlot = Arc<Mutex<Option<crate::audio::system_macos::SystemAudioCapture>>>;

struct Active {
    id: String,
    started: Instant,
    paused: Arc<AtomicBool>,
    mic: Option<MicCapture>,
    #[cfg(target_os = "macos")]
    system: SystemSlot,
    stopping: Arc<AtomicBool>,
    me: Arc<Mutex<Segmenter>>,
    them: Arc<Mutex<Option<Segmenter>>>,
    /// Queue and WAV path for the "Them" segmenter, which is created on the
    /// first system audio so its offset reflects when capture really began.
    them_init: ThemInit,
    worker: tauri::async_runtime::JoinHandle<()>,
    system_error: Arc<Mutex<Option<String>>>,
    dir: PathBuf,
    spool_dir: PathBuf,
    me_wav: Option<PathBuf>,
    them_wav: Option<PathBuf>,
}

#[derive(Default)]
pub struct Meetings {
    active: Mutex<Option<Active>>,
    /// Held while `start` sets up devices, so two concurrent starts can't both proceed.
    starting: AtomicBool,
    /// Meetings that were stopped but are still transcribing / mixing. They
    /// can't be resumed until that finishes.
    finalizing: Mutex<HashSet<String>>,
    detected: Mutex<Vec<String>>,
}

struct ClearOnDrop<'a>(&'a AtomicBool);

impl Drop for ClearOnDrop<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

struct Finalizing<'a>(&'a Mutex<HashSet<String>>, String);

impl Drop for Finalizing<'_> {
    fn drop(&mut self) {
        self.0.lock().remove(&self.1);
    }
}

impl Meetings {
    pub fn active_id(&self) -> Option<String> {
        self.active.lock().as_ref().map(|a| a.id.clone())
    }

    pub fn status(&self) -> Option<MeetingStatus> {
        let a = self.active.lock();
        let a = a.as_ref()?;
        #[cfg(target_os = "macos")]
        let system = a.system.lock().is_some();
        #[cfg(not(target_os = "macos"))]
        let system = false;
        Some(MeetingStatus {
            id: a.id.clone(),
            elapsed_ms: a.me.lock().duration_ms(),
            paused: a.paused.load(Ordering::Relaxed),
            mic: a.mic.is_some(),
            system,
            system_error: a.system_error.lock().clone(),
        })
    }

    pub fn set_paused(&self, paused: bool) {
        if let Some(a) = self.active.lock().as_ref() {
            a.paused.store(paused, Ordering::Relaxed);
        }
    }

    /// Start recording into an existing meeting row, or a new one.
    pub fn start(&self, existing: Option<String>, title: Option<String>) -> Result<Recording> {
        if self.starting.swap(true, Ordering::SeqCst) {
            return Err(anyhow!("A meeting is already being recorded"));
        }
        let _starting = ClearOnDrop(&self.starting);
        if self.active.lock().is_some() {
            return Err(anyhow!("A meeting is already being recorded"));
        }
        if let Some(id) = &existing
            && self.finalizing.lock().contains(id)
        {
            return Err(anyhow!("This meeting is still being processed. Try again in a moment."));
        }
        let st = state::get();
        let s = st.settings();

        let mut previous = None;
        let resumed = existing.and_then(|id| {
            st.db
                .update_recording(&id, |r| {
                    previous = Some((r.status.clone(), r.progress));
                    r.status = "recording".into();
                })
                .ok()
                .flatten()
        });
        let rec = match resumed {
            Some(r) => r,
            None => Recording {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "meeting".into(),
                title: title.filter(|t| !t.trim().is_empty()).unwrap_or_else(default_title),
                created_at: db::now_ms(),
                status: "recording".into(),
                template_id: Some(s.meetings.default_template.clone()),
                stt: Some(s.meetings.stt_profile.clone()),
                ..Default::default()
            },
        };
        // Resuming a meeting appends after what was already recorded.
        let base_ms = rec.segments.iter().map(|s| s.end_ms).max().unwrap_or(0).max(rec.duration_ms);
        if previous.is_none() {
            st.db.upsert_recording(&rec)?;
        }
        // If devices fail to start, put the row back the way it was.
        let rollback = |e: anyhow::Error| {
            match &previous {
                Some((status, progress)) => {
                    let _ = st.db.set_status(&rec.id, status, *progress, None);
                }
                None => {
                    let _ = st.db.delete_recording(&rec.id);
                }
            }
            e
        };

        let dir = crate::paths::audio_dir().join(&rec.id);
        std::fs::create_dir_all(&dir).map_err(|e| rollback(e.into()))?;
        // Each session's files are unique, so a resumed meeting never touches
        // the previous session's.
        let part = format!("{}-{}", db::now_ms(), &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let keep = s.meetings.keep_audio;
        let wav_path = |name: &str| keep.then(|| dir.join(format!("{name}-{part}.wav")));
        let (me_wav, them_wav) = (wav_path("me"), wav_path("them"));
        let spool_dir = crate::paths::spool_dir().join(&part);

        let (tx, rx) = mpsc::unbounded_channel::<Chunk>();
        let queue = ChunkQueue {
            id: rec.id.clone(),
            tx,
            queued: Arc::default(),
            spool_dir: spool_dir.clone(),
            seq: Arc::default(),
            warned: Arc::default(),
        };
        let queued = queue.queued.clone();
        let paused = Arc::new(AtomicBool::new(false));
        let me_sink = me_wav.as_ref().and_then(|p| WavSink::create(p, SAMPLE_RATE, 1).ok());
        let me = Arc::new(Mutex::new(Segmenter::new(ME, base_ms, queue.clone(), me_sink)));
        let them: Arc<Mutex<Option<Segmenter>>> = Arc::new(Mutex::new(None));
        let them_init: ThemInit = Arc::new(Mutex::new(None));

        let started = Instant::now();
        let me2 = me.clone();
        let paused2 = paused.clone();
        let mic = MicCapture::start(
            s.meetings.mic_device.as_deref(),
            Box::new(move |pcm| {
                if !paused2.load(Ordering::Relaxed) {
                    me2.lock().push(pcm);
                }
            }),
        )
        .map_err(rollback)?;

        let system_error = Arc::new(Mutex::new(None));
        let stopping = Arc::new(AtomicBool::new(false));
        #[cfg(target_os = "macos")]
        let system: SystemSlot = Arc::new(Mutex::new(None));
        #[cfg(target_os = "macos")]
        if s.meetings.capture_system_audio {
            if crate::audio::system_macos::is_supported() {
                *them_init.lock() = Some((queue.clone(), them_wav.clone()));
                start_system_capture(SystemStart {
                    me: me.clone(),
                    them: them.clone(),
                    them_init: them_init.clone(),
                    paused: paused.clone(),
                    system: system.clone(),
                    error: system_error.clone(),
                    stopping: stopping.clone(),
                });
            } else {
                *system_error.lock() = Some("System audio capture needs macOS 14.2 or later".into());
            }
        }
        drop(queue);

        let worker = tauri::async_runtime::spawn(transcribe_worker(rec.id.clone(), rx, queued));
        let (levels_me, levels_them, levels_stop) = (me.clone(), them.clone(), stopping.clone());
        tauri::async_runtime::spawn(async move {
            while !levels_stop.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let me = levels_me.lock().level;
                let them = levels_them.lock().as_ref().map(|s| s.level).unwrap_or(0.0);
                state::get().emit("meeting:levels", Levels { me, them });
            }
        });

        *self.active.lock() = Some(Active {
            id: rec.id.clone(),
            started,
            paused,
            mic: Some(mic),
            #[cfg(target_os = "macos")]
            system,
            stopping,
            me,
            them,
            them_init,
            worker,
            system_error,
            dir,
            spool_dir,
            me_wav,
            them_wav,
        });
        st.emit("meeting:started", &rec.id);
        crate::tray::refresh();
        Ok(rec)
    }

    /// Stop recording, finish transcription, and (optionally) enhance notes.
    pub async fn stop(&self) -> Result<String> {
        self.finish(false).await
    }

    /// Called when the app quits: finalize the recording's audio and give
    /// transcription a few seconds to catch up, but don't start AI work.
    pub async fn shutdown(&self) {
        if self.active_id().is_some()
            && let Err(e) = self.finish(true).await
        {
            log::error!("finishing meeting on quit: {e:#}");
        }
    }

    async fn finish(&self, quitting: bool) -> Result<String> {
        let (mut a, _finalizing) = {
            let mut active = self.active.lock();
            let a = active.take().ok_or_else(|| anyhow!("No meeting is being recorded"))?;
            self.finalizing.lock().insert(a.id.clone());
            let guard = Finalizing(&self.finalizing, a.id.clone());
            (a, guard)
        };
        // Wall-clock fallback, taken before waiting on devices and transcription.
        let wall_ms = a.started.elapsed().as_millis() as i64;
        let st = state::get();
        let id = a.id.clone();
        // Set before taking the system slot / "Them" segmenter: the system
        // capture thread checks it under those locks, so it can't install
        // anything after we've drained them.
        a.stopping.store(true, Ordering::SeqCst);
        st.db.set_status(&id, "processing", 0.0, None)?;
        st.emit("meeting:stopped", &id);
        crate::tray::refresh();

        if let Some(mut m) = a.mic.take() {
            tokio::task::spawn_blocking(move || m.stop()).await.ok();
        }
        #[cfg(target_os = "macos")]
        {
            let cap = a.system.lock().take();
            if let Some(mut c) = cap {
                tokio::task::spawn_blocking(move || c.stop()).await.ok();
            }
        }
        // Flushing the segmenters drops the last queue senders, which ends the worker.
        let (me_wav, me_dur, me_base) = {
            let mut me = a.me.lock();
            (me.finish(), me.duration_ms(), me.offset_ms)
        };
        a.them_init.lock().take();
        let them_seg = a.them.lock().take();
        let (them_wav, them_dur, them_offset) = match them_seg {
            Some(mut s) => (s.finish(), s.duration_ms(), s.offset_ms),
            None => (None, 0, me_base),
        };

        // Finalize the audio first, so it survives even if transcription is cut short.
        // The captured timeline (sample counts) excludes pauses and matches the
        // segment timestamps; fall back to wall time only if nothing was captured.
        let captured = me_dur.max(them_dur);
        let duration_ms = if captured > me_base { captured } else { me_base + wall_ms };
        for w in [me_wav, them_wav].into_iter().flatten() {
            let _ = w.finish();
        }
        let (dir, me_path, them_path) = (a.dir.clone(), a.me_wav.clone(), a.them_wav.clone());
        let shift_ms = them_offset - me_base;
        let mixed_path = tokio::task::spawn_blocking(move || {
            mix_meeting_audio(&dir, me_path.as_deref(), them_path.as_deref(), shift_ms)
        })
        .await
        .ok()
        .flatten();
        st.db.update_recording(&id, |r| {
            r.duration_ms = duration_ms;
            if let Some(p) = &mixed_path {
                r.audio_path = Some(p.to_string_lossy().into_owned());
            }
        })?;

        if quitting {
            if tokio::time::timeout(Duration::from_secs(5), &mut a.worker).await.is_err() {
                log::warn!("quitting before the meeting transcript caught up");
                a.worker.abort();
            }
        } else {
            let _ = (&mut a.worker).await;
        }
        let _ = std::fs::remove_dir_all(&a.spool_dir);

        let rec = st
            .db
            .update_recording(&id, |r| {
                r.segments.sort_by_key(|s| s.start_ms);
                r.status = "ready".into();
            })?
            .ok_or_else(|| anyhow!("meeting vanished"))?;
        st.emit("recording:updated", &id);

        let s = st.settings();
        if !quitting && s.meetings.auto_enhance && !rec.segments.is_empty() && s.llm(&s.meetings.llm_profile).is_some()
        {
            let id2 = id.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = enhance(&id2, None).await {
                    log::error!("enhance failed: {e:#}");
                    state::get().emit("meeting:enhance-error", serde_json::json!({"id": id2, "error": format!("{e}")}));
                }
            });
        }
        Ok(id)
    }

    /// Watch for meeting apps that start using the microphone.
    pub fn start_detection(&'static self) {
        #[cfg(target_os = "macos")]
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(4));
                let st = state::get();
                if !st.settings.read().meetings.detect_meetings || self.active.lock().is_some() {
                    self.detected.lock().clear();
                    continue;
                }
                let apps = mic_using_meeting_apps();
                let mut seen = self.detected.lock();
                for app in &apps {
                    if !seen.contains(app) {
                        st.emit("meeting:detected", app);
                        crate::notify(
                            &st.app,
                            "Meeting detected",
                            &format!("{app} is using your microphone. Open Hush to take notes."),
                        );
                    }
                }
                *seen = apps;
            }
        });
    }
}

#[cfg(target_os = "macos")]
struct SystemStart {
    me: Arc<Mutex<Segmenter>>,
    them: Arc<Mutex<Option<Segmenter>>>,
    them_init: ThemInit,
    paused: Arc<AtomicBool>,
    system: SystemSlot,
    error: Arc<Mutex<Option<String>>>,
    stopping: Arc<AtomicBool>,
}

/// Start the system-audio tap on its own thread (it can block on the
/// permission prompt). The "Them" segmenter is created on the first audio, at
/// the mic's current position, so a slow prompt doesn't shift the timeline.
#[cfg(target_os = "macos")]
fn start_system_capture(c: SystemStart) {
    let SystemStart { me, them, them_init, paused, system, error, stopping } = c;
    std::thread::spawn(move || {
        let them2 = them.clone();
        let res = crate::audio::system_macos::SystemAudioCapture::start(Box::new(move |pcm| {
            if paused.load(Ordering::Relaxed) {
                return;
            }
            let mut slot = them2.lock();
            if slot.is_none() {
                // `stop` takes `them_init` first, so this can't revive a stopped meeting.
                let Some((queue, wav)) = them_init.lock().take() else { return };
                let offset = me.lock().duration_ms();
                let sink = wav.and_then(|p| WavSink::create(&p, SAMPLE_RATE, 1).ok());
                *slot = Some(Segmenter::new(THEM, offset, queue, sink));
            }
            if let Some(seg) = slot.as_mut() {
                seg.push(pcm);
            }
        }));
        match res {
            Ok(mut cap) => {
                let mut slot = system.lock();
                if stopping.load(Ordering::SeqCst) {
                    drop(slot);
                    cap.stop();
                } else {
                    *slot = Some(cap);
                }
            }
            Err(e) => {
                log::error!("system audio: {e:#}");
                *error.lock() = Some(format!("{e}"));
            }
        }
    });
}

fn default_title() -> String {
    format!("Meeting {}", chrono::Local::now().format("%b %-d, %H:%M"))
}

#[cfg(target_os = "macos")]
fn mic_using_meeting_apps() -> Vec<String> {
    use cidre::core_audio::System;
    const APPS: &[(&str, &str)] = &[
        ("us.zoom.xos", "Zoom"),
        ("com.microsoft.teams2", "Microsoft Teams"),
        ("com.microsoft.teams", "Microsoft Teams"),
        ("com.apple.FaceTime", "FaceTime"),
        ("com.tinyspeck.slackmacgap", "Slack"),
        ("com.hnc.Discord", "Discord"),
        ("com.cisco.webexmeetingsapp", "Webex"),
        ("com.webex.meetingmanager", "Webex"),
        ("com.google.Chrome", "Google Chrome"),
        ("com.apple.Safari", "Safari"),
        ("company.thebrowser.Browser", "Arc"),
        ("com.brave.Browser", "Brave"),
        ("com.microsoft.edgemac", "Microsoft Edge"),
        ("org.mozilla.firefox", "Firefox"),
        ("net.whatsapp.WhatsApp", "WhatsApp"),
    ];
    let Ok(procs) = System::processes() else { return vec![] };
    let mut out = Vec::new();
    for p in procs {
        if !p.is_running_input().unwrap_or(false) {
            continue;
        }
        let Ok(bundle) = p.bundle_id() else { continue };
        let bundle = bundle.to_string();
        if let Some((_, name)) = APPS.iter().find(|(b, _)| bundle.starts_with(b))
            && !out.contains(&name.to_string())
        {
            out.push(name.to_string());
        }
    }
    out
}

/// Normalize text for duplicate detection.
fn norm(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// True if `seg` (from the mic) is likely speaker bleed of an overlapping "Them" segment.
fn is_bleed(seg: &Segment, existing: &[Segment]) -> bool {
    let a = norm(&seg.text);
    if a.len() < 6 {
        return false;
    }
    existing.iter().filter(|e| e.speaker.as_deref() == Some(THEM)).any(|e| {
        let overlap = seg.start_ms < e.end_ms + 2_000 && e.start_ms < seg.end_ms + 2_000;
        overlap && strsim::normalized_levenshtein(&a, &norm(&e.text)) > 0.7
    })
}

async fn transcribe_worker(id: String, mut rx: mpsc::UnboundedReceiver<Chunk>, queued: Arc<AtomicUsize>) {
    while let Some(chunk) = rx.recv().await {
        let pcm = ChunkQueue::load(&queued, chunk.pcm);
        let st = state::get();
        let s = st.settings();
        let profile_id =
            st.db.get_recording(&id).ok().flatten().and_then(|r| r.stt).unwrap_or(s.meetings.stt_profile.clone());
        let profile = s.stt(&profile_id);
        let opts = SttOptions {
            language: s.meetings.language.clone(),
            vocabulary: s.vocabulary.clone(),
            ..Default::default()
        };
        let res = stt::transcribe(&profile, &pcm, &opts, &|_| {}).await;
        let t = match res {
            Ok(t) => t,
            Err(e) => {
                log::warn!("meeting chunk failed: {e:#}");
                st.emit("meeting:error", serde_json::json!({"id": id, "error": format!("{e}")}));
                continue;
            }
        };
        let mut segs = if t.segments.is_empty() && !t.text.trim().is_empty() {
            vec![Segment {
                start_ms: 0,
                end_ms: pcm.len() as i64 * 1000 / SAMPLE_RATE as i64,
                text: t.text.trim().to_string(),
                ..Default::default()
            }]
        } else {
            t.offset(0).segments
        };
        // One live chunk is one utterance; merge model segments for readability.
        if segs.len() > 1 {
            let words = segs.iter().flat_map(|s| s.words.clone()).collect::<Vec<_>>();
            let text = segs.iter().map(|s| s.text.trim()).collect::<Vec<_>>().join(" ");
            segs = vec![Segment {
                start_ms: segs[0].start_ms,
                end_ms: segs[segs.len() - 1].end_ms,
                text,
                speaker: None,
                words,
            }];
        }
        let mut added = Vec::new();
        let _ = st.db.update_recording(&id, |r| {
            for mut seg in segs {
                seg.start_ms += chunk.start_ms;
                seg.end_ms += chunk.start_ms;
                for w in &mut seg.words {
                    w.start_ms += chunk.start_ms;
                    w.end_ms += chunk.start_ms;
                }
                seg.speaker = Some(chunk.speaker.to_string());
                if seg.text.trim().is_empty() || (chunk.speaker == ME && is_bleed(&seg, &r.segments)) {
                    continue;
                }
                if chunk.speaker == THEM {
                    // Drop mic segments that turn out to be bleed of this one.
                    let them = seg.clone();
                    r.segments
                        .retain(|e| !(e.speaker.as_deref() == Some(ME) && is_bleed(e, std::slice::from_ref(&them))));
                }
                let pos = r.segments.partition_point(|e| e.start_ms <= seg.start_ms);
                r.segments.insert(pos, seg.clone());
                added.push(seg);
            }
        });
        if !added.is_empty() {
            st.emit("meeting:transcript", &id);
        }
    }
}

/// Mix this session's me/them WAVs into one mono file (appending to an
/// existing mix when a meeting was resumed).
fn mix_meeting_audio(dir: &Path, me: Option<&Path>, them: Option<&Path>, them_shift_ms: i64) -> Option<PathBuf> {
    let me = me.filter(|p| p.exists()).map(Path::to_path_buf);
    let them = them.filter(|p| p.exists()).map(Path::to_path_buf);
    let read = |p: &Option<PathBuf>| -> Vec<i16> {
        p.as_ref()
            .and_then(|p| hound::WavReader::open(p).ok())
            .map(|r| r.into_samples::<i16>().flatten().collect())
            .unwrap_or_default()
    };
    let a = read(&me);
    let mut b = read(&them);
    // Align the system stream to the mic timeline.
    let shift = (them_shift_ms.max(0) as usize) * SAMPLE_RATE as usize / 1000;
    if !b.is_empty() {
        let mut padded = vec![0i16; shift];
        padded.append(&mut b);
        b = padded;
    }
    let n = a.len().max(b.len());
    if n == 0 {
        return None;
    }
    let out_path = dir.join("meeting.wav");
    let mut existing: Vec<i16> = if out_path.exists() {
        hound::WavReader::open(&out_path).ok().map(|r| r.into_samples::<i16>().flatten().collect()).unwrap_or_default()
    } else {
        Vec::new()
    };
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let tmp = dir.join("meeting.wav.tmp");
    let mut w = hound::WavWriter::create(&tmp, spec).ok()?;
    for s in existing.drain(..) {
        let _ = w.write_sample(s);
    }
    for i in 0..n {
        let x = *a.get(i).unwrap_or(&0) as i32 + *b.get(i).unwrap_or(&0) as i32;
        let _ = w.write_sample(x.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
    }
    w.finalize().ok()?;
    std::fs::rename(&tmp, &out_path).ok()?;
    // The per-stream files are no longer needed once mixed.
    for p in [me, them].into_iter().flatten() {
        let _ = std::fs::remove_file(p);
    }
    Some(out_path)
}

/// Generate enhanced notes with the given (or saved) template, streaming deltas
/// to the UI as `meeting:enhance` events.
pub async fn enhance(id: &str, template_id: Option<String>) -> Result<String> {
    let st = state::get();
    let s = st.settings();
    let rec = st.db.get_recording(id)?.ok_or_else(|| anyhow!("meeting not found"))?;
    let profile = s
        .llm(&s.meetings.llm_profile)
        .ok_or_else(|| anyhow!("Add an AI provider in Settings → AI to generate notes"))?;
    let tid = template_id.or(rec.template_id.clone()).unwrap_or(s.meetings.default_template.clone());
    let tpl = s
        .meetings
        .templates
        .iter()
        .find(|t| t.id == tid)
        .or(s.meetings.templates.first())
        .cloned()
        .ok_or_else(|| anyhow!("no templates"))?;
    let date = chrono::DateTime::from_timestamp_millis(rec.created_at)
        .map(|d| d.with_timezone(&chrono::Local).format("%A, %B %-d, %Y %H:%M").to_string())
        .unwrap_or_default();
    let segments = named_segments(&rec);
    let info = ai::MeetingInfo {
        title: &rec.title,
        date: &date,
        duration_min: rec.duration_ms / 60_000,
        your_name: &s.meetings.your_name,
    };
    let req = ai::enhance_request(&tpl, &rec.notes, &segments, &info);

    st.emit("meeting:enhance", serde_json::json!({"id": id, "reset": true}));
    let id_owned = id.to_string();
    let cancel = tokio_util::sync::CancellationToken::new();
    st.llm_tasks.lock().insert(format!("enhance:{id}"), cancel.clone());
    let result = llm::complete(&profile, &req, Some(cancel), &mut |d| {
        state::get().emit("meeting:enhance", serde_json::json!({"id": id_owned, "delta": d}));
    })
    .await;
    st.llm_tasks.lock().remove(&format!("enhance:{id}"));
    let notes = result?;

    // Auto-title meetings that still have the generated default name.
    let mut title = None;
    if rec.title.starts_with("Meeting ")
        && let Ok(t) = llm::complete_text(&profile, &ai::title_request(&notes)).await
    {
        let t = t.trim().trim_matches('"').trim().to_string();
        if !t.is_empty() && t.len() < 100 {
            title = Some(t);
        }
    }
    st.db.update_recording(id, |r| {
        r.enhanced = notes.clone();
        r.template_id = Some(tpl.id.clone());
        if let Some(t) = title {
            r.title = t;
        }
    })?;
    st.emit("recording:updated", id);
    st.emit("meeting:enhance", serde_json::json!({"id": id, "done": true}));
    Ok(notes)
}

/// Segments with speaker labels replaced by user-assigned names.
pub fn named_segments(rec: &Recording) -> Vec<Segment> {
    rec.segments
        .iter()
        .map(|s| {
            let mut s = s.clone();
            if let Some(sp) = &s.speaker
                && let Some(name) = rec.speakers.get(sp).filter(|n| !n.trim().is_empty())
            {
                s.speaker = Some(name.clone());
            }
            s.words.clear();
            s
        })
        .collect()
}
