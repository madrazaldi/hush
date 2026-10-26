import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFile } from "./decode";
import { SAMPLE_RATE, afconvert, wavBytes } from "./wav";
import { which } from "../shell-env";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hush-dec-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, b) => a + b * b, 0) / x.length);

test("decodes and resamples wav and aac (afconvert)", async () => {
  const dir = tmp();
  // 44.1 kHz source: write at 44.1k so the decoder must resample.
  const rate = 44_100;
  const pcm = Float32Array.from({ length: rate * 2 }, (_, i) => Math.sin((i * 440 * Math.PI * 2) / rate) * 0.5);
  const wav = join(dir, "tone.wav");
  await Bun.write(wav, wavBytes(pcm, rate));
  const m4a = join(dir, "tone.m4a");
  afconvert([wav, "-o", m4a, "-f", "m4af", "-d", "aac"]);
  for (const p of [wav, m4a]) {
    const out = await decodeFile(p);
    const secs = out.length / SAMPLE_RATE;
    expect(Math.abs(secs - 2)).toBeLessThan(0.1);
    const mid = out.subarray(SAMPLE_RATE / 2, (SAMPLE_RATE * 3) / 2);
    expect(Math.abs(rms(mid) - 0.5 / Math.SQRT2)).toBeLessThan(0.02);
  }
});

test("ffmpeg fallback decodes opus and cancel stops it", async () => {
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) return;
  const path = join(tmp(), "tone.webm");
  const r = Bun.spawnSync([ffmpeg, "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", path]);
  expect(r.exitCode).toBe(0);
  const out = await decodeFile(path);
  expect(Math.abs(out.length / SAMPLE_RATE - 3)).toBeLessThan(0.1);
  const ctl = new AbortController();
  ctl.abort();
  await expect(decodeFile(path, ctl.signal)).rejects.toThrow("Cancelled");
});

test("missing file reports an error", async () => {
  await expect(decodeFile(join(tmp(), "nope.mp3"))).rejects.toThrow();
});
