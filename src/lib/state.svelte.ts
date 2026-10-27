// App-wide reactive state shared by the main window's routes.

import { toast } from "svelte-sonner";
import { api, errorText, on } from "./api";
import type { AppInfo, MeetingStatus, ModelStatus, Permissions, Settings } from "./types";

export type Toast = { kind: "info" | "error" | "success"; text: string; action?: { label: string; run: () => void } };

class AppStore {
  settings = $state<Settings | null>(null);
  info = $state<AppInfo | null>(null);
  permissions = $state<Permissions | null>(null);
  meeting = $state<MeetingStatus | null>(null);
  models = $state<ModelStatus[]>([]);
  detectedApp = $state<string | null>(null);
  /** Bumped whenever recordings change, so lists can refetch. */
  recordingsVersion = $state(0);
  dictationsVersion = $state(0);

  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #started = false;

  async init() {
    if (this.#started) return;
    this.#started = true;
    const [s, info] = await Promise.all([api.getSettings(), api.appInfo()]);
    this.settings = s;
    this.info = info;
    applyTheme(s.general.theme);
    this.refreshPermissions();
    this.refreshModels();
    this.refreshMeeting();

    on("settings:changed", async () => {
      this.settings = await api.getSettings();
    });
    on<{ id: string; progress: number; done?: boolean }>("model:progress", (p) => {
      const m = this.models.find((m) => m.id === p.id);
      if (p.done) {
        if (p.progress < 0) this.toast("error", `Download of ${m?.name ?? p.id} failed or was cancelled`);
        this.refreshModels();
      } else if (m) {
        m.downloading = p.progress;
      }
    });
    on<string>("meeting:started", () => this.refreshMeeting());
    on<string>("meeting:stopped", () => {
      this.meeting = null;
      this.recordingsVersion++;
    });
    on("recording:updated", () => this.recordingsVersion++);
    on("recording:progress", () => this.recordingsVersion++);
    on("dictation:new", () => this.dictationsVersion++);
    on<string>("meeting:detected", (app) => {
      if (!this.meeting) this.detectedApp = app;
    });
    on<{ id: string; error: string }>("meeting:error", (p) => this.toast("error", p.error));
    on<{ id: string; error: string }>("meeting:enhance-error", (p) => this.toast("error", `Enhance failed: ${p.error}`));

    // Keep the elapsed clock and capture flags fresh while recording.
    setInterval(() => {
      if (this.meeting) this.refreshMeeting();
    }, 1000);
    window.addEventListener("focus", () => this.refreshPermissions());
  }

  async refreshPermissions() {
    this.permissions = await api.permissions();
  }
  async refreshModels() {
    this.models = await api.models();
  }
  async refreshMeeting() {
    this.meeting = await api.meetingStatus();
  }

  /** Persist settings (debounced). Call after mutating `settings`. */
  save(immediate = false) {
    clearTimeout(this.#saveTimer);
    const run = async () => {
      if (!this.settings) return;
      try {
        const errors = await api.saveSettings($state.snapshot(this.settings) as Settings);
        applyTheme(this.settings.general.theme);
        for (const e of errors) this.toast("error", e);
      } catch (e) {
        this.toast("error", `Couldn't save settings: ${errorText(e)}`);
      }
    };
    if (immediate) run();
    else this.#saveTimer = setTimeout(run, 400);
  }

  toast(kind: Toast["kind"], text: string, action?: Toast["action"]) {
    toast[kind](text, {
      duration: kind === "error" ? 7000 : 4000,
      action: action && { label: action.label, onClick: action.run },
    });
  }

  sttName(id: string | null | undefined): string {
    const p = this.settings?.stt_profiles.find((p) => p.id === id);
    if (!p) return id ?? "—";
    if (p.kind === "local") return this.models.find((m) => m.id === p.model)?.name ?? p.name;
    return p.name;
  }
  llmName(id: string | null | undefined): string {
    return this.settings?.llm_profiles.find((p) => p.id === id)?.name ?? "None";
  }
}

export const app = new AppStore();

export function applyTheme(theme: string) {
  try {
    localStorage.setItem("hush-theme", theme);
  } catch {}
  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

if (typeof window !== "undefined") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    applyTheme(app.settings?.general.theme ?? "system");
  });
}
