//! Agent CLI backends. Each CLI runs one-shot, sandboxed/tool-less where possible,
//! in an empty temp directory, with JSONL output that we parse into text deltas.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::{ChatRequest, DeltaFn, LlmKind, LlmProfile};
use crate::shell_env;

const TIMEOUT: Duration = Duration::from_secs(600);

struct Invocation {
    args: Vec<String>,
    stdin: Option<String>,
    envs: Vec<(String, String)>,
}

fn build(profile: &LlmProfile, req: &ChatRequest, workdir: &Path) -> Invocation {
    let model = profile.model.trim();
    let effort = profile.effort.trim();
    let mut envs = Vec::new();
    let mut args: Vec<String> = Vec::new();
    let stdin;

    match profile.kind {
        LlmKind::ClaudeCode => {
            args.extend(
                [
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--include-partial-messages",
                    "--no-session-persistence",
                    "--tools",
                    "",
                    "--disable-slash-commands",
                    "--setting-sources",
                    "",
                    "--strict-mcp-config",
                    "--permission-mode",
                    "dontAsk",
                ]
                .map(String::from),
            );
            if !req.system.trim().is_empty() {
                args.push("--system-prompt".into());
                args.push(req.system.clone());
            }
            if !model.is_empty() {
                args.extend(["--model".into(), model.into()]);
            }
            if !effort.is_empty() {
                args.extend(["--effort".into(), effort.into()]);
            }
            stdin = Some(req.flatten(false));
        }
        LlmKind::Codex => {
            args.extend(
                [
                    "exec",
                    "--json",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "-s",
                    "read-only",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--color",
                    "never",
                    "-C",
                ]
                .map(String::from),
            );
            args.push(workdir.to_string_lossy().into_owned());
            if !model.is_empty() {
                args.extend(["-m".into(), model.into()]);
            }
            if !effort.is_empty() {
                args.extend(["-c".into(), format!("model_reasoning_effort=\"{effort}\"")]);
            }
            args.push("-".into());
            stdin = Some(req.flatten(true));
        }
        LlmKind::Opencode => {
            args.extend(["run", "--format", "json"].map(String::from));
            if !model.is_empty() {
                args.extend(["-m".into(), model.into()]);
            }
            args.push(req.flatten(true));
            stdin = None;
            envs.push((
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"permission":"deny","share":"disabled","autoupdate":false}"#.into(),
            ));
            envs.push(("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()));
            envs.push(("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into()));
        }
        LlmKind::Antigravity => {
            args.extend(["-p".into(), req.flatten(true)]);
            args.extend(["--output-format", "stream-json", "--mode", "plan"].map(String::from));
            if !model.is_empty() {
                args.extend(["--model".into(), model.into()]);
            }
            if !effort.is_empty() {
                args.extend(["--effort".into(), effort.into()]);
            }
            stdin = None;
        }
        LlmKind::Gemini => {
            args.extend(["--skip-trust".into(), "-p".into(), req.flatten(true)]);
            args.extend(["--output-format", "stream-json", "--approval-mode", "plan"].map(String::from));
            if !model.is_empty() {
                args.extend(["-m".into(), model.into()]);
            }
            envs.push(("GEMINI_CLI_TRUST_WORKSPACE".into(), "true".into()));
            stdin = None;
        }
        _ => unreachable!("not a CLI backend"),
    }
    Invocation { args, stdin, envs }
}

/// Parses one JSONL line. Returns (delta text to stream, final text if this is a terminal event).
fn parse_line(kind: LlmKind, v: &Value) -> Result<(Option<String>, Option<String>)> {
    let s = |v: &Value| v.as_str().map(str::to_string);
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
    Ok(match kind {
        LlmKind::ClaudeCode => match ty {
            "stream_event" => {
                let ev = &v["event"];
                if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                    (s(&ev["delta"]["text"]), None)
                } else {
                    (None, None)
                }
            }
            "result" => {
                if v["is_error"].as_bool().unwrap_or(false) {
                    bail!("Claude Code error: {}", s(&v["result"]).unwrap_or_else(|| v["subtype"].to_string()));
                }
                (None, s(&v["result"]))
            }
            _ => (None, None),
        },
        LlmKind::Codex => match ty {
            "item.completed" if v["item"]["type"] == "agent_message" => (s(&v["item"]["text"]), None),
            "turn.failed" | "error" => {
                let msg = s(&v["error"]["message"]).or_else(|| s(&v["message"])).unwrap_or_else(|| v.to_string());
                bail!("Codex error: {msg}")
            }
            _ => (None, None),
        },
        LlmKind::Opencode => match ty {
            "text" => (s(&v["part"]["text"]), None),
            "error" => bail!("opencode error: {}", v["error"]),
            _ => (None, None),
        },
        LlmKind::Antigravity => {
            let ev = v.get("event").and_then(Value::as_str).unwrap_or("");
            match ev {
                "step_update" if v["step_update"]["step_type"] == "agent_response" => {
                    (s(&v["step_update"]["text_delta"]), None)
                }
                "result" => {
                    if v["result"]["status"] != "SUCCESS" {
                        bail!("Antigravity error: {}", v["result"]);
                    }
                    (None, s(&v["result"]["response"]))
                }
                _ => (None, None),
            }
        }
        LlmKind::Gemini => match ty {
            "message" if v["role"] == "assistant" => (s(&v["content"]), None),
            "error" => bail!("Gemini CLI error: {}", v),
            _ => (None, None),
        },
        _ => (None, None),
    })
}

pub async fn complete(profile: &LlmProfile, req: &ChatRequest, on_delta: DeltaFn<'_>) -> Result<String> {
    let bin = shell_env::resolve_bin(Some(&profile.bin_path), profile.kind.default_bin())
        .ok_or_else(|| anyhow!("`{}` not found on PATH", profile.kind.default_bin()))?;
    let workdir = tempfile::tempdir()?;
    let inv = build(profile, req, workdir.path());

    let mut cmd = Command::new(&bin);
    cmd.args(&inv.args)
        .current_dir(workdir.path())
        .env("PATH", shell_env::path())
        .envs(inv.envs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(if inv.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().with_context(|| format!("spawning {}", bin.display()))?;

    if let Some(input) = inv.stdin {
        let mut stdin = child.stdin.take().unwrap();
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let mut stderr = child.stderr.take().unwrap();
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf).await;
        buf
    });

    let kind = profile.kind;
    let run = async {
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut streamed = String::new();
        let mut final_text: Option<String> = None;
        while let Some(line) = lines.next_line().await? {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
            let (delta, fin) = parse_line(kind, &v)?;
            if let Some(d) = delta {
                // Codex/opencode emit whole messages; separate consecutive ones.
                let d = if matches!(kind, LlmKind::Codex | LlmKind::Opencode) && !streamed.is_empty() {
                    format!("\n\n{d}")
                } else {
                    d
                };
                on_delta(&d);
                streamed.push_str(&d);
            }
            if fin.is_some() {
                final_text = fin;
            }
        }
        let status = child.wait().await?;
        Ok::<_, anyhow::Error>((status, final_text.unwrap_or(streamed)))
    };

    let (status, text) =
        tokio::time::timeout(TIMEOUT, run).await.map_err(|_| anyhow!("{} timed out", profile.kind.default_bin()))??;
    let stderr = stderr_task.await.unwrap_or_default();

    if !status.success() && text.trim().is_empty() {
        let tail: String =
            stderr.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        bail!("{} exited with {status}: {tail}", profile.kind.default_bin());
    }
    if text.trim().is_empty() {
        bail!("{} returned no output", profile.kind.default_bin());
    }
    Ok(text)
}

pub async fn version(bin: &Path) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(8),
        Command::new(bin)
            .arg("--version")
            .env("PATH", shell_env::path())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

pub async fn opencode_models(profile: &LlmProfile) -> Result<Vec<String>> {
    let bin =
        shell_env::resolve_bin(Some(&profile.bin_path), "opencode").ok_or_else(|| anyhow!("opencode not found"))?;
    let out = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new(bin).arg("models").env("PATH", shell_env::path()).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await??;
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| l.contains('/') && !l.contains(' '))
        .map(String::from)
        .collect())
}
