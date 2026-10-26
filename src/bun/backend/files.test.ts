import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_RATE, writeWav } from "./audio/wav";
import { Db } from "./db";
import { onEvent } from "./events";
import { FileQueue } from "./files";
import { initPaths } from "./paths";
import { defaultSettings } from "./settings";
import { initState } from "./state";

const dir = mkdtempSync(join(tmpdir(), "hush-files-"));
let server: ReturnType<typeof Bun.serve>;
let db: Db;
const events: any[] = [];
let off = () => {};

beforeAll(() => {
  initPaths(dir);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.formData();
      return Response.json({ language: "english", text: "Hello there.", segments: [{ start: 0, end: 1.5, text: " Hello there." }] });
    },
  });
  const settings = defaultSettings();
  settings.stt_profiles = [{ id: "mock", name: "Mock", kind: "openai_compatible", model: "whisper-1", base_url: `http://localhost:${server.port}/v1`, api_key: "k" }];
  settings.files.stt_profile = "mock";
  db = new Db(join(dir, "t.db"));
  initState({ settings, db, dictation: null as any, meetings: null as any, files: null as any, llmTasks: new Map() });
  off = onEvent((e, p) => events.push([e, p]));
});
afterAll(() => {
  off();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(25);
  expect(cond()).toBe(true);
};

test("transcribes a file through the queue and reports progress", async () => {
  // A speech-like amplitude-modulated tone.
  const pcm = Float32Array.from({ length: SAMPLE_RATE * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SAMPLE_RATE)));
  const wav = join(dir, "My Talk.wav");
  writeWav(wav, pcm);
  const q = new FileQueue();
  const rec = q.addFile(wav);
  expect(rec.title).toBe("My Talk");
  expect(rec.status).toBe("queued");
  await waitFor(() => db.getRecording(rec.id)?.status === "ready");
  const done = db.getRecording(rec.id)!;
  expect(done.segments.map((s) => s.text.trim())).toEqual(["Hello there."]);
  expect(done.language).toBe("en");
  expect(Math.abs(done.duration_ms - 2000)).toBeLessThan(50);
  expect(done.progress).toBe(1);
  const stages = events.filter(([e, p]) => e === "recording:progress" && p.id === rec.id).map(([, p]) => p.stage || p.status);
  expect(stages).toContain("decoding");
  expect(stages).toContain("transcribing");
  expect(stages.at(-1)).toBe("ready");
});

test("a failing job is marked as an error, and queued jobs can be cancelled", async () => {
  const q = new FileQueue();
  const bad = q.addFile(join(dir, "My Talk.wav").replace("My Talk", "My Talk")); // valid file
  // A link that cannot be fetched fails quickly.
  const failing = q.addUrl("http://127.0.0.1:1/nope.mp3");
  const queued = q.addUrl("http://127.0.0.1:1/other.mp3");
  q.cancel(queued.id);
  await waitFor(() => db.getRecording(failing.id)?.status === "error");
  expect(db.getRecording(failing.id)!.error).toBeTruthy();
  await waitFor(() => db.getRecording(bad.id)?.status === "ready");
  expect(db.getRecording(queued.id)!.status).toBe("error");
  expect(db.getRecording(queued.id)!.error).toBe("Cancelled");
});

test("input validation", () => {
  const q = new FileQueue();
  expect(() => q.addUrl("ftp://x")).toThrow("Enter a full http(s) link");
  expect(() => q.addFile(join(dir, "missing.wav"))).toThrow("is not a file");
});
