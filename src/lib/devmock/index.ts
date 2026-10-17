// Dev-only stand-in for the Tauri IPC so the UI can run in a plain browser
// (`bun run dev`, then open http://127.0.0.1:1427). Never bundled in builds.

import settingsFixture from "./settings.json";
import catalog from "../../../src-tauri/resources/models.json";
import type { Dictation, Recording, RecordingSummary, Segment } from "#lib/types.js";

type Cb = (payload: unknown) => void;

const now = Date.now();
const min = 60_000;

const meetingSegments: Segment[] = [
  ["Me", "Thanks for jumping on. I wanted to walk through the launch plan for the dictation feature."],
  ["Them", "Sure. Where did we land on the hotkey? Last week we were split between Fn and right Option."],
  ["Me", "We're defaulting to Fn with a hold-or-tap behaviour, and right Option is one click away in settings."],
  ["Them", "Makes sense. What about people without an Apple keyboard?"],
  ["Me", "Onboarding detects that and suggests right Option. I'll write it up."],
  ["Them", "Great. And pricing — are we still doing a free local tier?"],
  ["Me", "Yes, local models are free forever. Cloud providers are bring-your-own-key."],
  ["Them", "Love it. Can we ship the beta by the twenty-fourth?"],
  ["Me", "If design signs off on the overlay by Monday, yes. Priya owns that."],
].map(([speaker, text], i) => ({ start_ms: i * 9_000, end_ms: i * 9_000 + 8_000, text, speaker }));

const fileSegments: Segment[] = [
  "Welcome back to the show. Today we're talking about why voice is finally becoming a real input method.",
  "For years, speech recognition was good enough for demos but frustrating in daily use.",
  "Two things changed: models like Parakeet got fast enough to run on a laptop, and language models can clean up what you say.",
  "That second part matters more than people think. Nobody speaks in finished paragraphs.",
  "We stop, we restart, we say 'um'. A good dictation tool turns that into what you meant to write.",
].map((text, i) => ({ start_ms: i * 7_500, end_ms: i * 7_500 + 7_000, text, speaker: i % 3 === 2 ? "Speaker 2" : "Speaker 1" }));

const recordings: Recording[] = [
  {
    id: "m1",
    kind: "meeting",
    title: "Dictation launch sync",
    created_at: now - 50 * min,
    updated_at: now - 20 * min,
    duration_ms: 81_000,
    status: "ready",
    progress: 1,
    error: null,
    source: null,
    media_path: null,
    audio_path: "/tmp/hush_test.wav",
    language: "en",
    segments: meetingSegments,
    notes: "hotkey: fn default\npricing?\nbeta date",
    enhanced:
      "## Summary\nAlex and Sam aligned on the dictation launch: **Fn** is the default hotkey and local models stay free.\n\n## Decisions\n- Default hotkey is Fn (hold to talk, tap to lock); right Option offered for non-Apple keyboards\n- Local models are free; cloud providers are bring-your-own-key\n\n## Action items\n- [ ] **Alex** — write up the keyboard-detection onboarding\n- [ ] **Priya** — sign off on the overlay design by Monday\n- [ ] **Team** — ship the beta on the 24th if design lands\n",
    summary: "",
    template_id: "general",
    speakers: { Me: "Alex", Them: "Sam" },
    chat: [],
    stt: "local",
    starred: true,
  },
  {
    id: "f1",
    kind: "file",
    title: "The Voice Interface — Episode 42",
    created_at: now - 26 * 60 * min,
    updated_at: now - 26 * 60 * min,
    duration_ms: 37_500,
    status: "ready",
    progress: 1,
    error: null,
    source: "/Users/alex/Downloads/voice-interface-42.mp3",
    media_path: "/Users/alex/Downloads/voice-interface-42.mp3",
    audio_path: null,
    language: "en",
    segments: fileSegments,
    notes: "",
    enhanced: "",
    summary:
      "**Gist:** Voice input is finally practical thanks to fast on-device models and LLM cleanup.\n\n- Recognition used to be demo-quality only\n- Parakeet-class models now run on laptops\n- LLM polish turns messy speech into intended text",
    template_id: null,
    speakers: { "Speaker 1": "Host" },
    chat: [],
    stt: "local",
    starred: false,
  },
  {
    id: "f2",
    kind: "file",
    title: "Customer interview — Lena",
    created_at: now - 3 * min,
    updated_at: now - 3 * min,
    duration_ms: 0,
    status: "processing",
    progress: 0.42,
    error: null,
    source: "/Users/alex/Desktop/lena.m4a",
    media_path: null,
    audio_path: null,
    language: null,
    segments: [],
    notes: "",
    enhanced: "",
    summary: "",
    template_id: null,
    speakers: {},
    chat: [],
    stt: "local",
    starred: false,
  },
];

