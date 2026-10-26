// WAV reading/writing, silence handling and the afconvert-based stereo AAC encoder.

import { closeSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SAMPLE_RATE = 16_000;

const f32ToI16 = (s: number) => Math.trunc(Math.max(-1, Math.min(1, s)) * 32767);

function wavHeader(dataBytes: number, rate: number, channels: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** Encode mono f32 PCM as 16-bit PCM WAV bytes. */
export function wavBytes(pcm: Float32Array, rate: number = SAMPLE_RATE): Buffer {
  const body = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) body.writeInt16LE(f32ToI16(pcm[i]), i * 2);
  return Buffer.concat([wavHeader(body.length, rate, 1), body]);
}

export function writeWav(path: string, pcm: Float32Array, rate: number = SAMPLE_RATE): void {
  writeFileSync(path, wavBytes(pcm, rate));
}

/** Incremental WAV writer for long recordings. */
export class WavSink {
  private fd: number;
  private bytes = 0;
  private closed = false;

  constructor(
    private path: string,
    private rate: number = SAMPLE_RATE,
    private channels = 1,
  ) {
    this.fd = openSync(path, "w");
    writeSync(this.fd, wavHeader(0, rate, channels));
  }

  write(pcm: Float32Array): void {
    if (this.closed || pcm.length === 0) return;
    const body = Buffer.alloc(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) body.writeInt16LE(f32ToI16(pcm[i]), i * 2);
    writeSync(this.fd, body);
    this.bytes += body.length;
  }

  /** Patch the header lengths and close. Safe to call twice. */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    const h = wavHeader(this.bytes, this.rate, this.channels);
    writeSync(this.fd, h, 0, 44, 0);
    closeSync(this.fd);
  }
}

export interface WavData {
  rate: number;
  channels: number;
  /** Interleaved samples as f32 in -1..1. */
  samples: Float32Array;
}

