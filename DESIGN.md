# Hush — design

One app, three jobs: **Dictation** (Wispr Flow / Superwhisper / Handy), **Files**
(MacWhisper / Buzz) and **Meetings** (Granola / Hyprnote). Local-first, with cloud
speech and LLM providers as opt-in.

## Research takeaways that shaped the design

| Area | Decision | Why |
|---|---|---|
| Local ASR | transcribe.cpp (ggml, Metal) running Parakeet TDT v3 / Whisper GGUF, in the native helper through its C API | Handy migrated off ONNX to it; one CMake dep, no ORT dylib, covers Parakeet + Whisper + Silero VAD + Sortformer diarization |
| Long audio | Split at silences into ≤ model-max windows, offset timestamps | Parakeet has a per-call audio cap; cloud APIs have 25 MB / 10 min caps |
| Mic | AUHAL input unit → mono → windowed-sinc resampler to 16 kHz (helper) | Universal; matches every engine's input |
| System audio (macOS) | Core Audio process tap (`CATapDescription`) + private aggregate device (14.2+) | Same as Hyprnote/anarlog & Meetily; needs only "System Audio Recording" permission; no screen-recording indicator |
| Me / Them | Separate mic + system streams, transcribed independently | Speaker separation for free (Granola "Me/Them"); mic frames whose loudness envelope tracks the system audio (speaker bleed) are silenced before transcription (`audio/bleed.ts`), with a text-similarity check as backstop. Saved as stereo AAC `meeting.m4a` (L = mic, R = system, 48 kbps via `afconvert`) so re-transcription keeps the separation |
| Hotkeys | CGEventTap in the helper (spec grammar and matching from `handy-keys`) | Modifier-only + Fn support, press/release edges for push-to-talk |
| Activation | Push-to-talk, toggle, and hybrid (short tap latches) | Handy/Wispr behaviour; Esc cancels |
| Insertion | Clipboard + synthesized ⌘V with clipboard restore; fallback typing; copy-only | Universal; restore only if clipboard unchanged |
| Overlay | Transparent click-through pill in a second Electrobun window with a non-activating panel style mask, shown without activating, all Spaces | Must never steal focus or the paste lands nowhere |
| Context | Snapshot frontmost app at key-down | Superwhisper lesson: context at paste time is wrong |
| Text pipeline | dictionary-biased ASR → replacements/snippets → filler removal → optional LLM style | Wispr/VoiceInk feature set |
| Media decoding | WAV in-process, everything else through `afconvert`/`ffmpeg` on PATH; `yt-dlp` for URLs | Meetily's hybrid |
| Meetings UX | Notepad-first; user notes + transcript → enhanced notes via template; chat; recipes | Granola's core loop |
| LLMs | Agent CLIs (Claude Code, Codex, opencode, Gemini/Antigravity) or BYOK (Chat Completions, Responses, Anthropic) | CLIs run tool-less/read-only in an empty temp dir; PATH resolved from the login shell |
| Storage | SQLite (`bun:sqlite`) + audio files in app data | Simple, local, queryable |

## Architecture

Three layers: a Chromium (CEF) webview showing a SvelteKit SPA, a TypeScript backend running on Bun in
Electrobun's main process, and a small Swift helper for what needs native code.

