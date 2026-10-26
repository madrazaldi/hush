// Live meeting audio plumbing: an energy-based utterance segmenter with an adaptive noise floor, and
// the bounded queue that hands its utterances to the transcription worker.

import { FRAME, FRAME_MS, SysEnvelope, frameRms } from "../audio/bleed";
import { SAMPLE_RATE, WavSink, level as levelOf, parseWav, writeWav } from "../audio/wav";
import { log } from "../log";
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ME = "Me";
export const THEM = "Them";
export type Speaker = typeof ME | typeof THEM;

const PREROLL_FRAMES = 10; // 300 ms
const END_SILENCE_FRAMES = 24; // 720 ms
const MIN_UTTERANCE = SAMPLE_RATE; // 1 s
const MAX_UTTERANCE = SAMPLE_RATE * 25;
/**
 * Speech waiting for transcription is kept in memory up to ~5 minutes; past that (slow provider, busy
 * local model) further chunks are spooled to disk.
 */
export const MAX_QUEUED_SAMPLES = SAMPLE_RATE * 300;
/**
 * If spooling fails too (disk full), speech beyond this backlog is skipped rather than growing memory
 * without bound. The recording itself is unaffected.
 */
const HARD_MAX_QUEUED_SAMPLES = MAX_QUEUED_SAMPLES * 2;

/** A chunk of speech from one stream, timestamped on the meeting timeline. */
export interface Chunk {
  speaker: Speaker;
  startMs: number;
  /** In memory, or the path of a spooled WAV. */
  pcm: Float32Array | string;
}

