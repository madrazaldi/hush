// Dictation: hotkey -> record -> transcribe -> clean up -> insert into the focused app.
//
// The controller is a small state machine (Idle -> Starting -> Recording -> Processing) driven by hotkey
// press/release edges, following Handy/Wispr semantics: push-to-talk, toggle, and hybrid (a quick tap
// latches recording on). Recording, hotkeys and text insertion run in the native helper.

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Dictation as DictationRow, Settings, Style } from "../../lib/types";
import * as ai from "./ai";
import { SAMPLE_RATE, readF32File, trimSilence, writeWav } from "./audio/wav";
import { nowMs } from "./db";
import * as llm from "./llm";
import { errMsg, log } from "./log";
import { type HotkeyAction, native } from "./native";
import { audioDir, scratchDir } from "./paths";
import { type FrontApp, frontApp, play, setOutputMuted } from "./platform";
import { llmFor, sttFor } from "./settings";
import { emit, settings, shell, st } from "./state";
import * as stt from "./stt";
import { defaultSttOptions } from "./stt/types";

const MAX_RECORDING_MS = 15 * 60_000;
const MIN_SAMPLES = SAMPLE_RATE / 4;

export type Mode = "dictate" | "command";

export interface OverlayState {
  /** idle | recording | processing | done | error */
  phase: string;
  mode: Mode;
  latched: boolean;
  message: string | null;
  style: string | null;
  app: string | null;
}

interface Rec {
  mode: Mode;
  startedAt: number;
  latched: boolean;
  front: FrontApp;
  captureId: string;
  file: string;
  /** Resolves to the previous muted state once the output was muted (when the setting asks for it). */
  mute: Promise<boolean | null> | null;
  session: number;
  safety: ReturnType<typeof setTimeout>;
  unlisten: () => void;
}

type Phase =
  | { t: "idle" }
  /** The mic is being opened for `session`; reserved so two starts (hotkey + UI) can't both open a device. */
  | { t: "starting"; session: number; mode: Mode; released: boolean }
  | { t: "recording"; rec: Rec }
  | { t: "processing"; ctl: AbortController; session: number };

function overlayEmit(phase: string, mode: Mode, latched: boolean, message: string | null = null, style: string | null = null, app: string | null = null) {
  const s: OverlayState = { phase, mode, latched, message, style, app };
  emit("dictation:state", s);
}

export class Dictation {
  private phase: Phase = { t: "idle" };
  private session = 0;
  private hotkeysOn = false;

  /** Listen for hotkey events from the helper and bind the configured keys. Call once after state init. */
  startHotkeys(): void {
    if (this.hotkeysOn) return;
    this.hotkeysOn = true;
    native().on("hotkey", (e) => this.onHotkey(e.action, e.pressed));
    // A restarted helper has no bindings.
    native().onRestart(() => void this.rebind());
    void this.rebind();
  }

  /** Apply hotkey settings. Returns the bindings that could not be registered. */
  async rebind(): Promise<string[]> {
    const s = settings();
    const bindings: { action: HotkeyAction; spec: string }[] = s.dictation.enabled
      ? [
          { action: "dictate", spec: s.dictation.hotkey },
          { action: "command", spec: s.dictation.command_hotkey },
          { action: "paste_last", spec: s.dictation.paste_last_hotkey },
        ]
      : [];
    try {
      return await native().hotkeysBind(bindings);
    } catch (e) {
      log.error("binding hotkeys failed:", e);
      return [errMsg(e)];
    }
  }

  private setCancel(on: boolean) {
    void native().hotkeysSetCancel(on).catch((e) => log.warn("hotkeys.set_cancel:", e));
  }

  isBusy(): boolean {
    return this.phase.t !== "idle";
  }

  isRecording(): boolean {
    return this.phase.t === "recording";
  }

