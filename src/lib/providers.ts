import type { LlmKind, LlmProfile, SttKind, SttProfile } from "./types";

export interface LlmKindInfo {
  label: string;
  cli: boolean;
  blurb: string;
  modelHint: string;
  baseUrl?: string;
  efforts?: string[];
}

export const LLM_KINDS: Record<LlmKind, LlmKindInfo> = {
  claude_code: {
    label: "Claude Code",
    cli: true,
    blurb: "Uses your signed-in `claude` CLI (Pro/Max subscription or API). Tools are disabled.",
    modelHint: "haiku, sonnet, opus or a full model id",
    efforts: ["low", "medium", "high"],
  },
  codex: {
    label: "Codex",
    cli: true,
    blurb: "Uses your signed-in `codex` CLI (ChatGPT plan or API key), read-only sandbox.",
    modelHint: "Leave empty for your Codex default",
    efforts: ["minimal", "low", "medium", "high"],
  },
  opencode: {
    label: "opencode",
    cli: true,
    blurb: "Uses `opencode run` with any provider you've configured there. All tool permissions denied.",
    modelHint: "provider/model, e.g. anthropic/claude-haiku-4-5",
  },
  gemini: {
    label: "Gemini CLI",
    cli: true,
    blurb: "Uses your signed-in `gemini` CLI in read-only plan mode.",
    modelHint: "e.g. gemini-3-flash",
  },
  antigravity: {
    label: "Antigravity",
    cli: true,
    blurb: "Uses Google Antigravity's `agy` CLI in plan mode.",
    modelHint: "Leave empty for the default",
  },
  openai_chat: {
    label: "Chat Completions",
    cli: false,
    blurb: "Any OpenAI-compatible /chat/completions endpoint: OpenAI, OpenRouter, Groq, xAI, Together, Ollama, LM Studio…",
    modelHint: "e.g. gpt-5-mini, llama-3.3-70b",
    baseUrl: "https://api.openai.com/v1",
  },
  openai_responses: {
    label: "Responses API",
    cli: false,
    blurb: "OpenAI's /responses endpoint (or a compatible one).",
    modelHint: "e.g. gpt-5-mini",
    baseUrl: "https://api.openai.com/v1",
    efforts: ["minimal", "low", "medium", "high"],
  },
  anthropic: {
    label: "Anthropic API",
    cli: false,
    blurb: "Anthropic Messages API with your own key.",
    modelHint: "e.g. claude-haiku-4-5",
    baseUrl: "https://api.anthropic.com/v1",
  },
};

export const LLM_PRESETS: { name: string; kind: LlmKind; base_url: string; model: string }[] = [
  { name: "OpenAI", kind: "openai_responses", base_url: "https://api.openai.com/v1", model: "gpt-5-mini" },
  { name: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" },
  { name: "OpenRouter", kind: "openai_chat", base_url: "https://openrouter.ai/api/v1", model: "" },
  { name: "Groq", kind: "openai_chat", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { name: "xAI Grok", kind: "openai_chat", base_url: "https://api.x.ai/v1", model: "grok-4-fast" },
  { name: "Ollama (local)", kind: "openai_chat", base_url: "http://localhost:11434/v1", model: "" },
  { name: "LM Studio (local)", kind: "openai_chat", base_url: "http://localhost:1234/v1", model: "" },
];

export interface SttKindInfo {
  label: string;
  blurb: string;
  model: string;
  baseUrl: string;
  keyUrl?: string;
  diarize: boolean;
}

export const STT_KINDS: Record<SttKind, SttKindInfo> = {
  local: { label: "On-device", blurb: "Runs on your Mac with Metal. Private and offline.", model: "", baseUrl: "", diarize: false },
  openai_compatible: {
    label: "OpenAI-compatible",
    blurb: "OpenAI, Groq, Mistral, Fireworks or any /audio/transcriptions endpoint.",
    model: "gpt-4o-transcribe",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    diarize: false,
  },
  xai: {
    label: "xAI Grok",
    blurb: "Grok speech-to-text.",
    model: "grok-voice-transcribe-2.0",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    diarize: true,
  },
  muse: {
    label: "Meta Muse",
    blurb: "Muse Transcribe from Meta AI.",
    model: "muse-voice-transcribe-1.0",
    baseUrl: "https://api.meta.ai/v1",
    diarize: true,
  },
  deepgram: {
    label: "Deepgram",
    blurb: "Nova models with fast diarization.",
    model: "nova-3",
    baseUrl: "https://api.deepgram.com/v1",
    keyUrl: "https://console.deepgram.com",
    diarize: true,
  },
  elevenlabs: {
    label: "ElevenLabs",
    blurb: "Scribe speech-to-text with speaker labels.",
    model: "scribe_v2",
    baseUrl: "https://api.elevenlabs.io/v1",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    diarize: true,
  },
  assemblyai: {
    label: "AssemblyAI",
    blurb: "Universal models with speaker labels.",
    model: "universal-3-5-pro",
    baseUrl: "https://api.assemblyai.com/v2",
    keyUrl: "https://www.assemblyai.com/app/api-keys",
    diarize: true,
  },
};

export const STT_PRESETS: { name: string; kind: SttKind; base_url: string; model: string }[] = [
  { name: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1", model: "gpt-4o-transcribe" },
  { name: "Groq Whisper", kind: "openai_compatible", base_url: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
  { name: "Mistral Voxtral", kind: "openai_compatible", base_url: "https://api.mistral.ai/v1", model: "voxtral-mini-latest" },
  { name: "xAI Grok", kind: "xai", base_url: "https://api.x.ai/v1", model: "grok-voice-transcribe-2.0" },
  { name: "Meta Muse", kind: "muse", base_url: "https://api.meta.ai/v1", model: "muse-voice-transcribe-1.0" },
  { name: "Deepgram", kind: "deepgram", base_url: "https://api.deepgram.com/v1", model: "nova-3" },
  { name: "ElevenLabs", kind: "elevenlabs", base_url: "https://api.elevenlabs.io/v1", model: "scribe_v2" },
  { name: "AssemblyAI", kind: "assemblyai", base_url: "https://api.assemblyai.com/v2", model: "universal-3-5-pro" },
];

export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function blankLlm(kind: LlmKind, name?: string): LlmProfile {
  return {
    id: newId(kind.replace("_", "-")),
    name: name ?? LLM_KINDS[kind].label,
    kind,
    model: kind === "claude_code" ? "haiku" : "",
    base_url: LLM_KINDS[kind].baseUrl ?? "",
    api_key: "",
    bin_path: "",
    effort: "",
  };
}

export function blankStt(kind: SttKind, name?: string): SttProfile {
  return { id: newId(kind), name: name ?? STT_KINDS[kind].label, kind, model: STT_KINDS[kind].model, base_url: STT_KINDS[kind].baseUrl, api_key: "" };
}
