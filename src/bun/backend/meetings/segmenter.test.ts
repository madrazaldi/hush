import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SysEnvelope } from "../audio/bleed";
import { SAMPLE_RATE } from "../audio/wav";
import { ChunkQueue, MAX_QUEUED_SAMPLES, ME, Segmenter, THEM } from "./segmenter";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hush-seg-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Noise with a syllable-like loudness envelope, like speech (a flat tone would drag the noise floor up). */
function burst(secs: number, amp: number, seed = 1): Float32Array {
  let x = BigInt.asUintN(64, BigInt(seed) * 6364136223846793005n + 1442695040888963407n);
  let phase = seed % 97;
  const n = Math.floor(SAMPLE_RATE * secs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = BigInt.asUintN(64, x * 6364136223846793005n + 1442695040888963407n);
    const noise = Number(x >> 33n) / 2 ** 31 - 0.5;
    if (i % 480 === 0) phase += 0.5 + Number((x >> 40n) % 7n) * 0.05;
    out[i] = noise * 2 * amp * (0.35 + 0.65 * Math.abs(Math.sin(phase)));
  }
  return out;
}
const silence = (secs: number) => new Float32Array(Math.floor(SAMPLE_RATE * secs));

test("cuts utterances at silence and timestamps them on the timeline", async () => {
  const q = new ChunkQueue("m", tmp());
  const seg = new Segmenter(THEM, 5000, q, null, SysEnvelope.live());
  // 1 s of near-silence, 2 s speech, 2 s silence, 2 more seconds of speech, 2 s silence.
  for (const part of [burst(1, 0.0005), burst(2, 0.3), silence(2), burst(2, 0.3, 7), silence(2)]) seg.push(part);
  seg.finish();
  q.close();
  const first = await q.next();
  expect(first).not.toBeNull();
  expect(first!.speaker).toBe(THEM);
  // starts ~1 s into the stream (minus 300 ms preroll) on top of the 5 s offset
  expect(first!.startMs).toBeGreaterThan(5000 + 600);
  expect(first!.startMs).toBeLessThan(5000 + 1100);
  const pcm = first!.pcm as Float32Array;
  expect(pcm.length / SAMPLE_RATE).toBeGreaterThan(2);
  expect(pcm.length / SAMPLE_RATE).toBeLessThan(3.2);
  const second = await q.next();
  expect(second!.startMs).toBeGreaterThan(5000 + 4500);
  expect(await q.next()).toBeNull();
  expect(seg.durationMs()).toBe(5000 + 9000);
});

test("pure silence produces no chunks", async () => {
  const q = new ChunkQueue("m", tmp());
  const seg = new Segmenter(THEM, 0, q, null, SysEnvelope.live());
  seg.push(silence(3));
  seg.finish();
  q.close();
  expect(await q.next()).toBeNull();
});

test("mic speech that mirrors the system audio is dropped as bleed", async () => {
  const env = SysEnvelope.live();
  const q = new ChunkQueue("m", tmp());
  const them = new Segmenter(THEM, 0, q, null, env);
  const me = new Segmenter(ME, 0, q, null, env);
  const speech = burst(3, 0.3);
  them.push(speech);
  // The mic hears a quieter copy of the same audio.
  me.push(Float32Array.from(speech, (x) => x * 0.15));
  me.push(silence(1.5));
  them.push(silence(1.5));
  me.finish();
  them.finish();
  q.close();
  const speakers: string[] = [];
  for (let c = await q.next(); c; c = await q.next()) speakers.push(c.speaker);
  expect(speakers).toEqual([THEM]);
});

test("backlog beyond five minutes is spooled to disk and read back", async () => {
  const dir = tmp();
  const q = new ChunkQueue("m", join(dir, "spool"));
  q.send(THEM, 0, new Float32Array(MAX_QUEUED_SAMPLES - 10).fill(0.1));
  q.send(THEM, 1, Float32Array.from({ length: 100 }, (_, i) => i / 200));
  q.close();
  const a = await q.next();
  const b = await q.next();
  expect(typeof a!.pcm).toBe("object");
  expect(typeof b!.pcm).toBe("string");
  const loaded = q.load(b!.pcm);
  expect(loaded.length).toBe(100);
  expect(Math.abs(loaded[50] - 0.25)).toBeLessThan(1e-3);
  q.load(a!.pcm);
  expect(q.queued).toBe(0);
});
