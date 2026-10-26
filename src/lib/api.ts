// Typed wrappers over the backend commands in src/bun/backend/commands.ts.

import { invoke, listen, type UnlistenFn } from "./ipc";
import type {
  AppInfo,
  CliStatus,
  Dictation,
  ExportOptions,
  InputDevice,
  LlmProfile,
  MeetingStatus,
  ModelStatus,
  Permissions,
  Recording,
  RecordingKind,
  RecordingPatch,
  RecordingSummary,
  Settings,
  Stats,
  SttProfile,
} from "./types";

export const api = {
  getSettings: () => invoke<Settings>("get_settings"),
  /** Returns hotkey registration errors, if any. */
  saveSettings: (settings: Settings) => invoke<string[]>("save_settings", { settings }),
  appInfo: () => invoke<AppInfo>("app_info"),
  permissions: () => invoke<Permissions>("get_permissions"),
  openPrivacy: (pane: "accessibility" | "microphone" | "system_audio" | "input_monitoring") =>
    invoke<void>("open_privacy", { pane }),
  requestMicrophone: () => invoke<void>("request_microphone"),
  validateHotkey: (hotkey: string) => invoke<void>("validate_hotkey", { hotkey }),
  inputDevices: () => invoke<InputDevice[]>("list_input_devices"),
  stats: () => invoke<Stats>("stats"),
  reveal: (path: string) => invoke<void>("reveal_path", { path }),

  models: () => invoke<ModelStatus[]>("list_models"),
  downloadModel: (id: string) => invoke<void>("download_model", { id }),
  cancelModelDownload: (id: string) => invoke<void>("cancel_model_download", { id }),
  deleteModel: (id: string) => invoke<void>("delete_model", { id }),
  testStt: (profile: SttProfile) => invoke<string>("test_stt", { profile }),

  detectClis: () => invoke<CliStatus[]>("detect_clis"),
  testLlm: (profile: LlmProfile) => invoke<string>("test_llm", { profile }),
  llmModels: (profile: LlmProfile) => invoke<string[]>("llm_models", { profile }),

  dictationToggle: () => invoke<void>("dictation_toggle"),
  dictationCancel: () => invoke<void>("dictation_cancel"),
  dictations: (query = "", limit = 100, offset = 0) =>
    invoke<Dictation[]>("list_dictations", { query, limit, offset }),
  deleteDictation: (id: string) => invoke<void>("delete_dictation", { id }),
  clearDictations: () => invoke<void>("clear_dictations"),
  applyStyle: (text: string, styleId: string) => invoke<string>("apply_style", { text, styleId }),

  addFiles: (paths: string[]) => invoke<Recording[]>("add_files", { paths }),
  addUrl: (url: string) => invoke<Recording>("add_url", { url }),
  recordings: (kind?: RecordingKind, query = "") => invoke<RecordingSummary[]>("list_recordings", { kind, query }),
  recording: (id: string) => invoke<Recording | null>("get_recording", { id }),
  updateRecording: (id: string, patch: RecordingPatch) => invoke<Recording | null>("update_recording", { id, patch }),
  deleteRecording: (id: string) => invoke<void>("delete_recording", { id }),
  retranscribe: (id: string, sttProfile?: string, language?: string | null) =>
    invoke<void>("retranscribe", { id, sttProfile, language }),
  cancelJob: (id: string) => invoke<void>("cancel_job", { id }),
  exportRecording: (id: string, options: ExportOptions, path: string) =>
    invoke<void>("export_recording", { id, options, path }),
  exportText: (id: string, options: ExportOptions) => invoke<string>("export_text", { id, options }),

  cancelLlm: (requestId: string) => invoke<void>("cancel_llm", { requestId }),
  summarize: (id: string, requestId: string) => invoke<string>("summarize", { id, requestId }),
  chat: (id: string, question: string, requestId: string) => invoke<string>("chat", { id, question, requestId }),
  clearChat: (id: string) => invoke<void>("clear_chat", { id }),
  runRecipe: (id: string, recipeId: string, requestId: string) =>
    invoke<string>("run_recipe", { id, recipeId, requestId }),
  askAll: (question: string, kind: RecordingKind | undefined, requestId: string) =>
    invoke<string>("ask_all", { question, kind, requestId }),
  translate: (id: string, language: string, requestId: string) =>
    invoke<string>("translate_recording", { id, language, requestId }),

  meetingStart: (id?: string, title?: string) => invoke<Recording>("meeting_start", { id, title }),
  meetingStop: () => invoke<string>("meeting_stop"),
  meetingStatus: () => invoke<MeetingStatus | null>("meeting_status"),
  meetingPause: (paused: boolean) => invoke<void>("meeting_pause", { paused }),
  meetingCreate: (title?: string) => invoke<Recording>("meeting_create", { title }),
  meetingEnhance: (id: string, templateId?: string) => invoke<string>("meeting_enhance", { id, templateId }),
};

/** Subscribe to a backend event; returns a sync cleanup suitable for $effect. */
export function on<T>(event: string, handler: (payload: T) => void): () => void {
  let un: UnlistenFn | undefined;
  let dead = false;
  listen<T>(event, (e) => handler(e.payload)).then((u) => {
    if (dead) u();
    else un = u;
  });
  return () => {
    dead = true;
    un?.();
  };
}

/** Stream an LLM call: `run` receives a request id, deltas arrive through `onDelta`. */
export async function streamLlm(
  run: (requestId: string) => Promise<string>,
  onDelta: (delta: string) => void,
): Promise<{ requestId: string; result: Promise<string> }> {
  const requestId = crypto.randomUUID();
  // Await the subscription so no early deltas are missed.
  const off = await listen<{ request_id: string; delta: string }>("llm:delta", (e) => {
    if (e.payload.request_id === requestId) onDelta(e.payload.delta);
  });
  const result = run(requestId).finally(off);
  return { requestId, result };
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
