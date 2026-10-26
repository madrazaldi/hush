/**
 * Electrobun main process.
 *
 * Owns the windows and runs the whole backend in-process (src/bun/backend, TypeScript). Only the audio
 * device, speech-to-text, global hotkeys and keystroke synthesis live outside it, in the native helper
 * (native/hush-native), which the backend drives over JSON-RPC on stdio.
 *
 *   webview --RPC invoke(cmd,args)--> dispatch() --> command handlers (backend/commands, ./shell)
 *   webview <--RPC "event" message--- backend emit()
 *   webview --http--> 127.0.0.1:<random port>/<token>/{file,upload}  (backend/media-server.ts)
 */
import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow, Updater, Utils } from "electrobun/main";
import type { HushGlobals, HushRPC } from "../lib/ipc-schema";
import { openApp, shutdownApp, startServices } from "./backend/app";
import { dispatch } from "./backend/commands";
import { onEvent } from "./backend/events";
import { log } from "./backend/log";
import { startMediaServer } from "./backend/media-server";
import { st } from "./backend/state";
import { createOverlay } from "./overlay";
import { installShell, showMain } from "./shell";
import { createTray } from "./tray";

const DEV_SERVER = "http://127.0.0.1:1427";
const MIN_SIZE = { width: 860, height: 560 };

// A long-lived app should survive a stray rejection from a child process or socket.
process.on("unhandledRejection", (e) => log.error("unhandled rejection:", e));

async function pickUrl(path: string): Promise<string> {
  if ((await Updater.localInfo.channel()) === "dev" && !process.env.HUSH_NO_DEV_SERVER) {
    try {
      await fetch(DEV_SERVER, { method: "HEAD", signal: AbortSignal.timeout(800) });
      log.info(`Using the Vite dev server at ${DEV_SERVER}`);
      return `${DEV_SERVER}${path}`;
    } catch {
      // not running: use the bundled build
    }
  }
  return "views://mainview/index.html";
}

// Only Hush's own pages may load in its windows: any page there can call every backend command (settings
// with API keys included). Rules are globs, "^" blocks, the last match wins. External links go through
// opener_open_url instead (see the click handler in +layout.svelte). Electrobun ignores the
// `navigationRules` window option, so they are set on each webview after creation.
const NAVIGATION_RULES = ["^*", "views://*", `${DEV_SERVER}/*`];

const state = openApp();
const media = startMediaServer({ isKnownMedia: (p) => state.db.mediaInUse(p) });

const makeRpc = () =>
  BrowserView.defineRPC<HushRPC>({
    // Transcription, downloads and LLM calls can run for minutes.
    maxRequestTime: Infinity,
    handlers: {
      requests: { invoke: ({ cmd, args }) => dispatch(cmd, args) },
      messages: {},
    },
  });

const globals = (window: HushGlobals["window"]): string => {
  const g: HushGlobals = { mediaBase: media.baseUrl, window, selftest: !!process.env.HUSH_SELFTEST };
  // Runs in the page before any other script.
  return `window.__hush = ${JSON.stringify(g)};`;
};

const mainRpc = makeRpc();
const win = new BrowserWindow({
  title: "Hush",
  url: await pickUrl("/"),
  frame: { width: 1180, height: 780 },
  renderer: "cef",
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 18, y: 22 },
  preload: globals("main"),
  rpc: mainRpc,
});

const overlayRpc = makeRpc();
const overlay = createOverlay({ url: await pickUrl("/overlay"), preload: globals("overlay"), rpc: overlayRpc });
for (const view of [win.webview, overlay.win.webview]) view.setNavigationRules(NAVIGATION_RULES);

let quitting = false;
let trayHandle: ReturnType<typeof createTray> | null = null;

function quit() {
  quitting = true;
  Utils.quit();
}

installShell(win, {
  refreshTray: () => trayHandle?.refresh(),
  overlayShow: (pos) => overlay.show(pos),
  overlayHide: () => overlay.hide(),
});

// Backend events -> webviews. The overlay only cares about dictation.
onEvent((event, payload) => {
  try {
    win.webview.rpc?.send.event({ event, payload });
  } catch (e) {
    log.warn(`could not deliver event ${event}`, e);
  }
  if (event.startsWith("dictation:")) {
    try {
      overlay.sendEvent(event, payload);
    } catch (e) {
      log.warn(`could not deliver event ${event} to the overlay`, e);
    }
  }
});

// Electrobun has no minimum window size option; enforce one on resize.
win.on("resize", (e) => {
  const { width, height } = (e as { data: { width: number; height: number } }).data;
  if (width < MIN_SIZE.width || height < MIN_SIZE.height) {
    win.setSize(Math.max(width, MIN_SIZE.width), Math.max(height, MIN_SIZE.height));
  }
});

// Closing the main window keeps Hush running in the menu bar.
win.on("will-close", (event) => {
  if (!quitting) {
    (event as { response?: { allow: boolean } }).response = { allow: false };
    win.hide();
  }
});

// Clicking the Dock icon brings the window back.
Electrobun.app.on("reopen", () => showMain());

// Quitting mid-meeting (or while one is still being saved): finish the recording properly first, release
// the microphone and stop the native helper, then exit. Repeated quits wait for the same shutdown.
let shutdownStarted = false;
let shutdownDone = false;
Electrobun.events.on("before-quit", (event) => {
  if (shutdownDone) return;
  (event as { response?: { allow: boolean } }).response = { allow: false };
  if (shutdownStarted) return;
  shutdownStarted = true;
  shutdownApp()
    .catch((e) => log.error("shutdown failed:", e))
    .finally(() => {
      shutdownDone = true;
      media.stop();
      quit();
    });
});

ApplicationMenu.setApplicationMenu([
  {
    label: "Hush",
    submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "showAll" }, { type: "separator" }, { role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
  },
  {
    label: "Window",
    submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }, { type: "separator" }, { role: "toggleFullScreen" }],
  },
]);

trayHandle = createTray("views://tray/tray.png", quit);
startServices();

log.info(`Hush started (data: ${st().settings.general.onboarded ? "onboarded" : "first run"})`);
