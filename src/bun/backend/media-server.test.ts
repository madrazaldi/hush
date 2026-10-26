import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRange, startMediaServer, type MediaServer } from "./media-server";
import { initPaths, mediaDir } from "./paths";

const dir = mkdtempSync(join(tmpdir(), "hush-media-"));
const outside = mkdtempSync(join(tmpdir(), "hush-outside-"));
let srv: MediaServer;
const known = new Set<string>();

beforeAll(() => {
  initPaths(dir);
  writeFileSync(join(dir, "media", "a.mp3"), Buffer.from("0123456789"));
  writeFileSync(join(outside, "b.mp4"), Buffer.from("abcdefghij"));
  writeFileSync(join(outside, "secret.txt"), "nope");
  known.add(join(outside, "b.mp4"));
  srv = startMediaServer({ isKnownMedia: (p) => known.has(p) });
});
afterAll(() => {
  srv.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const file = (p: string, headers: Record<string, string> = {}) => fetch(`${srv.baseUrl}/file?path=${encodeURIComponent(p)}`, { headers });

test("range parsing", () => {
  expect(parseRange(null, 10)).toBeNull();
  expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
  expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
  expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
  expect(parseRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
  expect(parseRange("bytes=10-", 10)).toBe("bad");
  expect(parseRange("bytes=4-2", 10)).toBe("bad");
  expect(parseRange("items=1-2", 10)).toBe("bad");
});

test("serves files in the data dir, with ranges", async () => {
  const p = join(dir, "media", "a.mp3");
  const full = await file(p);
  expect(full.status).toBe(200);
  expect(full.headers.get("content-type")).toBe("audio/mpeg");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(await full.text()).toBe("0123456789");
  const part = await file(p, { range: "bytes=2-5" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(await part.text()).toBe("2345");
  const tail = await file(p, { range: "bytes=-3" });
  expect(await tail.text()).toBe("789");
  expect((await file(p, { range: "bytes=50-" })).status).toBe(416);
});

test("serves recording media outside the data dir, and nothing else", async () => {
  expect(await (await file(join(outside, "b.mp4"))).text()).toBe("abcdefghij");
  expect((await file(join(outside, "secret.txt"))).status).toBe(403);
  expect((await file("/etc/hosts")).status).toBe(403);
  expect((await file("relative.mp3")).status).toBe(403);
  expect((await file(join(dir, "media", "..", "..", "etc", "hosts"))).status).toBe(403);
});

test("requires the token", async () => {
  const bad = srv.baseUrl.replace(/\/[^/]+$/, "/wrong");
  expect((await fetch(`${bad}/file?path=${encodeURIComponent(join(dir, "media", "a.mp3"))}`)).status).toBe(404);
  expect((await fetch(`${srv.baseUrl.replace(/\/[^/]+$/, "")}/file`)).status).toBe(404);
});

test("accepts uploads into the media directory", async () => {
  const res = await fetch(`${srv.baseUrl}/upload?name=${encodeURIComponent("../../evil name.wav")}`, { method: "POST", body: "RIFFdata" });
  expect(res.status).toBe(200);
  const { path } = (await res.json()) as { path: string };
  expect(path.startsWith(`${mediaDir()}/`)).toBe(true);
  expect(path.endsWith("/evil name.wav")).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("RIFFdata");
  // CORS preflight for the webview's cross-origin fetch.
  const pre = await fetch(`${srv.baseUrl}/upload`, { method: "OPTIONS" });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-origin")).toBe("*");
});
