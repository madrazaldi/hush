import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_RATE, WavSink, hasVoice, parseWav, readTracks, splitAtSilences, trimSilence, wavBytes, writeStereoAac } from "./wav";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hush-wav-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tone = (secs: number, hz = 440, amp = 0.5) =>
  Float32Array.from({ length: Math.floor(SAMPLE_RATE * secs) }, (_, i) => Math.sin((i * hz * Math.PI * 2) / SAMPLE_RATE) * amp);

test("wav round trip", () => {
  const pcm = tone(0.5);
  const w = parseWav(wavBytes(pcm));
  expect(w.rate).toBe(SAMPLE_RATE);
  expect(w.channels).toBe(1);
  expect(w.samples.length).toBe(pcm.length);
  expect(Math.abs(w.samples[100] - pcm[100])).toBeLessThan(1e-3);
});

test("wav sink patches the header on finish", () => {
  const p = join(tmp(), "s.wav");
  const s = new WavSink(p);
  s.write(tone(0.1));
  s.write(tone(0.1));
  s.finish();
  s.finish();
  expect(statSync(p).size).toBe(44 + 2 * 1600 * 2);
  expect(parseWav(readFileSync(p)).samples.length).toBe(3200);
});

test("splits at the quietest window in the last quarter", () => {
  const max = SAMPLE_RATE * 4;
  const pcm = tone(10);
  // Carve a silent gap at 3.5 s.
  pcm.fill(0, Math.floor(SAMPLE_RATE * 3.5), Math.floor(SAMPLE_RATE * 3.6));
  const parts = splitAtSilences(pcm, max);
  expect(parts.reduce((n, [, s]) => n + s.length, 0)).toBe(pcm.length);
  expect(parts[0][1].length).toBeGreaterThan(SAMPLE_RATE * 3.45);
  expect(parts[0][1].length).toBeLessThan(SAMPLE_RATE * 3.65);
  for (const [, s] of parts) expect(s.length).toBeLessThanOrEqual(max);
  expect(splitAtSilences(pcm, 0).length).toBe(1);
});

test("trim silence and voice detection", () => {
  const pcm = new Float32Array(SAMPLE_RATE * 3);
  pcm.set(tone(1), SAMPLE_RATE);
  const t = trimSilence(pcm);
  expect(t.length).toBeGreaterThan(SAMPLE_RATE);
  expect(t.length).toBeLessThan(SAMPLE_RATE * 1.5);
  expect(hasVoice(pcm)).toBe(true);
  expect(hasVoice(new Float32Array(SAMPLE_RATE))).toBe(false);
});

test("stereo aac round trip through afconvert", () => {
  const dir = tmp();
  const l = Int16Array.from(tone(1), (x) => x * 32767);
  const r = Int16Array.from(tone(1, 880), (x) => x * 32767);
  const out = join(dir, "m.m4a");
  writeStereoAac(out, l, r, SAMPLE_RATE, 48000);
  const [bl, br] = readTracks(out);
  expect(br).not.toBeNull();
  expect(Math.abs(bl.length - l.length)).toBeLessThan(SAMPLE_RATE * 0.1);
  expect(Math.abs(br!.length - bl.length)).toBeLessThan(2);
});
