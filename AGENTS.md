# AGENTS.md

Hush is a macOS (Apple Silicon, 14.2+) desktop app: dictation, file transcription and
meeting notes. [Electrobun](https://electrobun.dev) shell rendering with bundled Chromium (CEF),
backend in TypeScript on Bun (`src/bun/`), SvelteKit SPA frontend (Svelte 5 runes, TypeScript),
and a small Rust helper (`native/hush-native`) for the parts that need native code.
Use bun for everything JS (not npm/pnpm/yarn). Read `DESIGN.md` for the research and architecture.

## Commands

```sh
bun install                        # also runs `svelte-kit sync` and `electrobun prepare`
bun run dev                        # UI only in a browser, backed by src/lib/devmock (127.0.0.1:1427)
bun run app:dev                    # full app: builds the helper + UI, then `electrobun dev`
bun run app:build                  # release build: artifacts/ gets the .dmg and update files
bun run check                      # svelte-check + tsc for src/bun (must be 0 errors, 0 warnings)
bun run test                       # bun test src/bun (the TypeScript backend)
bun run test:native                # cargo test in native/hush-native
cd native/hush-native && cargo fmt && cargo clippy --all-targets -- -D warnings   # CI enforces both
bun run transcribe -- <file> [model-id]   # local STT on a file through the helper
bun run llm                        # dictation cleanup via each installed agent CLI
bun run systap                     # system-audio tap smoke test (needs the permission, prints levels)
```

Building the helper needs a Rust toolchain and CMake (transcribe-cpp compiles ggml with Metal). The
first build is slow. `electrobun prepare` (run by `bun install`, `dev`, `check`, `app:*`) projects the Electrobun SDK into
`.hutch/devkit`, which `tsconfig.bun.json` and the `#electrobun/view` import use.

## Layout

- `src/bun/index.ts` entry (windows, wiring), `shell.ts` (dialogs, clipboard, window RPC), `tray.ts`,
  `overlay.ts` (+ `overlay-layout.ts`). **Only these files and `scripts/` import `electrobun/*`**; everything under
  `src/bun/backend/` is plain Bun and importable from tests. Keep it that way.
- `src/bun/backend/commands.ts`: the command registry (`register`, `dispatch`), every command the UI calls.
  `src/lib/api.ts` wraps them (camelCase args, `RecordingPatch` fields snake_case) and `src/lib/types.ts`
  mirrors the types. Change all three together. `src/lib/ipc.ts` is the webview side of the bridge
  (`invoke`/`listen`/dialogs; replaces `@tauri-apps/*`), `src/lib/ipc-schema.ts` the shared RPC types.
- `src/bun/backend/settings.ts` <-> `Settings` in `types.ts`. Settings live in
  `~/Library/Application Support/com.hush.app/settings.json` (0600, holds API keys).
- `stt/` (local via the helper, cloud providers in `cloud.ts`, catalog in `resources/models.json`),
  `llm/` (agent CLIs + HTTP), `audio/` (WAV, decode, bleed), `dictation.ts` (state machine, text
  pipeline), `files.ts`, `meetings/`, `ai.ts`/`ai-data.ts` (all prompts), `db.ts` (SQLite via `bun:sqlite`),
  `media-server.ts` (loopback server for playback and dropped files), `native.ts` (helper client),
  `autostart.ts`, `app.ts` (startup/shutdown).
- `native/hush-native/` is the Rust helper, see below. `scripts/` are build and tooling scripts (Bun).
- Frontend: `src/routes/*` pages, `src/lib/components`, `src/lib/settings` (settings tabs),
  `src/lib/state.svelte.ts` (global `app` store, event subscriptions, debounced save),
  `src/app.css` (design tokens + shared classes: `.btn`, `.input`, `.card`, `.chip`, ...).
- Windows: `main` and `overlay` (`/overlay` route, a transparent non-activating panel). Both load the same
  SPA; `window.__hush.window` (injected by `preload`) says which one.

## The native helper

`native/hush-native` is the only Rust left: audio capture (mic via cpal, system audio via a Core Audio
process tap), ggml/Metal speech-to-text, global hotkeys (CGEventTap) and paste/keystroke synthesis.
Bun talks to it with newline-delimited JSON-RPC 2.0 over stdio (`src/bun/backend/native.ts`; protocol
documented in `native/hush-native/src/rpc.rs`). Logs go to stderr; stdout carries only protocol lines.
Audio never goes through the JSON channel: captures write f32 files (rotated into `<path>.<seq>` chunks
for meetings) and STT reads them by path. The helper is not a Tauri or Electrobun app and has no UI. Add
to it only what cannot be done from Bun.

## Conventions and gotchas

- Backend events are listed in `DESIGN.md`. Add new ones there and in `state.svelte.ts`.
- When adding a command or event the UI uses, also add a handler or fixture in
  `src/lib/devmock/index.ts` so the browser preview keeps working.
- `src/app.css` is plain CSS: no `:global(...)`. Component styles are scoped, so watch for
  class-name collisions with global classes (e.g. `.live`, `.dot`).
- SvelteKit 3: its config lives in `sveltekit({...})` in `vite.config.js` (no `svelte.config.js`); aliases
  go in `package.json` `imports` (`#lib/*`, `#electrobun/view`).
- Call `shutdownApp()` (app.ts) before the process exits so the helper stops its captures and ggml's
  Metal teardown does not assert. The quit path does; keep it.
- The overlay window must stay non-activating (`NonactivatingPanel` style mask, shown with `showInactive`)
  or paste lands in the wrong app.
- Agent CLIs are spawned with tools disabled / read-only in an empty temp dir, with PATH
  from the login shell (`shell-env.ts`). Keep it that way. Never let them touch user files.
- Never log or commit API keys. The devmock settings fixture must keep `api_key` empty.
- CEF hands the page no paths for dropped files, so drops are uploaded to the media server and then added.
- Design: serif headings (New York), warm "ink" dark / "paper" light palettes, ember
  accent. Use the tokens in `app.css` rather than literal colours.

## Environment variables

- `HUSH_DATA_DIR`: use this instead of `~/Library/Application Support/com.hush.app` (tests, throwaway runs).
- `HUSH_DEBUG=1`: debug logging. `HUSH_NATIVE_BIN`: helper binary to use. `HUSH_NATIVE_PROFILE=debug`:
  build the helper in debug.
- `HUSH_NO_DEV_SERVER=1`: with `electrobun dev`, load the built `dist/` instead of Vite.
- Build time: `HUSH_APP_ID` (bundle identifier; set it for smoke-test builds, because Electrobun keeps the
  CEF profile and caches under `~/Library/{Application Support,Caches}/<identifier>/stable/`),
  `HUSH_CDP_PORT` (open the DevTools protocol on that port, to verify a built app), and the signing
  variables below. Run-time `HUSH_SELFTEST=1` makes the UI report its status on the console.
- Signing is opt-in: `ELECTROBUN_DEVELOPER_ID` (identity name) signs; add `ELECTROBUN_APPLEID`,
  `ELECTROBUN_APPLEIDPASS`, `ELECTROBUN_TEAMID` to notarize. `scripts/post-wrap.ts` patches the
  Info.plist usage strings Electrobun does not set (audio capture, Apple Events).

## Verifying

Verify UI changes in the browser preview (`bun run dev`, `?onboarding`, `?live`,
`window.__hushEmit(event, payload)`), then run `bun run check`, `bun run test` and, for helper
changes, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` in
`native/hush-native`. For shell changes, build with `HUSH_APP_ID=com.hush.smoke HUSH_CDP_PORT=9222`
and launch with `HUSH_DATA_DIR` pointed at a temp folder; do not touch the installed app's data.
