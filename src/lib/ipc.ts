// The webview side of the IPC bridge. Replaces `@tauri-apps/api` and the dialog / opener / clipboard
// plugins: call sites keep the same shapes (`invoke`, `listen`, `open`, `save`, `ask`, `openUrl`,
// `writeText`).
//
//   webview  --rpc.request.invoke({cmd,args})-->  Bun main process  --> src/bun/backend (TypeScript)
//   webview  <--rpc message "event"-------------  Bun main process  <-- backend `emit`
//
// In a plain browser (`bun run dev`) there is no Electrobun; the devmock installs `window.__hushMock`
// and every call goes there instead.

import { Electroview } from "#electrobun/view";
import type { HushGlobals, HushRPC } from "./ipc-schema";

export type UnlistenFn = () => void;
type Listener = (e: { payload: unknown }) => void;

/** The browser-preview stand-in (see src/lib/devmock). */
export interface HushMock {
  invoke(cmd: string, args: Record<string, unknown>): Promise<unknown>;
  /** Subscribe to a fake backend event. */
  listen(event: string, cb: (payload: unknown) => void): UnlistenFn;
  /** URL for playing a fixture media path. */
  mediaUrl(path: string): string;
}

declare global {
  interface Window {
    __hush?: HushGlobals;
    __hushMock?: HushMock;
  }
}

const listeners = new Map<string, Set<Listener>>();
let rpc: ReturnType<typeof Electroview.defineRPC<HushRPC>> | null = null;

function bridge() {
  if (rpc) return rpc;
  rpc = Electroview.defineRPC<HushRPC>({
    // Transcription, downloads and LLM calls run for minutes; the default timeout would reject them.
    maxRequestTime: Infinity,
    handlers: {
      requests: {},
      messages: {
        event: ({ event, payload }) => {
          for (const fn of [...(listeners.get(event) ?? [])]) {
            try {
              fn({ payload });
            } catch (e) {
              console.error(`listener for "${event}" threw`, e);
            }
          }
        },
      },
    },
  });
  new Electroview({ rpc });
  return rpc;
}

/** The self-test (HUSH_SELFTEST=1) drives the real backend through this from the DevTools protocol. */
if (typeof window !== "undefined" && window.__hush?.selftest) {
  (window as unknown as Record<string, unknown>).__hushInvoke = (cmd: string, args?: Record<string, unknown>) => invoke(cmd, args);
}

const mock = () => (typeof window === "undefined" ? undefined : window.__hushMock);

/** True when running inside the Electrobun shell. */
export const inShell = () => typeof window !== "undefined" && window.__electrobun !== undefined;

/** Call a backend command. Rejects with the error text, like a Tauri command. */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const m = mock();
  if (m) return (await m.invoke(cmd, args ?? {})) as T;
  const r = await bridge().request.invoke({ cmd, args: args ?? {} });
  if ("err" in r) throw r.err;
  return r.ok as T;
}

/** Subscribe to a backend event. Resolves to an unsubscribe function. */
export async function listen<T = unknown>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  const m = mock();
  if (m) return m.listen(event, (payload) => cb({ payload: payload as T }));
  bridge();
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(cb as Listener);
  return () => set.delete(cb as Listener);
}

// --------------------------------------------------------------------- media

/** URL the page can play a local media file from. */
export function mediaUrl(path: string): string {
  const m = mock();
  if (m) return m.mediaUrl(path);
  const base = window.__hush?.mediaBase ?? "";
  return `${base}/file?path=${encodeURIComponent(path)}`;
}

/**
 * Copy a dropped file into Hush's media folder and return its path. (The embedded browser doesn't expose
 * the real paths of dropped files.)
 */
export async function uploadFile(file: File): Promise<string> {
  const m = mock();
  if (m) return `/tmp/${file.name}`;
  const base = window.__hush?.mediaBase ?? "";
  const res = await fetch(`${base}/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  if (!res.ok) throw new Error(`Could not import ${file.name} (${res.status})`);
  return ((await res.json()) as { path: string }).path;
}

// --------------------------------------------------------------------- dialogs

export interface DialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogOptions {
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  filters?: DialogFilter[];
  title?: string;
}

export interface SaveDialogOptions {
  defaultPath?: string;
  filters?: DialogFilter[];
  title?: string;
}

export function open(options: OpenDialogOptions & { multiple: true }): Promise<string[] | null>;
export function open(options?: OpenDialogOptions): Promise<string | null>;
export function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  return invoke("dialog_open", { options });
}

export function save(options: SaveDialogOptions = {}): Promise<string | null> {
  return invoke("dialog_save", { options });
}

export interface AskOptions {
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}

export function ask(message: string, options: AskOptions = {}): Promise<boolean> {
  return invoke("dialog_ask", { message, ...options });
}

// ---------------------------------------------------------------------- opener / clipboard

export const openUrl = (url: string): Promise<void> => invoke("opener_open_url", { url });
export const writeText = (text: string): Promise<void> => invoke("clipboard_write_text", { text });
