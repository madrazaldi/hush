//! File & link transcription: a sequential job queue plus exporters.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, anyhow};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::db::{self, Recording};
use crate::state;
use crate::stt::{self, SAMPLE_RATE, Segment, SttOptions};
use crate::{ai, audio, llm};

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub id: String,
    pub status: String,
    /// decoding | downloading | transcribing | summarizing
    pub stage: String,
    pub progress: f64,
    pub error: Option<String>,
}

pub struct FileQueue {
    tx: mpsc::UnboundedSender<String>,
    rx: Mutex<Option<mpsc::UnboundedReceiver<String>>>,
    /// One (generation, token) per queued or running job, created at enqueue
    /// time so queued jobs can be cancelled too.
    cancels: Mutex<HashMap<String, (u64, CancellationToken)>>,
    running: Mutex<Option<(String, CancellationToken)>>,
    generation: std::sync::atomic::AtomicU64,
}

impl Default for FileQueue {
    fn default() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            tx,
            rx: Mutex::new(Some(rx)),
            cancels: Mutex::new(HashMap::new()),
            running: Mutex::new(None),
            generation: Default::default(),
        }
    }
}

fn emit(id: &str, status: &str, stage: &str, progress: f64, error: Option<String>) {
    state::get().emit(
        "recording:progress",
        Progress { id: id.into(), status: status.into(), stage: stage.into(), progress, error },
    );
}

impl FileQueue {
    /// Spawn the worker. Call once after AppState is initialized.
    pub fn start(&self) {
        let Some(mut rx) = self.rx.lock().take() else { return };
        tauri::async_runtime::spawn(async move {
            while let Some(id) = rx.recv().await {
                let files = &state::get().files;
                // Jobs cancelled (or already run) while queued have no live token.
                let Some((generation, token)) =
                    files.cancels.lock().get(&id).cloned().filter(|(_, t)| !t.is_cancelled())
                else {
                    continue;
                };
                *files.running.lock() = Some((id.clone(), token.clone()));
                let res = tokio::select! {
                    r = run_job(&id) => r,
                    _ = token.cancelled() => Err(anyhow!("Cancelled")),
                };
                *files.running.lock() = None;
                {
                    // Only forget our own entry: the job may have been re-queued meanwhile.
                    let mut cancels = files.cancels.lock();
                    if cancels.get(&id).is_some_and(|(g, _)| *g == generation) {
                        cancels.remove(&id);
                    }
                }
                if let Err(e) = res {
                    let msg = format!("{e:#}");
                    log::error!("file job {id}: {msg}");
                    let _ = state::get().db.set_status(&id, "error", 0.0, Some(&msg));
                    emit(&id, "error", "", 0.0, Some(msg));
                }
            }
        });
    }

    pub fn enqueue(&self, id: &str) {
        let _ = state::get().db.set_status(id, "queued", 0.0, None);
        emit(id, "queued", "", 0.0, None);
        let generation = self.generation.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.cancels.lock().insert(id.to_string(), (generation, CancellationToken::new()));
        let _ = self.tx.send(id.to_string());
    }

    pub fn cancel(&self, id: &str) {
        let queued = self.cancels.lock().remove(id);
        if let Some((_, t)) = &queued {
            t.cancel();
        }
        // A running job reports its own cancellation; a queued one never will.
        let running = self.running.lock().as_ref().filter(|(r, _)| r == id).map(|(_, t)| t.clone());
        if let Some(t) = running {
            t.cancel();
        } else if queued.is_some() {
            let _ = state::get().db.set_status(id, "error", 0.0, Some("Cancelled"));
            emit(id, "error", "", 0.0, Some("Cancelled".into()));
        }
    }

    /// Create a recording row for a local file and queue it.
    pub fn add_file(&self, path: &Path) -> Result<Recording> {
        if !path.is_file() {
            return Err(anyhow!("{} is not a file", path.display()));
        }
        let title = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Untitled".into());
        let rec = new_recording(title, path.to_string_lossy().into_owned(), Some(path.to_string_lossy().into_owned()));
        state::get().db.upsert_recording(&rec)?;
        self.enqueue(&rec.id);
        Ok(rec)
    }

    pub fn add_url(&self, url: &str) -> Result<Recording> {
        let url = url.trim();
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(anyhow!("Enter a full http(s) link"));
        }
        let rec = new_recording(url.to_string(), url.to_string(), None);
        state::get().db.upsert_recording(&rec)?;
        self.enqueue(&rec.id);
        Ok(rec)
    }
}

