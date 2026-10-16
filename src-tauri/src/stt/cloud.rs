//! Cloud speech-to-text providers: OpenAI-compatible, xAI, Meta Muse, Deepgram,
//! ElevenLabs and AssemblyAI.
//!
//! Every provider takes one WAV chunk and returns a [`Transcript`]; [`transcribe`]
//! splits long audio at silences, runs the chunks sequentially and stitches the
//! results with corrected timestamps. Response parsers are pure functions over
//! `serde_json::Value` so they can be unit-tested without network access.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder};
use serde_json::{Value, json};

use super::{SAMPLE_RATE, Segment, SttKind, SttOptions, SttProfile, Transcript, Word};
use crate::audio::{split_at_silences, wav_bytes};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Transcribe 16 kHz mono PCM with a cloud provider. Long audio is chunked per
/// provider upload limits; `progress` receives 0..1 after each chunk.
pub async fn transcribe(
    profile: &SttProfile,
    pcm: &[f32],
    opts: &SttOptions,
    progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<Transcript> {
    if profile.kind == SttKind::Local {
        bail!("local models are not handled by the cloud transcriber");
    }
    progress(0.0);
    if pcm.is_empty() {
        progress(1.0);
        return Ok(Transcript::default());
    }
    let cx = Ctx { http: http_client(), p: profile, o: opts };
    let chunks = split_at_silences(pcm, max_chunk_secs(profile.kind) * SAMPLE_RATE as usize);
    let total = chunks.len();
    let mut out = Transcript::default();
    for (i, (start, slice)) in chunks.into_iter().enumerate() {
        let dur_ms = samples_to_ms(slice.len());
        let t = cx.transcribe_chunk(wav_bytes(slice, SAMPLE_RATE), dur_ms).await.map_err(|e| {
            if total > 1 { anyhow!("{e:#} (chunk {}/{total})", i + 1) } else { e }
        })?;
        out.extend(t.offset(samples_to_ms(start)));
        progress((i + 1) as f32 / total as f32);
    }
    Ok(out)
}

/// Validate credentials: transcribes a short generated tone (an empty transcript
/// counts as success). AssemblyAI is checked with a cheap list call instead.
pub async fn test_profile(profile: &SttProfile) -> Result<String> {
    let cx = Ctx { http: http_client(), p: profile, o: &SttOptions::default() };
    if profile.kind == SttKind::Assemblyai {
        let url = format!("{}/transcript?limit=1", cx.base());
        send(cx.http.get(url).header("authorization", &profile.api_key), "AssemblyAI").await?;
    } else {
        let tone: Vec<f32> = (0..SAMPLE_RATE as usize * 3 / 2)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin())
            .collect();
        transcribe(profile, &tone, &SttOptions::default(), &|_| {}).await?;
    }
    Ok(format!("{} accepted the request (model {})", provider_name(profile.kind), cx.model()))
}

/// Default model id for a provider (shown as a placeholder in settings).
pub fn default_model(kind: SttKind) -> &'static str {
    match kind {
        SttKind::Local => "",
        SttKind::OpenaiCompatible => "gpt-4o-transcribe",
        SttKind::Xai => "grok-voice-transcribe-2.0",
        SttKind::Muse => "muse-voice-transcribe-1.0",
        SttKind::Deepgram => "nova-3",
        SttKind::Elevenlabs => "scribe_v2",
        SttKind::Assemblyai => "universal-3-5-pro",
    }
}

/// Default API base URL for a provider.
pub fn default_base_url(kind: SttKind) -> &'static str {
    match kind {
        SttKind::Local => "",
        SttKind::OpenaiCompatible => "https://api.openai.com/v1",
        SttKind::Xai => "https://api.x.ai/v1",
        SttKind::Muse => "https://api.meta.ai/v1",
        SttKind::Deepgram => "https://api.deepgram.com/v1",
        SttKind::Elevenlabs => "https://api.elevenlabs.io/v1",
        SttKind::Assemblyai => "https://api.assemblyai.com/v2",
    }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(15 * 60))
            .build()
            .unwrap_or_default()
    })
}

/// Maximum chunk length in seconds, chosen to stay under each provider's upload cap.
fn max_chunk_secs(kind: SttKind) -> usize {
    match kind {
        SttKind::OpenaiCompatible => 10 * 60, // 25 MB cap; 10 min of 16-bit WAV is ~19 MB
        SttKind::Muse => 9 * 60 + 30,         // 10 min / 32 MB cap
        _ => 30 * 60,
    }
}

fn provider_name(kind: SttKind) -> &'static str {
    match kind {
        SttKind::Local => "Local",
        SttKind::OpenaiCompatible => "OpenAI-compatible API",
        SttKind::Xai => "xAI",
        SttKind::Muse => "Meta Muse",
        SttKind::Deepgram => "Deepgram",
        SttKind::Elevenlabs => "ElevenLabs",
        SttKind::Assemblyai => "AssemblyAI",
    }
}

fn samples_to_ms(samples: usize) -> i64 {
    samples as i64 * 1000 / SAMPLE_RATE as i64
}

/// Per-request context shared by the provider implementations.
struct Ctx<'a> {
    http: &'a Client,
    p: &'a SttProfile,
    o: &'a SttOptions,
}

impl Ctx<'_> {
    fn base(&self) -> String {
        match self.p.base_url.trim().trim_end_matches('/') {
            "" => default_base_url(self.p.kind).to_string(),
            b => b.to_string(),
        }
    }

    fn model(&self) -> String {
        match self.p.model.trim() {
            "" => default_model(self.p.kind).to_string(),
            m => m.to_string(),
        }
    }

    /// Explicit language code, or None for auto-detect.
    fn language(&self) -> Option<String> {
        let l = self.o.language.as_deref()?.trim().to_lowercase();
        (!l.is_empty() && l != "auto").then_some(l)
    }

    fn vocabulary(&self) -> Vec<String> {
        self.o.vocabulary.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
    }

    async fn transcribe_chunk(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        match self.p.kind {
            SttKind::Local => bail!("local models are not handled by the cloud transcriber"),
            SttKind::OpenaiCompatible => self.openai(wav, dur_ms).await,
            SttKind::Xai => self.xai(wav, dur_ms).await,
            SttKind::Muse => self.muse(wav, dur_ms).await,
            SttKind::Deepgram => self.deepgram(wav, dur_ms).await,
            SttKind::Elevenlabs => self.elevenlabs(wav, dur_ms).await,
            SttKind::Assemblyai => self.assemblyai(wav, dur_ms).await,
        }
    }
}

