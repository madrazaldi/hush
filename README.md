# Hush

[![CI](https://github.com/madrazaldi/hush/actions/workflows/ci.yml/badge.svg)](https://github.com/madrazaldi/hush/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/madrazaldi/hush?include_prereleases&sort=semver)](https://github.com/madrazaldi/hush/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS 14.2+ · Apple Silicon](https://img.shields.io/badge/macOS-14.2%2B%20%C2%B7%20Apple%20Silicon-lightgrey)

Dictation, file transcription and meeting notes in one macOS app. Local-first:
speech runs on your Mac by default, and cloud speech or AI providers are opt-in.

![Hush home](docs/screenshots/home.png)

- **Dictation**: hold <kbd>fn</kbd> anywhere and talk, then release to insert polished text.
  - A quick tap locks hands-free recording, and <kbd>Esc</kbd> cancels.
  - Command mode (<kbd>fn</kbd><kbd>⇧</kbd>) rewrites selected text by voice.
  - Per-app styles, vocabulary, replacements and searchable history.
- **Files**: drop audio or video, or paste a YouTube or podcast link, to get a timestamped, searchable transcript.
  - Synced playback and inline editing.
  - Speaker names, translation, summaries and chat.
  - Export to Markdown, TXT, SRT, VTT, CSV or JSON.
- **Meetings**: a notepad-first recorder that captures your mic ("Me") and system audio ("Them") without a bot joining the call.
  - Live transcript.
  - Enhanced notes from templates, chat and recipes (follow-up email, action items, and more).
  - Detects when Zoom, Meet, Teams and similar apps start using the mic.

| Meeting notes | File transcript |
|---|---|
| ![Meeting notes with a follow-up email recipe](docs/screenshots/meeting.png) | ![File transcript with synced player](docs/screenshots/file.png) |
| **Dictation history and styles** | **AI providers** |
| ![Dictation](docs/screenshots/dictation.png) | ![AI settings](docs/screenshots/settings-ai.png) |

<p align="center"><img src="docs/screenshots/overlay.png" width="420" alt="Dictation overlay"></p>

## Install

1. Download `macos-arm64-Hush.dmg` from the [latest release](https://github.com/madrazaldi/hush/releases/latest).
2. Open it and drag **Hush** to Applications.
3. Release builds are not notarized unless the repository has Apple signing secrets, so macOS may say Hush "is damaged" or "can't be opened". Clear the quarantine flag once:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Hush.app
   ```

4. Launch Hush. Onboarding grants permissions and downloads a speech model (Parakeet v3, about 740 MB, is recommended).

Optional: `brew install ffmpeg yt-dlp` for more media formats and link imports.

## Speech engines

| | |
|---|---|
| On-device | [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) on Metal (in the native helper), using Parakeet TDT v2/v3, Whisper (base → large v3 turbo), Moonshine, SenseVoice, Canary, Qwen3-ASR and others. Models download from Settings → Speech. |
| Cloud (BYOK) | OpenAI, Groq, Mistral, xAI Grok, Meta Muse, Deepgram, ElevenLabs, AssemblyAI, or any OpenAI-compatible `/audio/transcriptions` endpoint. |

Dictation, Files and Meetings each choose their own engine.

## AI providers

AI is used for dictation polish, command mode, meeting notes, summaries, translation, chat and recipes.

- **Agent CLIs** you're already signed in to: Claude Code, Codex, opencode, Gemini CLI, Antigravity.
  - They run with tools disabled or read-only, in an empty temporary directory. Claude Code, Codex and Gemini CLI keep no session history; opencode and Antigravity may keep their own.
- **Bring your own key**: any Chat Completions, Responses or Anthropic Messages endpoint.
  - Presets: OpenAI, Anthropic, OpenRouter, Groq, xAI, Ollama, LM Studio.

## Development

Requirements: macOS 14.2 or later (for system audio capture), [Bun](https://bun.sh), Xcode (Swift 6) and CMake (to build the native helper, which compiles transcribe.cpp). Optional: `ffmpeg` (more media formats) and `yt-dlp` (link imports).

Hush is an [Electrobun](https://electrobun.dev) app: the window is the bundled Chromium (CEF), the backend is TypeScript on Bun, and a small Swift helper (`native/hush-native`) does audio capture, speech-to-text, global hotkeys and paste.

```sh
bun install
bun run app:dev         # the app (builds the helper and UI, then electrobun dev)
bun run app:build       # release build: .app, .dmg and update files in artifacts/
bun run check           # svelte-check + tsc
bun run test            # bun tests for the TypeScript backend
bun run test:native      # swift test for the native helper
```

[AGENTS.md](AGENTS.md) has the code layout and conventions for contributors (human or AI).

### CI and releases

- [CI](.github/workflows/ci.yml) runs on every push and pull request: `svelte-check`, `tsc`, the bun tests and the UI build, then `swift format lint --strict`, a warnings-as-errors `swift build` and the unit tests of the native helper on macOS.
- [Release](.github/workflows/release.yml) runs when a `v*` tag is pushed. The tag must match `version` in `electrobun.config.ts`, `package.json` and `helperVersion` in `native/hush-native/Sources/HushNative/Methods.swift` (`bun scripts/version.ts` checks they agree). It builds the Apple Silicon `.dmg` with `electrobun build` and publishes a GitHub release. Tags with a `-` (e.g. `v0.2.0-beta.1`) become pre-releases.

  ```sh
  # bump version in electrobun.config.ts, package.json and helperVersion in Methods.swift, then:
  git tag v0.2.0 && git push origin v0.2.0
  ```

- To sign and notarize, add these repository secrets: `ELECTROBUN_CERTIFICATE` (base64 .p12), `ELECTROBUN_CERTIFICATE_PASSWORD`, `ELECTROBUN_DEVELOPER_ID` (the identity name), and for notarization `ELECTROBUN_APPLEID`, `ELECTROBUN_APPLEIDPASS` (app-specific password) and `ELECTROBUN_TEAMID`. Without them the build is unsigned. Locally, `ELECTROBUN_DEVELOPER_ID="Hush Local Signing" bun run app:build` signs with a keychain identity.

### UI without the native side

`bun run dev`, then open http://127.0.0.1:1427 in a browser. When the page runs outside the app, `src/lib/devmock` fakes the IPC with fixture data.

- Add `?onboarding` to the URL for the first-run flow, or `?live` for a meeting in progress.
- `window.__hushEmit(event, payload)` fires any backend event. For example, open `/overlay` and send `dictation:state` and `dictation:level`.

### Scripts

```sh
bun run transcribe -- talk.m4a [model-id]   # local STT on a file (builds the helper if needed)
bun run llm                                 # dictation cleanup via each installed CLI
bun run systap                              # system-audio tap smoke test (prints levels)
```

Set `HUSH_DATA_DIR` to run against a throwaway data folder instead of `~/Library/Application Support/com.hush.app`.

## Permissions

- **Microphone**: dictation and meetings.
- **Accessibility**: the global hotkey and pasting into other apps.
- **System Audio Recording**: the other side of meetings. macOS asks the first time a meeting records. It's under Privacy & Security → Screen & System Audio Recording.

Data lives in `~/Library/Application Support/com.hush.app`: SQLite, audio, models, and `settings.json` (mode 0600, holds API keys). Electrobun also keeps the Chromium profile in `com.hush.app/stable/`.

The app is a new binary relative to older builds, so macOS may ask for these permissions again after upgrading.

See [DESIGN.md](DESIGN.md) for the research and architecture.

## License

[MIT](LICENSE)
