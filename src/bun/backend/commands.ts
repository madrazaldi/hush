// The command surface used by the Svelte UI (the old `#[tauri::command]` set). The webview calls
// `invoke(cmd, args)`; `dispatch` looks the command up here. Arguments arrive camelCase from the UI (as
// Tauri converted them); RecordingPatch fields stay snake_case. Errors reach the UI as plain strings.

import { existsSync, rmSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LlmProfile, Recording, RecordingKind, RecordingPatch, Settings, SttProfile } from "../../lib/types";
import * as ai from "./ai";
import { ffmpegAvailable } from "./audio/decode";
import { newRecording, nowMs } from "./db";
import { exportRecording } from "./export";
import * as llm from "./llm";
import { errMsg, log } from "./log";
import { enhance, namedSegments } from "./meetings";
import { defaultTitle } from "./meetings/enhance";
import { native } from "./native";
import { audioDir, mediaDir, rootDir, scratchDir } from "./paths";
import { openPrivacyPane, revealPath } from "./platform";
import { llmFor, normalize, saveSettings } from "./settings";
import { which } from "./shell-env";
import { emit, settings, shell, st } from "./state";
import * as stt from "./stt";

type Handler = (args: any) => unknown | Promise<unknown>;
const registry = new Map<string, Handler>();

/** Add commands; the shell registers the ones that need windows and dialogs. */
export function register(handlers: Record<string, Handler>): void {
  for (const [name, fn] of Object.entries(handlers)) registry.set(name, fn);
}

export type Reply = { ok: unknown } | { err: string };

/** Run a command, turning a thrown error into the string the UI shows. */
export async function dispatch(cmd: string, args: unknown): Promise<Reply> {
  const fn = registry.get(cmd);
  if (!fn) return { err: `unknown command ${cmd}` };
  try {
    const out = await fn((args ?? {}) as Record<string, unknown>);
    return { ok: out === undefined ? null : out };
  } catch (e) {
    log.warn(`command ${cmd} failed:`, e);
    return { err: errMsg(e) };
  }
}

export const commandNames = (): string[] => [...registry.keys()];

const notFound = () => new Error("not found");
function recordingOrThrow(id: string): Recording {
  const rec = st().db.getRecording(id);
  if (!rec) throw notFound();
  return rec;
}

// ---------- LLM helpers ----------

async function streamLlm(profile: LlmProfile, req: llm.ChatRequest, requestId: string): Promise<string> {
  const ctl = new AbortController();
  const tasks = st().llmTasks;
  tasks.set(requestId, ctl);
  try {
    return await llm.complete(profile, req, { signal: ctl.signal, onDelta: (delta) => emit("llm:delta", { request_id: requestId, delta }) });
  } finally {
    if (tasks.get(requestId) === ctl) tasks.delete(requestId);
  }
}

function llmProfileFor(kind: string): LlmProfile {
  const s = settings();
  const p = llmFor(s, kind === "meeting" ? s.meetings.llm_profile : s.files.llm_profile);
  if (!p) throw new Error("Add an AI provider in Settings → AI first");
  return p;
}

async function chat(id: string, question: string, requestId: string): Promise<string> {
  const state = st();
  const rec = recordingOrThrow(id);
  const profile = llmProfileFor(rec.kind);
  const notes = rec.enhanced !== "" ? rec.enhanced : rec.notes;
  const req = ai.chatRequest(rec.title, namedSegments(rec), notes, rec.chat, question);
  const answer = await streamLlm(profile, req, requestId);
  state.db.updateRecording(id, (r) => {
    r.chat.push({ role: "user", content: question }, { role: "assistant", content: answer });
  });
  return answer;
}