fn wav_part(wav: Vec<u8>) -> Part {
    Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav").expect("static mime type is valid")
}

/// Send a request, returning parsed JSON or an error with status + provider message.
async fn send(req: RequestBuilder, what: &str) -> Result<Value> {
    let resp = req.send().await.map_err(|e| anyhow!("{what}: request failed: {:#}", anyhow::Error::from(e)))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| anyhow!("{what}: failed to read response: {e}"))?;
    if !status.is_success() {
        bail!("{what} returned {status}: {}", truncate(&error_message(&body), 400));
    }
    serde_json::from_str(&body)
        .map_err(|e| anyhow!("{what}: unexpected response ({e}): {}", truncate(&body, 200)))
}

/// Extract a human-readable message from the various provider error shapes.
fn error_message(body: &str) -> String {
    fn find(v: &Value) -> Option<String> {
        match v {
            Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
            Value::Object(m) => ["message", "err_msg", "error", "detail", "msg"].iter().find_map(|k| m.get(*k).and_then(find)),
            Value::Array(a) => a.iter().find_map(find),
            _ => None,
        }
    }
    serde_json::from_str::<Value>(body).ok().and_then(|v| find(&v)).unwrap_or_else(|| body.trim().to_string())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max).collect::<String>()) }
}

/// Keep the last `max` characters (Whisper only looks at the tail of a prompt).
fn tail_chars(s: &str, max: usize) -> String {
    let n = s.chars().count();
    s.chars().skip(n.saturating_sub(max)).collect()
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn jstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

fn jf(v: &Value, key: &str) -> Option<f64> {
    v.get(key)?.as_f64()
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn secs_ms(secs: f64) -> i64 {
    (secs * 1000.0).round() as i64
}

/// Seconds-based `start`/`end` pair of a JSON object, in ms.
fn span_secs(v: &Value) -> (i64, i64) {
    (secs_ms(jf(v, "start").unwrap_or(0.0)), secs_ms(jf(v, "end").unwrap_or(0.0)))
}

/// Millisecond-based `start`/`end` pair of a JSON object.
fn span_ms(v: &Value) -> (i64, i64) {
    (jf(v, "start").unwrap_or(0.0).round() as i64, jf(v, "end").unwrap_or(0.0).round() as i64)
}

/// Raw speaker label from `speaker` / `speaker_id` / `speaker_label`, normalised.
fn speaker_of(v: &Value) -> Option<String> {
    ["speaker", "speaker_id", "speaker_label"]
        .iter()
        .find_map(|k| match v.get(*k)? {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .and_then(|s| speaker_name(&s))
}

/// Map provider speaker labels to "Speaker N": letters (`A` -> 1) and trailing
/// 0-based indices (`0`, `speaker_0` -> 1). Other labels are kept verbatim.
fn speaker_name(raw: &str) -> Option<String> {
    let r = raw.trim();
    if r.is_empty() || r.eq_ignore_ascii_case("unknown") || r.eq_ignore_ascii_case("null") {
        return None;
    }
    let mut chars = r.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphabetic() {
            return Some(format!("Speaker {}", c.to_ascii_uppercase() as u32 - 'A' as u32 + 1));
        }
    }
    let digits = &r[r.trim_end_matches(|c: char| c.is_ascii_digit()).len()..];
    match digits.parse::<u32>() {
        Ok(n) => Some(format!("Speaker {}", n + 1)),
        Err(_) => Some(r.to_string()),
    }
}

/// (ISO 639-1, ISO 639-3, English name) for the languages we normalise.
const LANGS: &[(&str, &str, &str)] = &[
    ("en", "eng", "English"), ("es", "spa", "Spanish"), ("fr", "fra", "French"), ("de", "deu", "German"),
    ("it", "ita", "Italian"), ("pt", "por", "Portuguese"), ("nl", "nld", "Dutch"), ("ru", "rus", "Russian"),
    ("zh", "zho", "Chinese"), ("ja", "jpn", "Japanese"), ("ko", "kor", "Korean"), ("ar", "ara", "Arabic"),
    ("hi", "hin", "Hindi"), ("tr", "tur", "Turkish"), ("pl", "pol", "Polish"), ("uk", "ukr", "Ukrainian"),
    ("sv", "swe", "Swedish"), ("vi", "vie", "Vietnamese"), ("id", "ind", "Indonesian"),
];

/// Normalise "english", "eng", "en_us", "es-MX" … to a bare ISO 639-1 code when known.
fn normalize_language(raw: &str) -> String {
    let l = raw.trim().to_lowercase();
    let base = l.split(['_', '-']).next().unwrap_or("").to_string();
    LANGS
        .iter()
        .find(|(a, b, n)| base == *a || base == *b || base == n.to_lowercase())
        .map_or(base, |t| t.0.to_string())
}

fn language_name(code: &str) -> Option<&'static str> {
    let code = normalize_language(code);
    LANGS.iter().find(|t| t.0 == code).map(|t| t.2)
}

// ---------------------------------------------------------------------------
// Transcript assembly
// ---------------------------------------------------------------------------

/// A word as reported by a provider, before grouping into segments.
struct RawWord {
    text: String,
    start_ms: i64,
    end_ms: i64,
    speaker: Option<String>,
    /// Attach to the previous word without a space (CJK-style tokens).
    glue: bool,
}

impl RawWord {
    fn new(text: &str, start_ms: i64, end_ms: i64, speaker: Option<String>) -> Self {
        Self { text: text.trim().to_string(), start_ms, end_ms, speaker, glue: false }
    }
}

const GAP_MS: i64 = 800;
const SOFT_MS: i64 = 12_000;
const SOFT_WORDS: usize = 30;
const HARD_MS: i64 = 30_000;
const HARD_WORDS: usize = 80;

fn ends_sentence(text: &str) -> bool {
    text.trim_end_matches(['"', '\'', ')', '”', '’']).ends_with(['.', '!', '?', '。', '！', '？', '…'])
}

/// Group words into segments: break on speaker change, on a gap > 0.8 s, on a
/// sentence end once the segment passes ~12 s / ~30 words, or at a hard cap.
fn group_words(words: Vec<RawWord>) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut cur: Option<Segment> = None;
    for w in words.into_iter().filter(|w| !w.text.is_empty()) {
        if let Some(c) = &cur {
            let (dur, n) = (c.end_ms - c.start_ms, c.words.len());
            let soft = (dur >= SOFT_MS || n >= SOFT_WORDS) && ends_sentence(&c.text);
            let hard = dur >= HARD_MS || n >= HARD_WORDS;
            if c.speaker != w.speaker || w.start_ms - c.end_ms > GAP_MS || soft || hard {
                out.extend(cur.take());
            }
        }
        let c = cur.get_or_insert_with(|| Segment {
            start_ms: w.start_ms,
            end_ms: w.end_ms,
            speaker: w.speaker.clone(),
            ..Default::default()
        });
        if !c.text.is_empty() && !w.glue {
            c.text.push(' ');
        }
        c.text.push_str(&w.text);
        c.end_ms = c.end_ms.max(w.end_ms);
        c.words.push(Word { start_ms: w.start_ms, end_ms: w.end_ms, text: w.text });
    }
    out.extend(cur);
    out
}

/// Distribute time-ordered words over existing segments by start time.
fn attach_words(segs: &mut [Segment], words: Vec<RawWord>) {
    let mut i = 0;
    for w in words.into_iter().filter(|w| !w.text.is_empty()) {
        while i + 1 < segs.len() && w.start_ms >= segs[i].end_ms {
            i += 1;
        }
        segs[i].words.push(Word { start_ms: w.start_ms, end_ms: w.end_ms, text: w.text });
    }
}

/// One segment spanning the whole chunk (providers that return only text).
fn single(text: &str, dur_ms: i64) -> Vec<Segment> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    vec![Segment { start_ms: 0, end_ms: dur_ms, text: text.to_string(), ..Default::default() }]
}

