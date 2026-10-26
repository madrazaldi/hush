// Shared transcript types and helpers (the Rust `stt` module's data model).

import type { SttProfile, Word } from "../../../lib/types";

export type { SttProfile, Word };

/** A segment with its word list always present internally; assignable to the UI `Segment`. */
export interface Seg {
  start_ms: number;
  end_ms: number;
  text: string;
  /** Speaker label ("Me", "Them", "Speaker 1", ...) when known. */
  speaker?: string;
  words: Word[];
}

export interface Transcript {
  text: string;
  language: string | null;
  segments: Seg[];
}

export const emptyTranscript = (): Transcript => ({ text: "", language: null, segments: [] });

/** Shift all timestamps by `offsetMs` (used when stitching chunks). */
export function offsetTranscript(t: Transcript, offsetMs: number): Transcript {
  for (const s of t.segments) {
    s.start_ms += offsetMs;
    s.end_ms += offsetMs;
    for (const w of s.words) {
      w.start_ms += offsetMs;
      w.end_ms += offsetMs;
    }
  }
  return t;
}

/** Append another (already offset) transcript. */
export function extendTranscript(t: Transcript, other: Transcript): void {
  const text = other.text.trim();
  if (text !== "") {
    if (t.text !== "") t.text += " ";
    t.text += text;
  }
  t.language ??= other.language;
  t.segments.push(...other.segments);
}

/** Rebuild plain text from segments. */
export function textFromSegments(t: Pick<Transcript, "segments">): string {
  return t.segments
    .map((s) => s.text.trim())
    .filter((s) => s !== "")
    .join(" ");
}

/** Join word tokens, respecting tokens that carry their own leading space. */
export function joinWords(words: Word[]): string {
  const explicit = words.slice(1).some((w) => w.text.startsWith(" "));
  const s = explicit ? words.map((w) => w.text).join("") : words.map((w) => w.text.trim()).join(" ");
  return s.trim();
}

/**
 * Group word timings into readable segments: break on a long pause, or at sentence end once the segment
 * is long enough, or when it gets too long.
 */
export function groupWords(words: Word[], speaker?: string): Seg[] {
  const out: Seg[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const seg: Seg = { start_ms: cur[0].start_ms, end_ms: cur[cur.length - 1].end_ms, text: joinWords(cur), words: cur };
    if (speaker) seg.speaker = speaker;
    out.push(seg);
    cur = [];
  };
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last) {
      const gap = w.start_ms - last.end_ms;
      const dur = last.end_ms - cur[0].start_ms;
      const endsSentence = /[.?!。？！]$/.test(last.text.trimEnd());
      if (gap > 800 || (endsSentence && (dur > 6000 || cur.length > 18)) || dur > 20_000) flush();
    }
    cur.push({ ...w });
  }
  flush();
  return out;
}

export interface SttOptions {
  /** ISO-639-1 code, or null for auto-detect. */
  language: string | null;
  /** Custom vocabulary / key terms to bias recognition. */
  vocabulary: string[];
  /** Free-form context prompt (supported by Whisper-family models). */
  prompt: string | null;
  /** Request speaker diarization when the provider supports it. */
  diarize: boolean;
  /** Expected number of speakers (hint), if known. */
  numSpeakers: number | null;
  /** Translate to English (Whisper-family only). */
  translate: boolean;
}

export const defaultSttOptions = (over: Partial<SttOptions> = {}): SttOptions => ({
  language: null,
  vocabulary: [],
  prompt: null,
  diarize: false,
  numSpeakers: null,
  translate: false,
  ...over,
});
