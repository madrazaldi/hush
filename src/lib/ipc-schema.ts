// RPC contract between the webview and the Bun main process (Electrobun).
// Type-only: imported by both `src/lib/ipc.ts` (webview) and `src/bun/index.ts` (main).

import type { RPCSchema } from "#electrobun/view";

/** What `invoke` resolves with: the command result, or the error text (Tauri-style string errors). */
export type Reply = { ok: unknown } | { err: string };

export type HushRPC = {
  /** Handled by the Bun main process. */
  bun: RPCSchema<{
    requests: {
      invoke: { params: { cmd: string; args?: unknown }; response: Reply };
    };
    messages: Record<string, never>;
  }>;
  /** Handled by the webview. */
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      /** A backend event (the old Tauri `emit`). */
      event: { event: string; payload: unknown };
    };
  }>;
};

/** Injected into the page by the main process before any script runs (see `preload` in src/bun/index.ts). */
export interface HushGlobals {
  /** `http://127.0.0.1:<port>/<token>`: the media server (file streaming and uploads). */
  mediaBase: string;
  /** Which window this page is: the main app or the dictation overlay. */
  window: "main" | "overlay";
  /** Set by `HUSH_SELFTEST=1`: expose `window.__hushInvoke` for the launch self-test. */
  selftest?: boolean;
}
