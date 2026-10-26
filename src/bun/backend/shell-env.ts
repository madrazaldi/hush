// Resolves a usable PATH for spawning user CLIs (codex, claude, opencode, ffmpeg...).
//
// GUI apps launched from Finder/Dock inherit a minimal environment, so we ask the user's login shell
// for its PATH once and merge in well-known install locations.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SENTINEL = "__HUSH_PATH__";
let resolved: string | null = null;

/** The resolved PATH, computed once per process (blocks for up to ~4 s on the first call). */
export function path(): string {
  resolved ??= resolve();
  return resolved;
}

/** Kick off resolution in the background so the first real use is instant. */
export function warm(): void {
  setTimeout(() => void path(), 0);
}

export function mergePaths(...lists: (string | undefined)[]): string {
  const dirs: string[] = [];
  for (const l of lists) for (const d of (l ?? "").split(":")) if (d && !dirs.includes(d)) dirs.push(d);
  return dirs.join(":");
}

function resolve(): string {
  return mergePaths(loginShellPath(), process.env.PATH, fallbackDirs().join(":"));
}

function loginShellPath(): string {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // Interactive rc files can hang (prompts, plugins); bound the wait.
    const r = Bun.spawnSync([shell, "-ilc", `printf '${SENTINEL}%s${SENTINEL}' "$PATH"`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 4000,
      killSignal: "SIGKILL",
    });
    const s = r.stdout.toString();
    const start = s.indexOf(SENTINEL);
    if (start < 0) return "";
    const from = start + SENTINEL.length;
    const end = s.indexOf(SENTINEL, from);
    return end < 0 ? "" : s.slice(from, end);
  } catch {
    return "";
  }
}

function fallbackDirs(): string[] {
  const v: string[] = [];
  const home = homedir();
  for (const rel of [
    ".local/bin",
    ".bun/bin",
    ".cargo/bin",
    ".npm-global/bin",
    ".volta/bin",
    ".opencode/bin",
    ".claude/local",
    ".codex/packages/standalone/current/bin",
  ]) {
    v.push(join(home, rel));
  }
  // Newest nvm-managed node.
  try {
    const versions = readdirSync(join(home, ".nvm/versions/node")).sort();
    const latest = versions.pop();
    if (latest) v.push(join(home, ".nvm/versions/node", latest, "bin"));
  } catch {
    // no nvm
  }
  v.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  return v;
}

/** Find an executable by name on the resolved PATH. */
export function which(name: string): string | null {
  if (name.includes("/")) return isFile(name) ? name : null;
  return Bun.which(name, { PATH: path() });
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a binary either from an explicit user override or by name. */
export function resolveBin(overridePath: string | null | undefined, name: string): string | null {
  const o = overridePath?.trim();
  if (o) return isFile(o) ? o : which(o);
  return which(name);
}

/** Environment for child processes: the process env with the resolved PATH. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.PATH = path();
  return { ...env, ...extra };
}