  onHotkey(action: HotkeyAction, pressed: boolean): void {
    const s = settings();
    const activation = s.dictation.activation;
    const hold = Math.max(s.dictation.hold_ms, 100);

    if (action === "cancel") {
      if (pressed) this.cancel();
      return;
    }
    if (action === "paste_last") {
      if (pressed) {
        const d = st().db.lastDictation();
        if (d) void insertText(d.text, settings()).catch((e) => log.warn("paste last:", e));
      }
      return;
    }
    const mode: Mode = action === "dictate" ? "dictate" : "command";
    const p = this.phase;
    if (p.t === "idle") {
      if (pressed) void this.start(mode);
    } else if (p.t === "starting") {
      if (!pressed && p.mode === mode) p.released = true;
    } else if (p.t === "recording") {
      const rec = p.rec;
      if (pressed) {
        if (mode === "command" && rec.mode === "dictate" && Date.now() - rec.startedAt < 600) {
          // Fn then Shift: upgrade to command mode.
          rec.mode = "command";
          overlayEmit("recording", "command", rec.latched, null, null, rec.front.name);
        } else if (rec.latched || activation === "toggle") {
          void this.finish();
        }
      } else {
        if (rec.latched || (rec.mode !== mode && rec.mode === "dictate")) return;
        if (activation === "push_to_talk") {
          void this.finish();
        } else if (activation === "hybrid") {
          if (Date.now() - rec.startedAt < hold) {
            rec.latched = true;
            overlayEmit("recording", rec.mode, true, null, null, rec.front.name);
          } else {
            void this.finish();
          }
        }
      }
    }
  }

  /** Start recording (also used by the UI's record button). */
  async start(mode: Mode): Promise<void> {
    if (this.phase.t !== "idle") return;
    const session = ++this.session;
    const starting = { t: "starting" as const, session, mode, released: false };
    this.phase = starting;
    const s = settings();
    // The frontmost app is looked up while the mic opens, so it doesn't delay the recording.
    const frontP = frontApp();
    const profile = sttFor(s, s.dictation.stt_profile);
    if (profile.kind === "local") {
      try {
        stt.local.preload(profile.model);
      } catch (e) {
        log.warn("model preload:", e);
      }
    }

    const captureId = `dictation:${session}`;
    const file = join(scratchDir(), `dictation-${session}-${process.pid}.f32`);
    const unlisten = native().on("capture.level", (e) => {
      if (e.id === captureId) emit("dictation:level", e.level);
    });
    let failure: unknown = null;
    try {
      await native().captureStart({ id: captureId, source: "mic", device: s.dictation.mic_device, path: file, rotate_ms: 0 });
    } catch (e) {
      failure = e ?? new Error("could not open the microphone");
    }
    const front = await frontP;

    const cur = this.phase;
    if (cur.t !== "starting" || cur.session !== session) {
      // Cancelled while the mic was opening: release it.
      unlisten();
      if (!failure) await native().captureStop(captureId).catch(() => {});
      rmSync(file, { force: true });
      return;
    }
    if (failure) {
      unlisten();
      this.phase = { t: "idle" };
      log.error("mic:", failure);
      if (s.dictation.sounds) play("error");
      shell.overlayShow(s.dictation.overlay);
      overlayEmit("error", mode, false, errMsg(failure));
      this.hideLater(1800);
      return;
    }
    // Push-to-talk released before the mic was even open: nothing to record.
    if (cur.released && s.dictation.activation === "push_to_talk") {
      unlisten();
      this.phase = { t: "idle" };
      await native().captureStop(captureId).catch(() => {});
      rmSync(file, { force: true });
      return;
    }
    // In hybrid mode an early release is a quick tap, which latches.
    const latched = cur.released && s.dictation.activation === "hybrid";

    const mute = s.dictation.mute_system_audio ? setOutputMuted(true) : null;
    if (s.dictation.sounds) play("start");
    const style = pickStyle(s, front)?.name ?? null;
    const rec: Rec = {
      mode,
      startedAt: Date.now(),
      latched,
      front,
      captureId,
      file,
      mute,
      session,
      // Safety stop for forgotten latched recordings.
      safety: setTimeout(() => {
        if (this.phase.t === "recording" && this.phase.rec.session === session) void this.finish();
      }, MAX_RECORDING_MS),
      unlisten,
    };
    this.phase = { t: "recording", rec };
    this.setCancel(true);
    shell.overlayShow(s.dictation.overlay);
    overlayEmit("recording", mode, latched, null, mode === "dictate" ? style : null, front.name);
  }

