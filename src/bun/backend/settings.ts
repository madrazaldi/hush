// Persisted user settings: `settings.json` in the app data dir, byte-compatible with the format the
// Rust build wrote (snake_case keys, 2-space JSON, mode 0600 because it holds API keys).

import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Activation,
  AutoSubmit,
  DictationSettings,
  FileSettings,
  GeneralSettings,
  LlmKind,
  LlmProfile,
  MeetingSettings,
  NoteTemplate,
  OverlayPosition,
  PasteMethod,
  Recipe,
  Replacement,
  Settings,
  Style,
  SttKind,
  SttProfile,
} from "../../lib/types";
import { BUILTIN_RECIPES, BUILTIN_STYLES, BUILTIN_TEMPLATES } from "./ai-data";
import { log } from "./log";
import { settingsFile } from "./paths";

export const LOCAL_PROFILE = "local";

const ACTIVATIONS: Activation[] = ["push_to_talk", "toggle", "hybrid"];
const PASTE_METHODS: PasteMethod[] = ["paste", "type", "copy_only"];
const AUTO_SUBMITS: AutoSubmit[] = ["off", "enter", "cmd_enter"];
const OVERLAYS: OverlayPosition[] = ["top", "bottom", "hidden"];
const STT_KINDS: SttKind[] = ["local", "openai_compatible", "xai", "muse", "deepgram", "elevenlabs", "assemblyai"];
const LLM_KINDS: LlmKind[] = ["claude_code", "codex", "opencode", "gemini", "antigravity", "openai_chat", "openai_responses", "anthropic"];
const THEMES = ["system", "light", "dark"] as const;

export function defaultSettings(): Settings {
  return {
    general: { launch_at_login: false, show_in_dock: true, theme: "system", history_days: 0, onboarded: false },
    stt_profiles: [
      { id: LOCAL_PROFILE, name: "On-device", kind: "local", model: "parakeet-tdt-0.6b-v3", base_url: "", api_key: "" },
    ],
    llm_profiles: [],
    vocabulary: [],
    replacements: [],
    dictation: {
      enabled: true,
      hotkey: "Fn",
      activation: "hybrid",
      hold_ms: 300,
      command_hotkey: "Fn+Shift",
      paste_last_hotkey: "Cmd+Ctrl+V",
      stt_profile: LOCAL_PROFILE,
      language: null,
      mic_device: null,
      paste_method: "paste",
      restore_clipboard: true,
      auto_submit: "off",
      trailing_space: true,
      sounds: true,
      mute_system_audio: false,
      overlay: "bottom",
      remove_fillers: true,
      llm_enabled: false,
      llm_profile: "",
      default_style: "clean",
      styles: structuredClone(BUILTIN_STYLES),
      app_context: true,
      keep_audio: false,
    },
    meetings: {
      stt_profile: LOCAL_PROFILE,
      language: null,
      mic_device: null,
      capture_system_audio: true,
      keep_audio: true,
      auto_enhance: false,
      auto_enhance_confirmed: false,
      llm_profile: "",
      default_template: "general",
      templates: structuredClone(BUILTIN_TEMPLATES),
      recipes: structuredClone(BUILTIN_RECIPES),
      detect_meetings: true,
      your_name: "",
    },
    files: { stt_profile: LOCAL_PROFILE, language: null, diarize: false, llm_profile: "", auto_summarize: false },
  };
}

// ---- tolerant parsing (the equivalent of serde's `#[serde(default)]`) ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const optStr = (v: unknown, d: string | null): string | null => (v === null ? null : typeof v === "string" ? v : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
const strings = (v: unknown, d: string[]): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : d);
function list<T>(v: unknown, f: (o: Obj) => T | null, d: T[]): T[] {
  if (!Array.isArray(v)) return d;
  return v.filter(isObj).map(f).filter((x): x is T => x !== null);
}

function sttProfile(o: Obj): SttProfile | null {
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  return {
    id: o.id,
    name: o.name,
    kind: oneOf(o.kind, STT_KINDS, "local"),
    model: str(o.model, ""),
    base_url: str(o.base_url, ""),
    api_key: str(o.api_key, ""),
  };
}

