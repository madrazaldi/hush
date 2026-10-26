import { expect, test } from "bun:test";
import { FRAME, HISTORY_FRAMES, SysEnvelope, frameRms } from "./bleed";
import { SAMPLE_RATE } from "./wav";

/** Deterministic noise with a syllable-like loudness envelope (same generator as the Rust test). */
function speechy(seed: number, secs: number): Float32Array {
  let x = BigInt.asUintN(64, BigInt(seed) * 6364136223846793005n + 1442695040888963407n);
  let envPhase = seed % 97;
  const n = Math.floor(SAMPLE_RATE * secs);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = BigInt.asUintN(64, x * 6364136223846793005n + 1442695040888963407n);
    const noise = Number(x >> 33n) / 2 ** 31 - 0.5;
    if (i % FRAME === 0) envPhase += 0.37 + Number((x >> 40n) % 7n) * 0.11;
    const env = (Math.sin(envPhase) * 0.5 + 0.5) ** 3;
    out[i] = noise * 0.4 * env;
  }
  return out;
}

function delayed(src: Float32Array, frames: number, gain: number): Float32Array {
  const d = frames * FRAME;
  const out = new Float32Array(src.length);
  for (let i = d; i < src.length; i++) out[i] = src[i - d] * gain;
  return out;
}

const frac = (m: boolean[]) => m.filter(Boolean).length / m.length;

test("detects a delayed copy of system audio", () => {
  const sys = speechy(1, 8);
  const mic = delayed(sys, 4, 0.15);
  const room = speechy(9, 8);
  for (let i = 0; i < mic.length; i++) mic[i] += room[i] * 0.01;
  const m = SysEnvelope.fromPcm(sys).suppress(mic, 0);
  expect(frac(m)).toBeGreaterThan(0.9);
});

test("keeps the user's own voice", () => {
  const sys = speechy(1, 8);
  const mic = speechy(42, 8);
  expect(frac(SysEnvelope.fromPcm(sys).suppress(mic, 0))).toBeLessThan(0.05);
});

test("keeps voice when the system is silent", () => {
  const mic = speechy(42, 4);
  const env = SysEnvelope.fromPcm(new Float32Array(mic.length));
  expect(env.suppress(mic, 0).some(Boolean)).toBe(false);
});

test("keeps own voice after bleed", () => {
  // 6 s of bleed, then 6 s of the user talking while the call is quiet.
  const first = speechy(1, 6);
  const sys = new Float32Array(first.length + FRAME * 200);
  sys.set(first);
  const mic = delayed(sys, 3, 0.2);
  const own = speechy(7, 6);
  const off = FRAME * 200;
  const total = new Float32Array(Math.max(mic.length, off + own.length));
  total.set(mic);
  for (let i = 0; i < own.length; i++) total[off + i] += own[i];
  const silenced = SysEnvelope.fromPcm(sys).suppressAll(total);
  const a = frameRms(total.subarray(0, off));
  const b = frameRms(total.subarray(off + FRAME * 20));
  expect(silenced).toBeGreaterThan(150);
  expect(Array.from(a).filter((r) => r > 0).length).toBeLessThan(a.length / 5);
  expect(Array.from(b).filter((r) => r > 0).length).toBeGreaterThan((b.length * 9) / 10);
});

test("suppresses bleed across blocks", () => {
  const sys = speechy(3, 50);
  const mic = delayed(sys, 2, 0.15);
  const silenced = SysEnvelope.fromPcm(sys).suppressAll(mic);
  const frames = Math.ceil(mic.length / FRAME);
  expect(silenced * 10).toBeGreaterThan(frames * 9);
  const tail = frameRms(mic.subarray(mic.length - FRAME * 600));
  expect(Array.from(tail).filter((r) => r > 0).length).toBeLessThan(tail.length / 10);
});

test("live history is bounded and aligned", () => {
  const env = SysEnvelope.live();
  for (let f = 100; f < 100 + HISTORY_FRAMES + 50; f++) env.push(f, f);
  expect(env.length).toBe(HISTORY_FRAMES);
  const r = env.range(150 + HISTORY_FRAMES - 2, 152 + HISTORY_FRAMES);
  expect(Array.from(r)).toEqual([148 + HISTORY_FRAMES, 149 + HISTORY_FRAMES, 0, 0]);
  expect(Array.from(env.range(10, 12))).toEqual([0, 0]);
});