  /** Toggle from the UI (tray / button). */
  toggle(): Promise<void> {
    return this.phase.t === "recording" ? this.finish() : this.start("dictate");
  }

  /** Stop whatever is happening and discard it. */
  cancel(): void {
    const s = settings();
    const p = this.phase;
    switch (p.t) {
      case "idle":
        return;
      case "recording":
        this.phase = { t: "idle" };
        void this.releaseRecording(p.rec, false);
        if (s.dictation.sounds) play("cancel");
        break;
      case "processing":
        this.phase = { t: "idle" };
        p.ctl.abort();
        break;
      case "starting":
        // `start` sees the change and releases the mic itself.
        this.phase = { t: "idle" };
        break;
    }
    this.setCancel(false);
    overlayEmit("idle", "dictate", false);
    shell.overlayHide();
  }

  /** Stop the capture, restore the output volume, and return the recorded samples (empty when discarded). */
  private async releaseRecording(rec: Rec, keep: boolean): Promise<Float32Array> {
    clearTimeout(rec.safety);
    let pcm: Float32Array = new Float32Array(0);
    try {
      await native().captureStop(rec.captureId);
      if (keep) pcm = readF32File(rec.file);
    } catch (e) {
      log.warn("stopping dictation capture:", e);
    } finally {
      rec.unlisten();
      rmSync(rec.file, { force: true });
    }
    if (rec.mute) {
      const prev = await rec.mute;
      if (prev !== null) void setOutputMuted(prev);
    }
    return pcm;
  }

  /** Stop recording and process in the background. */
  async finish(): Promise<void> {
    const p = this.phase;
    if (p.t !== "recording") return;
    const rec = p.rec;
    const ctl = new AbortController();
    const session = rec.session;
    this.phase = { t: "processing", ctl, session };
    const s = settings();
    if (s.dictation.sounds) play("stop");
    const mode = rec.mode;
    const front = rec.front;
    overlayEmit("processing", mode, false, null, null, front.name);

    let result: string | null = null;
    let error: unknown = null;
    try {
      const pcm = await this.releaseRecording(rec, true);
      if (!ctl.signal.aborted) result = await processRecording(pcm, mode, front, s, ctl.signal);
    } catch (e) {
      error = e;
    }
    // If cancelled, `cancel()` already reset the UI and a newer session may own the overlay and
    // controller: touch nothing.
    const cur = this.phase;
    if (cur.t !== "processing" || cur.session !== session || ctl.signal.aborted) return;
    this.phase = { t: "idle" };
    this.setCancel(false);
    if (error) {
      log.error("dictation failed:", error);
      if (s.dictation.sounds) play("error");
      overlayEmit("error", mode, false, Array.from(errMsg(error)).slice(0, 120).join(""));
      this.hideLater(2600);
    } else if (result !== null) {
      overlayEmit("done", mode, false, Array.from(result).slice(0, 80).join(""));
      this.hideLater(450);
    } else {
      overlayEmit("idle", mode, false);
      shell.overlayHide();
    }
  }

  private hideLater(ms: number) {
    setTimeout(() => {
      if (this.phase.t === "idle") shell.overlayHide();
    }, ms).unref?.();
  }

  /** Release the mic on quit. */
  async shutdown(): Promise<void> {
    const p = this.phase;
    this.phase = { t: "idle" };
    if (p.t === "recording") await this.releaseRecording(p.rec, false);
    else if (p.t === "processing") p.ctl.abort();
  }
}

export function pickStyle(s: Settings, front: FrontApp): Style | undefined {
  const name = front.name.toLowerCase();
  const bundle = front.bundle_id.toLowerCase();
  return (
    s.dictation.styles.find((st) =>
      st.apps.some((a) => {
        const l = a.toLowerCase();
        return l !== "" && (l === name || l === bundle);
      }),
    ) ?? s.dictation.styles.find((st) => st.id === s.dictation.default_style)
  );
}