function llmProfile(o: Obj): LlmProfile | null {
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  return {
    id: o.id,
    name: o.name,
    kind: oneOf(o.kind, LLM_KINDS, "openai_chat"),
    model: str(o.model, ""),
    base_url: str(o.base_url, ""),
    api_key: str(o.api_key, ""),
    bin_path: str(o.bin_path, ""),
    effort: str(o.effort, ""),
  };
}

function style(o: Obj): Style | null {
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  return { id: o.id, name: o.name, prompt: str(o.prompt, ""), apps: strings(o.apps, []), builtin: bool(o.builtin, false) };
}

function template(o: Obj): NoteTemplate | null {
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  return { id: o.id, name: o.name, description: str(o.description, ""), prompt: str(o.prompt, ""), builtin: bool(o.builtin, false) };
}

function recipe(o: Obj): Recipe | null {
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  return { id: o.id, name: o.name, prompt: str(o.prompt, ""), builtin: bool(o.builtin, false) };
}

function replacement(o: Obj): Replacement | null {
  if (typeof o.from !== "string" || typeof o.to !== "string") return null;
  return { from: o.from, to: o.to };
}

/** Build a complete Settings from arbitrary JSON, filling anything missing from the defaults. */
export function parseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  const r = isObj(raw) ? raw : {};
  const g = isObj(r.general) ? r.general : {};
  const di = isObj(r.dictation) ? r.dictation : {};
  const m = isObj(r.meetings) ? r.meetings : {};
  const f = isObj(r.files) ? r.files : {};

  const general: GeneralSettings = {
    launch_at_login: bool(g.launch_at_login, d.general.launch_at_login),
    show_in_dock: bool(g.show_in_dock, d.general.show_in_dock),
    theme: oneOf(g.theme, THEMES, d.general.theme),
    history_days: num(g.history_days, d.general.history_days),
    onboarded: bool(g.onboarded, d.general.onboarded),
  };
  const dd = d.dictation;
  const dictation: DictationSettings = {
    enabled: bool(di.enabled, dd.enabled),
    hotkey: str(di.hotkey, dd.hotkey),
    activation: oneOf(di.activation, ACTIVATIONS, dd.activation),
    hold_ms: num(di.hold_ms, dd.hold_ms),
    command_hotkey: str(di.command_hotkey, dd.command_hotkey),
    paste_last_hotkey: str(di.paste_last_hotkey, dd.paste_last_hotkey),
    stt_profile: str(di.stt_profile, dd.stt_profile),
    language: optStr(di.language, dd.language),
    mic_device: optStr(di.mic_device, dd.mic_device),
    paste_method: oneOf(di.paste_method, PASTE_METHODS, dd.paste_method),
    restore_clipboard: bool(di.restore_clipboard, dd.restore_clipboard),
    auto_submit: oneOf(di.auto_submit, AUTO_SUBMITS, dd.auto_submit),
    trailing_space: bool(di.trailing_space, dd.trailing_space),
    sounds: bool(di.sounds, dd.sounds),
    mute_system_audio: bool(di.mute_system_audio, dd.mute_system_audio),
    overlay: oneOf(di.overlay, OVERLAYS, dd.overlay),
    remove_fillers: bool(di.remove_fillers, dd.remove_fillers),
    llm_enabled: bool(di.llm_enabled, dd.llm_enabled),
    llm_profile: str(di.llm_profile, dd.llm_profile),
    default_style: str(di.default_style, dd.default_style),
    styles: list(di.styles, style, dd.styles),
    app_context: bool(di.app_context, dd.app_context),
    keep_audio: bool(di.keep_audio, dd.keep_audio),
  };
  const dm = d.meetings;
  const meetings: MeetingSettings = {
    stt_profile: str(m.stt_profile, dm.stt_profile),
    language: optStr(m.language, dm.language),
    mic_device: optStr(m.mic_device, dm.mic_device),
    capture_system_audio: bool(m.capture_system_audio, dm.capture_system_audio),
    keep_audio: bool(m.keep_audio, dm.keep_audio),
    auto_enhance: bool(m.auto_enhance, dm.auto_enhance),
    auto_enhance_confirmed: bool(m.auto_enhance_confirmed, dm.auto_enhance_confirmed),
    llm_profile: str(m.llm_profile, dm.llm_profile),
    default_template: str(m.default_template, dm.default_template),
    templates: list(m.templates, template, dm.templates),
    recipes: list(m.recipes, recipe, dm.recipes),
    detect_meetings: bool(m.detect_meetings, dm.detect_meetings),
    your_name: str(m.your_name, dm.your_name),
  };
  const files: FileSettings = {
    stt_profile: str(f.stt_profile, d.files.stt_profile),
    language: optStr(f.language, d.files.language),
    diarize: bool(f.diarize, d.files.diarize),
    llm_profile: str(f.llm_profile, d.files.llm_profile),
    auto_summarize: bool(f.auto_summarize, d.files.auto_summarize),
  };
  return {
    general,
    stt_profiles: list(r.stt_profiles, sttProfile, d.stt_profiles),
    llm_profiles: list(r.llm_profiles, llmProfile, d.llm_profiles),
    vocabulary: strings(r.vocabulary, d.vocabulary),
    replacements: list(r.replacements, replacement, d.replacements),
    dictation,
    meetings,
    files,
  };
}