/// Build a transcript, preferring the provider's full text over joined segments.
fn finish(text: Option<&str>, language: Option<String>, segments: Vec<Segment>) -> Transcript {
    let mut t = Transcript { text: String::new(), language: language.filter(|l| !l.is_empty()), segments };
    t.text = match text.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.to_string(),
        None => t.text_from_segments(),
    };
    t
}

// ---------------------------------------------------------------------------
// OpenAI-compatible (OpenAI, Groq, Mistral, local servers)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OaiMode {
    /// Whisper-style `verbose_json` with segment + word timestamps.
    Verbose,
    /// `gpt-4o-transcribe-diarize`: `diarized_json`.
    Diarized,
    /// Mistral Voxtral: segment timestamps + `diarize` + `context_bias`.
    Mistral,
    /// Text-only models (gpt-4o-transcribe, gpt-transcribe, …).
    Plain,
}

fn oai_mode(base: &str, model: &str) -> OaiMode {
    let (b, m) = (base.to_lowercase(), model.to_lowercase());
    if b.contains("mistral") {
        OaiMode::Mistral
    } else if m.contains("diarize") {
        OaiMode::Diarized
    } else if m.contains("whisper") || b.contains("groq") {
        OaiMode::Verbose
    } else {
        OaiMode::Plain
    }
}

/// `prompt` field: user prompt plus vocabulary, capped to Whisper's ~224 tokens.
fn oai_prompt(o: &SttOptions, vocab: &[String]) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(p) = o.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        parts.push(p.to_string());
    }
    if !vocab.is_empty() {
        parts.push(format!("Vocabulary: {}", vocab.join(", ")));
    }
    (!parts.is_empty()).then(|| tail_chars(&parts.join(" "), 800))
}

impl Ctx<'_> {
    async fn openai(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        let base = self.base();
        let lb = base.to_lowercase();
        let model = match self.p.model.trim() {
            "" if lb.contains("mistral") => "voxtral-mini-latest".to_string(),
            "" if lb.contains("groq") => "whisper-large-v3-turbo".to_string(),
            _ => self.model(),
        };
        let mode = oai_mode(&base, &model);
        let translate = self.o.translate;
        if translate && mode != OaiMode::Verbose {
            bail!("translation to English requires a Whisper model (got \"{model}\")");
        }
        let vocab = self.vocabulary();
        let mut form = Form::new().text("model", model.clone());
        match mode {
            OaiMode::Verbose => {
                form = form
                    .text("response_format", "verbose_json")
                    .text("timestamp_granularities[]", "segment")
                    .text("timestamp_granularities[]", "word");
            }
            OaiMode::Diarized => {
                form = form.text("response_format", "diarized_json").text("chunking_strategy", "auto");
            }
            OaiMode::Mistral => {
                form = form.text("timestamp_granularities", "segment");
                if self.o.diarize {
                    form = form.text("diarize", "true");
                }
                for term in vocab.iter().take(100) {
                    form = form.text("context_bias", term.clone());
                }
            }
            OaiMode::Plain => form = form.text("response_format", "json"),
        }
        // Mistral rejects `language` with timestamps; gpt-transcribe replaced it with `languages`.
        let send_lang = !translate && mode != OaiMode::Mistral && !model.starts_with("gpt-transcribe");
        if let Some(l) = self.language().filter(|_| send_lang) {
            form = form.text("language", l);
        }
        if matches!(mode, OaiMode::Verbose | OaiMode::Plain) {
            if let Some(p) = oai_prompt(self.o, &vocab) {
                form = form.text("prompt", p);
            }
        }
        let path = if translate { "audio/translations" } else { "audio/transcriptions" };
        let mut req = self.http.post(format!("{base}/{path}")).multipart(form.part("file", wav_part(wav)));
        if !self.p.api_key.trim().is_empty() {
            req = req.bearer_auth(self.p.api_key.trim());
        }
        let v = send(req, provider_name(self.p.kind)).await?;
        Ok(parse_oai(&v, dur_ms))
    }
}

