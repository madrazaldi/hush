//! On-device transcription via transcribe-cpp (ggml, Metal on Apple Silicon).
//!
//! This is deliberately thin: it loads models, keeps the most recent two warm
//! (loading a 700 MB GGUF takes a second or two, which would ruin dictation
//! latency) and runs one chunk of audio at a time. Chunking, option policy and
//! segment post-processing live on the Bun side.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use anyhow::{Result, anyhow};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use transcribe_cpp::{CancelToken, Feature, Model, RunOptions, Session, Task, TimestampKind};

/// A loaded model plus a reusable session. Sessions are not Sync, so each is
/// guarded by its own mutex; transcribe-cpp serializes compute per model anyway.
struct Loaded {
    key: String,
    model: Model,
    session: Mutex<Session>,
}

static CACHE: LazyLock<Mutex<Vec<Arc<Loaded>>>> = LazyLock::new(Default::default);
const CACHE_SIZE: usize = 2;

/// Cancel tokens of runs in flight, keyed by the caller's job id, so a cancel
/// request (and `shutdown`) can stop them.
static RUNNING: LazyLock<Mutex<HashMap<String, CancelToken>>> = LazyLock::new(Default::default);
/// Model loads and engine runs in progress; `shutdown` waits for them.
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// Counts a blocking engine call as in flight for its whole lifetime.
struct InFlight;