/** Fix up settings written by older versions. */
export function migrate(s: Settings): void {
  // Sending meetings to an AI provider must be opted into: drop the old
  // default-on value unless the user chose it.
  if (!s.meetings.auto_enhance_confirmed) s.meetings.auto_enhance = false;
}

/** Built-ins are refreshed from code but user edits to them are kept. */
function mergeBuiltins<T extends { id: string }>(list: T[], builtins: T[]): void {
  for (const b of [...builtins].reverse()) {
    if (!list.some((x) => x.id === b.id)) list.unshift(structuredClone(b));
  }
}

/** Ensure invariants after loading or after the UI sends an update. */
export function normalize(s: Settings): Settings {
  // Anything that saves `auto_enhance: true` after `load` came from the user turning it on in the UI.
  if (s.meetings.auto_enhance) s.meetings.auto_enhance_confirmed = true;
  if (!s.stt_profiles.some((p) => p.id === LOCAL_PROFILE)) s.stt_profiles.unshift(defaultSettings().stt_profiles[0]);
  mergeBuiltins(s.dictation.styles, BUILTIN_STYLES);
  mergeBuiltins(s.meetings.templates, BUILTIN_TEMPLATES);
  mergeBuiltins(s.meetings.recipes, BUILTIN_RECIPES);
  const firstLlm = s.llm_profiles[0]?.id ?? "";
  for (const slot of ["dictation", "meetings", "files"] as const) {
    if (!s.llm_profiles.some((p) => p.id === s[slot].llm_profile)) s[slot].llm_profile = firstLlm;
    if (!s.stt_profiles.some((p) => p.id === s[slot].stt_profile)) s[slot].stt_profile = LOCAL_PROFILE;
  }
  return s;
}

export function loadSettings(path: string = settingsFile()): Settings {
  let raw: unknown = undefined;
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // first run
  }
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch (e) {
      log.error("settings parse error, using defaults:", e);
      try {
        copyFileSync(path, path.replace(/\.json$/, "") + ".json.bak");
      } catch {
        // best effort
      }
    }
  }
  const s = parseSettings(raw);
  migrate(s);
  return normalize(s);
}

/** Write atomically; the file is 0600 from the start because API keys live in it. */
export function saveSettings(s: Settings, path: string = settingsFile()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function sttFor(s: Settings, id: string): SttProfile {
  return s.stt_profiles.find((p) => p.id === id) ?? s.stt_profiles[0];
}

export function llmFor(s: Settings, id: string): LlmProfile | undefined {
  return s.llm_profiles.find((p) => p.id === id) ?? s.llm_profiles[0];
}

/** Default profiles for the agent CLIs that are installed, created on first run. */
export function seedLlmProfiles(s: Settings, installed: LlmKind[]): void {
  if (s.llm_profiles.length > 0) return;
  const known: Partial<Record<LlmKind, [string, string, string]>> = {
    claude_code: ["claude-code", "Claude Code", "haiku"],
    codex: ["codex", "Codex", ""],
    opencode: ["opencode", "opencode", ""],
    gemini: ["gemini", "Gemini CLI", ""],
    antigravity: ["antigravity", "Antigravity", ""],
  };
  for (const kind of installed) {
    const k = known[kind];
    if (!k) continue;
    s.llm_profiles.push({ id: k[0], name: k[1], kind, model: k[2], base_url: "", api_key: "", bin_path: "", effort: "" });
  }
  normalize(s);
}