const ymd = (ms: number) => {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

const firstChars = (s: string, n: number) => Array.from(s).slice(0, n).join("");

// ---------- settings & system ----------

register({
  get_settings: () => settings(),

  save_settings: async ({ settings: incoming }: { settings: Settings }) => {
    const state = st();
    const s = normalize(incoming);
    saveSettings(s);
    const prevLogin = state.settings.general.launch_at_login;
    state.settings = s;
    if (prevLogin !== s.general.launch_at_login) shell.setLaunchAtLogin(s.general.launch_at_login);
    shell.setDockVisible(s.general.show_in_dock);
    return await state.dictation.rebind();
  },

  app_info: () => ({
    version: shell.appVersion(),
    data_dir: rootDir(),
    ffmpeg: ffmpegAvailable(),
    ytdlp: which("yt-dlp") !== null,
    platform: "macos",
  }),

  get_permissions: () => native().permissions(),
  open_privacy: ({ pane }: { pane: string }) => openPrivacyPane(pane),

  /** Briefly open the mic so macOS shows its permission prompt (nothing is kept). */
  request_microphone: async () => {
    const id = `probe:${crypto.randomUUID()}`;
    const path = join(scratchDir(), `probe-${crypto.randomUUID()}.f32`);
    try {
      await native().captureStart({ id, source: "mic", path, rotate_ms: 0 });
      await Bun.sleep(300);
      await native().captureStop(id);
    } finally {
      rmSync(path, { force: true });
    }
  },

  validate_hotkey: async ({ hotkey }: { hotkey: string }) => {
    await native().hotkeysValidate(hotkey);
  },

  list_input_devices: async () => {
    try {
      return await native().devices();
    } catch (e) {
      log.warn("listing input devices:", e);
      return [];
    }
  },

  stats: () => st().db.stats(),
  reveal_path: ({ path }: { path: string }) => revealPath(path),
});

// ---------- models & providers ----------

register({
  list_models: () => stt.models.statuses(),

  download_model: async ({ id }: { id: string }) => {
    try {
      await stt.models.download(id, (progress) => emit("model:progress", { id, progress }));
    } catch (e) {
      emit("model:progress", { id, progress: -1, done: true });
      throw e;
    }
    emit("model:progress", { id, progress: 1, done: true });
  },

  cancel_model_download: ({ id }: { id: string }) => stt.models.cancelDownload(id),

  delete_model: ({ id }: { id: string }) => {
    try {
      stt.local.evict(id);
    } catch (e) {
      log.warn("evicting model:", e);
    }
    stt.models.remove(id);
  },

  test_stt: ({ profile }: { profile: SttProfile }) => (profile.kind === "local" ? stt.local.describe(profile.model) : stt.cloud.testProfile(profile)),

  detect_clis: () => llm.detectClis(),

  test_llm: async ({ profile }: { profile: LlmProfile }) => {
    const start = Date.now();
    const req = llm.simpleRequest("You are a connectivity check. Follow instructions exactly.", "Reply with exactly: OK");
    const out = await llm.complete(profile, req);
    return `${firstChars(out, 40)} (${((Date.now() - start) / 1000).toFixed(1)}s)`;
  },

  llm_models: ({ profile }: { profile: LlmProfile }) => llm.listModels(profile),
});

// ---------- dictation ----------

register({
  dictation_toggle: () => {
    void st().dictation.toggle();
  },
  dictation_cancel: () => st().dictation.cancel(),

  list_dictations: ({ query, limit, offset }: { query?: string; limit?: number; offset?: number }) =>
    st().db.listDictations(query ?? "", limit ?? 100, offset ?? 0),

  delete_dictation: ({ id }: { id: string }) => {
    const p = st().db.deleteDictation(id);
    if (p) rmSync(p, { force: true });
  },

  clear_dictations: () => {
    for (const p of st().db.clearDictations()) rmSync(p, { force: true });
  },

  /** Run raw text through a dictation style (the "try a style" playground). */
  apply_style: async ({ text, styleId }: { text: string; styleId: string }) => {
    const s = settings();
    const style = s.dictation.styles.find((x) => x.id === styleId);
    if (!style) throw new Error("unknown style");
    let t = ai.rules.spokenCommands(text);
    if (s.dictation.remove_fillers) t = ai.rules.removeFillers(t);
    if (style.prompt.trim() !== "") {
      const profile = llmFor(s, s.dictation.llm_profile);
      if (!profile) throw new Error("Add an AI provider first");
      t = await llm.complete(profile, ai.dictationRequest(style, t, { appName: null, vocabulary: s.vocabulary }));
    }
    return ai.rules.applyReplacements(t, s.replacements);
  },
});

// ---------- recordings (files + meetings) ----------

register({
  add_files: ({ paths }: { paths: string[] }) => paths.map((p) => st().files.addFile(p)),
  add_url: ({ url }: { url: string }) => st().files.addUrl(url),

  list_recordings: ({ kind, query }: { kind?: RecordingKind | null; query?: string | null }) => st().db.listRecordings(kind ?? "", query ?? ""),
  get_recording: ({ id }: { id: string }) => st().db.getRecording(id),

  update_recording: ({ id, patch }: { id: string; patch: RecordingPatch }) =>
    st().db.updateRecording(id, (r) => {
      if (patch.title != null) r.title = patch.title;
      if (patch.notes != null) r.notes = patch.notes;
      if (patch.enhanced != null) r.enhanced = patch.enhanced;
      if (patch.summary != null) r.summary = patch.summary;
      if (patch.speakers != null) r.speakers = patch.speakers;
      if (patch.starred != null) r.starred = patch.starred;
      if (patch.template_id != null) r.template_id = patch.template_id;
      if (patch.language != null) r.language = patch.language !== "" ? patch.language : null;
      if (patch.stt != null) r.stt = patch.stt;
      if (patch.segment_edit) {
        const [i, text] = patch.segment_edit;
        const seg = r.segments[i];
        if (seg) {
          seg.text = text;
          seg.words = [];
        }
      }
      if (patch.segment_speaker) {
        const [i, sp] = patch.segment_speaker;
        const seg = r.segments[i];
        if (seg) seg.speaker = sp !== "" ? sp : undefined;
      }
    }),

  delete_recording: ({ id }: { id: string }) => {
    const state = st();
    state.files.cancel(id);
    const rec = state.db.deleteRecording(id);
    if (!rec) return;
    // Only delete media we own (downloads, meeting audio), never the user's source file, and nothing
    // another recording (e.g. a translation) still uses.
    const root = `${rootDir()}/`;
    const unused = (p: string) => !state.db.mediaInUse(p);
    for (const p of [rec.media_path, rec.audio_path]) {
      if (!p || !p.startsWith(root) || !unused(p)) continue;
      rmSync(p, { force: true });
      // Uploaded files live in a folder of their own under media/.
      const parent = dirname(p);
      if (parent !== mediaDir() && parent.startsWith(`${mediaDir()}/`)) {
        try {
          rmdirSync(parent);
        } catch {
          // not empty: something else is in there
        }
      }
    }
    const dir = join(audioDir(), rec.id);
    if (existsSync(dir) && statSync(dir).isDirectory() && unused(dir)) rmSync(dir, { recursive: true, force: true });
  },

  retranscribe: ({ id, sttProfile, language }: { id: string; sttProfile?: string | null; language?: string | null }) => {
    const state = st();
    const rec = state.db.updateRecording(id, (r) => {
      if (sttProfile) r.stt = sttProfile;
      r.language = language ? language : null;
      // Re-transcribe the mixed meeting audio as a file.
      if (r.kind === "meeting") r.media_path = r.audio_path;
    });
    if (!rec) throw notFound();
    if (!rec.media_path && !rec.source) throw new Error("This recording has no audio to re-transcribe");
    state.files.enqueue(id);
  },

  cancel_job: ({ id }: { id: string }) => st().files.cancel(id),

  export_recording: async ({ id, options, path }: { id: string; options: Parameters<typeof exportRecording>[1]; path: string }) => {
    await Bun.write(path, exportRecording(recordingOrThrow(id), options));
  },
  export_text: ({ id, options }: { id: string; options: Parameters<typeof exportRecording>[1] }) => exportRecording(recordingOrThrow(id), options),
});

// ---------- LLM features (streaming via `llm:delta`) ----------

register({
  cancel_llm: ({ requestId }: { requestId: string }) => {
    const tasks = st().llmTasks;
    tasks.get(requestId)?.abort();
    tasks.delete(requestId);
  },

  summarize: async ({ id, requestId }: { id: string; requestId: string }) => {
    const rec = recordingOrThrow(id);
    const out = await streamLlm(llmProfileFor(rec.kind), ai.summaryRequest(rec.title, namedSegments(rec)), requestId);
    st().db.updateRecording(id, (r) => {
      r.summary = out;
    });
    return out;
  },

  chat: ({ id, question, requestId }: { id: string; question: string; requestId: string }) => chat(id, question, requestId),

  clear_chat: ({ id }: { id: string }) => {
    st().db.updateRecording(id, (r) => {
      r.chat = [];
    });
  },

  run_recipe: ({ id, recipeId, requestId }: { id: string; recipeId: string; requestId: string }) => {
    const recipe = settings().meetings.recipes.find((r) => r.id === recipeId);
    if (!recipe) throw new Error("unknown recipe");
    return chat(id, recipe.prompt, requestId);
  },

  /** Ask a question across many recordings ("what did we decide about pricing this month?"). */
  ask_all: async ({ question, kind, requestId }: { question: string; kind?: RecordingKind | null; requestId: string }) => {
    const state = st();
    const profile = llmProfileFor(kind ?? "meeting");
    const list = state.db.listRecordings(kind ?? "", "");
    // Budget the context: newest first, notes preferred over raw transcripts.
    let ctx = "";
    for (const item of list.slice(0, 40)) {
      const rec = state.db.getRecording(item.id);
      if (!rec) continue;
      const body = rec.enhanced !== "" ? rec.enhanced : rec.summary !== "" ? rec.summary : firstChars(ai.transcriptForLlm(namedSegments(rec)), 6000);
      ctx += `\n<recording title="${rec.title}" date="${ymd(rec.created_at)}">\n${body}\n</recording>\n`;
      if (Buffer.byteLength(ctx) > 120_000) break;
    }
    const req = llm.simpleRequest(
      `You answer questions across the user's recorded meetings and transcripts. Cite the recording title and date for every claim. If the answer isn't present, say so.\n${ctx}`,
      question,
    );
    return streamLlm(profile, req, requestId);
  },

  translate_recording: async ({ id, language, requestId }: { id: string; language: string; requestId: string }) => {
    const state = st();
    const rec = recordingOrThrow(id);
    const profile = llmProfileFor(rec.kind);
    const lines = rec.segments.map((s, i) => `[${i}] ${s.text.trim()}\n`).join("");
    const out = await streamLlm(profile, ai.translateRequest(lines, language), requestId);
    // Write a translated copy as a new recording so the original stays intact.
    const copy: Recording = structuredClone(rec);
    copy.id = crypto.randomUUID();
    copy.title = `${rec.title} (${language})`;
    copy.created_at = nowMs();
    copy.updated_at = copy.created_at;
    copy.chat = [];
    copy.summary = "";
    copy.enhanced = "";
    for (const line of out.split("\n")) {
      const m = /^\[([^\]]*)\](.*)$/s.exec(line.trim());
      if (!m) continue;
      const n = Number(m[1].trim());
      const seg = Number.isInteger(n) && n >= 0 ? copy.segments[n] : undefined;
      if (seg) {
        seg.text = m[2].trim();
        seg.words = [];
      }
    }
    copy.language = null;
    state.db.upsertRecording(copy);
    return copy.id;
  },
});

// ---------- meetings ----------

register({
  meeting_start: ({ id, title }: { id?: string | null; title?: string | null }) => st().meetings.start(id, title),
  meeting_stop: () => st().meetings.stop(),
  meeting_status: () => st().meetings.status(),
  meeting_pause: ({ paused }: { paused: boolean }) => st().meetings.setPaused(paused),

  /** Create an empty meeting note (e.g. to prep notes before a call). */
  meeting_create: ({ title }: { title?: string | null }) => {
    const s = settings();
    const rec = newRecording({
      id: crypto.randomUUID(),
      kind: "meeting",
      title: title && title.trim() !== "" ? title : defaultTitle(),
      status: "ready",
      template_id: s.meetings.default_template,
      stt: s.meetings.stt_profile,
    });
    st().db.upsertRecording(rec);
    return rec;
  },

  meeting_enhance: ({ id, templateId }: { id: string; templateId?: string | null }) => enhance(id, templateId),
});
