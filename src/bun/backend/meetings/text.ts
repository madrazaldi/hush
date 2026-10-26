// Transcript helpers for meetings: bleed detection between the "Me" and "Them" streams, naming.

import type { Recording, Segment } from "../../../lib/types";
import { THEM } from "./segmenter";

/** Normalize text for duplicate detection. */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Levenshtein distance over Unicode scalar values. */
function levenshtein(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1 - distance / longer length (1 for two empty strings). */
export function normalizedLevenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const longest = Math.max(x.length, y.length);
  return longest === 0 ? 1 : 1 - levenshtein(x, y) / longest;
}

/** True if `seg` (from the mic) is likely speaker bleed of an overlapping "Them" segment. */
export function isBleed(seg: Segment, existing: Segment[]): boolean {
  const a = norm(seg.text);
  if (Buffer.byteLength(a) < 6) return false;
  return existing
    .filter((e) => e.speaker === THEM)
    .some((e) => {
      const overlap = seg.start_ms < e.end_ms + 2000 && e.start_ms < seg.end_ms + 2000;
      return overlap && normalizedLevenshtein(a, norm(e.text)) > 0.7;
    });
}

/** Segments with speaker labels replaced by user-assigned names, and without word timings. */
export function namedSegments(rec: Pick<Recording, "segments" | "speakers">): Segment[] {
  return rec.segments.map((s) => {
    const { words: _words, ...rest } = s;
    const name = s.speaker ? rec.speakers[s.speaker] : undefined;
    return name && name.trim() !== "" ? { ...rest, speaker: name } : rest;
  });
}
