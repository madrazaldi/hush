// On-device transcription: chunking, option policy and segment post-processing live here; the helper
// only runs the engine on one chunk of audio at a time (a raw f32 file, never JSON).

import { rmSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_RATE, hasVoice, splitAtSilences, writeF32File } from "../audio/wav";
import { type RawStt, type SttInfo, native } from "../native";
import { scratchDir } from "../paths";
import * as models from "./models";
import { type Seg, type SttOptions, type Transcript, type Word, emptyTranscript, extendTranscript, groupWords, offsetTranscript } from "./types";

/** Chunk length when the model reports no practical limit. Keeps memory and progress granularity reasonable for hour-long files. */
const DEFAULT_CHUNK_MS = 120_000;

const infoCache = new Map<string, SttInfo>();

async function modelInfo(path: string): Promise<SttInfo> {
  let i = infoCache.get(path);
  if (!i) {
    i = await native().sttInfo(path);
    infoCache.set(path, i);
  }
  return i;
}

/** Load a model ahead of time (e.g. when the dictation hotkey goes down). */
export function preload(modelId: string): void {
  if (modelId === "") return;
  try {
    void native().sttPreload(models.resolve(modelId)).catch(() => {});
  } catch {
    // not downloaded: the real run reports it
  }
}

export function evict(modelId: string): void {
  const m = models.find(modelId);
  if (!m) return;
  const p = models.modelPath(m);
  infoCache.delete(p);
  if (native().running) void native().sttEvict(p).catch(() => {});
}

/** Short human-readable engine info for diagnostics. */
export async function describe(modelId: string): Promise<string> {
  const i = await modelInfo(models.resolve(modelId));
  return `${i.arch} on ${i.backend}`;
}

/** Convert the engine's raw output into a Transcript. */
export function convert(t: RawStt): Transcript {
  const words: Word[] = t.words.filter((w) => w.text.trim() !== "").map((w) => ({ start_ms: w.t0_ms, end_ms: w.t1_ms, text: w.text }));
  let segments: Seg[] = t.segments
    .filter((s) => s.text.trim() !== "")
    .map((s) => {
      const seg: Seg = {
        start_ms: s.t0_ms,
        end_ms: s.t1_ms,
        text: s.text.trim(),
        words:
          s.n_words > 0 && s.first_word >= 0
            ? t.words.slice(s.first_word, s.first_word + s.n_words).map((w) => ({ start_ms: w.t0_ms, end_ms: w.t1_ms, text: w.text }))
            : [],
      };
      if (s.speaker_id > 0) seg.speaker = `Speaker ${s.speaker_id}`;
      return seg;
    });
  // Token-timestamp models (Parakeet) often return one long segment; split it into sentence-sized
  // pieces so the transcript editor is usable.
  const tooCoarse = segments.length <= 1 || segments.some((s) => s.end_ms - s.start_ms > 30_000);
  if (tooCoarse && words.length > 1) segments = groupWords(words);
  return { text: t.text.trim(), language: t.language ? t.language : null, segments };
}

/** Timing fix-ups for one chunk that the engine reported oddly. */
function fixChunk(piece: Transcript, chunkMs: number): void {
  if (piece.segments.length === 0 && piece.text !== "") {
    piece.segments.push({ start_ms: 0, end_ms: chunkMs, text: piece.text, words: [] });
  }
  // Models without timestamps (Moonshine, SenseVoice) report zero-length segments; spread untimed ones
  // across the chunk so seeking still works.
  if (piece.segments.every((s) => s.end_ms <= s.start_ms)) {
    const n = Math.max(piece.segments.length, 1);
    piece.segments.forEach((seg, k) => {
      seg.start_ms = Math.trunc((chunkMs * k) / n);
      seg.end_ms = Math.trunc((chunkMs * (k + 1)) / n);
    });
  }
}

export async function transcribe(
  modelId: string,
  pcm: Float32Array,
  opts: SttOptions,
  progress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  const cancelled = () => new Error("Cancelled");
  if (signal?.aborted) throw cancelled();
  const path = models.resolve(modelId);
  const info = await modelInfo(path);
  const maxMs = info.max_audio_ms && info.max_audio_ms > 0 ? Math.min(info.max_audio_ms - 2000, DEFAULT_CHUNK_MS) : DEFAULT_CHUNK_MS;
  const chunks = splitAtSilences(pcm, Math.floor((maxMs * SAMPLE_RATE) / 1000));
  const total = chunks.length;
  const job = crypto.randomUUID();
  const runOpts = { language: opts.language, translate: opts.translate, vocabulary: opts.vocabulary, prompt: opts.prompt };
  const file = join(scratchDir(), `stt-${job}.f32`);

  // A cancel can race the helper registering the job; keep nudging until the run settles.
  let nudge: ReturnType<typeof setInterval> | undefined;
  const onAbort = () => {
    void native().sttCancel(job).catch(() => {});
    nudge ??= setInterval(() => void native().sttCancel(job).catch(() => {}), 100);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const out = emptyTranscript();
  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw cancelled();
      const [start, chunk] = chunks[i];
      if (!hasVoice(chunk)) {
        progress((i + 1) / total);
        continue;
      }
      writeF32File(file, chunk);
      let raw: RawStt;
      try {
        raw = await native().sttRun({ job, model: path, path: file, options: runOpts });
      } catch (e) {
        if (signal?.aborted) throw cancelled();
        throw e;
      }
      if (signal?.aborted) throw cancelled();
      const piece = convert(raw);
      const chunkMs = Math.trunc((chunk.length * 1000) / SAMPLE_RATE);
      fixChunk(piece, chunkMs);
      extendTranscript(out, offsetTranscript(piece, Math.trunc((start * 1000) / SAMPLE_RATE)));
      progress((i + 1) / total);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (nudge) clearInterval(nudge);
    rmSync(file, { force: true });
  }
  return out;
}
