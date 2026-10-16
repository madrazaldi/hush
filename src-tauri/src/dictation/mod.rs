//! Dictation: hotkey → record → transcribe → clean up → insert into the focused app.
//!
//! The controller is a small state machine (Idle → Recording → Processing)
//! driven by hotkey press/release edges, following Handy/Wispr semantics:
//! push-to-talk, toggle, and hybrid (a quick tap latches recording on).

pub mod hotkeys;
pub mod overlay;
pub mod platform;

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use parking_lot::Mutex;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::ai;
use crate::audio::mic::MicCapture;
use crate::db::{self, Dictation as DictationRow};
use crate::llm;
use crate::settings::{Activation, AutoSubmit, PasteMethod, Settings, Style};
use crate::state;
use crate::stt::{self, SAMPLE_RATE, SttKind, SttOptions};
use hotkeys::{Action, Hotkeys};
use platform::{FrontApp, Sound};

const MAX_RECORDING: Duration = Duration::from_secs(15 * 60);
const MIN_SAMPLES: usize = (SAMPLE_RATE as usize) / 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Dictate,
    Command,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverlayState {
    /// idle | recording | processing | done | error
    pub phase: &'static str,
    pub mode: Mode,
    pub latched: bool,
    pub message: Option<String>,
    pub style: Option<String>,
    pub app: Option<String>,
}

struct Recording {
    mode: Mode,
    started: Instant,
    latched: bool,
    front: FrontApp,
    mic: MicCapture,
    pcm: Arc<Mutex<Vec<f32>>>,
    restore_mute: Option<bool>,
    session: u64,
}

enum Phase {
    Idle,
    /// The mic is being opened for `session`. Reserved under the lock so two
    /// starts (hotkey + UI) can't both open a device.
    Starting {
        session: u64,
        mode: Mode,
        /// The hotkey was released before recording began.
        released: bool,
    },
    Recording(Box<Recording>),
    /// Transcribing/inserting the recording from `session`.
    Processing {
        token: CancellationToken,
        session: u64,
    },
}

pub struct Dictation {
    phase: Mutex<Phase>,
    hotkeys: Mutex<Option<Hotkeys>>,
    session: Mutex<u64>,
}

impl Default for Dictation {
    fn default() -> Self {
        Self { phase: Mutex::new(Phase::Idle), hotkeys: Mutex::new(None), session: Mutex::new(0) }
    }
}

fn overlay_emit(
    phase: &'static str,
    mode: Mode,
    latched: bool,
    message: Option<String>,
    style: Option<String>,
    app: Option<String>,
) {
    state::get().emit("dictation:state", OverlayState { phase, mode, latched, message, style, app });
}

impl Dictation {
    /// Start the hotkey thread. Call once after AppState is initialized.
    pub fn start_hotkeys(&self) {
        let hk = Hotkeys::spawn(Box::new(|action, pressed| {
            let st = state::get();
            st.dictation.on_hotkey(action, pressed);
        }));
        *self.hotkeys.lock() = Some(hk);
        self.rebind();
    }

    /// Apply hotkey settings. Returns binding errors.
    pub fn rebind(&self) -> Vec<String> {
        let s = state::get().settings();
        let Some(hk) = self.hotkeys.lock().clone() else { return vec![] };
        if !s.dictation.enabled {
            return hk.bind(vec![]);
        }
        hk.bind(vec![
            (Action::Dictate, s.dictation.hotkey.clone()),
            (Action::Command, s.dictation.command_hotkey.clone()),
            (Action::PasteLast, s.dictation.paste_last_hotkey.clone()),
        ])
    }

    fn set_cancel(&self, on: bool) {
        if let Some(hk) = self.hotkeys.lock().as_ref() {
            hk.set_cancel_enabled(on);
        }
    }

    pub fn is_busy(&self) -> bool {
        !matches!(*self.phase.lock(), Phase::Idle)
    }

