// Prompt library: request builders used by dictation, files and meetings, plus the rule-based text
// cleanup (fillers, spoken commands, replacements). The prompt texts themselves are in ai-data.ts.

import type { ChatMessage, NoteTemplate, Replacement, Segment, Style } from "../../lib/types";
import {
  CHAT_SYSTEM_HEAD,
  COMMAND_SYSTEM,
  DICTATION_SYSTEM,
  ENHANCE_SYSTEM_HEAD,
  SUMMARY_SYSTEM,
  TITLE_SYSTEM,
  TRANSLATE_SYSTEM,
} from "./ai-data";
import { type ChatRequest, simpleRequest } from "./llm/request";

export { type ChatRequest, flattenRequest, simpleRequest } from "./llm/request";
export { BUILTIN_RECIPES, BUILTIN_STYLES, BUILTIN_TEMPLATES } from "./ai-data";

export interface DictationContext {
  appName?: string | null;
  vocabulary: string[];
}

export function dictationRequest(style: Style, raw: string, ctx: DictationContext): ChatRequest {
  let system = `${DICTATION_SYSTEM}\n\nStyle: ${style.name}\n${style.prompt}`;
  if (ctx.appName) system += `\n\nThe text will be inserted into the app "${ctx.appName}"; match its conventions.`;
  if (ctx.vocabulary.length > 0) {
    system += `\n\nCorrect spellings of names and terms the user often says (fix near-misses to these): ${ctx.vocabulary.join(", ")}`;
  }
  return { ...simpleRequest(system, `<dictation>\n${raw}\n</dictation>`), temperature: 0.2 };
}

export function commandRequest(instruction: string, selected: string, app?: string | null): ChatRequest {
  let system = COMMAND_SYSTEM;
  if (app) system += ` The text lives in the app "${app}".`;
  return simpleRequest(system, `<instruction>${instruction}</instruction>\n<selection>\n${selected}\n</selection>`);
}

function fmtTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (s >= 3600) return `${Math.floor(s / 3600)}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  return `${p2(Math.floor(s / 60))}:${p2(s % 60)}`;
}

/** Transcript rendered for LLM context: `[mm:ss] Speaker: text`. */
export function transcriptForLlm(segments: Segment[]): string {
  let out = "";
  let last: string | undefined;
  for (const s of segments) {
    const speaker = s.speaker;
    if (speaker !== last || s.start_ms % 60_000 < 1) {
      out += `\n[${fmtTs(s.start_ms)}] ${speaker ?? "Speaker"}: `;
      last = speaker;
    } else {
      out += " ";
    }
    out += s.text.trim();
  }
  return out.trim();
}

export interface MeetingInfo {
  title: string;
  date: string;
  durationMin: number;
  yourName: string;
}

export function enhanceRequest(tpl: NoteTemplate, userNotes: string, segments: Segment[], info: MeetingInfo): ChatRequest {
  const me = info.yourName.trim() === "" ? "the user" : info.yourName;
  const system = `${ENHANCE_SYSTEM_HEAD.replace("{me}", () => me)}Template — ${tpl.name}:\n${tpl.prompt}`;
  const notes = userNotes.trim() === "" ? "(no notes taken)" : userNotes.trim();
  const user = `Meeting: ${info.title}\nDate: ${info.date}\nDuration: ${info.durationMin} min\n\n<my_notes>\n${notes}\n</my_notes>\n\n<transcript>\n${transcriptForLlm(segments)}\n</transcript>`;
  return { ...simpleRequest(system, user), temperature: 0.3 };
}

export function summaryRequest(title: string, segments: Segment[]): ChatRequest {
  return simpleRequest(SUMMARY_SYSTEM, `Title: ${title}\n\n<transcript>\n${transcriptForLlm(segments)}\n</transcript>`);
}

export function titleRequest(text: string): ChatRequest {
  return simpleRequest(TITLE_SYSTEM, Array.from(text).slice(0, 6000).join(""));
}

/** Chat over a transcript (and optionally notes). `history` is the prior turns. */
export function chatRequest(title: string, segments: Segment[], notes: string, history: ChatMessage[], question: string): ChatRequest {
  let system = `${CHAT_SYSTEM_HEAD.replace("{title}", () => title)}\n\n<transcript>\n${transcriptForLlm(segments)}\n</transcript>`;
  if (notes.trim() !== "") system += `\n\n<notes>\n${notes.trim()}\n</notes>`;
  return { system, messages: [...history, { role: "user", content: question }], temperature: 0.3 };
}

export function translateRequest(text: string, language: string): ChatRequest {
  return simpleRequest(TRANSLATE_SYSTEM.replace("{language}", () => language), text);
}

/** Rule-based cleanup used with or without an LLM. */
export const rules = {
  /**
   * Remove filler words and stutters. Works line by line so line breaks
   * produced by spoken commands ("new paragraph") survive.
   */
  removeFillers(text: string): string {
    return text.split("\n").map(removeFillersLine).join("\n");
  },

  /** Case-insensitive whole-word replacements (snippets are just replacements whose `to` is long). */
  applyReplacements(text: string, reps: Replacement[]): string {
    let out = text;
    for (const r of reps) {
      const from = r.from.trim();
      if (from === "") continue;
      out = replaceWordCi(out, from, r.to);
    }
    return out;
  },

  /** Spoken formatting commands that work even without an LLM. */
  spokenCommands(text: string): string {
    let s = text;
    for (const [from, to] of [
      ["new paragraph", "\n\n"],
      ["new line", "\n"],
      ["newline", "\n"],
    ] as const) {
      s = replaceWordCi(s, from, to);
    }
    return s.split(" \n").join("\n").split("\n ").join("\n").trim();
  },
};

const FILLERS = new Set(["um", "uh", "uhm", "umm", "erm", "er", "ah", "hmm", "mm", "mhm"]);
const NON_ALNUM_EDGES = /^[^\p{Alphabetic}\p{N}]+|[^\p{Alphabetic}\p{N}]+$/gu;
const isAlnum = (c: string) => /[\p{Alphabetic}\p{N}]/u.test(c);

function removeFillersLine(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\s+/).filter((w) => w !== "")) {
    const core = raw.replace(NON_ALNUM_EDGES, "").toLowerCase();
    if (FILLERS.has(core)) {
      // Preserve sentence punctuation attached to the filler.
      const last = Array.from(raw).pop();
      const prev = out[out.length - 1];
      if (last !== undefined && ".?!".includes(last) && prev !== undefined && !/[.?!,]$/.test(prev)) {
        out[out.length - 1] = prev + last;
      }
      continue;
    }
    out.push(raw);
  }
  // Collapse immediate stutters: "the the" -> "the".
  const dedup: string[] = [];
  for (const w of out.join(" ").split(" ")) {
    const l = dedup[dedup.length - 1];
    if (l !== undefined && l.toLowerCase() === w.toLowerCase() && /^\p{Alphabetic}*$/u.test(w)) continue;
    dedup.push(w);
  }
  const s = dedup.join(" ").split(" ,").join(",").split(",,").join(",");
  return capitalizeFirst(s.trim().replace(/^[, ]+/, ""));
}

function capitalizeFirst(s: string): string {
  const chars = Array.from(s);
  return chars.length === 0 ? "" : chars[0].toUpperCase() + chars.slice(1).join("");
}

function replaceWordCi(hay: string, needle: string, to: string): string {
  const lower = hay.toLowerCase();
  const nl = needle.toLowerCase();
  // Lowercasing can change the length of exotic characters; then offsets don't line up, so replace plainly.
  if (lower.length !== hay.length) return hay.split(needle).join(to);
  let out = "";
  let i = 0;
  for (;;) {
    const pos = lower.indexOf(nl, i);
    if (pos < 0) break;
    const end = pos + nl.length;
    const beforeOk = pos === 0 || !isAlnum(hay[pos - 1]);
    const afterOk = end >= hay.length || !isAlnum(hay[end]);
    out += hay.slice(i, pos);
    out += beforeOk && afterOk ? to : hay.slice(pos, end);
    i = end;
  }
  return out + hay.slice(i);
}