/// Parse `verbose_json`, `diarized_json`, Mistral and plain `json` responses.
fn parse_oai(v: &Value, dur_ms: i64) -> Transcript {
    let mut segments: Vec<Segment> = arr(v, "segments")
        .iter()
        .filter_map(|s| {
            let text = jstr(s, "text")?.trim();
            let (start_ms, end_ms) = span_secs(s);
            (!text.is_empty()).then(|| Segment { start_ms, end_ms, text: text.to_string(), speaker: speaker_of(s), words: vec![] })
        })
        .collect();
    let words: Vec<RawWord> = arr(v, "words")
        .iter()
        .filter_map(|w| {
            let (s, e) = span_secs(w);
            Some(RawWord::new(jstr(w, "word").or_else(|| jstr(w, "text"))?, s, e, None))
        })
        .collect();
    let text = jstr(v, "text");
    if segments.is_empty() {
        segments = if words.is_empty() { single(text.unwrap_or(""), dur_ms) } else { group_words(words) };
    } else {
        attach_words(&mut segments, words);
    }
    let language = jstr(v, "language")
        .or_else(|| arr(v, "languages").first().and_then(|l| jstr(l, "code")))
        .map(normalize_language);
    finish(text, language, segments)
}

// ---------------------------------------------------------------------------
// xAI
// ---------------------------------------------------------------------------

/// Languages for which xAI can apply inverse text normalisation (`format=true`).
const XAI_FORMAT_LANGS: &[&str] = &["ar", "de", "en", "es", "fr", "ja", "pt", "ru", "sv", "vi", "zh"];

impl Ctx<'_> {
    async fn xai(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        let mut form = Form::new();
        // The REST endpoint has no model field today; only forward an explicit override.
        let model = self.p.model.trim();
        if !model.is_empty() && model != default_model(SttKind::Xai) {
            form = form.text("model", model.to_string());
        }
        if let Some(l) = self.language() {
            if XAI_FORMAT_LANGS.contains(&l.as_str()) {
                form = form.text("format", "true");
            }
            form = form.text("language", l);
        }
        if self.o.diarize {
            form = form.text("diarize", "true");
        }
        for term in self.vocabulary().iter().take(100) {
            form = form.text("keyterm", truncate(term, 50));
        }
        // `file` must be the last field.
        form = form.part("file", wav_part(wav));
        let req = self.http.post(format!("{}/stt", self.base())).bearer_auth(self.p.api_key.trim()).multipart(form);
        Ok(parse_xai(&send(req, "xAI").await?, dur_ms))
    }
}

fn parse_xai(v: &Value, dur_ms: i64) -> Transcript {
    let words: Vec<RawWord> = arr(v, "words")
        .iter()
        .filter_map(|w| {
            let (s, e) = span_secs(w);
            Some(RawWord::new(jstr(w, "text")?, s, e, speaker_of(w)))
        })
        .collect();
    let text = jstr(v, "text");
    let segments = if words.is_empty() { single(text.unwrap_or(""), dur_ms) } else { group_words(words) };
    finish(text, jstr(v, "language").map(normalize_language), segments)
}

// ---------------------------------------------------------------------------
// Meta Muse Voice Transcribe
// ---------------------------------------------------------------------------

impl Ctx<'_> {
    async fn muse(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        let mut request = json!({
            "model": self.model(),
            "audioEncoding": "WAV",
            "mode": if self.o.diarize { "DIARIZATION" } else { "ENDPOINTING" },
        });
        let vocab = self.vocabulary();
        if !vocab.is_empty() {
            request["keywords"] = json!(vocab);
        }
        let language = self.language();
        if let Some(name) = language.as_deref().and_then(language_name) {
            request["languageBias"] = json!([name]);
        }
        let form = Form::new()
            .part("request", Part::text(request.to_string()).mime_str("application/json")?)
            .part("audio", Part::bytes(wav).file_name("audio.wav").mime_str("audio/wav")?);
        let req = self
            .http
            .post(format!("{}/asr/transcribe", self.base()))
            .bearer_auth(self.p.api_key.trim())
            .header("Accept", "application/json")
            .multipart(form);
        Ok(parse_muse(&send(req, "Meta Muse").await?, dur_ms, language))
    }
}

