//! On-device transcription via transcribe-cpp (ggml, Metal on Apple Silicon).
//!
//! Loaded models are cached (the most recent two) because loading a 700 MB
//! GGUF takes a second or two, which would ruin dictation latency.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use anyhow::{Result, anyhow};
use parking_lot::Mutex;
use transcribe_cpp::{CancelToken, Feature, Model, RunOptions, Session, Task, TimestampKind};

use super::{SAMPLE_RATE, Segment, SttOptions, Transcript, Word, models};

/// A loaded model plus a reusable session. Sessions are not Sync, so each is
/// guarded by its own mutex; transcribe-cpp serializes compute per model anyway.
struct Loaded {
    id: String,
    model: Model,
    session: Mutex<Session>,
}

static CACHE: LazyLock<Mutex<Vec<Arc<Loaded>>>> = LazyLock::new(Default::default);
const CACHE_SIZE: usize = 2;
/// Chunk length when the model reports no practical limit. Keeps memory and
/// progress granularity reasonable for hour-long files.
const DEFAULT_CHUNK_MS: i64 = 120_000;

fn load(id: &str) -> Result<Arc<Loaded>> {
    {
        let mut cache = CACHE.lock();
        if let Some(pos) = cache.iter().position(|l| l.id == id) {
            let l = cache.remove(pos);
            cache.insert(0, l.clone());
            return Ok(l);
        }
    }
    let path = models::resolve(id)?;
    log::info!("loading local model {}", path.display());
    let model = Model::load(&path).map_err(|e| anyhow!("failed to load model: {e}"))?;
    let session = model.session().map_err(|e| anyhow!("failed to create session: {e}"))?;
    let loaded = Arc::new(Loaded { id: id.to_string(), model, session: Mutex::new(session) });
    let mut cache = CACHE.lock();
    cache.insert(0, loaded.clone());
    cache.truncate(CACHE_SIZE);
    Ok(loaded)
}

/// Load a model ahead of time (e.g. when the dictation hotkey goes down).
pub fn preload(id: &str) {
    if id.is_empty() {
        return;
    }
    let id = id.to_string();
    std::thread::spawn(move || {
        if let Err(e) = load(&id) {
            log::warn!("preload {id}: {e:#}");
        }
    });
}

pub fn evict(id: &str) {
    CACHE.lock().retain(|l| l.id != id);
}

/// Release every loaded model. Must run before process exit: ggml's Metal
/// backend asserts if buffers are still alive when its static teardown runs.
pub fn shutdown() {
    for t in RUNNING.lock().values() {
        t.cancel();
    }
    // Aborted runs return between decode steps; give them a moment to unwind.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while IN_FLIGHT.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    CACHE.lock().clear();
}

