import { expect, test } from "bun:test";
import { SseParser, type SseEvent } from "./sse";

const enc = new TextEncoder();

test("multibyte characters split across chunks", () => {
  const body = enc.encode("event: delta\ndata: café ☕\n\ndata: [DONE]\n\n");
  const cut1 = body.indexOf(0xc3) + 1;
  const cut2 = body.indexOf(0xe2) + 2;
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (const part of [body.subarray(0, cut1), body.subarray(cut1, cut2), body.subarray(cut2)]) p.feed(part, out);
  p.finish(out);
  expect(out).toEqual([
    { event: "delta", data: "café ☕" },
    { event: null, data: "[DONE]" },
  ]);
});

test("crlf, multiline data and unterminated tail", () => {
  const p = new SseParser();
  const out: SseEvent[] = [];
  p.feed(enc.encode(": comment\r\ndata: a\r\ndata: b\r\n\r\ndata: tail"), out);
  p.finish(out);
  expect(out[0].data).toBe("a\nb");
  expect(out[1].data).toBe("tail");
});
