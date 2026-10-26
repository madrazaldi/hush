import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_RATE, readTracks, writeWav } from "../audio/wav";
import { mixMeetingAudio } from "./mix";

const dir = mkdtempSync(join(tmpdir(), "hush-mix-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tone = (secs: number, hz: number, amp: number) =>
  Float32Array.from({ length: Math.floor(secs * SAMPLE_RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE));

const rms = (v: Int16Array, from = 0, to = v.length) => {
  let e = 0;
  for (let i = from; i < to; i++) e += (v[i] / 32767) ** 2;
  return Math.sqrt(e / Math.max(1, to - from));
};

describe("mixMeetingAudio", () => {
  test("puts the mic on the left and system audio on the right, then appends a resumed session", async () => {
    const me = join(dir, "me-1.wav");
    const them = join(dir, "them-1.wav");
    writeWav(me, tone(2, 300, 0.5));
    writeWav(them, tone(1, 600, 0.25));
    // The system stream started half a second after the mic.
    const out = await mixMeetingAudio(dir, me, them, 0, 500);
    expect(out).toBe(join(dir, "meeting.m4a"));
    expect(existsSync(me)).toBe(false);
    expect(existsSync(them)).toBe(false);
    const [l, r] = readTracks(out!);
    expect(r).not.toBeNull();
    expect(Math.abs(l.length - 2 * SAMPLE_RATE)).toBeLessThan(SAMPLE_RATE / 10);
    expect(rms(l, SAMPLE_RATE / 2, SAMPLE_RATE)).toBeGreaterThan(0.25);
    // Silent right channel before the shift, signal after it.
    expect(rms(r!, 0, SAMPLE_RATE / 4)).toBeLessThan(0.02);
    expect(rms(r!, SAMPLE_RATE, Math.floor(1.4 * SAMPLE_RATE))).toBeGreaterThan(0.1);

    // Resume: the second session lands after the first (base 2 s).
    const me2 = join(dir, "me-2.wav");
    writeWav(me2, tone(1, 300, 0.5));
    const out2 = await mixMeetingAudio(dir, me2, null, 2000, 0);
    const [l2] = readTracks(out2!);
    expect(Math.abs(l2.length - 3 * SAMPLE_RATE)).toBeLessThan(SAMPLE_RATE / 5);
    expect(rms(l2, Math.floor(2.2 * SAMPLE_RATE), Math.floor(2.8 * SAMPLE_RATE))).toBeGreaterThan(0.25);
  });

  test("returns null when nothing was recorded", async () => {
    expect(await mixMeetingAudio(mkdtempSync(join(dir, "empty-")), null, null, 0, 0)).toBeNull();
  });
});
