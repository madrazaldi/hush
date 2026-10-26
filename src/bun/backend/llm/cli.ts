// Agent CLI backends. Each CLI runs one-shot, sandboxed/tool-less where possible, in an empty temp
// directory, with JSONL output that we parse into text deltas.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmKind, LlmProfile } from "../../../lib/types";
import { childEnv, resolveBin } from "../shell-env";
import type { DeltaFn } from "./http";
import { type ChatRequest, flattenRequest } from "./request";

const TIMEOUT_MS = 600_000;

export const DEFAULT_BIN: Record<LlmKind, string> = {
  claude_code: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  antigravity: "agy",
  openai_chat: "",
  openai_responses: "",
  anthropic: "",
};

/** Codex tools Hush never needs. Text in, text out. */
const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "apps",
  "plugins",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "multi_agent_v2",
  "skill_search",
  "tool_suggest",
  "memories",
  "hooks",
  "code_mode_host",
];

export interface Invocation {
  args: string[];
  stdin: string | null;
  envs: Record<string, string>;
}

export function build(profile: LlmProfile, req: ChatRequest, workdir: string): Invocation {
  const model = profile.model.trim();
  const effort = profile.effort.trim();
  const envs: Record<string, string> = {};
  const args: string[] = [];
  let stdin: string | null = null;

  switch (profile.kind) {
    case "claude_code":
      args.push(
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
      );
      if (req.system.trim() !== "") args.push("--system-prompt", req.system);
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      stdin = flattenRequest(req, false);
      break;
    case "codex":
      args.push("exec", "--json", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "--ignore-user-config", "--ignore-rules", "--color", "never", "-C", workdir);
      // The read-only sandbox still lets tools read any file on disk, so turn off everything that could
      // reach the filesystem or network. Set via `-c` (not `--disable`) so unknown names in older or
      // newer Codex versions are ignored instead of failing the run.
      for (const f of CODEX_DISABLED_FEATURES) args.push("-c", `features.${f}=false`);
      args.push("-c", 'web_search="disabled"');
      if (model) args.push("-m", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push("-");
      stdin = flattenRequest(req, true);
      break;
    case "opencode":
      args.push("run", "--format", "json");
      if (model) args.push("-m", model);
      args.push(flattenRequest(req, true));
      envs.OPENCODE_CONFIG_CONTENT = '{"permission":"deny","share":"disabled","autoupdate":false}';
      envs.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
      envs.OPENCODE_DISABLE_AUTOUPDATE = "1";
      break;
    case "antigravity":
      args.push("-p", flattenRequest(req, true), "--output-format", "stream-json", "--mode", "plan");
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      break;
    case "gemini":
      args.push("--skip-trust", "-p", flattenRequest(req, true), "--output-format", "stream-json", "--approval-mode", "plan");
      if (model) args.push("-m", model);
      envs.GEMINI_CLI_TRUST_WORKSPACE = "true";
      break;
    default:
      throw new Error("not a CLI backend");
  }
  return { args, stdin, envs };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Parses one JSONL event. Returns the delta text to stream and the final text if this is a terminal event. */
export function parseLine(kind: LlmKind, v: any): { delta: string | null; final: string | null } {
  const none = { delta: null, final: null };
  const ty: string = typeof v?.type === "string" ? v.type : "";
  switch (kind) {
    case "claude_code":
      if (ty === "stream_event") {
        const ev = v.event;
        return ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" ? { delta: str(ev.delta.text), final: null } : none;
      }
      if (ty === "result") {
        if (v.is_error === true) throw new Error(`Claude Code error: ${str(v.result) ?? JSON.stringify(v.subtype)}`);
        return { delta: null, final: str(v.result) };
      }
      return none;
    case "codex":
      if (ty === "item.completed" && v.item?.type === "agent_message") return { delta: str(v.item.text), final: null };
      if (ty === "turn.failed" || ty === "error") {
        throw new Error(`Codex error: ${str(v.error?.message) ?? str(v.message) ?? JSON.stringify(v)}`);
      }
      return none;
    case "opencode":
      if (ty === "text") return { delta: str(v.part?.text), final: null };
      if (ty === "error") throw new Error(`opencode error: ${JSON.stringify(v.error)}`);
      return none;
    case "antigravity": {
      const ev = typeof v?.event === "string" ? v.event : "";
      if (ev === "step_update" && v.step_update?.step_type === "agent_response") return { delta: str(v.step_update.text_delta), final: null };
      if (ev === "result") {
        if (v.result?.status !== "SUCCESS") throw new Error(`Antigravity error: ${JSON.stringify(v.result)}`);
        return { delta: null, final: str(v.result.response) };
      }
      return none;
    }
    case "gemini":
      if (ty === "message" && v.role === "assistant") return { delta: str(v.content), final: null };
      if (ty === "error") throw new Error(`Gemini CLI error: ${JSON.stringify(v)}`);
      return none;
    default:
      return none;
  }
}

export async function complete(profile: LlmProfile, req: ChatRequest, onDelta: DeltaFn, signal?: AbortSignal): Promise<string> {
  const name = DEFAULT_BIN[profile.kind];
  const bin = resolveBin(profile.bin_path, name);
  if (!bin) throw new Error(`\`${name}\` not found on PATH`);
  const workdir = mkdtempSync(join(tmpdir(), "hush-llm-"));
  let geminiHome: string | null = null;
  try {
    const inv = build(profile, req, workdir);
    // Gemini CLI saves every session under its home dir and has no switch to stop that, so give it a
    // throwaway home holding only the sign-in state.
    if (profile.kind === "gemini") {
      geminiHome = mkdtempSync(join(tmpdir(), "hush-gemini-"));
      prepareGeminiHome(geminiHome);
      inv.envs.GEMINI_CLI_HOME = geminiHome;
    }

    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const proc = Bun.spawn([bin, ...inv.args], {
      cwd: workdir,
      env: childEnv(inv.envs),
      stdin: inv.stdin === null ? "ignore" : new Blob([inv.stdin]),
      stdout: "pipe",
      stderr: "pipe",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const stderrP = new Response(proc.stderr).text().catch(() => "");

    let streamed = "";
    let finalText: string | null = null;
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let pending = "";
    const handle = (raw: string) => {
      const line = raw.trim();
      if (line === "") return;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        return;
      }
      const { delta, final } = parseLine(profile.kind, v);
      if (delta !== null) {
        // Codex/opencode emit whole messages; separate consecutive ones.
        const d = (profile.kind === "codex" || profile.kind === "opencode") && streamed !== "" ? `\n\n${delta}` : delta;
        onDelta(d);
        streamed += d;
      }
      if (final !== null) finalText = final;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          handle(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      }
      handle(pending);
    } catch (e) {
      proc.kill();
      if (signal?.aborted) throw new Error("cancelled");
      if (timeout.aborted) throw new Error(`${name} timed out`);
      throw e;
    }
    const code = await proc.exited;
    if (signal?.aborted) throw new Error("cancelled");
    if (timeout.aborted) throw new Error(`${name} timed out`);
    const stderr = await stderrP;
    const text = finalText ?? streamed;
    if (code !== 0 && text.trim() === "") {
      const tail = stderr.split("\n").filter((l) => l !== "").slice(-8).join("\n");
      throw new Error(`${name} exited with ${code}: ${tail}`);
    }
    if (text.trim() === "") throw new Error(`${name} returned no output`);
    return text;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    if (geminiHome) rmSync(geminiHome, { recursive: true, force: true });
  }
}

/**
 * Copy just the sign-in files from `~/.gemini` into a fresh `<home>/.gemini`. Settings are reduced to
 * the auth choice, so user MCP servers, extensions and hooks don't load either.
 */
function prepareGeminiHome(home: string): void {
  const dst = join(home, ".gemini");
  mkdirSync(dst, { recursive: true });
  const src = join(homedir(), ".gemini");
  for (const name of ["oauth_creds.json", "google_accounts.json", "installation_id", "user_id", ".env"]) {
    const from = join(src, name);
    if (existsSync(from) && statSync(from).isFile()) copyFileSync(from, join(dst, name));
  }
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(src, "settings.json"), "utf8"));
  } catch {
    // none
  }
  const slim: Record<string, unknown> = {};
  for (const key of ["security", "selectedAuthType"]) if (key in settings) slim[key] = settings[key];
  writeFileSync(join(dst, "settings.json"), JSON.stringify(slim, null, 2));
}

export async function version(bin: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(8000) });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const line = out.split("\n")[0]?.trim();
    return line ? line : null;
  } catch {
    return null;
  }
}

export async function opencodeModels(profile: LlmProfile): Promise<string[]> {
  const bin = resolveBin(profile.bin_path, "opencode");
  if (!bin) throw new Error("opencode not found");
  const proc = Bun.spawn([bin, "models"], { env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(30_000) });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("/") && !l.includes(" "));
}