/** Sending side of the transcription queue, shared by both streams; the worker drains it. */
export class ChunkQueue {
  private items: Chunk[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  queued = 0;
  private seq = 0;
  private warned = false;

  /**
   * @param spoolDir Session-owned temp dir (not the recording dir), removed when the session ends and
   *   swept on launch, so raw speech never lingers there.
   * @param onError Reports a user-visible problem (speech skipped).
   */
  constructor(
    readonly id: string,
    private spoolDir: string,
    private onError: (message: string) => void = () => {},
  ) {}

  send(speaker: Speaker, startMs: number, pcm: Float32Array): void {
    if (this.closed) return;
    const len = pcm.length;
    let item: Float32Array | string;
    if (this.queued + len > MAX_QUEUED_SAMPLES) {
      const path = join(this.spoolDir, `pending-${this.seq++}.wav`);
      try {
        mkdirSync(this.spoolDir, { recursive: true });
        writeWav(path, pcm, SAMPLE_RATE);
        item = path;
      } catch (e) {
        if (this.queued + len > HARD_MAX_QUEUED_SAMPLES) {
          log.error("transcription backlog full and spooling failed, skipping speech:", e);
          if (!this.warned) {
            this.warned = true;
            this.onError("Transcription fell behind and some speech was skipped");
          }
          return;
        }
        log.warn("spooling meeting audio failed:", e);
        this.queued += len;
        item = pcm;
      }
    } else {
      this.queued += len;
      item = pcm;
    }
    this.items.push({ speaker, startMs, pcm: item });
    this.wake();
  }

  /** No more chunks will be sent; the worker finishes what is queued and ends. */
  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /** The next chunk, or null once the queue is closed and drained. */
  async next(): Promise<Chunk | null> {
    for (;;) {
      const c = this.items.shift();
      if (c) return c;
      if (this.closed) return null;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }

  /** Take a chunk's audio back, releasing its share of the memory budget. */
  load(pcm: Float32Array | string): Float32Array {
    if (typeof pcm !== "string") {
      this.queued -= pcm.length;
      return pcm;
    }
    try {
      return parseWav(readFileSync(pcm)).samples;
    } catch (e) {
      log.warn("reading spooled meeting audio failed:", e);
      return new Float32Array(0);
    } finally {
      rmSync(pcm, { force: true });
    }
  }
}

/** Energy-based utterance segmenter with an adaptive noise floor. */
export class Segmenter {
  private pos = 0;
  private frame = new Float32Array(FRAME);
  private frameLen = 0;
  private preroll: Float32Array[] = [];
  private buf: Float32Array[] = [];
  private bufLen = 0;
  private bufStart = 0;
  private inSpeech = false;
  private silence = 0;
  private noise = 0.003;
  /** Cleared by `finish`, which is what ends the transcription worker. */
  private queue: ChunkQueue | null;
  private wav: WavSink | null;
  level = 0;

  /** @param env System-audio levels: "Them" records them, "Me" uses them to silence bleed. */
  constructor(
    readonly speaker: Speaker,
    readonly offsetMs: number,
    queue: ChunkQueue,
    wav: WavSink | null,
    private env: SysEnvelope,
  ) {
    this.queue = queue;
    this.wav = wav;
  }

  /** Frame index on the meeting timeline of sample `pos` of this stream. */
  private timelineFrame(pos: number): number {
    return Math.trunc(this.offsetMs / FRAME_MS) + Math.trunc(pos / FRAME);
  }

  push(pcm: Float32Array): void {
    this.wav?.write(pcm);
    let i = 0;
    while (i < pcm.length) {
      const take = Math.min(FRAME - this.frameLen, pcm.length - i);
      this.frame.set(pcm.subarray(i, i + take), this.frameLen);
      this.frameLen += take;
      i += take;
      if (this.frameLen === FRAME) {
        const f = this.frame;
        this.frame = new Float32Array(FRAME);
        this.frameLen = 0;
        this.onFrame(f);
      }
    }
  }

  private onFrame(f: Float32Array): void {
    let e = 0;
    for (let i = 0; i < f.length; i++) e += f[i] * f[i];
    const rms = Math.sqrt(e / f.length);
    this.level = levelOf(f);
    if (this.speaker === THEM) this.env.push(this.timelineFrame(this.pos), rms);
    // Noise floor: fast down, slow up.
    this.noise = rms < this.noise ? Math.max(rms, 1e-5) : this.noise * 0.998 + rms * 0.002;
    const speech = rms > Math.max(this.noise * 3, 0.006);
    const n = f.length;

    if (!this.inSpeech) {
      if (speech) {
        this.inSpeech = true;
        this.silence = 0;
        const pre = this.preroll.reduce((a, p) => a + p.length, 0);
        this.bufStart = this.pos - pre;
        this.buf = [...this.preroll, f];
        this.bufLen = pre + f.length;
        this.preroll = [];
      } else {
        this.preroll.push(f);
        if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      }
    } else {
      this.buf.push(f);
      this.bufLen += f.length;
      this.silence = speech ? 0 : this.silence + 1;
      if (this.silence >= END_SILENCE_FRAMES) {
        if (this.bufLen >= MIN_UTTERANCE) this.emit();
        else this.clearBuf();
        this.inSpeech = false;
      } else if (this.bufLen >= MAX_UTTERANCE) {
        this.emit();
        this.bufStart = this.pos + n;
      }
    }
    this.pos += n;
  }

  private clearBuf() {
    this.buf = [];
    this.bufLen = 0;
  }

  private emit(): void {
    const pcm = new Float32Array(this.bufLen);
    let o = 0;
    for (const f of this.buf) {
      pcm.set(f, o);
      o += f.length;
    }
    this.clearBuf();
    const startMs = this.offsetMs + Math.trunc((this.bufStart * 1000) / SAMPLE_RATE);
    if (this.speaker === ME) {
      // Silence what the mic picked up from the speakers; skip the chunk if hardly any of the user's own
      // speech is left.
      const bleed = this.env.suppress(pcm, this.timelineFrame(this.bufStart));
      const thresh = Math.max(this.noise * 3, 0.006);
      const rms = frameRms(pcm);
      let own = 0;
      for (let i = 0; i < Math.min(rms.length, bleed.length); i++) if (!bleed[i] && rms[i] > thresh) own++;
      if (own < 10) return;
    }
    this.queue?.send(this.speaker, startMs, pcm);
  }

  /** Flush the last utterance and release the queue and WAV sink (returned for the caller to finish). */
  finish(): WavSink | null {
    if (this.inSpeech && this.bufLen >= SAMPLE_RATE / 2) this.emit();
    this.queue = null;
    const w = this.wav;
    this.wav = null;
    return w;
  }

  durationMs(): number {
    return this.offsetMs + Math.trunc((this.pos * 1000) / SAMPLE_RATE);
  }
}
