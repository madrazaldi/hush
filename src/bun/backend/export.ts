// Transcript exporters: txt, md, srt, vtt, csv, json.

import type { ExportOptions, Recording, Segment, Word } from "../../lib/types";
import { joinWords } from "./stt/types";

const p2 = (n: number) => String(n).padStart(2, "0");

export function ts(ms: number, sep: string): string {
  const m = Math.max(0, Math.trunc(ms));
  return `${p2(Math.trunc(m / 3_600_000))}:${p2(Math.trunc(m / 60_000) % 60)}:${p2(Math.trunc(m / 1000) % 60)}${sep}${String(m % 1000).padStart(3, "0")}`;
}

export function shortTs(ms: number): string {
  const s = Math.trunc(Math.max(0, ms) / 1000);
  return s >= 3600 ? `${Math.trunc(s / 3600)}:${p2(Math.trunc(s / 60) % 60)}:${p2(s % 60)}` : `${p2(Math.trunc(s / 60))}:${p2(s % 60)}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `%B %-d, %Y %H:%M` in local time. */
function longDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const bytes = (s: string) => Buffer.byteLength(s);
const chars = (s: string) => Array.from(s).length;

function speakerName(rec: Pick<Recording, "speakers">, seg: Segment): string | undefined {
  return seg.speaker ? (rec.speakers[seg.speaker] ?? seg.speaker) : undefined;
}

/** Split long segments into subtitle-sized cues (<= 2 lines x `maxChars`). */
export function subtitleCues(segments: Segment[], maxChars: number): Segment[] {
  const out: Segment[] = [];
  const limit = maxChars * 2;
  for (const s of segments) {
    if (chars(s.text) <= limit) {
      out.push(s);
      continue;
    }
    const speaker = s.speaker;
    const cue = (a: number, b: number, text: string): Segment => (speaker ? { start_ms: a, end_ms: b, text, speaker } : { start_ms: a, end_ms: b, text });
    if (s.words && s.words.length > 0) {
      let cur: Word[] = [];
      const flush = () => out.push(cue(cur[0].start_ms, cur[cur.length - 1].end_ms, joinWords(cur)));
      for (const w of s.words) {
        const len = chars(joinWords(cur)) + chars(w.text) + 1;
        if (cur.length > 0 && len > limit) {
          flush();
          cur = [];
        }
        cur.push(w);
      }
      if (cur.length > 0) flush();
      continue;
    }
    // No word timings: split by characters, interpolating time.
    const words = s.text.split(/\s+/).filter(Boolean);
    const total = Math.max(chars(s.text), 1);
    const dur = s.end_ms - s.start_ms;
    let startChars = 0;
    let cur: string[] = [];
    const flush = () => {
      const text = cur.join(" ");
      const n = chars(text) + 1;
      const a = s.start_ms + Math.trunc(dur * (startChars / total));
      const b = s.start_ms + Math.trunc(dur * Math.min((startChars + n) / total, 1));
      out.push(cue(a, b, text));
      startChars += n;
      cur = [];
    };
    for (const w of words) {
      if (cur.length > 0 && chars(cur.join(" ")) + bytes(w) + 1 > limit) flush();
      cur.push(w);
    }
    if (cur.length > 0) flush();
  }
  return out;
}

export function wrapLines(text: string, max: number): string {
  if (chars(text) <= max) return text;
  // Break at the space closest to the middle.
  const mid = Math.trunc(text.length / 2);
  let idx = -1;
  let best = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") {
      const d = Math.abs(i - mid);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
  }
  return idx < 0 ? text : `${text.slice(0, idx)}\n${text.slice(idx + 1)}`;
}

/** Merge consecutive segments from the same speaker into paragraphs. */
export function mergeSpeakerRuns(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last) {
      const gap = s.start_ms - last.end_ms;
      const long = bytes(last.text) > 600;
      if (last.speaker === s.speaker && gap < 2000 && !long) {
        last.text += ` ${s.text.trim()}`;
        last.end_ms = s.end_ms;
        continue;
      }
    }
    const { words: _words, ...rest } = s;
    out.push({ ...rest });
  }
  return out;
}

export function exportRecording(rec: Recording, opts: ExportOptions): string {
  const timestamps = opts.timestamps ?? true;
  const speakers = opts.speakers ?? true;
  const includeNotes = opts.include_notes ?? false;
  const segs = rec.segments;
  const label = (s: Segment) => {
    const n = speakers ? speakerName(rec, s) : undefined;
    return n !== undefined ? `${n}: ` : "";
  };
  switch (opts.format) {
    case "txt": {
      let out = "";
      if (includeNotes && rec.enhanced !== "") out += `${rec.enhanced}\n\n---\n\n`;
      for (const s of mergeSpeakerRuns(segs)) {
        if (timestamps) out += `[${shortTs(s.start_ms)}] `;
        out += `${label(s)}${s.text.trim()}\n\n`;
      }
      return `${out.trimEnd()}\n`;
    }
    case "md": {
      let out = `# ${rec.title}\n\n*${longDate(rec.created_at)} · ${shortTs(rec.duration_ms)}*\n\n`;
      if (rec.enhanced !== "") out += `${rec.enhanced}\n\n`;
      else if (rec.summary !== "") out += `## Summary\n\n${rec.summary}\n\n`;
      if (includeNotes && rec.notes.trim() !== "") out += `## My notes\n\n${rec.notes.trim()}\n\n`;
      out += "## Transcript\n\n";
      for (const s of mergeSpeakerRuns(segs)) {
        const t = timestamps ? `\`${shortTs(s.start_ms)}\` ` : "";
        const n = speakers ? speakerName(rec, s) : undefined;
        out += `${t}${n !== undefined ? `**${n}:** ` : ""}${s.text.trim()}\n\n`;
      }
      return out;
    }
    case "srt": {
      let out = "";
      subtitleCues(segs, 42).forEach((s, i) => {
        out += `${i + 1}\n${ts(s.start_ms, ",")} --> ${ts(Math.max(s.end_ms, s.start_ms + 500), ",")}\n${label(s)}${wrapLines(s.text.trim(), 42)}\n\n`;
      });
      return out;
    }
    case "vtt": {
      let out = "WEBVTT\n\n";
      for (const s of subtitleCues(segs, 42)) {
        const text = wrapLines(s.text.trim(), 42);
        const n = speakers ? speakerName(rec, s) : undefined;
        const body = n !== undefined ? `<v ${n}>${text}` : text;
        out += `${ts(s.start_ms, ".")} --> ${ts(Math.max(s.end_ms, s.start_ms + 500), ".")}\n${body}\n\n`;
      }
      return out;
    }
    case "csv": {
      let out = "start,end,speaker,text\n";
      const q = (v: string) => `"${v.replaceAll('"', '""')}"`;
      for (const s of segs) out += `${shortTs(s.start_ms)},${shortTs(s.end_ms)},${q(speakerName(rec, s) ?? "")},${q(s.text.trim())}\n`;
      return out;
    }
    case "json":
      return JSON.stringify(
        {
          title: rec.title,
          created_at: rec.created_at,
          duration_ms: rec.duration_ms,
          language: rec.language,
          notes: rec.notes,
          enhanced_notes: rec.enhanced,
          summary: rec.summary,
          speakers: rec.speakers,
          segments: segs,
        },
        null,
        2,
      );
    default:
      throw new Error(`unknown export format ${opts.format}`);
  }
}
