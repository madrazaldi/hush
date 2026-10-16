//! Tauri command surface used by the Svelte UI.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use crate::db::{Dictation, Recording, RecordingSummary, Stats};
use crate::dictation::{self, platform};
use crate::files::ExportOptions;
use crate::llm::{self, ChatMessage, LlmProfile, Role};
use crate::settings::Settings;
use crate::state;
use crate::stt::{self, SttProfile, models};
use crate::{ai, meetings, shell_env};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

trait OrString<T> {
    fn s(self) -> CmdResult<T>;
}
impl<T> OrString<T> for anyhow::Result<T> {
    fn s(self) -> CmdResult<T> {
        self.map_err(|e| format!("{e:#}"))
    }
}

// ---------- settings & system ----------

#[tauri::command]
pub fn get_settings() -> Settings {
    state::get().settings()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> CmdResult<Vec<String>> {
    let st = state::get();
    let mut s = settings;
    s.normalize();
    s.save().s()?;
    let prev_login = st.settings.read().general.launch_at_login;
    *st.settings.write() = s.clone();
    if prev_login != s.general.launch_at_login {
        use tauri_plugin_autostart::ManagerExt;
        let al = app.autolaunch();
        let _ = if s.general.launch_at_login { al.enable() } else { al.disable() };
    }
    crate::apply_dock_visibility(&app, s.general.show_in_dock);
    Ok(st.dictation.rebind())
}

#[derive(Serialize)]
pub struct AppInfo {
    version: String,
    data_dir: String,
    ffmpeg: bool,
    ytdlp: bool,
    platform: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: crate::paths::root().to_string_lossy().into_owned(),
        ffmpeg: shell_env::which("ffmpeg").is_some(),
        ytdlp: shell_env::which("yt-dlp").is_some(),
        platform: std::env::consts::OS.into(),
    }
}

#[tauri::command]
pub fn get_permissions() -> platform::Permissions {
    platform::permissions()
}

#[tauri::command]
pub fn open_privacy(pane: String) {
    platform::open_privacy_pane(&pane);
}

/// Briefly open the mic so macOS shows its permission prompt.
#[tauri::command]
pub async fn request_microphone() -> CmdResult<()> {
    tokio::task::spawn_blocking(|| {
        let mut m = crate::audio::mic::MicCapture::start(None, Box::new(|_| {}))?;
        std::thread::sleep(std::time::Duration::from_millis(300));
        m.stop();
        Ok::<_, anyhow::Error>(())
    })
    .await
    .map_err(err)?
    .s()
}

#[tauri::command]
pub fn validate_hotkey(hotkey: String) -> CmdResult<()> {
    dictation::hotkeys::validate(&hotkey)
}

#[tauri::command]
pub fn list_input_devices() -> Vec<crate::audio::mic::InputDevice> {
    crate::audio::mic::list_input_devices()
}

#[tauri::command]
pub fn stats() -> CmdResult<Stats> {
    state::get().db.stats().s()
}

#[tauri::command]
pub fn reveal_path(path: String) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(path).status();
    #[cfg(not(target_os = "macos"))]
    let _ = path;
}

// ---------- models & providers ----------

#[tauri::command]
pub fn list_models() -> Vec<models::ModelStatus> {
    models::statuses()
}

#[tauri::command]
pub async fn download_model(id: String) -> CmdResult<()> {
    let id2 = id.clone();
    let res = models::download(&id, move |p| {
        state::get().emit("model:progress", serde_json::json!({"id": id2, "progress": p}));
    })
    .await;
    state::get().emit("model:progress", serde_json::json!({"id": id, "progress": if res.is_ok() { 1.0 } else { -1.0 }, "done": true}));
    res.s()
}

#[tauri::command]
pub fn cancel_model_download(id: String) {
    models::cancel_download(&id);
}

#[tauri::command]
pub fn delete_model(id: String) -> CmdResult<()> {
    models::delete(&id).s()
}

#[tauri::command]
pub async fn test_stt(profile: SttProfile) -> CmdResult<String> {
    match profile.kind {
        stt::SttKind::Local => tokio::task::spawn_blocking(move || stt::local::describe(&profile.model)).await.map_err(err)?.s(),
        _ => stt::cloud::test_profile(&profile).await.s(),
    }
}

#[tauri::command]
pub async fn detect_clis() -> Vec<llm::CliStatus> {
    llm::detect_clis().await
}

#[tauri::command]
pub async fn test_llm(profile: LlmProfile) -> CmdResult<String> {
    let start = std::time::Instant::now();
    let req = llm::ChatRequest::simple("You are a connectivity check. Follow instructions exactly.", "Reply with exactly: OK");
    let out = llm::complete_text(&profile, &req).await.s()?;
    Ok(format!("{} ({:.1}s)", out.chars().take(40).collect::<String>(), start.elapsed().as_secs_f32()))
}