/** Full pipeline. Returns the inserted text, or null if there was nothing to insert. */
export async function processRecording(pcm: Float32Array, mode: Mode, front: FrontApp, s: Settings, signal: AbortSignal): Promise<string | null> {
  const state = st();
  const durationMs = Math.trunc((pcm.length * 1000) / SAMPLE_RATE);
  const trimmed = trimSilence(pcm);
  if (trimmed.length < MIN_SAMPLES) return null;

  const profile = sttFor(s, s.dictation.stt_profile);
  const opts = defaultSttOptions({ language: s.dictation.language, vocabulary: s.vocabulary });
  const transcript = await stt.transcribe(profile, trimmed, opts, () => {}, signal);
  const raw = transcript.text.trim();
  if (raw === "") return null;

  const appName = s.dictation.app_context && front.name !== "" ? front.name : null;
  const llmProfile = llmFor(s, s.dictation.llm_profile);
  let usedLlm: string | null = null;
  let styleName: string | null = null;

  let text: string;
  if (mode === "command") {
    if (!llmProfile) throw new Error("Command mode needs an AI provider (Settings → AI)");
    let selection = "";
    try {
      selection = (await native().selectedText()) ?? "";
    } catch (e) {
      log.warn("reading the selection failed:", e);
    }
    usedLlm = llmProfile.name;
    text = await llm.complete(llmProfile, ai.commandRequest(raw, selection, appName), { signal });
  } else {
    text = ai.rules.spokenCommands(raw);
    if (s.dictation.remove_fillers) text = ai.rules.removeFillers(text);
    const style = pickStyle(s, front);
    styleName = style?.name ?? null;
    if (s.dictation.llm_enabled && style && llmProfile && style.prompt.trim() !== "") {
      const req = ai.dictationRequest(style, text, { appName, vocabulary: s.vocabulary });
      try {
        const out = await llm.complete(llmProfile, req, { signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
        if (out.trim() !== "") {
          usedLlm = llmProfile.name;
          text = out;
        }
      } catch (e) {
        if (signal.aborted) return null;
        log.warn("LLM cleanup failed, inserting raw text:", e);
      }
    }
    text = ai.rules.applyReplacements(text, s.replacements);
  }
  text = text.trim();
  if (text === "" || signal.aborted) return null;

  const toInsert = s.dictation.trailing_space && mode === "dictate" && !text.endsWith("\n") ? `${text} ` : text;
  await insertText(toInsert, s, signal);
  if (signal.aborted) return null;

  let audioPath: string | null = null;
  if (s.dictation.keep_audio) {
    const p = join(audioDir(), `dictation-${nowMs()}.wav`);
    try {
      writeWav(p, pcm, SAMPLE_RATE);
      audioPath = p;
    } catch (e) {
      log.warn("could not keep dictation audio:", e);
    }
  }
  const row: DictationRow = {
    id: crypto.randomUUID(),
    created_at: nowMs(),
    kind: mode === "command" ? "command" : "dictation",
    raw_text: raw,
    text,
    app: front.name !== "" ? front.name : null,
    style: styleName,
    duration_ms: durationMs,
    stt: profile.name,
    llm: usedLlm,
    audio_path: audioPath,
    error: null,
  };
  state.db.insertDictation(row);
  emit("dictation:new", row);
  return text;
}

/**
 * Insert into the focused app. Aborting `signal` stops further typing and the auto-submit key (the helper
 * is told to cancel its own in-flight work).
 */
export async function insertText(text: string, s: Settings, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const onAbort = () => void native().inputCancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let done = true;
    switch (s.dictation.paste_method) {
      case "paste":
        done = (await native().paste(text, s.dictation.restore_clipboard)).done;
        break;
      case "type":
        done = (await native().type(text)).done;
        break;
      case "copy_only":
        shell.copyText(text);
        return;
    }
    if (!done || signal?.aborted) return;
    if (s.dictation.auto_submit === "off") return;
    await Bun.sleep(60);
    // Re-checked right before the key: Escape during the pause must not submit.
    if (signal?.aborted) return;
    await native().enter(s.dictation.auto_submit === "cmd_enter");
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
