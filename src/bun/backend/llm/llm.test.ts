import { expect, test } from "bun:test";
import type { LlmProfile } from "../../../lib/types";
import { build, parseLine } from "./cli";
import { anthropic, chatCompletions, stripThink } from "./http";
import { complete } from "./index";
import { simpleRequest } from "./request";

const profile = (over: Partial<LlmProfile>): LlmProfile => ({
  id: "p",
  name: "P",
  kind: "openai_chat",
  model: "m",
  base_url: "",
  api_key: "",
  bin_path: "",
  effort: "",
  ...over,
});

test("strip think blocks", () => {
  expect(stripThink("a<think>x</think>b<think>y</think>c")).toBe("abc");
  expect(stripThink("a<think>unterminated")).toBe("a");
});

test("claude code stream events", () => {
  const d = parseLine("claude_code", { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } } });
  expect(d).toEqual({ delta: "hi", final: null });
  expect(parseLine("claude_code", { type: "result", result: "done" }).final).toBe("done");
  expect(() => parseLine("claude_code", { type: "result", is_error: true, result: "bad" })).toThrow("Claude Code error: bad");
});

test("codex, opencode, gemini, antigravity lines", () => {
  expect(parseLine("codex", { type: "item.completed", item: { type: "agent_message", text: "x" } }).delta).toBe("x");
  expect(() => parseLine("codex", { type: "turn.failed", error: { message: "no" } })).toThrow("Codex error: no");
  expect(parseLine("opencode", { type: "text", part: { text: "y" } }).delta).toBe("y");
  expect(parseLine("gemini", { type: "message", role: "assistant", content: "z" }).delta).toBe("z");
  expect(parseLine("gemini", { type: "message", role: "user", content: "z" }).delta).toBeNull();
  expect(parseLine("antigravity", { event: "result", result: { status: "SUCCESS", response: "r" } }).final).toBe("r");
});

test("cli invocations are tool-less and keep prompts out of argv where stdin is used", () => {
  const req = simpleRequest("sys", "hello");
  const claude = build(profile({ kind: "claude_code", model: "haiku" }), req, "/tmp/w");
  expect(claude.args).toContain("--system-prompt");
  expect(claude.args).toContain("haiku");
  expect(claude.stdin).toBe("hello");
  const codex = build(profile({ kind: "codex", effort: "low" }), req, "/tmp/w");
  expect(codex.args.slice(-1)).toEqual(["-"]);
  expect(codex.args).toContain("features.shell_tool=false");
  expect(codex.args).toContain('model_reasoning_effort="low"');
  expect(codex.stdin).toBe("sys\n\nhello");
});

function sse(chunks: string[]) {
  return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("openai chat streaming against a local server", async () => {
  let seen: any;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = { url: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() };
      return sse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo<think>hm</think>"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    },
  });
  try {
    const deltas: string[] = [];
    const p = profile({ base_url: `http://localhost:${server.port}/v1/`, api_key: " k " });
    const req = { ...simpleRequest("sys", "hi"), temperature: 0.2 };
    const out = await chatCompletions(p, req, (d) => deltas.push(d));
    expect(out).toBe("Hello");
    expect(deltas.join("")).toBe("Hello<think>hm</think>");
    expect(seen.url).toBe("/v1/chat/completions");
    expect(seen.auth).toBe("Bearer k");
    expect(seen.body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(seen.body.temperature).toBe(0.2);
  } finally {
    server.stop(true);
  }
});

test("anthropic streaming and http errors", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname.startsWith("/fail")) return new Response('{"error":{"message":"nope"}}', { status: 401 });
      return sse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ignored"}}\n\n',
      ]);
    },
  });
  try {
    const p = profile({ kind: "anthropic", base_url: `http://localhost:${server.port}` });
    expect(await complete(p, simpleRequest("", "q"))).toBe("A");
    await expect(complete({ ...p, base_url: `http://localhost:${server.port}/fail` }, simpleRequest("", "q"))).rejects.toThrow("nope");
    await expect(anthropic({ ...p, model: "" }, simpleRequest("", "q"), () => {})).rejects.toThrow("No model configured");
  } finally {
    server.stop(true);
  }
});

test("cancelling aborts the request", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  try {
    const ctl = new AbortController();
    const p = profile({ base_url: `http://localhost:${server.port}` });
    const run = complete(p, simpleRequest("", "q"), { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await expect(run).rejects.toThrow("cancelled");
  } finally {
    server.stop(true);
  }
});
