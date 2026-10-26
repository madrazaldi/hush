// Well-known on-disk locations, rooted at the app data directory.
//
// Same place and layout as the Tauri build (`~/Library/Application Support/com.hush.app`) so existing
// databases, settings, models and meetings keep loading. `HUSH_DATA_DIR` overrides the root, which is
// how tests and smoke runs stay away from real data.

import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const APP_IDENTIFIER = "com.hush.app";

let ROOT: string | null = null;

export function defaultRoot(): string {
  return process.env.HUSH_DATA_DIR || join(homedir(), "Library", "Application Support", APP_IDENTIFIER);
}

/** Pick the data root, create the directories, and clear leftovers of an unclean shutdown. */
export function initPaths(root: string = defaultRoot()): void {
  ROOT = root;
  for (const d of [rootDir(), modelsDir(), audioDir(), mediaDir()]) mkdirSync(d, { recursive: true });
  // Spooled meeting audio from a session that didn't end cleanly.
  rmSync(spoolDir(), { recursive: true, force: true });
}

export function rootDir(): string {
  return ROOT ?? defaultRoot();
}

export const modelsDir = () => join(rootDir(), "models");
/** Recorded audio (dictations, meetings). */
export const audioDir = () => join(rootDir(), "audio");
/** Temporary per-session meeting audio waiting for transcription. */
export const spoolDir = () => join(rootDir(), "spool");
/** Imported / downloaded media for file transcriptions. */
export const mediaDir = () => join(rootDir(), "media");
export const settingsFile = () => join(rootDir(), "settings.json");
export const dbFile = () => join(rootDir(), "hush.db");

/** Scratch space for short-lived audio files (capture chunks, decode output). */
export function scratchDir(): string {
  const d = join(tmpdir(), `hush-${process.getuid?.() ?? 0}`);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