/// Parse a Muse `TranscribeResponse` (`transcript`, `audioDurationMs`, `turns[]`
/// with `startMs`/`endMs`/`transcript`/`speaker`), tolerating alternate field names.
fn parse_muse(v: &Value, dur_ms: i64, language: Option<String>) -> Transcript {
    fn time_ms(t: &Value, ms_keys: &[&str], sec_keys: &[&str]) -> i64 {
        ms_keys
            .iter()
            .find_map(|k| jf(t, k))
            .map(|x| x.round() as i64)
            .or_else(|| sec_keys.iter().find_map(|k| jf(t, k)).map(secs_ms))
            .unwrap_or(0)
    }
    let turns = ["turns", "segments", "results"].iter().map(|k| arr(v, k)).find(|a| !a.is_empty()).unwrap_or(&[]);
    let segments: Vec<Segment> = turns
        .iter()
        .filter_map(|t| {
            let text = jstr(t, "transcript").or_else(|| jstr(t, "text"))?.trim();
            (!text.is_empty()).then(|| Segment {
                start_ms: time_ms(t, &["startMs", "start_ms"], &["start", "startTime", "start_time"]),
                end_ms: time_ms(t, &["endMs", "end_ms"], &["end", "endTime", "end_time"]),
                text: text.to_string(),
                speaker: speaker_of(t),
                words: vec![],
            })
        })
        .collect();
    let text = jstr(v, "transcript").or_else(|| jstr(v, "text"));
    let segments = if segments.is_empty() {
        single(text.unwrap_or(""), jf(v, "audioDurationMs").map_or(dur_ms, |d| d.round() as i64))
    } else {
        segments
    };
    finish(text, language, segments)
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

impl Ctx<'_> {
    async fn deepgram(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        let model = self.model();
        let mut q: Vec<(&str, String)> = vec![
            ("model", model.clone()),
            ("smart_format", "true".into()),
            ("punctuate", "true".into()),
            ("utterances", "true".into()),
        ];
        if self.o.diarize {
            q.push(("diarize", "true".into()));
        }
        match self.language() {
            Some(l) => q.push(("language", l)),
            None => q.push(("detect_language", "true".into())),
        }
        // `keyterm` is Nova-3 only; older models use the legacy `keywords`.
        let key = if model.starts_with("nova-3") { "keyterm" } else { "keywords" };
        q.extend(self.vocabulary().into_iter().take(100).map(|t| (key, t)));
        let req = self
            .http
            .post(format!("{}/listen", self.base()))
            .header("Authorization", format!("Token {}", self.p.api_key.trim()))
            .header("Content-Type", "audio/wav")
            .query(&q)
            .body(wav);
        Ok(parse_deepgram(&send(req, "Deepgram").await?, dur_ms))
    }
}

fn parse_deepgram(v: &Value, dur_ms: i64) -> Transcript {
    let alt = v.pointer("/results/channels/0/alternatives/0");
    let language = v.pointer("/results/channels/0/detected_language").and_then(Value::as_str).map(normalize_language);
    let utterances = v.pointer("/results/utterances").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let mut segments: Vec<Segment> = utterances
        .iter()
        .filter_map(|u| {
            let text = jstr(u, "transcript")?.trim();
            let (start_ms, end_ms) = span_secs(u);
            let words = arr(u, "words")
                .iter()
                .filter_map(|w| {
                    let (s, e) = span_secs(w);
                    let t = jstr(w, "punctuated_word").or_else(|| jstr(w, "word"))?;
                    Some(Word { start_ms: s, end_ms: e, text: t.to_string() })
                })
                .collect();
            (!text.is_empty()).then(|| Segment { start_ms, end_ms, text: text.to_string(), speaker: speaker_of(u), words })
        })
        .collect();
    let text = alt.and_then(|a| jstr(a, "transcript"));
    if segments.is_empty() {
        let words: Vec<RawWord> = alt
            .map(|a| arr(a, "words"))
            .unwrap_or(&[])
            .iter()
            .filter_map(|w| {
                let (s, e) = span_secs(w);
                Some(RawWord::new(jstr(w, "punctuated_word").or_else(|| jstr(w, "word"))?, s, e, speaker_of(w)))
            })
            .collect();
        segments = if words.is_empty() { single(text.unwrap_or(""), dur_ms) } else { group_words(words) };
    }
    finish(text, language, segments)
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

/// ElevenLabs keyterms: < 50 chars, <= 5 words, none of `<>{}[]\``.
fn valid_keyterm(t: &str) -> bool {
    t.chars().count() < 50 && t.split_whitespace().count() <= 5 && !t.contains(['<', '>', '{', '}', '[', ']', '`'])
}

impl Ctx<'_> {
    async fn elevenlabs(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        let mut form = Form::new()
            .text("model_id", self.model())
            .text("timestamps_granularity", "word")
            .text("tag_audio_events", "false")
            .text("diarize", self.o.diarize.to_string());
        if let Some(n) = self.o.num_speakers.filter(|_| self.o.diarize) {
            form = form.text("num_speakers", n.clamp(1, 32).to_string());
        }
        if let Some(l) = self.language() {
            form = form.text("language_code", l);
        }
        for term in self.vocabulary().into_iter().filter(|t| valid_keyterm(t)).take(1000) {
            form = form.text("keyterms", term);
        }
        let req = self
            .http
            .post(format!("{}/speech-to-text", self.base()))
            .header("xi-api-key", self.p.api_key.trim())
            .multipart(form.part("file", wav_part(wav)));
        Ok(parse_elevenlabs(&send(req, "ElevenLabs").await?, self.o.diarize, dur_ms))
    }
}

/// Parse a Scribe response: `words[]` of type word/spacing/audio_event (seconds).
fn parse_elevenlabs(v: &Value, diarize: bool, dur_ms: i64) -> Transcript {
    let items = arr(v, "words");
    // Without spacing tokens (e.g. CJK) words are glued; if none exist at all, fall back to spaces.
    let has_spacing = items.iter().any(|w| jstr(w, "type") == Some("spacing"));
    let mut words = Vec::new();
    let mut space_before = true;
    for w in items {
        match jstr(w, "type").unwrap_or("word") {
            "spacing" => space_before = true,
            "word" => {
                let Some(text) = jstr(w, "text") else { continue };
                let (s, e) = span_secs(w);
                let mut rw = RawWord::new(text, s, e, if diarize { speaker_of(w) } else { None });
                rw.glue = has_spacing && !space_before;
                words.push(rw);
                space_before = false;
            }
            _ => {}
        }
    }
    let text = jstr(v, "text");
    let segments = if words.is_empty() { single(text.unwrap_or(""), dur_ms) } else { group_words(words) };
    finish(text, jstr(v, "language_code").map(normalize_language), segments)
}

// ---------------------------------------------------------------------------
// AssemblyAI
// ---------------------------------------------------------------------------

const ASSEMBLY_POLL: Duration = Duration::from_secs(2);
const ASSEMBLY_TIMEOUT: Duration = Duration::from_secs(30 * 60);