fn run_options(model: &Model, opts: &SttOptions) -> RunOptions {
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

fn convert(t: transcribe_cpp::Transcript) -> Transcript {
    let words: Vec<Word> = t
        .words
        .iter()
        .filter(|w| !w.text.trim().is_empty())
        .map(|w| Word { start_ms: w.t0_ms, end_ms: w.t1_ms, text: w.text.clone() })
        .collect();

    let mut segments: Vec<Segment> = t
        .segments
        .iter()
        .filter(|s| !s.text.trim().is_empty())
        .map(|s| Segment {
            start_ms: s.t0_ms,
            end_ms: s.t1_ms,
            text: s.text.trim().to_string(),
            speaker: (s.speaker_id > 0).then(|| format!("Speaker {}", s.speaker_id)),
            words: if s.n_words > 0 && s.first_word >= 0 {
                t.words
                    .iter()
                    .skip(s.first_word as usize)
                    .take(s.n_words as usize)
                    .map(|w| Word { start_ms: w.t0_ms, end_ms: w.t1_ms, text: w.text.clone() })
                    .collect()
            } else {
                Vec::new()
            },
        })
        .collect();

    // Token-timestamp models (Parakeet) often return one long segment; split
    // it into sentence-sized pieces so the transcript editor is usable.
    let too_coarse = segments.len() <= 1 || segments.iter().any(|s| s.end_ms - s.start_ms > 30_000);
    if too_coarse && words.len() > 1 {
        segments = super::group_words(&words, None);
    }
    Transcript { text: t.text.trim().to_string(), language: t.language.filter(|l| !l.is_empty()), segments }
}

/// Cancel tokens of runs in flight, so `shutdown` can stop them.
static RUNNING: LazyLock<Mutex<HashMap<u64, CancelToken>>> = LazyLock::new(Default::default);
static NEXT_RUN: AtomicU64 = AtomicU64::new(0);
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

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

/// Registers a run's token, and cancels it when the async caller is dropped
/// (job cancelled, app quitting) or finishes.
struct RunGuard {
    key: u64,
    token: CancelToken,
}

impl RunGuard {
    fn new() -> Self {
        let key = NEXT_RUN.fetch_add(1, Ordering::Relaxed);
        let token = CancelToken::new();
        RUNNING.lock().insert(key, token.clone());
        RunGuard { key, token }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.token.cancel();
        RUNNING.lock().remove(&self.key);
    }
}

fn cancelled() -> anyhow::Error {
    anyhow!("Cancelled")
}

/// Run one chunk on the model's shared session.
fn run_chunk(loaded: &Loaded, chunk: &[f32], ro: &RunOptions, token: &CancelToken) -> Result<Transcript> {
    let _in_flight = InFlight::enter();
    if token.is_cancelled() {
        return Err(cancelled());
    }
    let mut session = loaded.session.lock();
    // Checked again: the session may have been busy (another job) while we waited.
    if token.is_cancelled() {
        return Err(cancelled());
    }
    session.set_cancel_token(token);
    let res = session.run(chunk, ro);
    session.clear_cancel_token();
    match res {
        Ok(r) => Ok(convert(r)),
        Err(_) if token.is_cancelled() => Err(cancelled()),
        // Truncated/repetition still carries a usable partial transcript.
        Err(e) => match e.partial() {
            Some(p) => Ok(convert(p.clone())),
            None => Err(anyhow!("transcription failed: {e}")),
        },
    }
}

pub async fn transcribe(
    model_id: &str,
    pcm: &[f32],
    opts: &SttOptions,
    progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<Transcript> {
    // The engine is synchronous, so each chunk runs on the blocking pool. The
    // session is locked per chunk rather than per file, so a dictation can slip
    // in between the chunks of a long file instead of waiting for all of it.
    let run = RunGuard::new();
    let token = run.token.clone();

    let id = model_id.to_string();
    let opts = opts.clone();
    let (loaded, ro, max_ms) = tokio::task::spawn_blocking(move || -> Result<_> {
        let loaded = load(&id)?;
        let ro = run_options(&loaded.model, &opts);
        let max_ms = loaded
            .session
            .lock()
            .limits()
            .ok()
            .map(|l| l.effective_max_audio_ms)
            .filter(|&m| m > 0)
            .map(|m| (m - 2_000).min(DEFAULT_CHUNK_MS))
            .unwrap_or(DEFAULT_CHUNK_MS);
        Ok((loaded, Arc::new(ro), max_ms))
    })
    .await
    .map_err(|e| anyhow!("transcription task panicked: {e}"))??;

    let max_samples = (max_ms as usize) * (SAMPLE_RATE as usize) / 1000;
    let chunks = crate::audio::split_at_silences(pcm, max_samples);
    let total = chunks.len();

    let mut out = Transcript::default();
    for (i, (start, chunk)) in chunks.into_iter().enumerate() {
        if token.is_cancelled() {
            return Err(cancelled());
        }
        if !crate::audio::has_voice(chunk) {
            progress((i + 1) as f32 / total as f32);
            continue;
        }
        let (l, r, t, owned) = (loaded.clone(), ro.clone(), token.clone(), chunk.to_vec());
        let mut piece = tokio::task::spawn_blocking(move || run_chunk(&l, &owned, &r, &t))
            .await
            .map_err(|e| anyhow!("transcription task panicked: {e}"))??;
        let offset_ms = (start as i64) * 1000 / SAMPLE_RATE as i64;
        let chunk_ms = (chunk.len() as i64) * 1000 / SAMPLE_RATE as i64;
        if piece.segments.is_empty() && !piece.text.is_empty() {
            piece.segments.push(Segment {
                start_ms: 0,
                end_ms: chunk_ms,
                text: piece.text.clone(),
                ..Default::default()
            });
        }
        // Models without timestamps (Moonshine, SenseVoice) report zero-length
        // segments; spread untimed ones across the chunk so seeking still works.
        if piece.segments.iter().all(|s| s.end_ms <= s.start_ms) {
            let n = piece.segments.len().max(1) as i64;
            for (k, seg) in piece.segments.iter_mut().enumerate() {
                seg.start_ms = chunk_ms * k as i64 / n;
                seg.end_ms = chunk_ms * (k as i64 + 1) / n;
            }
        }
        out.extend(piece.offset(offset_ms));
        progress((i + 1) as f32 / total as f32);
    }
    Ok(out)
}

/// Short human-readable engine info for diagnostics.
pub fn describe(model_id: &str) -> Result<String> {
    let l = load(model_id)?;
    Ok(format!("{} on {}", l.model.arch(), l.model.backend()))
}
