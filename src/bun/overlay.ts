/**
 * The recording indicator: a small, borderless, click-through pill that floats above other windows on the
 * screen holding the mouse cursor. It is a second Electrobun window showing the `/overlay` route, created
 * as a non-activating panel so showing it never steals focus from the app being dictated into (paste
 * would land in the wrong place otherwise).
 */
import { BrowserWindow, Screen } from "electrobun/main";
import type { OverlayPosition } from "../lib/types";
import { log } from "./backend/log";
import { HEIGHT, WIDTH, overlayPosition } from "./overlay-layout";

export interface OverlayHandle {
  win: BrowserWindow;
  /** Deliver a backend event to the overlay page. */
  sendEvent(event: string, payload: unknown): void;
  show(pos: OverlayPosition): void;
  hide(): void;
}

export function createOverlay(opts: { url: string; preload: string; rpc: NonNullable<ConstructorParameters<typeof BrowserWindow>[0]>["rpc"] }): OverlayHandle {
  const win = new BrowserWindow({
    title: "Hush",
    url: opts.url,
    preload: opts.preload,
    frame: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    renderer: "cef",
    titleBarStyle: "hidden",
    transparent: true,
    passthrough: true,
    hidden: true,
    activate: false,
    styleMask: { Borderless: true, Titled: false, Closable: false, Miniaturizable: false, Resizable: false, NonactivatingPanel: true },
    rpc: opts.rpc,
  });
  try {
    win.setAlwaysOnTop(true);
    win.setVisibleOnAllWorkspaces(true);
  } catch (e) {
    log.warn("overlay window level:", e);
  }

  const place = (pos: OverlayPosition) => {
    try {
      const cursor = Screen.getCursorScreenPoint();
      const displays = Screen.getAllDisplays();
      const inside = (b: { x: number; y: number; width: number; height: number }) => cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
      const display = displays.find((d) => inside(d.bounds)) ?? displays.find((d) => d.isPrimary) ?? displays[0];
      if (!display) return;
      const { x, y } = overlayPosition(display.workArea, pos);
      win.setPosition(x, y);
    } catch (e) {
      log.warn("placing the overlay:", e);
    }
  };

  return {
    win,
    sendEvent(event, payload) {
      const rpc = win.webview.rpc as unknown as { send: { event(m: { event: string; payload: unknown }): void } } | undefined;
      rpc?.send.event({ event, payload });
    },
    show(pos) {
      if (pos === "hidden") return;
      place(pos);
      try {
        win.showInactive();
      } catch (e) {
        log.warn("showing the overlay:", e);
      }
    },
    hide() {
      try {
        win.hide();
      } catch (e) {
        log.warn("hiding the overlay:", e);
      }
    },
  };
}