impl InFlight {
    fn enter() -> Self {
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        InFlight
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Per-run options chosen by the caller.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Options {
    /// ISO-639-1 code, or None for auto-detect.
    pub language: Option<String>,
    /// Translate to English (Whisper-family only).
    pub translate: bool,
    /// Custom vocabulary / key terms to bias recognition.
    pub vocabulary: Vec<String>,
    /// Free-form context prompt.
    pub prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RawWord {
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RawSegment {
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub text: String,
    pub speaker_id: i64,
    pub first_word: i64,
    pub n_words: i64,
}

/// What the engine produced for one chunk, before any post-processing.
#[derive(Debug, Clone, Serialize)]
pub struct RawTranscript {
    pub text: String,
    pub language: Option<String>,
    pub segments: Vec<RawSegment>,
    pub words: Vec<RawWord>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Info {
    pub arch: String,
    pub backend: String,
    /// Longest audio the model takes in one call, if it reports a limit.
    pub max_audio_ms: Option<i64>,
    pub languages: Vec<String>,
}

fn load(path: &Path) -> Result<Arc<Loaded>> {
    let _in_flight = InFlight::enter();
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err(anyhow!("Hush is quitting"));
    }
    let key = path.to_string_lossy().into_owned();
    {
        let mut cache = CACHE.lock();
        if let Some(pos) = cache.iter().position(|l| l.key == key) {
            let l = cache.remove(pos);
            cache.insert(0, l.clone());
            return Ok(l);
        }
    }
    if !path.is_file() {
        return Err(anyhow!("model file not found: {}", path.display()));
    }
    log::info!("loading local model {}", path.display());
    let model = Model::load(path).map_err(|e| anyhow!("failed to load model: {e}"))?;
    let session = model.session().map_err(|e| anyhow!("failed to create session: {e}"))?;
    let loaded = Arc::new(Loaded { key, model, session: Mutex::new(session) });
    let mut cache = CACHE.lock();
    // Don't repopulate the cache after `shutdown` cleared it.
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err(anyhow!("Hush is quitting"));
    }
    cache.insert(0, loaded.clone());
    cache.truncate(CACHE_SIZE);
    Ok(loaded)
}

/// Load a model and report what it can do.
pub fn info(path: &Path) -> Result<Info> {
    let l = load(path)?;
    let max_audio_ms = l.session.lock().limits().ok().map(|l| l.effective_max_audio_ms).filter(|&m| m > 0);
    let languages = l.model.capabilities().map(|c| c.languages.clone()).unwrap_or_default();
    Ok(Info { arch: l.model.arch().to_string(), backend: l.model.backend().to_string(), max_audio_ms, languages })
}

/// Load a model ahead of time (e.g. when the dictation hotkey goes down).
pub fn preload(path: &Path) {
    let path = path.to_path_buf();
    std::thread::spawn(move || {
        if let Err(e) = load(&path) {
            log::warn!("preload {}: {e:#}", path.display());
        }
    });
}

pub fn evict(path: &Path) {
    let key = path.to_string_lossy();
    CACHE.lock().retain(|l| l.key != key);
}

/// Abort the run in flight for `job`, if any.
pub fn cancel(job: &str) {
    if let Some(t) = RUNNING.lock().get(job) {
        t.cancel();
    }
}

/// Release every loaded model. Must run before process exit: ggml's Metal
/// backend asserts if buffers are still alive when its static teardown runs.
pub fn shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    for t in RUNNING.lock().values() {
        t.cancel();
    }
    // Aborted runs return between decode steps and model loads can't be
    // interrupted; give both a moment to finish.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while IN_FLIGHT.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    CACHE.lock().clear();
}

fn run_options(model: &Model, opts: &Options) -> RunOptions {
    let caps = model.capabilities().ok();
    let mut ro = RunOptions { timestamps: TimestampKind::Auto, ..Default::default() };

    if let (Some(lang), Some(caps)) = (opts.language.as_deref(), caps.as_ref()) {
        let multilingual = caps.languages.len() > 1;
        if multilingual && caps.languages.iter().any(|l| l == lang) {
            ro.language = Some(lang.to_string());
        }
    }
    if opts.translate && caps.as_ref().is_some_and(|c| c.supports_translate) {
        ro.task = Task::Translate;
        ro.target_language = Some("en".into());
    }
    if !opts.vocabulary.is_empty() && model.supports(Feature::Vocabulary) {
        ro.vocabulary = opts.vocabulary.clone();
    }
    let mut prompt = opts.prompt.clone().unwrap_or_default();
    if !opts.vocabulary.is_empty() && !model.supports(Feature::Vocabulary) {
        // Whisper-style models take vocabulary through the initial prompt.
        if !prompt.is_empty() {
            prompt.push(' ');
        }
        prompt.push_str(&opts.vocabulary.join(", "));
    }
    if !prompt.trim().is_empty() && (model.supports(Feature::ContextPrompt) || model.supports(Feature::InitialPrompt)) {
        ro.prompt = Some(prompt);
    }
    ro
}

fn convert(t: transcribe_cpp::Transcript) -> RawTranscript {
    RawTranscript {
        text: t.text.trim().to_string(),
        language: t.language.filter(|l| !l.is_empty()),
        segments: t
            .segments
            .iter()
            .map(|s| RawSegment {
                t0_ms: s.t0_ms,
                t1_ms: s.t1_ms,
                text: s.text.clone(),
                speaker_id: s.speaker_id as i64,
                first_word: s.first_word as i64,
                n_words: s.n_words as i64,
            })
            .collect(),
        words: t.words.iter().map(|w| RawWord { t0_ms: w.t0_ms, t1_ms: w.t1_ms, text: w.text.clone() }).collect(),
    }
}

/// Removes a run's cancel token when the run ends, however it ends.
struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.lock().remove(&self.0);
    }
}

/// Run one chunk of 16 kHz mono audio on the model's shared session. The
/// session is locked per chunk, so a dictation can slip in between the chunks
/// of a long file instead of waiting for all of it.
pub fn run(job: &str, path: &Path, pcm: &[f32], opts: &Options) -> Result<RawTranscript> {
    let token = CancelToken::new();
    RUNNING.lock().insert(job.to_string(), token.clone());
    let _guard = RunGuard(job.to_string());

    let loaded = load(path)?;
    let ro = run_options(&loaded.model, opts);

    let _in_flight = InFlight::enter();
    if token.is_cancelled() {
        return Err(anyhow!("Cancelled"));
    }
    let mut session = loaded.session.lock();
    // Checked again: the session may have been busy (another job) while we waited.
    if token.is_cancelled() {
        return Err(anyhow!("Cancelled"));
    }
    session.set_cancel_token(&token);
    let res = session.run(pcm, &ro);
    session.clear_cancel_token();
    match res {
        Ok(r) => Ok(convert(r)),
        Err(_) if token.is_cancelled() => Err(anyhow!("Cancelled")),
        // Truncated/repetition still carries a usable partial transcript.
        Err(e) => match e.partial() {
            Some(p) => Ok(convert(p.clone())),
            None => Err(anyhow!("transcription failed: {e}")),
        },
    }
}
