// Combine a meeting session's per-stream WAVs into the meeting's single audio file, and re-transcribe
// a saved meeting recording per channel.

import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Segment } from "../../../lib/types";
import { FRAME_MS, SysEnvelope } from "../audio/bleed";
import { SAMPLE_RATE, readTracks, stereoWavBytes, writeStereoAac } from "../audio/wav";
import { log } from "../log";
import * as stt from "../stt";
import type { Seg, SttOptions, Transcript } from "../stt/types";
import { ME, THEM } from "./segmenter";
import { isBleed } from "./text";

/** Bitrate of the stored meeting audio (stereo AAC, ~0.35 MB per minute). */
export const AAC_BITRATE = 48_000;

/**
 * Combine this session's me/them WAVs into the meeting's audio file: stereo AAC with the mic on the left
 * and system audio on the right, so a later re-transcription can still tell the user apart from the call.
 * A resumed meeting is appended to the previous sessions' audio, starting at the session's position on
 * the meeting timeline (`baseMs`).
 */
export async function mixMeetingAudio(dir: string, me: string | null, them: string | null, baseMs: number, themShiftMs: number): Promise<string | null> {
  const mePath = me && existsSync(me) ? me : null;
  const themPath = them && existsSync(them) ? them : null;
  const read = (p: string | null): Int16Array => {
    if (!p) return new Int16Array(0);
    try {
      return readTracks(p)[0];
    } catch {
      return new Int16Array(0);
    }
  };
  const a = read(mePath);
  let b = read(themPath);
  // Align the system stream to the mic timeline.
  const shift = Math.trunc((Math.max(themShiftMs, 0) * SAMPLE_RATE) / 1000);
  if (b.length > 0) {
    const padded = new Int16Array(shift + b.length);
    padded.set(b, shift);
    b = padded;
  }
  const n = Math.max(a.length, b.length);
  if (n === 0) return null;

  const aac = join(dir, "meeting.m4a");
  const legacy = join(dir, "meeting.wav");
  const previous = [aac, legacy].find((p) => existsSync(p));
  let left: Int16Array = new Int16Array(0);
  let right: Int16Array = new Int16Array(0);
  if (previous) {
    try {
      const [l, r] = readTracks(previous);
      // Older meetings were saved as a mono mix.
      left = l;
      right = r ?? l.slice();
    } catch (e) {
      log.error("reading previous meeting audio failed, not appending to it:", e);
      return null;
    }
  }
  // Pad up to where this session's segments start, which is past the previous audio if an earlier
  // session kept none.
  const base = Math.trunc((Math.max(baseMs, 0) * SAMPLE_RATE) / 1000);
  const len = Math.max(left.length, right.length, base);
  const L = new Int16Array(len + n);
  const R = new Int16Array(len + n);
  L.set(left);
  R.set(right);
  L.set(a, len);
  R.set(b.subarray(0, Math.min(b.length, n)), len);

  const tmp = join(dir, "meeting.tmp.m4a");
  let out: string;
  try {
    await writeStereoAac(tmp, L, R, SAMPLE_RATE, AAC_BITRATE);
    renameSync(tmp, aac);
    rmSync(legacy, { force: true });
    out = aac;
  } catch (e) {
    // Keep the audio uncompressed rather than lose it.
    log.error("encoding meeting audio failed, keeping WAV:", e);
    rmSync(tmp, { force: true });
    const wavTmp = join(dir, "meeting.wav.tmp");
    try {
      writeFileSync(wavTmp, stereoWavBytes(L, R, SAMPLE_RATE));
      renameSync(wavTmp, legacy);
    } catch (e2) {
      log.error("writing meeting WAV failed:", e2);
      rmSync(wavTmp, { force: true });
      return null;
    }
    // The WAV now holds everything; an older AAC would be read first on resume.
    rmSync(aac, { force: true });
    out = legacy;
  }
  // The per-stream files are no longer needed once mixed.
  for (const p of [mePath, themPath]) if (p) rmSync(p, { force: true });
  return out;
}

const i16ToF32 = (v: Int16Array) => Float32Array.from(v, (s) => s / 32767);

/** Providers that return only text get one segment spanning the audio. */
function withFallbackSegment(segments: Seg[], text: string, samples: number): Seg[] {
  if (segments.length === 0 && text.trim() !== "") {
    return [{ start_ms: 0, end_ms: Math.trunc((samples * 1000) / SAMPLE_RATE), text: text.trim(), words: [] }];
  }
  return segments;
}

/**
 * Re-transcribe a meeting's saved audio. Stereo recordings are transcribed per channel (left = "Me" with
 * speaker bleed removed, right = "Them"); older mono mixes fall back to the provider's diarization.
 */
export async function transcribeAudio(
  path: string,
  profile: Parameters<typeof stt.transcribe>[0],
  opts: SttOptions,
  progress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const [leftI, rightI] = readTracks(path);
  if (!rightI) {
    const mono = i16ToF32(leftI);
    const t = await stt.transcribe(profile, mono, { ...opts, diarize: true }, progress, signal);
    t.segments = withFallbackSegment(t.segments, t.text, mono.length);
    return t;
  }
  const them = i16ToF32(rightI);
  const me = i16ToF32(leftI);
  const silenced = SysEnvelope.fromPcm(them).suppressAll(me);
  log.info(`meeting re-transcribe: silenced ${Math.trunc((silenced * FRAME_MS) / 1000)}s of mic bleed`);

  const tThem = await stt.transcribe(profile, them, opts, (p) => progress(p * 0.5), signal);
  const tMe = await stt.transcribe(profile, me, opts, (p) => progress(0.5 + p * 0.5), signal);
  const label = (segs: Seg[], speaker: string): Seg[] => segs.map((s) => ({ ...s, speaker }));
  const segments = label(withFallbackSegment(tThem.segments, tThem.text, them.length), THEM);
  const mine = label(withFallbackSegment(tMe.segments, tMe.text, me.length), ME);
  const theirs = segments.slice();
  segments.push(...mine.filter((s) => s.text.trim() !== "" && !isBleed(s, theirs as Segment[])));
  segments.sort((x, y) => x.start_ms - y.start_ms);
  const text = segments.map((s) => s.text.trim()).join(" ");
  return { text, language: tThem.language ?? tMe.language, segments };
}