#[tauri::command]
pub async fn llm_models(profile: LlmProfile) -> CmdResult<Vec<String>> {
    llm::list_models(&profile).await.s()
}

// ---------- dictation ----------

#[tauri::command]
pub fn dictation_toggle() {
    std::thread::spawn(|| state::get().dictation.toggle());
}

#[tauri::command]
pub fn dictation_cancel() {
    state::get().dictation.cancel();
}

#[tauri::command]
pub fn list_dictations(query: Option<String>, limit: Option<i64>, offset: Option<i64>) -> CmdResult<Vec<Dictation>> {
    state::get().db.list_dictations(query.as_deref().unwrap_or(""), limit.unwrap_or(100), offset.unwrap_or(0)).s()
}

#[tauri::command]
pub fn delete_dictation(id: String) -> CmdResult<()> {
    if let Some(p) = state::get().db.delete_dictation(&id).s()? {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[tauri::command]
pub fn clear_dictations() -> CmdResult<()> {
    for p in state::get().db.clear_dictations().s()? {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Run raw text through a dictation style (used by the "try a style" playground).
#[tauri::command]
pub async fn apply_style(text: String, style_id: String) -> CmdResult<String> {
    let s = state::get().settings();
    let style = s.dictation.styles.iter().find(|st| st.id == style_id).cloned().ok_or("unknown style")?;
    let mut t = ai::rules::spoken_commands(&text);
    if s.dictation.remove_fillers {
        t = ai::rules::remove_fillers(&t);
    }
    if !style.prompt.trim().is_empty() {
        let profile = s.llm(&s.dictation.llm_profile).ok_or("Add an AI provider first")?;
        let req = ai::dictation_request(&style, &t, &ai::DictationContext { app_name: None, vocabulary: &s.vocabulary });
        t = llm::complete_text(&profile, &req).await.s()?;
    }
    Ok(ai::rules::apply_replacements(&t, &s.replacements))
}

// ---------- recordings (files + meetings) ----------

#[tauri::command]
pub fn add_files(paths: Vec<String>) -> CmdResult<Vec<Recording>> {
    let st = state::get();
    paths.iter().map(|p| st.files.add_file(&PathBuf::from(p)).s()).collect()
}

#[tauri::command]
pub fn add_url(url: String) -> CmdResult<Recording> {
    state::get().files.add_url(&url).s()
}

#[tauri::command]
pub fn list_recordings(kind: Option<String>, query: Option<String>) -> CmdResult<Vec<RecordingSummary>> {
    state::get().db.list_recordings(kind.as_deref().unwrap_or(""), query.as_deref().unwrap_or("")).s()
}

#[tauri::command]
pub fn get_recording(id: String) -> CmdResult<Option<Recording>> {
    state::get().db.get_recording(&id).s()
}

#[derive(Deserialize)]
pub struct RecordingPatch {
    title: Option<String>,
    notes: Option<String>,
    enhanced: Option<String>,
    summary: Option<String>,
    speakers: Option<BTreeMap<String, String>>,
    starred: Option<bool>,
    template_id: Option<String>,
    language: Option<String>,
    stt: Option<String>,
    /// Edit one segment's text: (index, text).
    segment_edit: Option<(usize, String)>,
    /// Rename one segment's speaker: (index, speaker).
    segment_speaker: Option<(usize, String)>,
}

#[tauri::command]
pub fn update_recording(id: String, patch: RecordingPatch) -> CmdResult<Option<Recording>> {
    let rec = state::get()
        .db
        .update_recording(&id, |r| {
            if let Some(v) = patch.title {
                r.title = v;
            }
            if let Some(v) = patch.notes {
                r.notes = v;
            }
            if let Some(v) = patch.enhanced {
                r.enhanced = v;
            }
            if let Some(v) = patch.summary {
                r.summary = v;
            }
            if let Some(v) = patch.speakers {
                r.speakers = v;
            }
            if let Some(v) = patch.starred {
                r.starred = v;
            }
            if let Some(v) = patch.template_id {
                r.template_id = Some(v);
            }
            if let Some(v) = patch.language {
                r.language = Some(v).filter(|l| !l.is_empty());
            }
            if let Some(v) = patch.stt {
                r.stt = Some(v);
            }
            if let Some((i, text)) = patch.segment_edit {
                if let Some(seg) = r.segments.get_mut(i) {
                    seg.text = text;
                    seg.words.clear();
                }
            }
            if let Some((i, sp)) = patch.segment_speaker {
                if let Some(seg) = r.segments.get_mut(i) {
                    seg.speaker = Some(sp).filter(|s| !s.is_empty());
                }
            }
        })
        .s()?;
    Ok(rec)
}

#[tauri::command]
pub fn delete_recording(id: String) -> CmdResult<()> {
    let st = state::get();
    st.files.cancel(&id);
    if let Some(rec) = st.db.delete_recording(&id).s()? {
        // Only delete media we own (downloads, meeting audio), never the user's source file.
        let owned = |p: &Option<String>| p.as_ref().map(PathBuf::from).filter(|p| p.starts_with(crate::paths::root()));
        for p in [owned(&rec.media_path), owned(&rec.audio_path)].into_iter().flatten() {
            let _ = std::fs::remove_file(p);
        }
        let dir = crate::paths::audio_dir().join(&rec.id);
        if dir.is_dir() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn retranscribe(id: String, stt_profile: Option<String>, language: Option<String>) -> CmdResult<()> {
    let st = state::get();
    let rec = st
        .db
        .update_recording(&id, |r| {
            if let Some(p) = stt_profile {
                r.stt = Some(p);
            }
            r.language = language.filter(|l| !l.is_empty());
            if r.kind == "meeting" {
                // Re-transcribe the mixed meeting audio as a file.
                r.media_path = r.audio_path.clone();
            }
        })
        .s()?
        .ok_or("not found")?;
    if rec.media_path.is_none() && rec.source.is_none() {
        return Err("This recording has no audio to re-transcribe".into());
    }
    st.files.enqueue(&id);
    Ok(())
}

#[tauri::command]
pub fn cancel_job(id: String) {
    state::get().files.cancel(&id);
}

#[tauri::command]
pub fn export_recording(id: String, options: ExportOptions, path: String) -> CmdResult<()> {
    let rec = state::get().db.get_recording(&id).s()?.ok_or("not found")?;
    let text = crate::files::export(&rec, &options).s()?;
    std::fs::write(&path, text).map_err(err)
}

#[tauri::command]
pub fn export_text(id: String, options: ExportOptions) -> CmdResult<String> {
    let rec = state::get().db.get_recording(&id).s()?.ok_or("not found")?;
    crate::files::export(&rec, &options).s()
}

// ---------- LLM features (streaming via `llm:delta`) ----------

#[derive(Clone, Serialize)]
struct Delta<'a> {
    request_id: &'a str,
    delta: &'a str,
}

async fn stream_llm(profile: &LlmProfile, req: &llm::ChatRequest, request_id: &str) -> anyhow::Result<String> {
    let st = state::get();
    let token = CancellationToken::new();
    st.llm_tasks.lock().insert(request_id.to_string(), token.clone());
    let rid = request_id.to_string();
    let res = llm::complete(profile, req, Some(token), &mut |d| {
        state::get().emit("llm:delta", Delta { request_id: &rid, delta: d });
    })
    .await;
    st.llm_tasks.lock().remove(request_id);
    res
}

fn llm_for(kind: &str) -> CmdResult<LlmProfile> {
    let s = state::get().settings();
    let id = if kind == "meeting" { &s.meetings.llm_profile } else { &s.files.llm_profile };
    s.llm(id).ok_or_else(|| "Add an AI provider in Settings → AI first".to_string())
}

#[tauri::command]
pub fn cancel_llm(request_id: String) {
    if let Some(t) = state::get().llm_tasks.lock().remove(&request_id) {
        t.cancel();
    }
}

#[tauri::command]
pub async fn summarize(id: String, request_id: String) -> CmdResult<String> {
    let st = state::get();
    let rec = st.db.get_recording(&id).s()?.ok_or("not found")?;
    let profile = llm_for(&rec.kind)?;
    let req = ai::summary_request(&rec.title, &meetings::named_segments(&rec));
    let out = stream_llm(&profile, &req, &request_id).await.s()?;
    st.db.update_recording(&id, |r| r.summary = out.clone()).s()?;
    Ok(out)
}

#[tauri::command]
pub async fn chat(id: String, question: String, request_id: String) -> CmdResult<String> {
    let st = state::get();
    let rec = st.db.get_recording(&id).s()?.ok_or("not found")?;
    let profile = llm_for(&rec.kind)?;
    let notes = if rec.enhanced.is_empty() { rec.notes.clone() } else { rec.enhanced.clone() };
    let req = ai::chat_request(&rec.title, &meetings::named_segments(&rec), &notes, &rec.chat, &question);
    let answer = stream_llm(&profile, &req, &request_id).await.s()?;
    st.db
        .update_recording(&id, |r| {
            r.chat.push(ChatMessage { role: Role::User, content: question.clone() });
            r.chat.push(ChatMessage { role: Role::Assistant, content: answer.clone() });
        })
        .s()?;
    Ok(answer)
}

#[tauri::command]
pub fn clear_chat(id: String) -> CmdResult<()> {
    state::get().db.update_recording(&id, |r| r.chat.clear()).s().map(|_| ())
}

#[tauri::command]
pub async fn run_recipe(id: String, recipe_id: String, request_id: String) -> CmdResult<String> {
    let s = state::get().settings();
    let recipe = s.meetings.recipes.iter().find(|r| r.id == recipe_id).cloned().ok_or("unknown recipe")?;
    chat(id, recipe.prompt, request_id).await
}

/// Ask a question across many recordings (e.g. "what did we decide about pricing this month?").
#[tauri::command]
pub async fn ask_all(question: String, kind: Option<String>, request_id: String) -> CmdResult<String> {
    let st = state::get();
    let profile = llm_for(kind.as_deref().unwrap_or("meeting"))?;
    let list = st.db.list_recordings(kind.as_deref().unwrap_or(""), "").s()?;
    // Budget the context: newest first, notes preferred over raw transcripts.
    let mut ctx = String::new();
    for item in list.iter().take(40) {
        let Some(rec) = st.db.get_recording(&item.id).s()? else { continue };
        let date = chrono::DateTime::from_timestamp_millis(rec.created_at)
            .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        let body = if !rec.enhanced.is_empty() {
            rec.enhanced.clone()
        } else if !rec.summary.is_empty() {
            rec.summary.clone()
        } else {
            ai::transcript_for_llm(&meetings::named_segments(&rec)).chars().take(6000).collect()
        };
        ctx.push_str(&format!("\n<recording title=\"{}\" date=\"{date}\">\n{body}\n</recording>\n", rec.title));
        if ctx.len() > 120_000 {
            break;
        }
    }
    let req = llm::ChatRequest::simple(
        format!(
            "You answer questions across the user's recorded meetings and transcripts. Cite the recording title and date \
             for every claim. If the answer isn't present, say so.\n{ctx}"
        ),
        question,
    );
    stream_llm(&profile, &req, &request_id).await.s()
}

#[tauri::command]
pub async fn translate_recording(id: String, language: String, request_id: String) -> CmdResult<String> {
    let st = state::get();
    let rec = st.db.get_recording(&id).s()?.ok_or("not found")?;
    let profile = llm_for(&rec.kind)?;
    let lines: String = rec.segments.iter().enumerate().map(|(i, s)| format!("[{i}] {}\n", s.text.trim())).collect();
    let out = stream_llm(&profile, &ai::translate_request(&lines, &language), &request_id).await.s()?;
    // Write a translated copy as a new recording so the original stays intact.
    let mut copy = rec.clone();
    copy.id = uuid::Uuid::new_v4().to_string();
    copy.title = format!("{} ({language})", rec.title);
    copy.created_at = crate::db::now_ms();
    copy.chat.clear();
    copy.summary.clear();
    copy.enhanced.clear();
    for line in out.lines() {
        let Some((n, text)) = line.trim().strip_prefix('[').and_then(|rest| rest.split_once(']')) else { continue };
        if let Some(s) = n.trim().parse::<usize>().ok().and_then(|i| copy.segments.get_mut(i)) {
            s.text = text.trim().to_string();
            s.words.clear();
        }
    }
    copy.language = None;
    st.db.upsert_recording(&copy).s()?;
    Ok(copy.id)
}

// ---------- meetings ----------

#[tauri::command]
pub async fn meeting_start(id: Option<String>, title: Option<String>) -> CmdResult<Recording> {
    tokio::task::spawn_blocking(move || state::get().meetings.start(id, title)).await.map_err(err)?.s()
}

#[tauri::command]
pub async fn meeting_stop() -> CmdResult<String> {
    state::get().meetings.stop().await.s()
}

#[tauri::command]
pub fn meeting_status() -> Option<meetings::MeetingStatus> {
    state::get().meetings.status()
}

#[tauri::command]
pub fn meeting_pause(paused: bool) {
    state::get().meetings.set_paused(paused);
}

/// Create an empty meeting note (e.g. to prep notes before a call).
#[tauri::command]
pub fn meeting_create(title: Option<String>) -> CmdResult<Recording> {
    let s = state::get().settings();
    let rec = Recording {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "meeting".into(),
        title: title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| format!("Meeting {}", chrono::Local::now().format("%b %-d, %H:%M"))),
        created_at: crate::db::now_ms(),
        status: "ready".into(),
        template_id: Some(s.meetings.default_template.clone()),
        stt: Some(s.meetings.stt_profile.clone()),
        ..Default::default()
    };
    state::get().db.upsert_recording(&rec).s()?;
    Ok(rec)
}

#[tauri::command]
pub async fn meeting_enhance(id: String, template_id: Option<String>) -> CmdResult<String> {
    meetings::enhance(&id, template_id).await.s()
}
