# AGENTS.md

Hush is a macOS (Apple Silicon, 14.2+) desktop app: dictation, file transcription and
meeting notes. Tauri 2 + Rust (edition 2024) backend, SvelteKit SPA frontend
(Svelte 5 runes, TypeScript), pnpm. Read `DESIGN.md` for the research and architecture.

## Commands

```sh
pnpm install
pnpm tauri dev                     # full app; Vite on 127.0.0.1:1427 (strictPort)
pnpm dev                           # UI only in a browser, backed by src/lib/devmock
pnpm check                         # svelte-check (must be 0 errors, 0 warnings)
pnpm build                         # static SPA into build/
cd src-tauri && cargo test --lib   # Rust unit tests
cd src-tauri && cargo clippy --all-targets
cd src-tauri && cargo run --release --example transcribe -- <file> [model-id]
cd src-tauri && cargo run --release --example llm      # dictation cleanup via installed CLIs
cd src-tauri && cargo run --release --example systap   # system-audio tap smoke test
```

Building needs CMake (transcribe-cpp compiles ggml with Metal). The first build is slow.

## Layout

- `src-tauri/src/commands.rs`: every `#[tauri::command]`. `src/lib/api.ts` wraps them
  (camelCase args) and `src/lib/types.ts` mirrors the Rust types. Change all three together.
- `src-tauri/src/settings.rs` ↔ `Settings` in `types.ts`. Settings live in
  `~/Library/Application Support/com.hush.app/settings.json` (0600, holds API keys).
- `stt/` (local via transcribe-cpp, cloud providers in `cloud.rs`, catalog in
  `src-tauri/resources/models.json`), `llm/` (agent CLIs + HTTP), `audio/`,
  `dictation/` (hotkeys, state machine, overlay panel, paste), `files.rs`, `meetings.rs`,
  `ai.rs` (all prompts), `db.rs` (SQLite).
- Frontend: `src/routes/*` pages, `src/lib/components`, `src/lib/settings` (settings tabs),
  `src/lib/state.svelte.ts` (global `app` store, event subscriptions, debounced save),
  `src/app.css` (design tokens + shared classes: `.btn`, `.input`, `.card`, `.chip`, …).
- Windows: `main` and `overlay` (`/overlay` route, a non-activating NSPanel).

## Conventions and gotchas

- Backend events are listed in `DESIGN.md`. Add new ones there and in `state.svelte.ts`.
- When adding a command or event the UI uses, also add a handler or fixture in
  `src/lib/devmock/index.ts` so the browser preview keeps working.
- `src/app.css` is plain CSS: no `:global(...)`. Component styles are scoped, so watch for
  class-name collisions with global classes (e.g. `.live`, `.dot`).
- Call `stt::local::shutdown()` before process exit. Otherwise ggml's Metal teardown asserts.
- The overlay panel must stay non-activating and undecorated (see `dictation/overlay.rs`),
  or paste lands in the wrong app and AppKit panics on style-mask changes.
- Agent CLIs are spawned with tools disabled / read-only in an empty temp dir, with PATH
  from the login shell (`shell_env.rs`). Keep it that way. Never let them touch user files.
- Never log or commit API keys. The devmock settings fixture must keep `api_key` empty.
- Design: serif headings (New York), warm "ink" dark / "paper" light palettes, ember
  accent. Use the tokens in `app.css` rather than literal colours.
- Verify UI changes in the browser preview (`pnpm dev`, `?onboarding`, `?live`,
  `window.__hushEmit(event, payload)`) and run `pnpm check` + `cargo test --lib`.
