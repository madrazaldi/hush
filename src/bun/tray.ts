/** Menu-bar tray: quick dictation / meeting controls. */
import { Tray } from "electrobun/main";
import { errMsg, log } from "./backend/log";
import { shell, settings, st } from "./backend/state";
import { showMain } from "./shell";

type MenuItem = Parameters<Tray["setMenu"]>[0][number];

export function buildMenu(): MenuItem[] {
  const recording = st().meetings.activeId() !== null;
  return [
    { type: "normal", label: `Dictate  (${settings().dictation.hotkey})`, action: "dictate" },
    { type: "normal", label: recording ? "Stop meeting recording" : "Start meeting recording", action: "meeting" },
    { type: "divider" },
    { type: "normal", label: "Open Hush", action: "open" },
    { type: "normal", label: "Settings…", action: "settings" },
    { type: "divider" },
    { type: "normal", label: "Quit Hush", action: "quit" },
  ];
}

export interface TrayHandle {
  refresh(): void;
}

export function createTray(image: string, quit: () => void): TrayHandle {
  const tray = new Tray({ title: "", image, template: true, width: 18, height: 18 });
  const refresh = () => {
    try {
      tray.setMenu(buildMenu());
    } catch (e) {
      log.warn("refreshing the tray menu:", e);
    }
  };
  refresh();
  tray.on("tray-clicked", (event) => {
    const action = (event as { data?: { action?: string } }).data?.action;
    const state = st();
    switch (action) {
      case "dictate":
        void state.dictation.toggle();
        break;
      case "meeting":
        void toggleMeeting();
        break;
      case "open":
        showMain();
        break;
      case "settings":
        showMain("/settings");
        break;
      case "quit":
        quit();
        break;
    }
  });
  return { refresh };
}

async function toggleMeeting() {
  const state = st();
  try {
    if (state.meetings.activeId()) {
      const id = await state.meetings.stop();
      showMain(`/meetings/${id}`);
    } else {
      const rec = await state.meetings.start(null, null);
      showMain(`/meetings/${rec.id}`);
    }
  } catch (e) {
    shell.notify("Couldn't start recording", errMsg(e));
  }
}
