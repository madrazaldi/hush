// Granola-style notes: the user's rough notes plus the transcript become structured notes.

import * as ai from "../ai";
import * as llm from "../llm";
import { llmFor } from "../settings";
import { emit, settings, st } from "../state";
import { namedSegments } from "./text";

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

/** "Monday, October 26, 2026 14:05" in local time. */
export function longDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${WEEKDAY.format(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "Oct 26, 14:05" in local time. */
export function defaultTitle(ms: number = Date.now()): string {
  const d = new Date(ms);
  const mon = d.toLocaleString("en-US", { month: "short" });
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `Meeting ${mon} ${d.getDate()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * Generate enhanced notes with the given (or saved) template, streaming deltas to the UI as
 * `meeting:enhance` events.
 */
export async function enhance(id: string, templateId?: string | null): Promise<string> {
  const state = st();
  const s = settings();
  const rec = state.db.getRecording(id);
  if (!rec) throw new Error("meeting not found");
  const profile = llmFor(s, s.meetings.llm_profile);
  if (!profile) throw new Error("Add an AI provider in Settings → AI to generate notes");
  const tid = templateId ?? rec.template_id ?? s.meetings.default_template;
  const tpl = s.meetings.templates.find((t) => t.id === tid) ?? s.meetings.templates[0];
  if (!tpl) throw new Error("no templates");
  const info = {
    title: rec.title,
    date: longDate(rec.created_at),
    durationMin: Math.trunc(rec.duration_ms / 60_000),
    yourName: s.meetings.your_name,
  };
  const req = ai.enhanceRequest(tpl, rec.notes, namedSegments(rec), info);

  emit("meeting:enhance", { id, reset: true });
  const key = `enhance:${id}`;
  const ctl = new AbortController();
  state.llmTasks.get(key)?.abort();
  state.llmTasks.set(key, ctl);
  let notes: string;
  try {
    notes = await llm.complete(profile, req, { signal: ctl.signal, onDelta: (delta) => emit("meeting:enhance", { id, delta }) });
  } finally {
    if (state.llmTasks.get(key) === ctl) state.llmTasks.delete(key);
  }

  // Auto-title meetings that still have the generated default name.
  let title: string | null = null;
  if (rec.title.startsWith("Meeting ")) {
    try {
      const t = (await llm.complete(profile, ai.titleRequest(notes))).trim().replace(/^"+|"+$/g, "").trim();
      if (t !== "" && Buffer.byteLength(t) < 100) title = t;
    } catch {
      // the generated title is optional
    }
  }
  state.db.updateRecording(id, (r) => {
    r.enhanced = notes;
    r.template_id = tpl.id;
    if (title) r.title = title;
  });
  emit("recording:updated", id);
  emit("meeting:enhance", { id, done: true });
  return notes;
}