const dictations: Dictation[] = [
  ["Can you send me the deck before Thursday's review? I want to add the pricing slide.", "Slack", "message", 6200],
  ["Hi Jordan,\n\nThanks for the quick turnaround on the contract. I've signed and attached it.\n\nBest,\nAlex", "Mail", "email", 9800],
  ["Refactor the hotkey state machine so command mode can be entered from a latched recording.", "Cursor", "prompt", 7100],
  ["Pick up oat milk, coffee filters and the dry cleaning.", "Notes", "notes", 3900],
].map(([text, app, style, ms], i) => ({
  id: `d${i}`,
  created_at: now - (i * 47 + 5) * min,
  kind: "dictation",
  raw_text: String(text).toLowerCase().replace(/\n/g, " "),
  text: String(text),
  app: String(app),
  style: String(style),
  duration_ms: Number(ms),
  stt: "local",
  llm: "claude-code",
  audio_path: null,
  error: null,
}));

function summary(r: Recording): RecordingSummary {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    created_at: r.created_at,
    duration_ms: r.duration_ms,
    status: r.status,
    progress: r.progress,
    error: r.error,
    preview: r.segments.slice(0, 2).map((s) => s.text).join(" "),
    starred: r.starred,
    source: r.source,
  };
}

const downloaded = new Set(["parakeet-tdt-0.6b-v3", "moonshine-base"]);
let settings = structuredClone(settingsFixture);

async function streamText(text: string, rid: string) {
  for (const w of text.split(/(?<= )/)) {
    emit("llm:delta", { request_id: rid, delta: w });
    await new Promise((r) => setTimeout(r, 18));
  }
  return text;
}

const handlers: Record<string, (a: any) => unknown> = {
  get_settings: () => structuredClone(settings),
  save_settings: (a) => ((settings = a.settings), []),
  app_info: () => ({ version: "0.1.0", data_dir: "/Users/alex/Library/Application Support/com.hush.app", ffmpeg: true, ytdlp: true, platform: "macos" }),
  get_permissions: () => ({ accessibility: true, microphone: "granted", system_audio_supported: true }),
  list_input_devices: () => [
    { name: "MacBook Pro Microphone", is_default: true },
    { name: "AirPods Pro", is_default: false },
  ],
  stats: () => ({ dictation_count: 412, dictation_words: 18_340, dictation_ms: 7_020_000, file_count: 23, meeting_count: 31, transcribed_ms: 61_200_000, streak_days: 6 }),
  list_models: () =>
    (catalog as any).models.map((m: any) => ({ ...m, downloaded: downloaded.has(m.id), downloading: m.id === "whisper-large-v3-turbo" ? 0.37 : null })),
  detect_clis: () => [
    { kind: "claude_code", path: "/Users/alex/.local/bin/claude", version: "2.1.301 (Claude Code)" },
    { kind: "codex", path: "/Users/alex/.local/bin/codex", version: "codex-cli 0.163.0" },
    { kind: "opencode", path: "/Users/alex/.local/bin/opencode", version: "opencode v2.0.27" },
    { kind: "gemini", path: null, version: null },
    { kind: "antigravity", path: "/opt/homebrew/bin/agy", version: "1.4.0" },
  ],
  test_llm: () => "OK · 2.1s",
  test_stt: () => "Parakeet TDT 0.6B v3 · 25 languages · Metal",
  validate_hotkey: () => null,
  list_dictations: (a) => dictations.filter((d) => !a.query || d.text.toLowerCase().includes(a.query.toLowerCase())),
  apply_style: (a) => a.text.replace(/\b(um|uh|so basically|the the)\b ?/g, "").replace(/^./, (c: string) => c.toUpperCase()) + ".",
  list_recordings: (a) =>
    recordings
      .filter((r) => !a.kind || r.kind === a.kind)
      .filter((r) => !a.query || JSON.stringify(r).toLowerCase().includes(a.query.toLowerCase()))
      .sort((x, y) => y.created_at - x.created_at)
      .map(summary),
  get_recording: (a) => structuredClone(recordings.find((r) => r.id === a.id) ?? null),
  update_recording: (a) => {
    const r = recordings.find((r) => r.id === a.id);
    if (!r) return null;
    const { segment_edit, segment_speaker, ...rest } = a.patch;
    Object.assign(r, rest);
    if (segment_edit) r.segments[segment_edit[0]].text = segment_edit[1];
    if (segment_speaker) r.segments[segment_speaker[0]].speaker = segment_speaker[1];
    return structuredClone(r);
  },
  retranscribe: (a) => {
    const r = recordings.find((r) => r.id === a.id);
    if (!r) return;
    r.status = "processing";
    emit("recording:progress", { id: r.id, status: "processing", stage: "transcribing", progress: 0, error: null });
    setTimeout(() => {
      r.status = "ready";
      emit("recording:progress", { id: r.id, status: "ready", stage: "", progress: 1, error: null });
      emit("recording:updated", r.id);
    }, 1500);
  },
  // `?live` previews m1 as an in-progress recording.
  meeting_status: () =>
    new URLSearchParams(location.search).has("live")
      ? { id: "m1", elapsed_ms: Date.now() - live, paused: false, mic: true, system: true, system_error: null }
      : null,
  chat: (a) =>
    streamText(
      "Here's what I found:\n\n- **Fn** is the default dictation hotkey\n- The beta ships on the **24th**, pending Priya's overlay sign-off",
      a.requestId,
    ),
  run_recipe: (a) => streamText(
      "**Subject:** Dictation launch — next steps\n\nHi Sam,\n\nThanks for the sync today. Quick recap:\n\n- **Fn** is the default hotkey; onboarding suggests right Option on non-Apple keyboards\n- Local models stay free, cloud is bring-your-own-key\n- Beta ships on the **24th**, pending Priya's overlay sign-off on Monday\n\nI'll send the onboarding write-up tomorrow.\n\nBest,\nAlex",
      a.requestId,
    ),
  ask_all: (a) => streamText("Across 3 meetings, the team decided to keep **local models free** and ship the beta on the 24th.", a.requestId),
  summarize: (a) => streamText(recordings.find((r) => r.id === a.id)?.summary || "Summary", a.requestId),
};

