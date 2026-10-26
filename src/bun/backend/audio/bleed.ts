// Speaker bleed: the microphone picking up what the system audio is playing (a call on laptop
// speakers). Bleed is a delayed, quieter copy of the system signal, so its loudness envelope tracks the
// system envelope closely at some small lag, while the user's own voice is unrelated to it. We compare
// the two envelopes in 30 ms frames and silence the mic frames that follow the system audio, before
// they reach transcription.

import { SAMPLE_RATE } from "./wav";

export const FRAME = Math.floor((SAMPLE_RATE * 30) / 1000); // 30 ms
export const FRAME_MS = 30;
/** How far the mic may trail the system audio (output + acoustic + input latency + clock alignment). */
export const MAX_LAG = 20; // 600 ms
/** How far the mic may appear to lead it (alignment error the other way). */
export const MAX_LEAD = 10; // 300 ms
/** Correlation window around each frame. */
const HALF_WINDOW = 16; // ~1 s total
/** Envelope correlation above which a mic frame counts as bleed. */
const THRESHOLD = 0.6;
/** System frames quieter than this are treated as silence (nothing to bleed). */
const SYS_ACTIVE = 0.002;
/** System history kept for live meetings, comfortably above the longest utterance plus queueing. */
export const HISTORY_FRAMES = Math.floor((3 * 60 * 1000) / FRAME_MS);

/** RMS of each 30 ms frame (a trailing partial frame counts as a frame). */
export function frameRms(pcm: Float32Array): Float32Array {
  const n = Math.ceil(pcm.length / FRAME);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const a = f * FRAME;
    const b = Math.min(pcm.length, a + FRAME);
    let e = 0;
    for (let i = a; i < b; i++) e += pcm[i] * pcm[i];
    out[f] = Math.sqrt(e / (b - a));
  }
  return out;
}

/** System-audio frame levels indexed by frame on the meeting timeline. */
export class SysEnvelope {
  start = 0;
  rms: number[] = [];
  private head = 0; // index of the first live element in `rms` (cheap pop_front)

  private constructor(private bounded: boolean) {}

  /** Rolling history for a live meeting. */
  static live(): SysEnvelope {
    return new SysEnvelope(true);
  }

  /** The whole system track of a recorded meeting. */
  static fromPcm(pcm: Float32Array): SysEnvelope {
    const e = new SysEnvelope(false);
    e.rms = Array.from(frameRms(pcm));
    return e;
  }

  get length(): number {
    return this.rms.length - this.head;
  }

  push(frame: number, rms: number): void {
    if (this.length === 0) {
      this.rms = [];
      this.head = 0;
      this.start = frame;
    }
    const end = this.start + this.length;
    if (frame < this.start) return;
    if (frame < end) {
      this.rms[this.head + (frame - this.start)] = rms;
    } else {
      // Gaps (dropped callbacks) read as silence.
      for (let f = end; f < frame; f++) this.rms.push(0);
      this.rms.push(rms);
    }
    if (this.bounded) {
      while (this.length > HISTORY_FRAMES) {
        this.head++;
        this.start++;
      }
      if (this.head > 4096) {
        this.rms = this.rms.slice(this.head);
        this.head = 0;
      }
    }
  }

  /** Levels for frames `from..to`, zero where unknown. */
  range(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    for (let f = from; f < to; f++) {
      const i = f - this.start;
      out[f - from] = i >= 0 && i < this.length ? this.rms[this.head + i] : 0;
    }
    return out;
  }

  /** Silence the frames of `mic` (starting at timeline frame `start`) that are bleed. Returns the per-frame mask. */
  suppress(mic: Float32Array, start: number): boolean[] {
    const micRms = frameRms(mic);
    const sys = this.range(start - MAX_LAG, start + micRms.length + MAX_LEAD);
    const m = mask(micRms, sys);
    for (let f = 0; f < m.length; f++) {
      if (m[f]) mic.fill(0, f * FRAME, Math.min(mic.length, (f + 1) * FRAME));
    }
    return m;
  }

  /** Offline version of `suppress` for a whole recorded mic track, in blocks so the best lag can follow clock drift. */
  suppressAll(mic: Float32Array): number {
    // A whole number of frames, so every block stays on the system track's frame grid.
    const BLOCK = FRAME * Math.floor(20_000 / FRAME_MS); // ~20 s
    let silenced = 0;
    for (let i = 0, off = 0; off < mic.length; i++, off += BLOCK) {
      const block = mic.subarray(off, Math.min(mic.length, off + BLOCK));
      const start = Math.floor((i * BLOCK) / FRAME);
      silenced += this.suppress(block, start).filter(Boolean).length;
    }
    return silenced;
  }
}

const db = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-4));

function pearson(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = a.length;
  if (n < 4) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const dx = a[i] - ma;
    const dy = b[i] - mb;
    cov += dx * dy;
    va += dx * dx;
    vb += dy * dy;
  }
  // A flat envelope (silence, steady noise) correlates with nothing.
  return va < 1 || vb < 1 ? 0 : cov / Math.sqrt(va * vb);
}

/**
 * Per-frame bleed mask. `sys` covers the mic frames padded by MAX_LAG frames before and MAX_LEAD after,
 * so `sys[i + MAX_LAG]` is simultaneous with `mic[i]`.
 */
export function mask(mic: ArrayLike<number>, sys: ArrayLike<number>): boolean[] {
  const n = mic.length;
  const out = new Array<boolean>(n).fill(false);
  let active = false;
  for (let i = 0; i < sys.length; i++) if (sys[i] > SYS_ACTIVE) active = true;
  if (n === 0 || sys.length !== n + MAX_LAG + MAX_LEAD || !active) return out;
  const m = Array.from(mic, db);
  const s = Array.from(sys, db);
  // `lag` = how many frames the mic trails the system audio, offset by MAX_LEAD.
  const at = (lag: number, i: number) => i + MAX_LAG + MAX_LEAD - lag;
  const shifted = (lag: number, a: number, b: number) => {
    const o = new Array<number>(b - a);
    for (let i = a; i < b; i++) o[i - a] = s[at(lag, i)];
    return o;
  };

  let lag = 0;
  let best = -Infinity;
  for (let l = 0; l <= MAX_LAG + MAX_LEAD; l++) {
    const p = pearson(m, shifted(l, 0, n));
    if (p > best) {
      best = p;
      lag = l;
    }
  }
  // Whole-chunk correlation is a cheap early out for chunks with no bleed at all; a chunk that is
  // partly bleed still correlates noticeably.
  if (best < THRESHOLD / 3) return out;
  const floor = db(SYS_ACTIVE);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - HALF_WINDOW);
    const b = Math.min(n, i + HALF_WINDOW + 1);
    const sw = shifted(lag, a, b);
    out[i] = sw.some((x) => x > floor) && pearson(m.slice(a, b), sw) > THRESHOLD;
  }
  return out;
}
