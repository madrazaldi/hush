// Application lifecycle shared by the Electrobun entry point and the self-test: open the data directory,
// build the process-wide state, start the background services, and shut everything down cleanly.

import { rmSync } from "node:fs";
import type { LlmKind } from "../../lib/types";
import "./commands";
import { Db } from "./db";
import { Dictation } from "./dictation";
import { emit } from "./events";
import { FileQueue } from "./files";
import { detectClis } from "./llm";
import { log } from "./log";
import { Meetings } from "./meetings";
import { native } from "./native";
import { dbFile, initPaths, rootDir } from "./paths";
import { loadSettings, saveSettings, seedLlmProfiles } from "./settings";
import { warm as warmShellEnv } from "./shell-env";
import { type AppState, initState, shell, st } from "./state";

/** Open the data directory and create the application state. Call once at startup. */
export function openApp(): AppState {
  initPaths();
  log.info("data directory", rootDir());
  // Resolve the login-shell PATH early (in the background) so CLIs are found.
  warmShellEnv();
  const settings = loadSettings();
  const state: AppState = {
    settings,
    db: new Db(dbFile()),
    dictation: new Dictation(),
    meetings: new Meetings(),
    files: new FileQueue(),
    llmTasks: new Map(),
  };
  initState(state);
  return state;
}

/** Start the hotkeys, detection and first-run work. Needs the shell hooks to be installed. */
export function startServices(): void {
  const state = st();
  const s = state.settings;

  // First run: create LLM profiles for installed agent CLIs.
  if (s.llm_profiles.length === 0) {
    void detectClis()
      .then((found) => {
        const kinds: LlmKind[] = found.filter((c) => c.path).map((c) => c.kind);
        const cur = st().settings;
        if (cur.llm_profiles.length === 0 && kinds.length > 0) {
          seedLlmProfiles(cur, kinds);
          saveSettings(cur);
          emit("settings:changed", null);
        }
      })
      .catch((e) => log.warn("detecting agent CLIs:", e));
  }

  // Retention cleanup.
  try {
    for (const p of state.db.pruneDictations(s.general.history_days)) rmSync(p, { force: true });
  } catch (e) {
    log.warn("history cleanup failed:", e);
  }

  shell.setDockVisible(s.general.show_in_dock);
  // Keep the login item in step with the setting (it points at this app's current location).
  if (s.general.launch_at_login) shell.setLaunchAtLogin(true);
  state.dictation.startHotkeys();
  state.meetings.startDetection();
}

/**
 * Finish a meeting that is still recording or saving, release the microphone, and stop the native
 * helper (which unloads the speech models). Safe to call twice.
 */
export async function shutdownApp(): Promise<void> {
  const state = st();
  state.meetings.stopDetection();
  await state.meetings.shutdown();
  await state.dictation.shutdown();
  await native().stop();
}
