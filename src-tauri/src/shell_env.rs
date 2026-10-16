//! Resolves a usable PATH for spawning user CLIs (codex, claude, opencode, ffmpeg…).
//!
//! GUI apps launched from Finder/Dock inherit a minimal environment, so we ask the
//! user's login shell for its PATH once and merge in well-known install locations.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

static RESOLVED_PATH: OnceLock<String> = OnceLock::new();

const SENTINEL: &str = "__HUSH_PATH__";

/// The resolved PATH, computed once per process.
pub fn path() -> &'static str {
    RESOLVED_PATH.get_or_init(resolve)
}

fn resolve() -> String {
    let mut dirs: Vec<String> = Vec::new();
    let mut push = |d: String| {
        if !d.is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    };

    if let Some(p) = login_shell_path() {
        p.split(':').map(str::to_string).for_each(&mut push);
    }
    if let Ok(p) = std::env::var("PATH") {
        p.split(':').map(str::to_string).for_each(&mut push);
    }
    for d in fallback_dirs() {
        push(d.to_string_lossy().into_owned());
    }
    dirs.join(":")
}

#[cfg(unix)]
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", &format!("printf '{SENTINEL}%s{SENTINEL}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Interactive rc files can hang (prompts, plugins); bound the wait.
    let deadline = std::time::Instant::now() + Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25))
            }
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    let start = s.find(SENTINEL)? + SENTINEL.len();
    let end = s[start..].find(SENTINEL)? + start;
    Some(s[start..end].to_string())
}

#[cfg(not(unix))]
fn login_shell_path() -> Option<String> {
    None
}

fn fallback_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for rel in [
            ".local/bin",
            ".bun/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".opencode/bin",
            ".claude/local",
            ".codex/packages/standalone/current/bin",
        ] {
            v.push(home.join(rel));
        }
        // Newest nvm-managed node.
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            versions.sort();
            if let Some(latest) = versions.pop() {
                v.push(latest.join("bin"));
            }
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        v.push(PathBuf::from(d));
    }
    v
}

/// Find an executable by name on the resolved PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    which::which_in(name, Some(path()), std::env::temp_dir()).ok()
}

/// Resolve a binary either from an explicit user override or by name.
pub fn resolve_bin(override_path: Option<&str>, name: &str) -> Option<PathBuf> {
    match override_path.map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let pb = PathBuf::from(p);
            if pb.is_file() { Some(pb) } else { which(p) }
        }
        None => which(name),
    }
}
