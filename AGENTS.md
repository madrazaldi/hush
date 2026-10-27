# AGENTS.md

Hush is a macOS (Apple Silicon, 14.2+) desktop app: dictation, file transcription and
meeting notes. [Electrobun](https://electrobun.dev) shell rendering with bundled Chromium (CEF),
backend in TypeScript on Bun (`src/bun/`), SvelteKit SPA frontend (Svelte 5 runes, TypeScript),
and a small Swift helper (`native/hush-native`) for the parts that need native code.
Use bun for everything JS (not npm/pnpm/yarn). Read `DESIGN.md` for the research and architecture.

## Commands

```sh
bun install                        # also runs `svelte-kit sync` and `electrobun prepare`
bun run dev                        # UI only in a browser, backed by src/lib/devmock (127.0.0.1:1427)
bun run app:dev                    # full app: builds the helper + UI, then `electrobun dev`
bun run app:build                  # release build: artifacts/ gets the .dmg and update files
bun run check                      # svelte-check + tsc for src/bun (must be 0 errors, 0 warnings)
bun run test                       # bun test src/bun (the TypeScript backend)
bun run build:native               # transcribe.cpp (first time) + swift build, staged at native/bin/hush-native
bun run test:native                # swift test in native/hush-native
cd native/hush-native && swift format --in-place --recursive Sources Tests Package.swift
bun run lint:native                # swift format lint --strict; CI also builds with -warnings-as-errors
bun run transcribe -- <file> [model-id]   # local STT on a file through the helper
bun run llm                        # dictation cleanup via each installed agent CLI
bun run systap                     # system-audio tap smoke test (needs the permission, prints levels)
```

Building the helper needs Xcode (Swift 6) and CMake. `scripts/build-native.ts` clones transcribe.cpp at a
pinned tag into `native/hush-native/vendor/` and builds ggml with Metal there (gitignored); the first build is
slow, later ones reuse it. `electrobun prepare` (run by `bun install`, `dev`, `check`, `app:*`) projects the Electrobun SDK into
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
- `native/hush-native/` is the Swift helper, see below. `scripts/` are build and tooling scripts (Bun).
- Frontend: `src/routes/*` pages, `src/lib/components`, `src/lib/settings` (settings tabs),
  `src/lib/state.svelte.ts` (global `app` store, event subscriptions, debounced save),
  `src/app.css` (Tailwind v4 entry: shadcn theme tokens, Hush extras like `ember`/`sage`/`amber`, `.prose`).
  UI primitives are [shadcn-svelte](https://shadcn-svelte.com) components in `src/lib/components/ui`
  (generated: add more with `bunx shadcn-svelte@latest add <name>`, `components.json` maps them to `#lib`),
  styled with Tailwind utilities. Route scaffolding: `Page.svelte` and `PageHeader.svelte`.
- Windows: `main` and `overlay` (`/overlay` route, a transparent non-activating panel). Both load the same
  SPA; `window.__hush.window` (injected by `preload`) says which one.

## The native helper

`native/hush-native` is a SwiftPM package: audio capture (mic via an AUHAL unit, system audio via a Core
Audio process tap), ggml/Metal speech-to-text (transcribe.cpp through its C API), global hotkeys
(CGEventTap) and paste/keystroke synthesis. The realtime audio callbacks and their lock-free ring are C
(`Sources/CHushAudio`) so they never allocate; keep it that way. Bun talks to it with newline-delimited
JSON-RPC 2.0 over stdio (`src/bun/backend/native.ts`; protocol documented in
`native/hush-native/Sources/HushNative/RPC.swift`). Wire names are snake_case, mapped from camelCase
Swift by the coders in `JSON.swift`. Logs go to stderr; stdout carries only protocol lines.
Audio never goes through the JSON channel: captures write f32 files (rotated into `<path>.<seq>` chunks
for meetings) and STT reads them by path. The helper is not an app bundle and has no UI. Add
to it only what cannot be done from Bun.

## Conventions and gotchas

- Backend events are listed in `DESIGN.md`. Add new ones there and in `state.svelte.ts`.
- When adding a command or event the UI uses, also add a handler or fixture in
  `src/lib/devmock/index.ts` so the browser preview keeps working.
- Style with Tailwind utilities and the shadcn components; keep scoped `<style>` for what utilities can't
  express. `src/app.css` has no `:global(...)`. Themes switch on `data-theme` on `<html>` (the `dark:`
  variant follows it), not on a `.dark` class. Toasts go through `app.toast()` (svelte-sonner).
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
  accent (`primary`). Use the tokens in `app.css` (`bg-card`, `text-muted-foreground`, `text-ember-text`, ...)
  rather than literal colours, and the `heading` utility for serif titles.

## Environment variables

- `HUSH_DATA_DIR`: use this instead of `~/Library/Application Support/com.hush.app` (tests, throwaway runs).
- `HUSH_DEBUG=1`: debug logging (the helper too). `HUSH_NATIVE_LOG`: helper log level (error, warn, info,
  debug). `HUSH_NATIVE_BIN`: helper binary to use. `HUSH_NATIVE_PROFILE=debug`: build the helper in debug.
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
changes, `bun run lint:native`, `swift build -Xswiftc -warnings-as-errors` and `swift test` in
`native/hush-native` (plus `bun run systap` and `bun run transcribe` for capture and STT). For shell changes, build with `HUSH_APP_ID=com.hush.smoke HUSH_CDP_PORT=9222`
and launch with `HUSH_DATA_DIR` pointed at a temp folder; do not touch the installed app's data.
