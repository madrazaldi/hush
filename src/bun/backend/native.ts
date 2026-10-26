// Client for the hush-native sidecar: newline-delimited JSON-RPC 2.0 over the child's stdio.
//
// The helper is a child of the app's Bun process, so macOS attributes microphone / system-audio /
// accessibility use to the app bundle (the "responsible process"). It exits by itself when our end of
// stdin closes. If it dies mid-session every pending call rejects and the next call starts a fresh one;
// `onRestart` lets owners re-apply state (hotkey bindings).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InputDevice, Permissions } from "../../lib/types";
import { log } from "./log";

export interface RawStt {
  text: string;
  language: string | null;
  segments: { t0_ms: number; t1_ms: number; text: string; speaker_id: number; first_word: number; n_words: number }[];
  words: { t0_ms: number; t1_ms: number; text: string }[];
}

export interface SttInfo {
  arch: string;
  backend: string;
  max_audio_ms: number | null;
  languages: string[];
}

export interface RunOptions {
  language: string | null;
  translate: boolean;
  vocabulary: string[];
  prompt: string | null;
}

export type HotkeyAction = "dictate" | "command" | "paste_last" | "cancel";

export interface NativeEvents {
  "capture.level": { id: string; level: number };
  "capture.chunk": { id: string; seq: number; path: string; samples: number };
  hotkey: { action: HotkeyAction; pressed: boolean };
}

/** Where the helper lives: env override, the packaged app, then the one `bun run build:native` staged. */
export function resolveNativeBin(): string | null {
  const cands: string[] = [];
  if (process.env.HUSH_NATIVE_BIN) cands.push(process.env.HUSH_NATIVE_BIN);
  // Packaged: Contents/Resources/app/bun/index.js next to Contents/Resources/app/native/hush-native.
  cands.push(join(import.meta.dir, "../native/hush-native"), join(import.meta.dir, "../../native/hush-native"));
  // Source tree (dev, tests, scripts): <repo>/native/bin/hush-native.
  for (let d = import.meta.dir, i = 0; i < 6; i++, d = dirname(d)) cands.push(join(d, "native/bin/hush-native"));
  return cands.find((p) => existsSync(p)) ?? null;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> };

export class Native {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(p: any) => void>>();
  private restartHandlers = new Set<() => void>();
  private crashHandlers = new Set<() => void>();
  private stopping = false;
  private starts = 0;

  constructor(private binPath: () => string | null = resolveNativeBin) {}

  on<K extends keyof NativeEvents>(event: K, fn: (p: NativeEvents[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Called after the helper was started again following a crash. */
  onRestart(fn: () => void): () => void {
    this.restartHandlers.add(fn);
    return () => this.restartHandlers.delete(fn);
  }

  /** Called when the helper dies without being asked to stop (captures in flight are lost). */
  onCrash(fn: () => void): () => void {
    this.crashHandlers.add(fn);
    return () => this.crashHandlers.delete(fn);
  }

  get running(): boolean {
    return this.proc !== null;
  }

  private start(): NonNullable<Native["proc"]> {
    if (this.proc) return this.proc;
    const bin = this.binPath();
    if (!bin) throw new Error("The Hush native helper is missing (hush-native). Rebuild the app.");
    this.stopping = false;
    const proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, HUSH_NATIVE_LOG: process.env.HUSH_NATIVE_LOG ?? (process.env.HUSH_DEBUG === "1" ? "debug" : "info") } });
    this.proc = proc;
    const restarted = this.starts++ > 0;
    log.info(`native helper started (pid ${proc.pid})`);
    void this.pump(proc);
    void this.forwardStderr(proc);
    void proc.exited.then((code) => this.onExit(proc, code));
    if (restarted) queueMicrotask(() => this.restartHandlers.forEach((f) => f()));
    return proc;
  }