```
src/bun                  Bun process (the only place that imports electrobun/*)
├── index.ts             entry: window, RPC handlers, lifecycle (close-to-tray, quit, reopen)
├── shell.ts             dialogs, clipboard, notifications, window RPC and event delivery
├── tray.ts              menu-bar item
├── overlay.ts           recording pill window (+ overlay-layout.ts: placement maths)
└── backend/             plain Bun, unit-tested with `bun test`
    ├── commands.ts      command registry: every call the UI makes
    ├── app.ts           startup / shutdown ordering
    ├── state.ts         settings, db, controllers
    ├── settings.ts      persisted JSON settings + defaults
    ├── db.ts            SQLite schema + queries (bun:sqlite)
    ├── native.ts        client for the helper (JSON-RPC over stdio)
    ├── shell-env.ts     login-shell PATH resolution for spawning CLIs
    ├── media-server.ts  loopback HTTP: Range playback for the webview, uploads for dropped files
    ├── autostart.ts     launch at login (LaunchAgent)
    ├── llm/             LLM backends (cli.ts, http.ts, sse.ts)
    ├── stt/             Transcript types, provider dispatch, chunking, model catalog + downloads, cloud providers
    ├── audio/           WAV IO, decode to 16 kHz mono, silence split, mic-bleed detection
    ├── dictation.ts     hotkey actions, state machine, text pipeline, insertion
    ├── files.ts         file/URL transcription queue
    ├── meetings/        dual-stream recorder, segmenters, live transcription, enhancement, stereo mix
    ├── export.ts        Markdown, TXT, SRT, VTT, CSV, JSON
    └── ai.ts            prompts: dictation styles, note templates, summaries, chat (data in ai-data.ts)

native/hush-native       Swift helper (SwiftPM), spawned by native.ts, newline-delimited JSON-RPC 2.0 on stdio
├── Sources/HushNative
│   ├── RPC.swift / Methods.swift   transport and the method table
│   ├── Capture.swift        capture sessions writing f32 files (rotated chunks for meetings)
│   ├── Mic.swift, SystemAudio.swift   AUHAL microphone, Core Audio process tap
│   ├── Pump.swift, Audio.swift        drain thread, resampling to 16 kHz, levels
│   ├── STT.swift            transcribe.cpp engine and model cache
│   ├── Keys.swift, Hotkeys.swift      hotkey specs and matching, CGEventTap
│   ├── Input.swift, Pasteboard.swift  paste / typing / Return / selection via Core Graphics events
│   └── Perms.swift          microphone, accessibility, system-audio permission state
├── Sources/CHushAudio   realtime Core Audio callbacks and the lock-free ring they fill (C)
├── Sources/CTranscribe  module map for transcribe.cpp's C API
└── vendor/              transcribe.cpp, fetched and built with CMake by scripts/build-native.ts (not committed)
```

### Why the helper exists

Everything that needs a real thread-safe native API lives in the helper: audio capture (AUHAL, Core Audio
tap), ggml/Metal speech-to-text, global hotkeys on a CGEventTap and keystroke / pasteboard synthesis. Bun has
no FFI-free way to do those well. The helper is Swift because every one of them is a macOS framework API;
the realtime audio callbacks are plain C so they never allocate or touch reference counts, and transcribe.cpp
is linked through its C API. Everything else (settings, SQLite, LLM and cloud STT clients, queues, exports,
prompts, mixing, windowing) is TypeScript.

Protocol: requests `{id, method, params}`, replies `{id, result|error}`, events as notifications
(`capture.level`, `capture.chunk`, `hotkey`). Methods: `ping`, `shutdown`, `capture.start/stop`, `stt.info/preload/evict/cancel/run`,
`hotkeys.bind/validate/set_cancel`, `input.paste/type/enter/selected_text/cancel`, `audio.mic_users`,
`devices.list`, `permissions.get`. Audio moves through files, never the JSON channel.

### Windows and IPC

Windows: `main` (app) and `overlay` (recording pill). Commands are RPC requests from the webview to Bun
(`invoke`), events are pushed back (`listen`); `src/lib/ipc.ts` is the webview side and keeps the call
shapes of the old Tauri API. In a plain browser the same module falls back to `src/lib/devmock`.

Events from the backend: `dictation:state`, `dictation:level`,
`dictation:new`, `recording:progress`, `recording:updated`, `meeting:started`,
`meeting:stopped`, `meeting:levels`, `meeting:transcript`, `meeting:enhance`,
`meeting:detected`, `meeting:error`, `model:progress`, `settings:changed`,
`llm:delta`, `navigate`.
