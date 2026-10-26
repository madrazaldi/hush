// Process-wide application state, plus the hooks the Electrobun shell fills in (windows, tray, dock,
// notifications). Everything outside src/bun/index.ts and the shell files talks to the shell through
// `shell`, so the backend stays importable from tests and scripts.

import type { OverlayPosition, Settings } from "../../lib/types";
import type { Db } from "./db";
import type { Dictation } from "./dictation";
import { emit } from "./events";
import type { FileQueue } from "./files";
import type { Meetings } from "./meetings";

export interface AppState {
  settings: Settings;
  db: Db;
  dictation: Dictation;
  meetings: Meetings;
  files: FileQueue;
  /** Cancellation for in-flight LLM requests, keyed by request id. */
  llmTasks: Map<string, AbortController>;
}

let current: AppState | null = null;

export function initState(s: AppState): void {
  current = s;
}

/** The application state; throws before `initState`. */
export function st(): AppState {
  if (!current) throw new Error("app state is not initialized");
  return current;
}

export const settings = (): Settings => st().settings;

export { emit };

export interface ShellHooks {
  notify(title: string, body: string): void;
  /** Bring the main window forward, optionally navigating to a route. */
  showMain(route?: string): void;
  refreshTray(): void;
  setDockVisible(show: boolean): void;
  overlayShow(pos: OverlayPosition): void;
  overlayHide(): void;
  /** Put plain text on the clipboard (no transient markers). */
  copyText(text: string): void;
  setLaunchAtLogin(enabled: boolean): void;
  appVersion(): string;
}

const noop = () => {};

/** Replaced by the real implementations in src/bun/index.ts. */
export const shell: ShellHooks = {
  notify: noop,
  showMain: noop,
  refreshTray: noop,
  setDockVisible: noop,
  overlayShow: noop,
  overlayHide: noop,
  copyText: noop,
  setLaunchAtLogin: noop,
  appVersion: () => "0.0.0",
};
