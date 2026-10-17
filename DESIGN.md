# Hush — design

One app, three jobs: **Dictation** (Wispr Flow / Superwhisper / Handy), **Files**
(MacWhisper / Buzz) and **Meetings** (Granola / Hyprnote). Local-first, with cloud
speech and LLM providers as opt-in.

## Research takeaways that shaped the design

| Area | Decision | Why |
|---|---|---|
| Local ASR | `transcribe-cpp` (ggml, Metal) running Parakeet TDT v3 / Whisper GGUF | Handy migrated off ONNX to it; one CMake dep, no ORT dylib, covers Parakeet + Whisper + Silero VAD + Sortformer diarization |
| Long audio | Split at silences into ≤ model-max windows, offset timestamps | Parakeet has a per-call audio cap; cloud APIs have 25 MB / 10 min caps |
| Mic | `cpal` → mono → `rubato` to 16 kHz | Universal; matches every engine's input |
| System audio (macOS) | Core Audio process tap + private aggregate device via `cidre` (14.2+) | Same as Hyprnote/anarlog & Meetily; needs only "System Audio Recording" permission; no screen-recording indicator |
| Me / Them | Separate mic + system streams, transcribed independently | Speaker separation for free (Granola "Me/Them"); mic frames whose loudness envelope tracks the system audio (speaker bleed) are silenced before transcription (`audio/bleed.rs`), with a text-similarity check as backstop. Saved as stereo AAC `meeting.m4a` (L = mic, R = system, 48 kbps via `afconvert`) so re-transcription keeps the separation |
| Hotkeys | `handy-keys` (CGEventTap) | Modifier-only + Fn support, press/release edges for push-to-talk |
| Activation | Push-to-talk, toggle, and hybrid (short tap latches) | Handy/Wispr behaviour; Esc cancels |
| Insertion | Clipboard + synthesized ⌘V with clipboard restore; fallback typing; copy-only | Universal; restore only if clipboard unchanged |
| Overlay | Non-activating NSPanel pill (`tauri-nspanel`), all Spaces, click-through | Must never steal focus or the paste lands nowhere |
| Context | Snapshot frontmost app at key-down | Superwhisper lesson: context at paste time is wrong |
| Text pipeline | dictionary-biased ASR → replacements/snippets → filler removal → optional LLM style | Wispr/VoiceInk feature set |
| Media decoding | `symphonia` in-process, fall back to `ffmpeg` on PATH; `yt-dlp` for URLs | Meetily's hybrid |
| Meetings UX | Notepad-first; user notes + transcript → enhanced notes via template; chat; recipes | Granola's core loop |
| LLMs | Agent CLIs (Claude Code, Codex, opencode, Gemini/Antigravity) or BYOK (Chat Completions, Responses, Anthropic) | CLIs run tool-less/read-only in an empty temp dir; PATH resolved from the login shell |
| Storage | SQLite (`rusqlite` bundled) + audio files in app data | Simple, local, queryable |

## Architecture

```
src-tauri/src
├── lib.rs            app setup, tray, windows, plugin wiring
├── state.rs          AppState (settings, db, engines, controllers)
├── settings.rs       persisted JSON settings + defaults
├── db.rs             SQLite schema + queries
├── commands.rs       #[tauri::command] surface for the UI
├── shell_env.rs      login-shell PATH resolution for spawning CLIs
├── llm/              LLM backends (cli.rs, http.rs, sse.rs)
├── stt/              speech-to-text
│   ├── mod.rs        Transcript types, provider dispatch, chunking
│   ├── local.rs      transcribe-cpp engine + model cache
│   ├── models.rs     model catalog + downloads
│   └── cloud.rs      OpenAI-compatible, xAI, Meta Muse, Deepgram, ElevenLabs, AssemblyAI
├── audio/
│   ├── mod.rs        resampling, WAV/AAC IO, levels, silence split
│   ├── bleed.rs      mic-picks-up-speakers detection (envelope correlation)
│   ├── mic.rs        cpal capture
│   ├── system_macos.rs  Core Audio process tap
│   └── decode.rs     symphonia / ffmpeg decode to 16 kHz mono
├── dictation/        hotkeys, controller state machine, paste, overlay, text pipeline
├── files.rs          file/URL transcription queue, exports
├── meetings.rs       dual-stream recorder, live transcription, enhancement
└── ai.rs             prompts: dictation styles, note templates, summaries, chat
```

Frontend: SvelteKit SPA (Svelte 5 runes). Windows: `main` (app) and `overlay`
(recording pill). Events from Rust: `dictation:state`, `dictation:level`,
`dictation:new`, `recording:progress`, `recording:updated`, `meeting:started`,
`meeting:stopped`, `meeting:levels`, `meeting:transcript`, `meeting:enhance`,
`meeting:detected`, `meeting:error`, `model:progress`, `settings:changed`,
`llm:delta`, `navigate`.