impl Ctx<'_> {
    async fn assemblyai(&self, wav: Vec<u8>, dur_ms: i64) -> Result<Transcript> {
        let base = self.base();
        let key = self.p.api_key.trim();
        let uploaded = send(
            self.http.post(format!("{base}/upload")).header("authorization", key).header("Content-Type", "application/octet-stream").body(wav),
            "AssemblyAI upload",
        )
        .await?;
        let audio_url = jstr(&uploaded, "upload_url").ok_or_else(|| anyhow!("AssemblyAI upload returned no upload_url"))?;

        // Default (or the default model named explicitly) keeps the documented fallback chain.
        let custom_model = self.p.model.trim();
        let use_default = custom_model.is_empty() || custom_model == default_model(SttKind::Assemblyai);
        let models = if use_default { json!([default_model(SttKind::Assemblyai), "universal-2"]) } else { json!([custom_model]) };
        let mut body = json!({ "audio_url": audio_url, "speech_models": models });
        match self.language() {
            Some(l) => body["language_code"] = json!(l),
            None => body["language_detection"] = json!(true),
        }
        if self.o.diarize {
            body["speaker_labels"] = json!(true);
            if let Some(n) = self.o.num_speakers {
                body["speakers_expected"] = json!(n.max(1));
            }
        }
        let vocab: Vec<String> = self.vocabulary().into_iter().take(200).collect();
        if !vocab.is_empty() {
            body["keyterms_prompt"] = json!(vocab);
        } else if let Some(p) = self.o.prompt.as_deref().map(str::trim).filter(|p| !p.is_empty() && use_default) {
            body["prompt"] = json!(p); // Universal-3.5 Pro only
        }

        let created = send(self.http.post(format!("{base}/transcript")).header("authorization", key).json(&body), "AssemblyAI").await?;
        let id = jstr(&created, "id").ok_or_else(|| anyhow!("AssemblyAI returned no transcript id"))?.to_string();
        let started = Instant::now();
        loop {
            tokio::time::sleep(ASSEMBLY_POLL).await;
            let v = send(self.http.get(format!("{base}/transcript/{id}")).header("authorization", key), "AssemblyAI").await?;
            match jstr(&v, "status") {
                Some("completed") => return Ok(parse_assembly(&v, dur_ms)),
                Some("error") => {
                    let msg = jstr(&v, "error").unwrap_or("unknown error");
                    // A silent chunk is not a failure.
                    if msg.contains("no spoken audio") {
                        return Ok(Transcript::default());
                    }
                    bail!("AssemblyAI transcription failed: {}", truncate(msg, 400));
                }
                _ if started.elapsed() > ASSEMBLY_TIMEOUT => bail!("AssemblyAI transcription timed out after 30 minutes"),
                _ => {}
            }
        }
    }
}

