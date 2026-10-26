// LLM backends: local agent CLIs (Claude Code, Codex, opencode, Antigravity/Gemini) and
// bring-your-own-key HTTP endpoints (Chat Completions, Responses, Anthropic).
//
// Every backend exposes the same streaming `complete` call; backends that cannot stream deltas simply
// emit the whole answer as one delta.

import type { CliStatus, LlmKind, LlmProfile } from "../../../lib/types";
import { which } from "../shell-env";
import * as cli from "./cli";
import * as http from "./http";
import type { ChatRequest } from "./request";

export { type ChatRequest, simpleRequest } from "./request";

export const isCli = (k: LlmKind) => k === "claude_code" || k === "codex" || k === "opencode" || k === "gemini" || k === "antigravity";

/** Upper bound on any single completion, so nothing that awaits one can hang. */
const TIMEOUT_MS = 15 * 60_000;

/** Run a completion, streaming text deltas to `onDelta`. Returns the full (trimmed) text. */
export async function complete(
  profile: LlmProfile,
  req: ChatRequest,
  opts: { signal?: AbortSignal; onDelta?: (d: string) => void } = {},
): Promise<string> {
  const onDelta = opts.onDelta ?? (() => {});
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  try {
    let text: string;
    switch (profile.kind) {
      case "openai_chat":
        text = await http.chatCompletions(profile, req, onDelta, signal);
        break;
      case "openai_responses":
        text = await http.responses(profile, req, onDelta, signal);
        break;
      case "anthropic":
        text = await http.anthropic(profile, req, onDelta, signal);
        break;
      default:
        text = await cli.complete(profile, req, onDelta, signal);
    }
    return text.trim();
  } catch (e) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    if (timeout.aborted) throw new Error(`${profile.name} took too long to respond`);
    throw e;
  }
}

/** Detect which agent CLIs are installed. */
export async function detectClis(): Promise<CliStatus[]> {
  const kinds: LlmKind[] = ["claude_code", "codex", "opencode", "gemini", "antigravity"];
  return Promise.all(
    kinds.map(async (kind) => {
      const path = which(cli.DEFAULT_BIN[kind]);
      return { kind, path, version: path ? await cli.version(path) : null };
    }),
  );
}

/** List models for HTTP backends (via /models) or CLIs that support listing. */
export async function listModels(profile: LlmProfile): Promise<string[]> {
  switch (profile.kind) {
    case "openai_chat":
    case "openai_responses":
    case "anthropic":
      return http.listModels(profile);
    case "opencode":
      return cli.opencodeModels(profile);
    case "claude_code":
      return ["haiku", "sonnet", "opus"];
    default:
      return [];
  }
}