const tones = new Map<number, string>();
function toneUrl(ms: number) {
  if (tones.has(ms)) return tones.get(ms)!;
  const rate = 8000;
  const n = Math.round((rate * ms) / 1000);
  const buf = new DataView(new ArrayBuffer(44 + n));
  const str = (o: number, t: string) => [...t].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  buf.setUint32(4, 36 + n, true);
  str(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate, true);
  buf.setUint16(32, 1, true);
  buf.setUint16(34, 8, true);
  str(36, "data");
  buf.setUint32(40, n, true);
  for (let i = 0; i < n; i++) buf.setUint8(44 + i, 128 + Math.round(2 * Math.sin(i / 20)));
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  tones.set(ms, url);
  return url;
}

const listeners = new Map<string, Map<number, Cb>>();
const callbacks = new Map<number, Cb>();
let nextId = 1;

export function emit(event: string, payload: unknown) {
  for (const id of listeners.get(event)?.keys() ?? []) callbacks.get(id)?.({ event, id, payload });
}

const live = Date.now() - 754_000;

export function install() {
  const w = window as any;
  // `?onboarding` previews the first-run flow.
  if (new URLSearchParams(location.search).has("onboarding")) settings.general.onboarded = false;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb: Cb) {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    // Fixture media paths don't exist; play a quiet tone of the right length instead.
    convertFileSrc: (p: string) => toneUrl(recordings.find((r) => r.media_path === p || r.audio_path === p)?.duration_ms ?? 60_000),
    async invoke(cmd: string, args: any = {}) {
      if (cmd === "plugin:event|listen") {
        if (!listeners.has(args.event)) listeners.set(args.event, new Map());
        listeners.get(args.event)!.set(args.handler, callbacks.get(args.handler)!);
        return args.handler;
      }
      if (cmd.startsWith("plugin:")) return null;
      const h = handlers[cmd];
      if (!h) {
        console.debug("[devmock] unhandled", cmd, args);
        return null;
      }
      return h(args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, id: number) {
      listeners.get(event)?.delete(id);
    },
  };
  w.__hushEmit = emit;
  if (new URLSearchParams(location.search).has("live")) {
    let t = 0;
    setInterval(() => {
      t++;
      emit("meeting:levels", { me: t % 40 < 18 ? 0.25 + Math.random() * 0.5 : 0.02, them: t % 40 >= 20 ? 0.2 + Math.random() * 0.5 : 0.02 });
    }, 80);
  }
  console.info("[devmock] Tauri IPC mocked for browser preview");
}
