//! LLM backends: local agent CLIs (Claude Code, Codex, opencode, Antigravity/Gemini)
//! and bring-your-own-key HTTP endpoints (Chat Completions, Responses, Anthropic).
//!
//! Every backend exposes the same streaming `complete` call; backends that cannot
//! stream deltas simply emit the whole answer as one delta.

mod cli;
mod http;
mod sse;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LlmKind {
    ClaudeCode,
    Codex,
    Opencode,
    Gemini,
    Antigravity,
    OpenaiChat,
    OpenaiResponses,
    Anthropic,
}

impl LlmKind {
    pub fn is_cli(self) -> bool {
        matches!(self, Self::ClaudeCode | Self::Codex | Self::Opencode | Self::Gemini | Self::Antigravity)
    }

    pub fn default_bin(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Gemini => "gemini",
            Self::Antigravity => "agy",
            _ => "",
        }
    }
}

/// A user-configured LLM. Multiple profiles let e.g. dictation use a fast model
/// while meeting notes use a stronger one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProfile {
    pub id: String,
    pub name: String,
    pub kind: LlmKind,
    #[serde(default)]
    pub model: String,
    /// HTTP backends only. Empty means the provider default.
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    /// CLI backends only: explicit binary path override.
    #[serde(default)]
    pub bin_path: String,
    /// Reasoning effort hint for backends that support it ("low", "medium", "high").
    #[serde(default)]
    pub effort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Default)]
pub struct ChatRequest {
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: Option<f32>,
}

impl ChatRequest {
    pub fn simple(system: impl Into<String>, user: impl Into<String>) -> Self {
        Self {
            system: system.into(),
            messages: vec![ChatMessage { role: Role::User, content: user.into() }],
            temperature: None,
        }
    }

    /// Flattens the conversation into a single prompt for one-shot CLIs.
    pub(crate) fn flatten(&self, include_system: bool) -> String {
        let mut out = String::new();
        if include_system && !self.system.trim().is_empty() {
            out.push_str(&self.system);
            out.push_str("\n\n");
        }
        if self.messages.len() == 1 {
            out.push_str(&self.messages[0].content);
            return out;
        }
        out.push_str("Conversation so far:\n\n");
        for m in &self.messages {
            let who = if m.role == Role::User { "User" } else { "Assistant" };
            out.push_str(&format!("### {who}\n{}\n\n", m.content));
        }
        out.push_str("Reply as the Assistant to the latest User message.");
        out
    }
}

pub type DeltaFn<'a> = &'a mut (dyn FnMut(&str) + Send);

/// Run a completion, streaming text deltas to `on_delta`. Returns the full text.
pub async fn complete(
    profile: &LlmProfile,
    req: &ChatRequest,
    cancel: Option<CancellationToken>,
    on_delta: DeltaFn<'_>,
) -> Result<String> {
    let cancel = cancel.unwrap_or_default();
    let fut = async {
        match profile.kind {
            k if k.is_cli() => cli::complete(profile, req, on_delta).await,
            LlmKind::OpenaiChat => http::chat_completions(profile, req, on_delta).await,
            LlmKind::OpenaiResponses => http::responses(profile, req, on_delta).await,
            LlmKind::Anthropic => http::anthropic(profile, req, on_delta).await,
            _ => unreachable!(),
        }
    };
    tokio::select! {
        r = fut => r.map(|s| s.trim().to_string()),
        _ = cancel.cancelled() => anyhow::bail!("cancelled"),
    }
}

/// Convenience wrapper without streaming.
pub async fn complete_text(profile: &LlmProfile, req: &ChatRequest) -> Result<String> {
    complete(profile, req, None, &mut |_| {}).await
}

#[derive(Debug, Clone, Serialize)]
pub struct CliStatus {
    pub kind: LlmKind,
    pub path: Option<String>,
    pub version: Option<String>,
}

/// Detect which agent CLIs are installed.
pub async fn detect_clis() -> Vec<CliStatus> {
    let kinds = [LlmKind::ClaudeCode, LlmKind::Codex, LlmKind::Opencode, LlmKind::Gemini, LlmKind::Antigravity];
    let mut out = Vec::new();
    for kind in kinds {
        let path = crate::shell_env::which(kind.default_bin());
        let version = match &path {
            Some(p) => cli::version(p).await,
            None => None,
        };
        out.push(CliStatus { kind, path: path.map(|p| p.to_string_lossy().into_owned()), version });
    }
    out
}

/// List models for HTTP backends (via /models) or CLIs that support listing.
pub async fn list_models(profile: &LlmProfile) -> Result<Vec<String>> {
    match profile.kind {
        LlmKind::OpenaiChat | LlmKind::OpenaiResponses | LlmKind::Anthropic => http::list_models(profile).await,
        LlmKind::Opencode => cli::opencode_models(profile).await,
        LlmKind::ClaudeCode => Ok(["haiku", "sonnet", "opus"].map(String::from).to_vec()),
        _ => Ok(vec![]),
    }
}