fn new_recording(title: String, source: String, media_path: Option<String>) -> Recording {
    let s = state::get().settings();
    Recording {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "file".into(),
        title,
        created_at: db::now_ms(),
        status: "queued".into(),
        source: Some(source),
        media_path,
        stt: Some(s.files.stt_profile.clone()),
        ..Default::default()
    }
}

struct SetOnDrop(Arc<AtomicBool>);

impl Drop for SetOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn run_job(id: &str) -> Result<()> {
    let st = state::get();
    let s = st.settings();
    let mut rec = st.db.get_recording(id)?.ok_or_else(|| anyhow!("recording vanished"))?;

    // 1. Fetch remote media.
    if rec.media_path.is_none() {
        let url = rec.source.clone().unwrap_or_default();
        st.db.set_status(id, "processing", 0.0, None)?;
        emit(id, "processing", "downloading", 0.0, None);
        let dl = audio::decode::download_url(&url, &crate::paths::media_dir()).await?;
        rec = st
            .db
            .update_recording(id, |r| {
                r.media_path = Some(dl.path.to_string_lossy().into_owned());
                r.title = dl.title.clone();
            })?
            .ok_or_else(|| anyhow!("recording vanished"))?;
        st.emit("recording:updated", id);
    }

    let profile_id = rec.stt.clone().unwrap_or_else(|| s.files.stt_profile.clone());
    let profile = s.stt(&profile_id);
    let opts = SttOptions {
        language: rec.language.clone().or(s.files.language.clone()),
        vocabulary: s.vocabulary.clone(),
        diarize: s.files.diarize,
        ..Default::default()
    };
    let id_owned = id.to_string();
    let last = Mutex::new(0.0f32);
    let progress = |p: f32| {
        let mut l = last.lock();
        if p - *l >= 0.01 || p >= 1.0 {
            *l = p;
            let _ = state::get().db.set_status(&id_owned, "processing", p as f64, None);
            emit(&id_owned, "processing", "transcribing", p as f64, None);
        }
    };
    let media = PathBuf::from(rec.media_path.clone().unwrap_or_default());

    let (transcript, duration_ms) = if rec.kind == "meeting" {
        // Meeting audio keeps mic and system audio on separate channels.
        st.db.set_status(id, "processing", 0.0, None)?;
        emit(id, "processing", "transcribing", 0.0, None);
        (crate::meetings::transcribe_audio(&media, &profile, &opts, &progress).await?, rec.duration_ms)
    } else {
        // 2. Decode.
        st.db.set_status(id, "processing", 0.0, None)?;
        emit(id, "processing", "decoding", 0.0, None);
        // Dropping this future (job cancelled) sets the flag, which stops the decoder.
        let cancel = Arc::new(AtomicBool::new(false));
        let _stop_decode = SetOnDrop(cancel.clone());
        let pcm = tokio::task::spawn_blocking(move || audio::decode::decode_file(&media, &cancel)).await??;
        if pcm.is_empty() {
            return Err(anyhow!("No audio found in this file"));
        }
        let duration_ms = pcm.len() as i64 * 1000 / SAMPLE_RATE as i64;

        // 3. Transcribe.
        emit(id, "processing", "transcribing", 0.0, None);
        (stt::transcribe(&profile, &pcm, &opts, &progress).await?, duration_ms)
    };

    let mut segments = transcript.segments;
    if segments.is_empty() && !transcript.text.is_empty() {
        segments.push(Segment {
            start_ms: 0,
            end_ms: duration_ms,
            text: transcript.text.clone(),
            ..Default::default()
        });
    }
    st.db.update_recording(id, |r| {
        r.segments = segments.clone();
        r.duration_ms = duration_ms;
        r.language = transcript.language.clone().or(r.language.clone());
        r.status = "ready".into();
        r.progress = 1.0;
        r.error = None;
        r.stt = Some(profile.id.clone());
    })?;
    emit(id, "ready", "", 1.0, None);