/** Parse a PCM16/PCM24/PCM32/float32 WAV, walking chunks (afconvert inserts a FLLR padding chunk). */
export function parseWav(buf: Uint8Array): WavData {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (buf.length < 12 || (tag(0) !== "RIFF" && tag(0) !== "RF64") || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = tag(o);
    let size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      let format = dv.getUint16(body, true);
      const bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt");
      // Streaming writers leave 0 or 0xFFFFFFFF as the size; use what is there.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      const bytesPer = fmt.bits / 8;
      const n = Math.floor(size / bytesPer);
      const out = new Float32Array(n);
      if (fmt.format === 3 && fmt.bits === 32) {
        for (let i = 0; i < n; i++) out[i] = dv.getFloat32(body + i * 4, true);
      } else if (fmt.format === 1 && fmt.bits === 16) {
        for (let i = 0; i < n; i++) out[i] = dv.getInt16(body + i * 2, true) / 32768;
      } else if (fmt.format === 1 && fmt.bits === 24) {
        for (let i = 0; i < n; i++) {
          const b = body + i * 3;
          out[i] = (((buf[b] | (buf[b + 1] << 8) | (buf[b + 2] << 16)) << 8) >> 8) / 8388608;
        }
      } else if (fmt.format === 1 && fmt.bits === 32) {
        for (let i = 0; i < n; i++) out[i] = dv.getInt32(body + i * 4, true) / 2147483648;
      } else {
        throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}`);
      }
      return { rate: fmt.rate, channels: fmt.channels, samples: out };
    }
    o = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export async function afconvertAsync(args: string[]): Promise<void> {
  const p = Bun.spawn(["/usr/bin/afconvert", ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const err = new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`afconvert failed: ${(await err).trim()}`);
}

export function afconvert(args: string[]): void {
  const r = Bun.spawnSync(["/usr/bin/afconvert", ...args], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`afconvert failed: ${r.stderr.toString().trim()}`);
}

const tmpPath = (ext: string) => join(tmpdir(), `hush-${crypto.randomUUID().replaceAll("-", "")}.${ext}`);

/**
 * 16-bit samples of a mono or stereo recording: `[left, right]` for stereo, `[mono, null]` for mono.
 * WAV is read directly; anything else (the meetings' AAC) is decoded to a temporary WAV with afconvert.
 */
export function readTracks(path: string): [Int16Array, Int16Array | null] {
  const isWav = path.toLowerCase().endsWith(".wav");
  const tmp = isWav ? null : tmpPath("wav");
  try {
    if (tmp) afconvert([path, "-o", tmp, "-f", "WAVE", "-d", "LEI16"]);
    const w = parseWav(readFileSync(tmp ?? path));
    const toI16 = (x: number) => Math.round(x * 32768);
    if (w.channels === 1) return [Int16Array.from(w.samples, (x) => Math.max(-32768, Math.min(32767, toI16(x)))), null];
    const frames = Math.floor(w.samples.length / w.channels);
    const l = new Int16Array(frames);
    const r = new Int16Array(frames);
    for (let i = 0; i < frames; i++) {
      l[i] = Math.max(-32768, Math.min(32767, toI16(w.samples[i * w.channels])));
      r[i] = Math.max(-32768, Math.min(32767, toI16(w.samples[i * w.channels + 1])));
    }
    return [l, r];
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
}

/**
 * Write stereo 16-bit tracks (padded to equal length) as AAC in an M4A container via afconvert,
 * about a sixth the size of the 16-bit WAV.
 */
export async function writeStereoAac(path: string, left: Int16Array, right: Int16Array, rate: number, bitrate: number): Promise<void> {
  const wav = path.replace(/\.[^./]*$/, "") + ".tmp.wav";
  try {
    writeFileSync(wav, stereoWavBytes(left, right, rate));
    await afconvertAsync([wav, "-o", path, "-f", "m4af", "-d", "aac", "-b", String(bitrate)]);
  } finally {
    rmSync(wav, { force: true });
  }
}

/**
 * Split audio into chunks no longer than `maxSamples`, preferring to cut in the quietest 20 ms window
 * within the last 25% of each chunk. Returns `[startSample, slice]` pairs covering the whole input.
 */
export function splitAtSilences(pcm: Float32Array, maxSamples: number): [number, Float32Array][] {
  if (pcm.length <= maxSamples || maxSamples === 0) return [[0, pcm]];
  const WIN = SAMPLE_RATE / 50; // 20 ms
  const out: [number, Float32Array][] = [];
  let start = 0;
  while (start < pcm.length) {
    if (pcm.length - start <= maxSamples) {
      out.push([start, pcm.subarray(start)]);
      break;
    }
    const searchFrom = start + Math.floor((maxSamples * 3) / 4);
    const searchTo = start + maxSamples;
    let best = searchTo;
    let bestEnergy = Infinity;
    for (let i = searchFrom; i + WIN <= searchTo; i += WIN / 2) {
      let e = 0;
      for (let j = i; j < i + WIN; j++) e += pcm[j] * pcm[j];
      if (e < bestEnergy) {
        bestEnergy = e;
        best = i + WIN / 2;
      }
    }
    out.push([start, pcm.subarray(start, best)]);
    start = best;
  }
  return out;
}

/** Trim leading/trailing near-silence (keeps a small margin). Used for dictation. */
export function trimSilence(pcm: Float32Array): Float32Array {
  const WIN = SAMPLE_RATE / 50;
  const MARGIN = SAMPLE_RATE / 5; // 200 ms
  const thresh = 0.004; // ~ -48 dBFS RMS
  const n = pcm.length;
  let first = -1;
  let last = 0;
  for (let i = 0; i + WIN <= n; i += WIN) {
    let e = 0;
    for (let j = i; j < i + WIN; j++) e += pcm[j] * pcm[j];
    if (Math.sqrt(e / WIN) > thresh) {
      if (first < 0) first = i;
      last = i + WIN;
    }
  }
  return first < 0 ? pcm.subarray(0, 0) : pcm.subarray(Math.max(0, first - MARGIN), Math.min(n, last + MARGIN));
}

/** True if the buffer contains any meaningful speech-level energy. */
export function hasVoice(pcm: Float32Array): boolean {
  return trimSilence(pcm).length > 0 && pcm.length > SAMPLE_RATE / 4;
}

/** RMS level in 0..1 (roughly perceptual, for meters): about -60 dB..0 dB mapped to 0..1. */
export function level(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let e = 0;
  for (let i = 0; i < pcm.length; i++) e += pcm[i] * pcm[i];
  const rms = Math.sqrt(e / pcm.length);
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

/** Stereo 16-bit WAV bytes (shorter channel padded with silence). */
export function stereoWavBytes(left: Int16Array, right: Int16Array, rate: number): Buffer {
  const frames = Math.max(left.length, right.length);
  const body = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    body.writeInt16LE(left[i] ?? 0, i * 4);
    body.writeInt16LE(right[i] ?? 0, i * 4 + 2);
  }
  return Buffer.concat([wavHeader(body.length, rate, 2), body]);
}

/** Read a raw little-endian f32 file (the helper's capture format) into samples. */
export function readF32File(path: string): Float32Array {
  const b = readFileSync(path);
  const n = Math.floor(b.length / 4);
  const out = new Float32Array(n);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** Write samples as a raw little-endian f32 file (what the helper's `stt.run` reads). */
export function writeF32File(path: string, pcm: Float32Array): void {
  const b = Buffer.alloc(pcm.length * 4);
  for (let i = 0; i < pcm.length; i++) b.writeFloatLE(pcm[i], i * 4);
  writeFileSync(path, b);
}