  private async forwardStderr(proc: NonNullable<Native["proc"]>) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          console.error(`[native] ${buf.slice(0, nl)}`);
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      // process gone
    }
  }

  private async pump(proc: NonNullable<Native["proc"]>) {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim() !== "") this.dispatch(line);
        }
      }
    } catch {
      // process gone
    }
  }

  private dispatch(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn("native: unparseable line", line.slice(0, 200));
      return;
    }
    if (msg.id !== undefined && msg.id !== null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "native error"));
      else p.resolve(msg.result);
    } else if (typeof msg.method === "string") {
      for (const fn of this.handlers.get(msg.method) ?? []) {
        try {
          fn(msg.params);
        } catch (e) {
          log.error("native event handler", msg.method, e);
        }
      }
    }
  }

  private onExit(proc: NonNullable<Native["proc"]>, code: number | null) {
    if (this.proc === proc) this.proc = null;
    if (!this.stopping) log.warn(`native helper exited (code ${code})`);
    const err = new Error(this.stopping ? "native helper stopped" : "The native helper stopped unexpectedly");
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
    if (!this.stopping) for (const f of this.crashHandlers) f();
  }

  call<T = any>(method: string, params: unknown = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    let proc: NonNullable<Native["proc"]>;
    try {
      proc = this.start();
    } catch (e) {
      return Promise.reject(e);
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (opts.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, opts.timeoutMs);
      }
      this.pending.set(id, entry);
      try {
        const sink = proc.stdin as import("bun").FileSink;
        sink.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        void sink.flush();
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Ask the helper to release devices and models, then wait (briefly) for it to exit. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    try {
      await this.call("shutdown", {}, { timeoutMs: 3000 });
    } catch {
      // fall through to the kill
    }
    const exited = await Promise.race([proc.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    if (!exited) proc.kill("SIGKILL");
  }

  // ---- typed wrappers ----

  ping = () => this.call<{ version: string; pid: number }>("ping", {}, { timeoutMs: 5000 });
  permissions = () => this.call<Permissions>("permissions.get", {}, { timeoutMs: 10_000 });
  devices = () => this.call<InputDevice[]>("devices.list", {}, { timeoutMs: 10_000 });
  micUsers = () => this.call<string[]>("audio.mic_users", {}, { timeoutMs: 5000 });
  captureStart = (p: { id: string; source: "mic" | "system"; device?: string | null; path: string; rotate_ms?: number }) =>
    this.call<{ device: string | null; sample_rate: number }>("capture.start", p);
  captureStop = (id: string) => this.call<{ samples: number }>("capture.stop", { id }, { timeoutMs: 30_000 });
  sttInfo = (model: string) => this.call<SttInfo>("stt.info", { model });
  sttPreload = (model: string) => this.call("stt.preload", { model });
  sttEvict = (model: string) => this.call("stt.evict", { model });
  sttCancel = (job: string) => this.call("stt.cancel", { job });
  sttRun = (p: { job: string; model: string; path: string; start?: number; len?: number; options: RunOptions }) => this.call<RawStt>("stt.run", p);
  hotkeysBind = (bindings: { action: HotkeyAction; spec: string }[]) => this.call<string[]>("hotkeys.bind", { bindings }, { timeoutMs: 10_000 });
  hotkeysValidate = (spec: string) => this.call("hotkeys.validate", { spec }, { timeoutMs: 5000 });
  hotkeysSetCancel = (enabled: boolean) => this.call("hotkeys.set_cancel", { enabled }, { timeoutMs: 5000 });
  paste = (text: string, restore: boolean) => this.call<{ done: boolean }>("input.paste", { text, restore }, { timeoutMs: 15_000 });
  type = (text: string) => this.call<{ done: boolean }>("input.type", { text }, { timeoutMs: 120_000 });
  enter = (command: boolean) => this.call("input.enter", { command }, { timeoutMs: 5000 });
  selectedText = () => this.call<string | null>("input.selected_text", {}, { timeoutMs: 5000 });
  inputCancel = () => this.call("input.cancel", {}, { timeoutMs: 2000 });
}

let shared: Native | null = null;
/** Replace the process-wide client (tests use a fake that never touches a device). */
export function setNative(n: Native | null): void {
  shared = n;
}
/** The process-wide helper client. */
export function native(): Native {
  shared ??= new Native();
  return shared;
}