    // 4. Optional summary.
    if s.files.auto_summarize
        && !segments.is_empty()
        && let Some(llm_profile) = s.llm(&s.files.llm_profile)
    {
        emit(id, "ready", "summarizing", 1.0, None);
        let req = ai::summary_request(&rec.title, &segments);
        match llm::complete_text(&llm_profile, &req).await {
            Ok(summary) => {
                st.db.update_recording(id, |r| r.summary = summary)?;
            }
            Err(e) => log::warn!("auto-summary failed: {e:#}"),
        }
        emit(id, "ready", "", 1.0, None);
    }
    st.emit("recording:updated", id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Export

fn ts(ms: i64, sep: char) -> String {
    let ms = ms.max(0);
    format!("{:02}:{:02}:{:02}{sep}{:03}", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}

fn short_ts(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

fn speaker_name<'a>(rec: &'a Recording, seg: &'a Segment) -> Option<&'a str> {
    seg.speaker.as_deref().map(|sp| rec.speakers.get(sp).map(String::as_str).unwrap_or(sp))
}

/// Split long segments into subtitle-sized cues (≤ 2 lines × `max_chars`).
fn subtitle_cues(segments: &[Segment], max_chars: usize) -> Vec<Segment> {
    let mut out = Vec::new();
    for s in segments {
        if s.text.chars().count() <= max_chars * 2 {
            out.push(s.clone());
            continue;
        }
        if !s.words.is_empty() {
            let mut cur: Vec<stt::Word> = Vec::new();
            for w in &s.words {
                let len = stt::join_words(&cur).chars().count() + w.text.chars().count() + 1;
                if !cur.is_empty() && len > max_chars * 2 {
                    out.push(Segment {
                        start_ms: cur[0].start_ms,
                        end_ms: cur.last().unwrap().end_ms,
                        text: stt::join_words(&cur),
                        speaker: s.speaker.clone(),
                        words: vec![],
                    });
                    cur.clear();
                }
                cur.push(w.clone());
            }
            if !cur.is_empty() {
                out.push(Segment {
                    start_ms: cur[0].start_ms,
                    end_ms: cur.last().unwrap().end_ms,
                    text: stt::join_words(&cur),
                    speaker: s.speaker.clone(),
                    words: vec![],
                });
            }
            continue;
        }
        // No word timings: split by characters, interpolating time.
        let words: Vec<&str> = s.text.split_whitespace().collect();
        let total = s.text.chars().count().max(1) as f64;
        let dur = (s.end_ms - s.start_ms) as f64;
        let mut start_chars = 0usize;
        let mut cur: Vec<&str> = Vec::new();
        let flush = |cur: &mut Vec<&str>, start_chars: &mut usize, out: &mut Vec<Segment>| {
            let text = cur.join(" ");
            let n = text.chars().count() + 1;
            let a = s.start_ms + (dur * (*start_chars as f64 / total)) as i64;
            let b = s.start_ms + (dur * ((*start_chars + n) as f64 / total).min(1.0)) as i64;
            out.push(Segment { start_ms: a, end_ms: b, text, speaker: s.speaker.clone(), words: vec![] });
            *start_chars += n;
            cur.clear();
        };
        for w in words {
            if !cur.is_empty() && cur.join(" ").chars().count() + w.len() + 1 > max_chars * 2 {
                flush(&mut cur, &mut start_chars, &mut out);
            }
            cur.push(w);
        }
        if !cur.is_empty() {
            flush(&mut cur, &mut start_chars, &mut out);
        }
    }
    out
}

fn wrap_lines(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    // Break at the space closest to the middle.
    let mid = text.len() / 2;
    let idx =
        text.char_indices().filter(|(_, c)| *c == ' ').map(|(i, _)| i).min_by_key(|i| (*i as i64 - mid as i64).abs());
    match idx {
        Some(i) => format!("{}\n{}", &text[..i], &text[i + 1..]),
        None => text.to_string(),
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ExportOptions {
    pub format: String,
    #[serde(default = "yes")]
    pub timestamps: bool,
    #[serde(default = "yes")]
    pub speakers: bool,
    #[serde(default)]
    pub include_notes: bool,
}

fn yes() -> bool {
    true
}

pub fn export(rec: &Recording, opts: &ExportOptions) -> Result<String> {
    let segs = &rec.segments;
    let label = |s: &Segment| -> String {
        match (opts.speakers, speaker_name(rec, s)) {
            (true, Some(n)) => format!("{n}: "),
            _ => String::new(),
        }
    };
    Ok(match opts.format.as_str() {
        "txt" => {
            let mut out = String::new();
            if opts.include_notes && !rec.enhanced.is_empty() {
                out.push_str(&rec.enhanced);
                out.push_str("\n\n---\n\n");
            }
            for s in merge_speaker_runs(segs) {
                if opts.timestamps {
                    out.push_str(&format!("[{}] ", short_ts(s.start_ms)));
                }
                out.push_str(&label(&s));
                out.push_str(s.text.trim());
                out.push_str("\n\n");
            }
            out.trim_end().to_string() + "\n"
        }
        "md" => {
            let mut out = format!("# {}\n\n", rec.title);
            let date = chrono::DateTime::from_timestamp_millis(rec.created_at)
                .map(|d| d.with_timezone(&chrono::Local).format("%B %-d, %Y %H:%M").to_string())
                .unwrap_or_default();
            out.push_str(&format!("*{date} · {}*\n\n", short_ts(rec.duration_ms)));
            if !rec.enhanced.is_empty() {
                out.push_str(&rec.enhanced);
                out.push_str("\n\n");
            } else if !rec.summary.is_empty() {
                out.push_str("## Summary\n\n");
                out.push_str(&rec.summary);
                out.push_str("\n\n");
            }
            if opts.include_notes && !rec.notes.trim().is_empty() {
                out.push_str("## My notes\n\n");
                out.push_str(rec.notes.trim());
                out.push_str("\n\n");
            }
            out.push_str("## Transcript\n\n");
            for s in merge_speaker_runs(segs) {
                let ts = if opts.timestamps { format!("`{}` ", short_ts(s.start_ms)) } else { String::new() };
                let sp = match (opts.speakers, speaker_name(rec, &s)) {
                    (true, Some(n)) => format!("**{n}:** "),
                    _ => String::new(),
                };
                out.push_str(&format!("{ts}{sp}{}\n\n", s.text.trim()));
            }
            out
        }
        "srt" => {
            let mut out = String::new();
            for (i, s) in subtitle_cues(segs, 42).iter().enumerate() {
                out.push_str(&format!(
                    "{}\n{} --> {}\n{}{}\n\n",
                    i + 1,
                    ts(s.start_ms, ','),
                    ts(s.end_ms.max(s.start_ms + 500), ','),
                    label(s),
                    wrap_lines(s.text.trim(), 42)
                ));
            }
            out
        }
        "vtt" => {
            let mut out = String::from("WEBVTT\n\n");
            for s in subtitle_cues(segs, 42) {
                let text = wrap_lines(s.text.trim(), 42);
                let body = match (opts.speakers, speaker_name(rec, &s)) {
                    (true, Some(n)) => format!("<v {n}>{text}"),
                    _ => text,
                };
                out.push_str(&format!(
                    "{} --> {}\n{body}\n\n",
                    ts(s.start_ms, '.'),
                    ts(s.end_ms.max(s.start_ms + 500), '.')
                ));
            }
            out
        }
        "csv" => {
            let mut out = String::from("start,end,speaker,text\n");
            for s in segs {
                let q = |v: &str| format!("\"{}\"", v.replace('"', "\"\""));
                out.push_str(&format!(
                    "{},{},{},{}\n",
                    short_ts(s.start_ms),
                    short_ts(s.end_ms),
                    q(speaker_name(rec, s).unwrap_or("")),
                    q(s.text.trim())
                ));
            }
            out
        }
        "json" => serde_json::to_string_pretty(&serde_json::json!({
            "title": rec.title,
            "created_at": rec.created_at,
            "duration_ms": rec.duration_ms,
            "language": rec.language,
            "notes": rec.notes,
            "enhanced_notes": rec.enhanced,
            "summary": rec.summary,
            "speakers": rec.speakers,
            "segments": segs,
        }))?,
        other => return Err(anyhow!("unknown export format {other}")),
    })
}

/// Merge consecutive segments from the same speaker into paragraphs.
fn merge_speaker_runs(segs: &[Segment]) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for s in segs {
        if let Some(last) = out.last_mut() {
            let gap = s.start_ms - last.end_ms;
            let long = last.text.len() > 600;
            if last.speaker == s.speaker && gap < 2_000 && !long {
                last.text.push(' ');
                last.text.push_str(s.text.trim());
                last.end_ms = s.end_ms;
                continue;
            }
        }
        out.push(Segment { words: vec![], ..s.clone() });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_timestamps() {
        assert_eq!(ts(3_723_456, ','), "01:02:03,456");
    }

    #[test]
    fn cues_split_long_segments() {
        let s =
            Segment { start_ms: 0, end_ms: 10_000, text: "word ".repeat(60).trim().to_string(), ..Default::default() };
        let cues = subtitle_cues(&[s], 42);
        assert!(cues.len() > 1);
        assert!(cues.iter().all(|c| c.text.chars().count() <= 84));
        assert_eq!(cues.last().unwrap().end_ms, 10_000);
    }
}
