//! Persisted user settings (JSON in the app data dir).

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::llm::{LlmKind, LlmProfile};
use crate::paths;
use crate::stt::{SttKind, SttProfile};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Activation {
    /// Hold to talk, release to finish.
    PushToTalk,
    /// Press to start, press again to finish.
    Toggle,
    /// Hold to talk; a quick tap latches recording on until the next press.
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteMethod {
    /// Clipboard + ⌘V, restoring the previous clipboard afterwards.
    Paste,
    /// Synthesize keystrokes (works in apps that block paste).
    Type,
    /// Only copy to the clipboard.
    CopyOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoSubmit {
    Off,
    Enter,
    CmdEnter,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OverlayPosition {
    Top,
    Bottom,
    Hidden,
}

/// A dictation style ("mode"): how the LLM should rewrite raw dictation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Style {
    pub id: String,
    pub name: String,
    /// Instructions for the LLM. Empty means "no LLM, just rules".
    pub prompt: String,
    /// Frontmost-app names or bundle ids that auto-select this style.
    #[serde(default)]
    pub apps: Vec<String>,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Replacement {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DictationSettings {
    pub enabled: bool,
    pub hotkey: String,
    pub activation: Activation,
    /// Hold threshold for Hybrid activation.
    pub hold_ms: u64,
    /// Hotkey that dictates an instruction applied to the selected text.
    pub command_hotkey: String,
    /// Paste the last dictation again.
    pub paste_last_hotkey: String,
    pub stt_profile: String,
    pub language: Option<String>,
    pub mic_device: Option<String>,
    pub paste_method: PasteMethod,
    pub restore_clipboard: bool,
    pub auto_submit: AutoSubmit,
    pub trailing_space: bool,
    pub sounds: bool,
    pub mute_system_audio: bool,
    pub overlay: OverlayPosition,
    pub remove_fillers: bool,
    /// LLM cleanup on/off; when off, only rule-based cleanup is applied.
    pub llm_enabled: bool,
    pub llm_profile: String,
    pub default_style: String,
    pub styles: Vec<Style>,
    /// Pass the frontmost app name to the LLM as context.
    pub app_context: bool,
    pub keep_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MeetingSettings {
    pub stt_profile: String,
    pub language: Option<String>,
    pub mic_device: Option<String>,
    pub capture_system_audio: bool,
    pub keep_audio: bool,
    /// Generate enhanced notes automatically when a meeting ends.
    pub auto_enhance: bool,
    pub llm_profile: String,
    pub default_template: String,
    pub templates: Vec<NoteTemplate>,
    pub recipes: Vec<Recipe>,
    /// Notify when a meeting app starts using the microphone.
    pub detect_meetings: bool,
    pub your_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct FileSettings {
    pub stt_profile: String,
    pub language: Option<String>,
    pub diarize: bool,
    pub llm_profile: String,
    pub auto_summarize: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneralSettings {
    pub launch_at_login: bool,
    pub show_in_dock: bool,
    pub theme: String,
    pub history_days: u32,
    pub onboarded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub general: GeneralSettings,
    pub stt_profiles: Vec<SttProfile>,
    pub llm_profiles: Vec<LlmProfile>,
    pub vocabulary: Vec<String>,
    pub replacements: Vec<Replacement>,
    pub dictation: DictationSettings,
    pub meetings: MeetingSettings,
    pub files: FileSettings,
}

pub const LOCAL_PROFILE: &str = "local";

impl Default for GeneralSettings {
    fn default() -> Self {
        Self { launch_at_login: false, show_in_dock: true, theme: "system".into(), history_days: 0, onboarded: false }
    }
}

impl Default for DictationSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            hotkey: "Fn".into(),
            activation: Activation::Hybrid,
            hold_ms: 300,
            command_hotkey: "Fn+Shift".into(),
            paste_last_hotkey: "Cmd+Ctrl+V".into(),
            stt_profile: LOCAL_PROFILE.into(),
            language: None,
            mic_device: None,
            paste_method: PasteMethod::Paste,
            restore_clipboard: true,
            auto_submit: AutoSubmit::Off,
            trailing_space: true,
            sounds: true,
            mute_system_audio: false,
            overlay: OverlayPosition::Bottom,
            remove_fillers: true,
            llm_enabled: false,
            llm_profile: String::new(),
            default_style: "clean".into(),
            styles: crate::ai::builtin_styles(),
            app_context: true,
            keep_audio: false,
        }
    }
}

impl Default for MeetingSettings {
    fn default() -> Self {
        Self {
            stt_profile: LOCAL_PROFILE.into(),
            language: None,
            mic_device: None,
            capture_system_audio: true,
            keep_audio: true,
            auto_enhance: true,
            llm_profile: String::new(),
            default_template: "general".into(),
            templates: crate::ai::builtin_templates(),
            recipes: crate::ai::builtin_recipes(),
            detect_meetings: true,
            your_name: String::new(),
        }
    }
}

impl Default for FileSettings {
    fn default() -> Self {
        Self {
            stt_profile: LOCAL_PROFILE.into(),
            language: None,
            diarize: false,
            llm_profile: String::new(),
            auto_summarize: false,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            general: Default::default(),
            stt_profiles: vec![SttProfile {
                id: LOCAL_PROFILE.into(),
                name: "On-device".into(),
                kind: SttKind::Local,
                model: "parakeet-tdt-0.6b-v3".into(),
                base_url: String::new(),
                api_key: String::new(),
            }],
            llm_profiles: Vec::new(),
            vocabulary: Vec::new(),
            replacements: Vec::new(),
            dictation: Default::default(),
            meetings: Default::default(),
            files: Default::default(),
        }
    }
}

impl Settings {
    pub fn load() -> Self {
        let path = paths::settings_file();
        let mut s: Settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|txt| match serde_json::from_str(&txt) {
                Ok(s) => Some(s),
                Err(e) => {
                    log::error!("settings parse error, using defaults: {e}");
                    let _ = std::fs::copy(&path, path.with_extension("json.bak"));
                    None
                }
            })
            .unwrap_or_default();
        s.normalize();
        s
    }

    pub fn save(&self) -> Result<()> {
        let path = paths::settings_file();
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // API keys live here; keep the file private to the user.
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Ensure invariants after loading or after the UI sends an update.
    pub fn normalize(&mut self) {
        if !self.stt_profiles.iter().any(|p| p.id == LOCAL_PROFILE) {
            self.stt_profiles.insert(0, Settings::default().stt_profiles.remove(0));
        }
        // Built-ins are refreshed from code but user edits to them are kept.
        merge_builtins(&mut self.dictation.styles, crate::ai::builtin_styles(), |s| &s.id);
        merge_builtins(&mut self.meetings.templates, crate::ai::builtin_templates(), |t| &t.id);
        merge_builtins(&mut self.meetings.recipes, crate::ai::builtin_recipes(), |r| &r.id);
        let first_llm = self.llm_profiles.first().map(|p| p.id.clone()).unwrap_or_default();
        for slot in [&mut self.dictation.llm_profile, &mut self.meetings.llm_profile, &mut self.files.llm_profile] {
            if !self.llm_profiles.iter().any(|p| &p.id == slot) {
                *slot = first_llm.clone();
            }
        }
        for slot in [&mut self.dictation.stt_profile, &mut self.meetings.stt_profile, &mut self.files.stt_profile] {
            if !self.stt_profiles.iter().any(|p| &p.id == slot) {
                *slot = LOCAL_PROFILE.into();
            }
        }
    }

    pub fn stt(&self, id: &str) -> SttProfile {
        self.stt_profiles.iter().find(|p| p.id == id).or(self.stt_profiles.first()).cloned().expect("local profile exists")
    }

    pub fn llm(&self, id: &str) -> Option<LlmProfile> {
        self.llm_profiles.iter().find(|p| p.id == id).or(self.llm_profiles.first()).cloned()
    }

    /// Default profiles for the agent CLIs that are installed, created on first run.
    pub fn seed_llm_profiles(&mut self, installed: &[LlmKind]) {
        if !self.llm_profiles.is_empty() {
            return;
        }
        for kind in installed {
            let (id, name, model) = match kind {
                LlmKind::ClaudeCode => ("claude-code", "Claude Code", "haiku"),
                LlmKind::Codex => ("codex", "Codex", ""),
                LlmKind::Opencode => ("opencode", "opencode", ""),
                LlmKind::Gemini => ("gemini", "Gemini CLI", ""),
                LlmKind::Antigravity => ("antigravity", "Antigravity", ""),
                _ => continue,
            };
            self.llm_profiles.push(LlmProfile {
                id: id.into(),
                name: name.into(),
                kind: *kind,
                model: model.into(),
                base_url: String::new(),
                api_key: String::new(),
                bin_path: String::new(),
                effort: String::new(),
            });
        }
        self.normalize();
    }
}

fn merge_builtins<T: Clone>(list: &mut Vec<T>, builtins: Vec<T>, id: impl Fn(&T) -> &String) {
    for b in builtins.into_iter().rev() {
        if !list.iter().any(|x| id(x) == id(&b)) {
            list.insert(0, b);
        }
    }
}
