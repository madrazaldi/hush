//! Speech-to-text: shared transcript types, provider profiles and dispatch.

pub mod cloud;
pub mod local;
pub mod models;

use anyhow::Result;
use serde::{Deserialize, Serialize};

pub const SAMPLE_RATE: u32 = 16_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Word {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    /// Speaker label ("Me", "Them", "Speaker 1", …) when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
    pub segments: Vec<Segment>,
}

impl Transcript {
    /// Shift all timestamps by `offset_ms` (used when stitching chunks).
    pub fn offset(mut self, offset_ms: i64) -> Self {
        for s in &mut self.segments {
            s.start_ms += offset_ms;
            s.end_ms += offset_ms;
            for w in &mut s.words {
                w.start_ms += offset_ms;
                w.end_ms += offset_ms;
            }
        }
        self
    }

    /// Append another (already offset) transcript.
    pub fn extend(&mut self, other: Transcript) {
        let t = other.text.trim();
        if !t.is_empty() {
            if !self.text.is_empty() {
                self.text.push(' ');
            }
            self.text.push_str(t);
        }
        if self.language.is_none() {
            self.language = other.language;
        }
        self.segments.extend(other.segments);
    }

    /// Rebuild plain text from segments.
    pub fn text_from_segments(&self) -> String {
        self.segments.iter().map(|s| s.text.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }
}

/// Group word timings into readable segments: break on a long pause, or at
/// sentence end once the segment is long enough, or when it gets too long.
pub fn group_words(words: &[Word], speaker: Option<&str>) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    let mut cur: Vec<Word> = Vec::new();
    let flush = |cur: &mut Vec<Word>, out: &mut Vec<Segment>| {
        if cur.is_empty() {
            return;
        }
        let text = join_words(cur);
        out.push(Segment {
            start_ms: cur[0].start_ms,
            end_ms: cur[cur.len() - 1].end_ms,
            text,
            speaker: speaker.map(str::to_string),
            words: std::mem::take(cur),
        });
    };
    for w in words {
        if let Some(last) = cur.last() {
            let gap = w.start_ms - last.end_ms;
            let dur = last.end_ms - cur[0].start_ms;
            let ends_sentence = last.text.trim_end().ends_with(['.', '?', '!', '。', '？', '！']);
            if gap > 800 || (ends_sentence && (dur > 6_000 || cur.len() > 18)) || dur > 20_000 {
                flush(&mut cur, &mut out);
            }
        }
        cur.push(w.clone());
    }
    flush(&mut cur, &mut out);
    out
}

/// Join word tokens, respecting tokens that carry their own leading space.
pub fn join_words(words: &[Word]) -> String {
    let explicit_spaces = words.iter().skip(1).any(|w| w.text.starts_with(' '));
    let s = if explicit_spaces {
        words.iter().map(|w| w.text.as_str()).collect::<String>()
    } else {
        words.iter().map(|w| w.text.trim()).collect::<Vec<_>>().join(" ")
    };
    s.trim().to_string()
}

#[derive(Debug, Clone, Default)]
pub struct SttOptions {
    /// ISO-639-1 code, or None for auto-detect.
    pub language: Option<String>,
    /// Custom vocabulary / key terms to bias recognition.
    pub vocabulary: Vec<String>,
    /// Free-form context prompt (supported by Whisper-family models).
    pub prompt: Option<String>,
    /// Request speaker diarization when the provider supports it.
    pub diarize: bool,
    /// Expected number of speakers (hint), if known.
    pub num_speakers: Option<u32>,
    /// Translate to English (Whisper-family only).
    pub translate: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SttKind {
    /// On-device via transcribe-cpp; `model` is a catalog model id.
    Local,
    /// Any OpenAI `/audio/transcriptions`-compatible API (OpenAI, Groq, Mistral, local servers).
    OpenaiCompatible,
    /// xAI Grok speech-to-text.
    Xai,
    /// Meta Muse Voice Transcribe.
    Muse,
    Deepgram,
    Elevenlabs,
    Assemblyai,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SttProfile {
    pub id: String,
    pub name: String,
    pub kind: SttKind,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

/// Transcribe 16 kHz mono f32 PCM with the given profile.
///
/// Long audio is split at silences into provider-appropriate chunks and
/// stitched back together with corrected timestamps. `progress` receives 0..1.
pub async fn transcribe(
    profile: &SttProfile,
    pcm: &[f32],
    opts: &SttOptions,
    progress: &(dyn Fn(f32) + Send + Sync),
) -> Result<Transcript> {
    match profile.kind {
        SttKind::Local => local::transcribe(&profile.model, pcm, opts, progress).await,
        _ => cloud::transcribe(profile, pcm, opts, progress).await,
    }
}
