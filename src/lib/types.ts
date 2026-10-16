// Mirrors of the Rust types serialized over IPC (see src-tauri/src).

export type SttKind = "local" | "openai_compatible" | "xai" | "muse" | "deepgram" | "elevenlabs" | "assemblyai";
export type LlmKind =
  | "claude_code"
  | "codex"
  | "opencode"
  | "gemini"
  | "antigravity"
  | "openai_chat"
  | "openai_responses"
  | "anthropic";

export interface SttProfile {
  id: string;
  name: string;
  kind: SttKind;
  model: string;
  base_url: string;
  api_key: string;
}

export interface LlmProfile {
  id: string;
  name: string;
  kind: LlmKind;
  model: string;
  base_url: string;
  api_key: string;
  bin_path: string;
  effort: string;
}

export interface Style {
  id: string;
  name: string;
  prompt: string;
  apps: string[];
  builtin: boolean;
}
export interface Replacement {
  from: string;
  to: string;
}
export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtin: boolean;
}
export interface Recipe {
  id: string;
  name: string;
  prompt: string;
  builtin: boolean;
}

export type Activation = "push_to_talk" | "toggle" | "hybrid";
export type PasteMethod = "paste" | "type" | "copy_only";
export type AutoSubmit = "off" | "enter" | "cmd_enter";
export type OverlayPosition = "top" | "bottom" | "hidden";

export interface DictationSettings {
  enabled: boolean;
  hotkey: string;
  activation: Activation;
  hold_ms: number;
  command_hotkey: string;
  paste_last_hotkey: string;
  stt_profile: string;
  language: string | null;
  mic_device: string | null;
  paste_method: PasteMethod;
  restore_clipboard: boolean;
  auto_submit: AutoSubmit;
  trailing_space: boolean;
  sounds: boolean;
  mute_system_audio: boolean;
  overlay: OverlayPosition;
  remove_fillers: boolean;
  llm_enabled: boolean;
  llm_profile: string;
  default_style: string;
  styles: Style[];
  app_context: boolean;
  keep_audio: boolean;
}

export interface MeetingSettings {
  stt_profile: string;
  language: string | null;
  mic_device: string | null;
  capture_system_audio: boolean;
  keep_audio: boolean;
  auto_enhance: boolean;
  llm_profile: string;
  default_template: string;
  templates: NoteTemplate[];
  recipes: Recipe[];
  detect_meetings: boolean;
  your_name: string;
}

export interface FileSettings {
  stt_profile: string;
  language: string | null;
  diarize: boolean;
  llm_profile: string;
  auto_summarize: boolean;
}

export interface GeneralSettings {
  launch_at_login: boolean;
  show_in_dock: boolean;
  theme: "system" | "light" | "dark";
  history_days: number;
  onboarded: boolean;
}

export interface Settings {
  general: GeneralSettings;
  stt_profiles: SttProfile[];
  llm_profiles: LlmProfile[];
  vocabulary: string[];
  replacements: Replacement[];
  dictation: DictationSettings;
  meetings: MeetingSettings;
  files: FileSettings;
}

export interface Word {
  start_ms: number;
  end_ms: number;
  text: string;
}
export interface Segment {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker?: string;
  words?: Word[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type RecordingKind = "file" | "meeting";
export type RecordingStatus = "queued" | "processing" | "recording" | "ready" | "error";

export interface Recording {
  id: string;
  kind: RecordingKind;
  title: string;
  created_at: number;
  updated_at: number;
  duration_ms: number;
  status: RecordingStatus;
  progress: number;
  error: string | null;
  source: string | null;
  media_path: string | null;
  audio_path: string | null;
  language: string | null;
  segments: Segment[];
  notes: string;
  enhanced: string;
  summary: string;
  template_id: string | null;
  speakers: Record<string, string>;
  chat: ChatMessage[];
  stt: string | null;
  starred: boolean;
}

export interface RecordingSummary {
  id: string;
  kind: RecordingKind;
  title: string;
  created_at: number;
  duration_ms: number;
  status: RecordingStatus;
  progress: number;
  error: string | null;
  preview: string;
  starred: boolean;
  source: string | null;
}

export interface RecordingPatch {
  title?: string;
  notes?: string;
  enhanced?: string;
  summary?: string;
  speakers?: Record<string, string>;
  starred?: boolean;
  template_id?: string;
  language?: string;
  stt?: string;
  segment_edit?: [number, string];
  segment_speaker?: [number, string];
}

export interface Dictation {
  id: string;
  created_at: number;
  kind: "dictate" | "command" | string;
  raw_text: string;
  text: string;
  app: string | null;
  style: string | null;
  duration_ms: number;
  stt: string | null;
  llm: string | null;
  audio_path: string | null;
  error: string | null;
}

export interface Stats {
  dictation_count: number;
  dictation_words: number;
  dictation_ms: number;
  file_count: number;
  meeting_count: number;
  transcribed_ms: number;
  streak_days: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  family: string;
  description: string;
  repo: string;
  revision: string;
  filename: string;
  quant: string;
  size_bytes: number;
  sha256: string;
  languages: string[];
  streaming: boolean;
  translate: boolean;
  lang_detect: boolean;
  timestamps: string;
  speed: number;
  accuracy: number;
  recommended: boolean;
  rank: number;
  license: string;
}
export interface ModelStatus extends CatalogModel {
  downloaded: boolean;
  downloading: number | null;
}

export interface CliStatus {
  kind: LlmKind;
  path: string | null;
  version: string | null;
}

export interface AppInfo {
  version: string;
  data_dir: string;
  ffmpeg: boolean;
  ytdlp: boolean;
  platform: string;
}

export interface Permissions {
  accessibility: boolean;
  /** "granted" | "denied" | "undetermined" | "unknown" */
  microphone: string;
  system_audio_supported: boolean;
}

export interface InputDevice {
  name: string;
  is_default: boolean;
}

export interface MeetingStatus {
  id: string;
  elapsed_ms: number;
  paused: boolean;
  mic: boolean;
  system: boolean;
  system_error: string | null;
}

export type DictationPhase = "idle" | "recording" | "processing" | "done" | "error";
export interface OverlayState {
  phase: DictationPhase;
  mode: "dictate" | "command";
  latched: boolean;
  message: string | null;
  style: string | null;
  app: string | null;
}

export interface JobProgress {
  id: string;
  status: RecordingStatus;
  stage: string;
  progress: number;
  error: string | null;
}

export interface ExportOptions {
  format: "txt" | "md" | "srt" | "vtt" | "csv" | "json";
  timestamps?: boolean;
  speakers?: boolean;
  include_notes?: boolean;
}