    pub fn on_hotkey(&self, action: Action, pressed: bool) {
        let s = state::get().settings();
        let activation = s.dictation.activation;
        let hold = Duration::from_millis(s.dictation.hold_ms.max(100));

        match action {
            Action::Cancel if pressed => self.cancel(),
            Action::PasteLast if pressed => {
                std::thread::spawn(|| {
                    if let Ok(Some(d)) = state::get().db.last_dictation() {
                        let s = state::get().settings();
                        let _ = insert_text(&d.text, &s, &|| false);
                    }
                });
            }
            Action::Dictate | Action::Command => {
                let mode = if action == Action::Dictate { Mode::Dictate } else { Mode::Command };
                let mut phase = self.phase.lock();
                match (&mut *phase, pressed) {
                    (Phase::Idle, true) => {
                        drop(phase);
                        self.start(mode);
                    }
                    (Phase::Recording(rec), true) => {
                        if mode == Mode::Command
                            && rec.mode == Mode::Dictate
                            && rec.started.elapsed() < Duration::from_millis(600)
                        {
                            // Fn then Shift: upgrade to command mode.
                            rec.mode = Mode::Command;
                            overlay_emit(
                                "recording",
                                Mode::Command,
                                rec.latched,
                                None,
                                None,
                                Some(rec.front.name.clone()),
                            );
                        } else if rec.latched || activation == Activation::Toggle {
                            drop(phase);
                            self.finish();
                        }
                    }
                    (Phase::Starting { mode: m, released, .. }, false) if *m == mode => *released = true,
                    (Phase::Recording(rec), false) => {
                        if rec.latched || (rec.mode != mode && rec.mode == Mode::Dictate) {
                            return;
                        }
                        match activation {
                            Activation::Toggle => {}
                            Activation::PushToTalk => {
                                drop(phase);
                                self.finish();
                            }
                            Activation::Hybrid => {
                                if rec.started.elapsed() < hold {
                                    rec.latched = true;
                                    overlay_emit("recording", rec.mode, true, None, None, Some(rec.front.name.clone()));
                                } else {
                                    drop(phase);
                                    self.finish();
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// Start recording (also used by the UI's record button).
    pub fn start(&self, mode: Mode) {
        let session = {
            let mut phase = self.phase.lock();
            if !matches!(*phase, Phase::Idle) {
                return;
            }
            let mut n = self.session.lock();
            *n += 1;
            *phase = Phase::Starting { session: *n, mode, released: false };
            *n
        };
        let st = state::get();
        let s = st.settings();
        let front = platform::front_app();
        let profile = s.stt(&s.dictation.stt_profile);
        if profile.kind == SttKind::Local {
            crate::stt::local::preload(&profile.model);
        }

        let pcm = Arc::new(Mutex::new(Vec::<f32>::with_capacity(SAMPLE_RATE as usize * 30)));
        let pcm2 = pcm.clone();
        let mut last_level = Instant::now();
        let mic = MicCapture::start(
            s.dictation.mic_device.as_deref(),
            Box::new(move |chunk| {
                pcm2.lock().extend_from_slice(chunk);
                if last_level.elapsed() > Duration::from_millis(45) {
                    last_level = Instant::now();
                    state::get().emit("dictation:level", crate::audio::level(chunk));
                }
            }),
        );

        let mut phase = self.phase.lock();
        let Phase::Starting { session: current, released, .. } = *phase else { return };
        if current != session {
            // Cancelled while the mic was opening; `mic` is dropped (stopped) here.
            return;
        }
        let mut mic = match mic {
            Ok(m) => m,
            Err(e) => {
                *phase = Phase::Idle;
                log::error!("mic: {e:#}");
                if s.dictation.sounds {
                    platform::play(Sound::Error);
                }
                overlay::show(&st.app, s.dictation.overlay);
                overlay_emit("error", mode, false, Some(format!("{e}")), None, None);
                hide_later(1800);
                return;
            }
        };
        // Push-to-talk released before the mic was even open: nothing to record.
        if released && s.dictation.activation == Activation::PushToTalk {
            *phase = Phase::Idle;
            mic.stop();
            return;
        }
        // In hybrid mode an early release is a quick tap, which latches.
        let latched = released && s.dictation.activation == Activation::Hybrid;

        let restore_mute = if s.dictation.mute_system_audio { platform::set_output_muted(true) } else { None };
        if s.dictation.sounds {
            platform::play(Sound::Start);
        }
        let style = pick_style(&s, &front).map(|st| st.name.clone());
        *phase = Phase::Recording(Box::new(Recording {
            mode,
            started: Instant::now(),
            latched,
            front: front.clone(),
            mic,
            pcm,
            restore_mute,
            session,
        }));
        self.set_cancel(true);
        overlay::show(&st.app, s.dictation.overlay);
        overlay_emit(
            "recording",
            mode,
            latched,
            None,
            if mode == Mode::Dictate { style } else { None },
            Some(front.name),
        );
        drop(phase);

        // Safety stop for forgotten latched recordings.
        std::thread::spawn(move || {
            std::thread::sleep(MAX_RECORDING);
            let d = &state::get().dictation;
            let same = matches!(&*d.phase.lock(), Phase::Recording(r) if r.session == session);
            if same {
                d.finish();
            }
        });
    }

    /// Toggle from the UI (tray / button).
    pub fn toggle(&self) {
        let recording = matches!(*self.phase.lock(), Phase::Recording(_));
        if recording { self.finish() } else { self.start(Mode::Dictate) }
    }

    /// Every phase change and its UI effects happen under the phase lock, so a
    /// stale session can never touch the overlay or devices of a newer one.
    pub fn cancel(&self) {
        let st = state::get();
        let s = st.settings();
        let mut phase = self.phase.lock();
        match std::mem::replace(&mut *phase, Phase::Idle) {
            Phase::Recording(mut rec) => {
                rec.mic.stop();
                if let Some(m) = rec.restore_mute {
                    platform::set_output_muted(m);
                }
                if s.dictation.sounds {
                    platform::play(Sound::Cancel);
                }
            }
            Phase::Processing { token, .. } => token.cancel(),
            // `start` sees the change and releases the mic itself.
            Phase::Starting { .. } => {}
            Phase::Idle => return,
        }
        self.set_cancel(false);
        overlay_emit("idle", Mode::Dictate, false, None, None, None);
        overlay::hide(&st.app);
    }

    /// Stop recording and process in the background.
    pub fn finish(&self) {
        let token = CancellationToken::new();
        let mut phase = self.phase.lock();
        let Phase::Recording(rec) = &*phase else { return };
        let session = rec.session;
        let Phase::Recording(mut rec) =
            std::mem::replace(&mut *phase, Phase::Processing { token: token.clone(), session })
        else {
            unreachable!()
        };
        rec.mic.stop();
        let st = state::get();
        let s = st.settings();
        if let Some(m) = rec.restore_mute {
            platform::set_output_muted(m);
        }
        if s.dictation.sounds {
            platform::play(Sound::Stop);
        }
        let pcm = std::mem::take(&mut *rec.pcm.lock());
        let mode = rec.mode;
        let front = rec.front.clone();
        overlay_emit("processing", mode, false, None, None, Some(front.name.clone()));
        drop(phase);

        tauri::async_runtime::spawn(async move {
            let result = tokio::select! {
                r = process(pcm, mode, front, s.clone(), token.clone()) => r,
                _ = token.cancelled() => Ok(None),
            };
            let d = &state::get().dictation;
            let st = state::get();
            let mut phase = d.phase.lock();
            // If cancelled, `cancel()` already reset the UI and a newer session
            // may own the overlay and controller: touch nothing.
            let current = matches!(*phase, Phase::Processing { session: s, .. } if s == session);
            if !current || token.is_cancelled() {
                return;
            }
            *phase = Phase::Idle;
            d.set_cancel(false);
            match result {
                Ok(Some(text)) => {
                    overlay_emit("done", mode, false, Some(text.chars().take(80).collect()), None, None);
                    hide_later(450);
                }
                Ok(None) => {
                    overlay_emit("idle", mode, false, None, None, None);
                    overlay::hide(&st.app);
                }
                Err(e) => {
                    log::error!("dictation failed: {e:#}");
                    if s.dictation.sounds {
                        platform::play(Sound::Error);
                    }
                    overlay_emit("error", mode, false, Some(short_error(&e)), None, None);
                    hide_later(2600);
                }
            }
        });
    }
}

fn short_error(e: &anyhow::Error) -> String {
    let s = format!("{e}");
    s.chars().take(120).collect()
}

fn hide_later(ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        let st = state::get();
        // Checked and hidden under the lock: a session starting in between
        // queues its `show` after this `hide` on the main thread.
        let phase = st.dictation.phase.lock();
        if matches!(*phase, Phase::Idle) {
            overlay::hide(&st.app);
        }
    });
}

pub fn pick_style<'a>(s: &'a Settings, front: &FrontApp) -> Option<&'a Style> {
    let name = front.name.to_lowercase();
    let bundle = front.bundle_id.to_lowercase();
    s.dictation
        .styles
        .iter()
        .find(|st| {
            st.apps.iter().any(|a| {
                let a = a.to_lowercase();
                !a.is_empty() && (a == name || a == bundle)
            })
        })
        .or_else(|| s.dictation.styles.iter().find(|st| st.id == s.dictation.default_style))
}

/// Full pipeline. Returns the inserted text, or None if there was nothing to insert.
async fn process(
    pcm: Vec<f32>,
    mode: Mode,
    front: FrontApp,
    s: Settings,
    token: CancellationToken,
) -> Result<Option<String>> {
    let st = state::get();
    let duration_ms = (pcm.len() as i64) * 1000 / SAMPLE_RATE as i64;
    let trimmed = crate::audio::trim_silence(&pcm).to_vec();
    if trimmed.len() < MIN_SAMPLES {
        return Ok(None);
    }

    let profile = s.stt(&s.dictation.stt_profile);
    let opts =
        SttOptions { language: s.dictation.language.clone(), vocabulary: s.vocabulary.clone(), ..Default::default() };
    let transcript = stt::transcribe(&profile, &trimmed, &opts, &|_| {}).await?;
    let raw = transcript.text.trim().to_string();
    if raw.is_empty() {
        return Ok(None);
    }

    let app_name = s.dictation.app_context.then_some(front.name.as_str()).filter(|n| !n.is_empty());
    let llm_profile = s.llm(&s.dictation.llm_profile);
    let mut used_llm: Option<String> = None;
    let mut style_name: Option<String> = None;

    let text = match mode {
        Mode::Command => {
            let profile =
                llm_profile.ok_or_else(|| anyhow::anyhow!("Command mode needs an AI provider (Settings → AI)"))?;
            let selection =
                tokio::task::spawn_blocking(platform::selected_text).await.ok().flatten().unwrap_or_default();
            let req = ai::command_request(&raw, &selection, app_name);
            used_llm = Some(profile.name.clone());
            llm::complete_text(&profile, &req).await?
        }
        Mode::Dictate => {
            let mut text = ai::rules::spoken_commands(&raw);
            if s.dictation.remove_fillers {
                text = ai::rules::remove_fillers(&text);
            }
            let style = pick_style(&s, &front);
            style_name = style.map(|st| st.name.clone());
            if let (true, Some(style), Some(profile)) = (s.dictation.llm_enabled, style, llm_profile)
                && !style.prompt.trim().is_empty()
            {
                let req =
                    ai::dictation_request(style, &text, &ai::DictationContext { app_name, vocabulary: &s.vocabulary });
                match tokio::time::timeout(Duration::from_secs(25), llm::complete_text(&profile, &req)).await {
                    Ok(Ok(out)) if !out.trim().is_empty() => {
                        used_llm = Some(profile.name.clone());
                        text = out;
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => log::warn!("LLM cleanup failed, inserting raw text: {e:#}"),
                    Err(_) => log::warn!("LLM cleanup timed out, inserting raw text"),
                }
            }
            ai::rules::apply_replacements(&text, &s.replacements)
        }
    };
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }

    let to_insert = if s.dictation.trailing_space && mode == Mode::Dictate && !text.ends_with('\n') {
        format!("{text} ")
    } else {
        text.clone()
    };
    let settings = s.clone();
    let cancel = token.clone();
    tokio::task::spawn_blocking(move || insert_text(&to_insert, &settings, &|| cancel.is_cancelled())).await??;
    if token.is_cancelled() {
        return Ok(None);
    }

    let audio_path = if s.dictation.keep_audio {
        let p = crate::paths::audio_dir().join(format!("dictation-{}.wav", db::now_ms()));
        crate::audio::write_wav(&p, &pcm, SAMPLE_RATE).ok().map(|_| p.to_string_lossy().into_owned())
    } else {
        None
    };
    let row = DictationRow {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: db::now_ms(),
        kind: if mode == Mode::Command { "command".into() } else { "dictation".into() },
        raw_text: raw,
        text: text.clone(),
        app: Some(front.name).filter(|n| !n.is_empty()),
        style: style_name,
        duration_ms,
        stt: Some(profile.name),
        llm: used_llm,
        audio_path,
        error: None,
    };
    st.db.insert_dictation(&row)?;
    st.emit("dictation:new", &row);
    Ok(Some(text))
}

/// Insert into the focused app. `cancelled` is polled before each step so a
/// cancel during insertion stops further typing and the auto-submit key.
fn insert_text(text: &str, s: &Settings, cancelled: &dyn Fn() -> bool) -> Result<()> {
    if cancelled() {
        return Ok(());
    }
    match s.dictation.paste_method {
        PasteMethod::Paste => platform::paste_text(text, s.dictation.restore_clipboard, cancelled)?,
        PasteMethod::Type => platform::type_text(text, cancelled)?,
        PasteMethod::CopyOnly => {
            platform::copy_text(text)?;
            return Ok(());
        }
    }
    if cancelled() {
        return Ok(());
    }
    if s.dictation.auto_submit == AutoSubmit::Off {
        return Ok(());
    }
    std::thread::sleep(Duration::from_millis(60));
    // Re-checked right before the key: Escape during the pause must not submit.
    if cancelled() {
        return Ok(());
    }
    platform::press_enter(s.dictation.auto_submit == AutoSubmit::CmdEnter)
}