/// Parse an AssemblyAI transcript (millisecond timestamps, speaker letters).
fn parse_assembly(v: &Value, dur_ms: i64) -> Transcript {
    let mut segments: Vec<Segment> = arr(v, "utterances")
        .iter()
        .filter_map(|u| {
            let text = jstr(u, "text")?.trim();
            let (start_ms, end_ms) = span_ms(u);
            let words = arr(u, "words")
                .iter()
                .filter_map(|w| {
                    let (s, e) = span_ms(w);
                    Some(Word { start_ms: s, end_ms: e, text: jstr(w, "text")?.trim().to_string() })
                })
                .collect();
            (!text.is_empty()).then(|| Segment { start_ms, end_ms, text: text.to_string(), speaker: speaker_of(u), words })
        })
        .collect();
    let text = jstr(v, "text");
    if segments.is_empty() {
        let words: Vec<RawWord> = arr(v, "words")
            .iter()
            .filter_map(|w| {
                let (s, e) = span_ms(w);
                Some(RawWord::new(jstr(w, "text")?, s, e, speaker_of(w)))
            })
            .collect();
        segments = if words.is_empty() { single(text.unwrap_or(""), dur_ms) } else { group_words(words) };
    }
    finish(text, jstr(v, "language_code").map(normalize_language), segments)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn rw(t: &str, s: i64, e: i64, spk: Option<&str>) -> RawWord {
        RawWord::new(t, s, e, spk.map(String::from))
    }

    #[test]
    fn speaker_labels_are_normalised() {
        assert_eq!(speaker_name("A").as_deref(), Some("Speaker 1"));
        assert_eq!(speaker_name("c").as_deref(), Some("Speaker 3"));
        assert_eq!(speaker_name("0").as_deref(), Some("Speaker 1"));
        assert_eq!(speaker_name("speaker_1").as_deref(), Some("Speaker 2"));
        assert_eq!(speaker_name("unknown"), None);
        assert_eq!(speaker_name("agent").as_deref(), Some("agent"));
        assert_eq!(speaker_of(&json!({ "speaker": 2 })).as_deref(), Some("Speaker 3"));
        assert_eq!(speaker_of(&json!({ "speaker": null })), None);
    }

    #[test]
    fn languages_are_normalised() {
        assert_eq!(normalize_language("english"), "en");
        assert_eq!(normalize_language("eng"), "en");
        assert_eq!(normalize_language("en_us"), "en");
        assert_eq!(normalize_language("es-MX"), "es");
        assert_eq!(normalize_language("xx"), "xx");
        assert_eq!(language_name("fr"), Some("French"));
    }

    #[test]
    fn groups_words_on_gap_and_speaker() {
        let segs = group_words(vec![
            rw("Hello", 0, 400, Some("Speaker 1")),
            rw("there.", 450, 900, Some("Speaker 1")),
            rw("Hi", 950, 1200, Some("Speaker 2")), // speaker change
            rw("again", 3000, 3400, Some("Speaker 2")), // gap > 0.8 s
        ]);
        let texts: Vec<_> = segs.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, ["Hello there.", "Hi", "again"]);
        assert_eq!(segs[0].start_ms, 0);
        assert_eq!(segs[0].end_ms, 900);
        assert_eq!(segs[0].words.len(), 2);
        assert_eq!(segs[1].speaker.as_deref(), Some("Speaker 2"));
    }

    #[test]
    fn long_segments_break_only_at_sentence_end() {
        // 40 words, 0.3 s each, contiguous; a period after word 35.
        let words: Vec<_> = (0..40)
            .map(|i| rw(if i == 34 { "end." } else { "word" }, i * 300, i * 300 + 280, None))
            .collect();
        let segs = group_words(words);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].words.len(), 35);
        assert!(segs[0].text.ends_with("end."));
    }

    #[test]
    fn glued_words_have_no_spaces() {
        let mut a = rw("你", 0, 100, None);
        a.glue = true;
        let mut b = rw("好", 100, 200, None);
        b.glue = true;
        assert_eq!(group_words(vec![a, b])[0].text, "你好");
    }

    #[test]
    fn error_messages_are_extracted_and_truncated() {
        assert_eq!(error_message(r#"{"error":{"message":"bad key","type":"auth"}}"#), "bad key");
        assert_eq!(error_message(r#"{"err_code":"X","err_msg":"nope"}"#), "nope");
        assert_eq!(error_message(r#"{"detail":{"status":"invalid","message":"quota"}}"#), "quota");
        assert_eq!(error_message(r#"{"error":"plain"}"#), "plain");
        assert_eq!(error_message("gateway timeout"), "gateway timeout");
        assert_eq!(truncate(&"x".repeat(500), 400).chars().count(), 401);
    }

    #[test]
    fn selects_openai_mode() {
        let openai = "https://api.openai.com/v1";
        assert_eq!(oai_mode(openai, "whisper-1"), OaiMode::Verbose);
        assert_eq!(oai_mode("https://api.groq.com/openai/v1", "whisper-large-v3-turbo"), OaiMode::Verbose);
        assert_eq!(oai_mode(openai, "gpt-4o-transcribe-diarize"), OaiMode::Diarized);
        assert_eq!(oai_mode(openai, "gpt-4o-transcribe"), OaiMode::Plain);
        assert_eq!(oai_mode("https://api.mistral.ai/v1", "voxtral-mini-latest"), OaiMode::Mistral);
        assert_eq!(oai_mode("http://localhost:8080/v1", "ggml-large-v3"), OaiMode::Plain);
    }

    #[test]
    fn builds_prompt_with_vocabulary() {
        let o = SttOptions { prompt: Some("Meeting about Rust.".into()), ..Default::default() };
        let vocab = vec!["Tauri".to_string(), "Hush".to_string()];
        assert_eq!(oai_prompt(&o, &vocab).as_deref(), Some("Meeting about Rust. Vocabulary: Tauri, Hush"));
        assert_eq!(oai_prompt(&SttOptions::default(), &[]), None);
    }

    #[test]
    fn parses_openai_verbose_json() {
        let v = json!({
            "language": "english", "duration": 5.0, "text": "Hello world. Bye.",
            "segments": [
                {"id": 0, "start": 0.0, "end": 2.0, "text": " Hello world."},
                {"id": 1, "start": 2.5, "end": 3.5, "text": " Bye."}
            ],
            "words": [
                {"word": "Hello", "start": 0.0, "end": 0.5},
                {"word": "world", "start": 0.6, "end": 1.2},
                {"word": "Bye", "start": 2.5, "end": 3.0}
            ]
        });
        let t = parse_oai(&v, 5000);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].text, "Hello world.");
        assert_eq!(t.segments[0].words.len(), 2);
        assert_eq!(t.segments[1].words[0].start_ms, 2500);
        assert_eq!(t.text, "Hello world. Bye.");
    }

    #[test]
    fn parses_openai_diarized_and_mistral() {
        let v = json!({
            "task": "transcribe", "duration": 4.0, "text": "A: hi B: yo",
            "segments": [
                {"id": "s1", "start": 0.0, "end": 1.0, "text": "hi", "speaker": "A", "type": "transcript.text.segment"},
                {"id": "s2", "start": 1.2, "end": 2.0, "text": "yo", "speaker": "B", "type": "transcript.text.segment"}
            ]
        });
        let t = parse_oai(&v, 4000);
        assert_eq!(t.segments[0].speaker.as_deref(), Some("Speaker 1"));
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));

        let m = json!({"text": "bonjour", "language": "fr", "segments": [{"start": 0.0, "end": 1.0, "text": "bonjour", "speaker_id": "speaker_0"}]});
        let t = parse_oai(&m, 1000);
        assert_eq!(t.segments[0].speaker.as_deref(), Some("Speaker 1"));
        assert_eq!(t.language.as_deref(), Some("fr"));
    }

    #[test]
    fn parses_openai_plain_json_as_single_segment() {
        let t = parse_oai(&json!({"text": " Just text. ", "languages": [{"code": "de"}]}), 7000);
        assert_eq!(t.text, "Just text.");
        assert_eq!(t.language.as_deref(), Some("de"));
        assert_eq!((t.segments[0].start_ms, t.segments[0].end_ms), (0, 7000));
        assert!(parse_oai(&json!({"text": ""}), 1000).segments.is_empty());
    }

    #[test]
    fn parses_xai_words_with_speakers() {
        let v = json!({
            "text": "Hello there. Hi.", "language": "en", "duration": 3.0,
            "words": [
                {"text": "Hello", "start": 0.0, "end": 0.4, "confidence": 0.9, "speaker": 0},
                {"text": "there.", "start": 0.5, "end": 0.9, "speaker": 0},
                {"text": "Hi.", "start": 1.2, "end": 1.5, "speaker": 1}
            ]
        });
        let t = parse_xai(&v, 3000);
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].text, "Hello there.");
        assert_eq!(t.segments[0].speaker.as_deref(), Some("Speaker 1"));
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(t.segments[1].start_ms, 1200);
    }

    #[test]
    fn parses_muse_turns() {
        let v = json!({
            "sessionId": "s", "transcript": "Hello. Hi there.", "audioDurationMs": 4000,
            "turns": [
                {"turnId": 0, "startMs": 100, "endMs": 1500, "transcript": "Hello.", "speaker": "A"},
                {"turnId": 1, "startMs": 1800, "endMs": 3900, "transcript": "Hi there.", "speaker": "B"},
                {"turnId": 2, "startMs": 3950, "endMs": 4000, "transcript": ""}
            ]
        });
        let t = parse_muse(&v, 4000, Some("en".into()));
        assert_eq!(t.segments.len(), 2);
        assert_eq!((t.segments[1].start_ms, t.segments[1].end_ms), (1800, 3900));
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(t.language.as_deref(), Some("en"));
        // Tolerant: seconds-based names, no turns at all.
        let alt = json!({"segments": [{"start": 1.5, "end": 2.5, "text": "x", "speaker": "unknown"}]});
        let t = parse_muse(&alt, 3000, None);
        assert_eq!((t.segments[0].start_ms, t.segments[0].end_ms), (1500, 2500));
        assert_eq!(t.segments[0].speaker, None);
        let t = parse_muse(&json!({"transcript": "only text", "turns": []}), 2000, None);
        assert_eq!((t.segments[0].start_ms, t.segments[0].end_ms), (0, 2000));
    }

    #[test]
    fn parses_deepgram_utterances() {
        let v = json!({"results": {
            "channels": [{"detected_language": "en", "alternatives": [{"transcript": "hello there hi", "words": []}]}],
            "utterances": [
                {"start": 0.1, "end": 1.0, "transcript": "Hello there.", "speaker": 0, "words": [
                    {"word": "hello", "punctuated_word": "Hello", "start": 0.1, "end": 0.5, "speaker": 0},
                    {"word": "there", "punctuated_word": "there.", "start": 0.5, "end": 1.0, "speaker": 0}]},
                {"start": 1.5, "end": 2.0, "transcript": "Hi.", "speaker": 1, "words": []}
            ]}});
        let t = parse_deepgram(&v, 2000);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].words[1].text, "there.");
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));
        assert_eq!(t.text, "hello there hi");
    }

    #[test]
    fn parses_deepgram_words_without_utterances() {
        let v = json!({"results": {"channels": [{"alternatives": [{"transcript": "hello there", "words": [
            {"word": "hello", "start": 0.0, "end": 0.4, "speaker": 0},
            {"word": "there", "start": 0.4, "end": 0.8, "speaker": 0}]}]}]}});
        let t = parse_deepgram(&v, 1000);
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].text, "hello there");
        assert_eq!(t.language, None);
        assert!(parse_deepgram(&json!({"results": {"channels": [{"alternatives": [{"transcript": ""}]}]}}), 1000).segments.is_empty());
    }

    #[test]
    fn parses_elevenlabs_words_and_spacing() {
        let v = json!({"language_code": "eng", "text": "Hello world. Hi", "words": [
            {"text": "Hello", "type": "word", "start": 0.0, "end": 0.4, "speaker_id": "speaker_0"},
            {"text": " ", "type": "spacing", "start": 0.4, "end": 0.5, "speaker_id": "speaker_0"},
            {"text": "world.", "type": "word", "start": 0.5, "end": 0.9, "speaker_id": "speaker_0"},
            {"text": "(laughter)", "type": "audio_event", "start": 0.9, "end": 1.1},
            {"text": " ", "type": "spacing", "start": 1.1, "end": 1.2},
            {"text": "Hi", "type": "word", "start": 1.3, "end": 1.5, "speaker_id": "speaker_1"}
        ]});
        let t = parse_elevenlabs(&v, true, 2000);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 2);
        assert_eq!(t.segments[0].text, "Hello world.");
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));
        // Without diarization, speakers are dropped and words merge across the speaker change.
        let t = parse_elevenlabs(&v, false, 2000);
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].speaker, None);
        assert!(valid_keyterm("Tauri") && !valid_keyterm("a<b") && !valid_keyterm("one two three four five six"));
    }

    #[test]
    fn parses_assemblyai_utterances_and_words() {
        let v = json!({"status": "completed", "text": "Hello. Hi.", "language_code": "en_us",
            "utterances": [
                {"start": 250, "end": 900, "text": "Hello.", "speaker": "A", "words": [{"text": "Hello.", "start": 250, "end": 900, "speaker": "A"}]},
                {"start": 1200, "end": 1500, "text": "Hi.", "speaker": "B", "words": []}
            ]});
        let t = parse_assembly(&v, 2000);
        assert_eq!(t.language.as_deref(), Some("en"));
        assert_eq!(t.segments.len(), 2);
        assert_eq!((t.segments[0].start_ms, t.segments[0].end_ms), (250, 900));
        assert_eq!(t.segments[0].words[0].text, "Hello.");
        assert_eq!(t.segments[1].speaker.as_deref(), Some("Speaker 2"));

        let w = json!({"text": "one two", "utterances": null, "words": [
            {"text": "one", "start": 0, "end": 300, "speaker": null},
            {"text": "two", "start": 350, "end": 700, "speaker": null}]});
        let t = parse_assembly(&w, 1000);
        assert_eq!(t.segments.len(), 1);
        assert_eq!(t.segments[0].text, "one two");
        assert_eq!(t.segments[0].speaker, None);
    }

    #[test]
    fn defaults_exist_for_cloud_kinds() {
        for k in [SttKind::OpenaiCompatible, SttKind::Xai, SttKind::Muse, SttKind::Deepgram, SttKind::Elevenlabs, SttKind::Assemblyai] {
            assert!(!default_model(k).is_empty() && default_base_url(k).starts_with("https://"));
            assert!(max_chunk_secs(k) <= 30 * 60);
        }
        assert!(max_chunk_secs(SttKind::Muse) < 600);
    }
}
