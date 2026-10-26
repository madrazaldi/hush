// Bring-your-own-key HTTP backends with SSE streaming.

import type { LlmProfile } from "../../../lib/types";
import type { ChatRequest } from "./request";
import { forEachEvent } from "./sse";

export type DeltaFn = (delta: string) => void;

/** A stalled stream fails instead of hanging. Generous, since reasoning models can think for minutes. */
const READ_TIMEOUT_MS = 300_000;

function base(profile: LlmProfile, dflt: string): string {
  const b = profile.base_url.trim().replace(/\/+$/, "");
  return b === "" ? dflt : b;
}

/** Joins `base` and `path`. */
export function join(b: string, path: string): string {
  return `${b}/${path.replace(/^\/+/, "")}`;
}

async function check(resp: Response): Promise<Response> {
  if (resp.ok) return resp;
  const body = await resp.text().catch(() => "");
  let msg = body;
  try {
    const m = JSON.parse(body)?.error?.message;
    if (typeof m === "string") msg = m;
  } catch {
    // not JSON
  }
  throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${Array.from(msg).slice(0, 500).join("")}`);
}

/** fetch whose abort covers connect and every stall of `READ_TIMEOUT_MS`; `touch` re-arms the timer. */
function request(url: string, init: RequestInit, signal?: AbortSignal) {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(new Error("the server stopped responding")), READ_TIMEOUT_MS);
  };
  const onAbort = () => ctl.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  // A signal aborted before this call never fires "abort".
  if (signal?.aborted) onAbort();
  touch();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
  const send = fetch(url, { ...init, signal: ctl.signal }).then(check);
  return { send, touch, done };
}

const bearer = (key: string): Record<string, string> => (key.trim() === "" ? {} : { Authorization: `Bearer ${key.trim()}` });

function requireModel(p: LlmProfile): string {
  const m = p.model.trim();
  if (m === "") throw new Error(`No model configured for "${p.name}"`);
  return m;
}

async function stream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  onEvent: (ev: { event: string | null; data: string }, push: (d: string) => void) => boolean,
  onDelta: DeltaFn,
): Promise<string> {
  const r = request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }, signal);
  let out = "";
  try {
    const resp = await r.send;
    const push = (d: string) => {
      onDelta(d);
      out += d;
    };
    await forEachEvent(resp, (ev) => {
      r.touch();
      return onEvent(ev, push);
    });
  } finally {
    r.done();
  }
  return out;
}

function parse(data: string): any | undefined {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export async function chatCompletions(profile: LlmProfile, req: ChatRequest, onDelta: DeltaFn, signal?: AbortSignal): Promise<string> {
  const url = join(base(profile, "https://api.openai.com/v1"), "chat/completions");
  const messages: { role: string; content: string }[] = [];
  if (req.system.trim() !== "") messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role === "user" ? "user" : "assistant", content: m.content });
  const body: Record<string, unknown> = { model: requireModel(profile), messages, stream: true };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (profile.effort.trim() !== "") body.reasoning_effort = profile.effort.trim();
  const out = await stream(
    url,
    bearer(profile.api_key),
    body,
    signal,
    (ev, push) => {
      if (ev.data.trim() === "[DONE]") return false;
      const v = parse(ev.data);
      if (!v) return true;
      if (v.error) throw new Error(v.error.message ?? "stream error");
      const d = v.choices?.[0]?.delta?.content;
      if (typeof d === "string") push(d);
      return true;
    },
    onDelta,
  );
  return stripThink(out);
}

export async function responses(profile: LlmProfile, req: ChatRequest, onDelta: DeltaFn, signal?: AbortSignal): Promise<string> {
  const url = join(base(profile, "https://api.openai.com/v1"), "responses");
  const input = req.messages.map((m) =>
    m.role === "user"
      ? { role: "user", content: [{ type: "input_text", text: m.content }] }
      : { role: "assistant", content: [{ type: "output_text", text: m.content }] },
  );
  const body: Record<string, unknown> = { model: requireModel(profile), instructions: req.system, input, stream: true, store: false };
  if (profile.effort.trim() !== "") body.reasoning = { effort: profile.effort.trim() };
  const out = await stream(
    url,
    bearer(profile.api_key),
    body,
    signal,
    (ev, push) => {
      const v = parse(ev.data);
      if (!v) return true;
      const ty: string = v.type ?? ev.event ?? "";
      switch (ty) {
        case "response.output_text.delta":
          if (typeof v.delta === "string") push(v.delta);
          break;
        case "response.completed":
          return false;
        case "response.failed":
        case "error":
          throw new Error(v.response?.error?.message ?? v.message ?? v.error?.message ?? "response failed");
      }
      return true;
    },
    onDelta,
  );
  return stripThink(out);
}

export async function anthropic(profile: LlmProfile, req: ChatRequest, onDelta: DeltaFn, signal?: AbortSignal): Promise<string> {
  const url = join(base(profile, "https://api.anthropic.com/v1"), "messages");
  const messages = req.messages.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));
  const body: Record<string, unknown> = { model: requireModel(profile), max_tokens: 16000, messages, stream: true };
  if (req.system.trim() !== "") body.system = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return stream(
    url,
    { "x-api-key": profile.api_key.trim(), "anthropic-version": "2023-06-01" },
    body,
    signal,
    (ev, push) => {
      const v = parse(ev.data);
      if (!v) return true;
      switch (v.type ?? "") {
        case "content_block_delta":
          if (v.delta?.type === "text_delta" && typeof v.delta.text === "string") push(v.delta.text);
          break;
        case "message_stop":
          return false;
        case "error":
          throw new Error(v.error?.message ?? "stream error");
      }
      return true;
    },
    onDelta,
  );
}

export async function listModels(profile: LlmProfile): Promise<string[]> {
  const isAnthropic = profile.kind === "anthropic";
  const url = join(base(profile, isAnthropic ? "https://api.anthropic.com/v1" : "https://api.openai.com/v1"), "models");
  const headers = isAnthropic ? { "x-api-key": profile.api_key.trim(), "anthropic-version": "2023-06-01" } : bearer(profile.api_key);
  const r = request(url, { headers }, undefined);
  try {
    const v = (await (await r.send).json()) as { data?: { id?: unknown }[] };
    return (v.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
  } finally {
    r.done();
  }
}

/** Removes `<think>...</think>` blocks some local reasoning models emit inline. */
export function stripThink(s: string): string {
  let out = s;
  for (;;) {
    const start = out.indexOf("<think>");
    if (start < 0) return out;
    const end = out.indexOf("</think>", start);
    if (end < 0) return out.slice(0, start);
    out = out.slice(0, start) + out.slice(end + "</think>".length);
  }
}
