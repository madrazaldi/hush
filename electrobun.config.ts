import type { ElectrobunConfig } from "electrobun";

// Signing is opt-in: set ELECTROBUN_DEVELOPER_ID (a codesigning identity, e.g. "Hush Local Signing" for a
// local self-signed one) and the build signs the bundle; add the Apple ID or API key variables to also
// notarize. Without them the app is built unsigned, which is fine for development.
const env = process.env;
const sign = Boolean(env.ELECTROBUN_DEVELOPER_ID);
const notarize =
  sign &&
  Boolean((env.ELECTROBUN_APPLEID && env.ELECTROBUN_APPLEIDPASS && env.ELECTROBUN_TEAMID) || (env.ELECTROBUN_APPLEAPIKEY && env.ELECTROBUN_APPLEAPIISSUER && env.ELECTROBUN_APPLEAPIKEYPATH));

// Window options (size, title bar, traffic lights) live in src/bun/index.ts.
// Hush renders with the bundled Chromium (CEF), not the system webview.
export default {
  app: {
    name: "Hush",
    // Same identifier as the Tauri build, so TCC grants and the data folder
    // (~/Library/Application Support/com.hush.app, see src/bun/backend/paths.ts) carry over.
    // Electrobun also keeps its CEF profile and caches under this identifier, so smoke-test builds set
    // HUSH_APP_ID to something else to keep them away from an installed Hush.
    identifier: env.HUSH_APP_ID || "com.hush.app",
    version: "0.1.0",
    description: "Dictation, file transcription and meeting notes for macOS",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    copy: {
      // SvelteKit's static output (`bun run build:ui` writes dist/).
      dist: "views/mainview",
      "assets/icons/tray.png": "views/tray/tray.png",
      // The native helper (`bun run build:native` stages it here).
      "native/bin/hush-native": "native/hush-native",
    },
    watchIgnore: ["dist/**", "native/**", "node_modules/**"],
    mac: {
      bundleCEF: true,
      defaultRenderer: "cef",
      icons: "assets/icons/icon.iconset",
      codesign: sign,
      notarize,
      // Electrobun turns a string value into the matching Info.plist usage description.
      entitlements: {
        "com.apple.security.device.microphone": "Hush records your voice for dictation and meeting transcription.",
        "com.apple.security.device.audio-input": true,
        "com.apple.security.automation.apple-events": true,
        "com.apple.security.cs.allow-jit": true,
      },
      // Opt-in DevTools protocol port for verifying a built app (HUSH_CDP_PORT=9222).
      chromiumFlags: env.HUSH_CDP_PORT ? { "remote-debugging-port": env.HUSH_CDP_PORT } : {},
    },
  },
  runtime: {
    // Hush lives in the menu bar: closing the window hides it, and Quit quits.
    exitOnLastWindowClosed: false,
  },
  scripts: {
    // Adds the usage descriptions Electrobun has no entitlement mapping for (system audio, Apple events),
    // to the app bundle and to the self-extracting wrapper around it.
    postBuild: "scripts/post-wrap.ts",
    postWrap: "scripts/post-wrap.ts",
  },
} satisfies ElectrobunConfig;
