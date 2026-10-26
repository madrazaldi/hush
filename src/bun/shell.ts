/**
 * The pieces of the app that need the Electrobun shell rather than plain backend code: file dialogs, the
 * opener, the clipboard, notifications, the dock icon, launch at login, and bringing the main window
 * forward. They are registered as commands (for the webview) and installed as `shell` hooks (for the
 * backend), so everything under src/bun/backend stays importable from tests and scripts.
 */
import { basename, dirname, extname } from "node:path";
import { type BrowserWindow, Updater, Utils } from "electrobun/main";
import { setLaunchAtLogin } from "./backend/autostart";
import { register } from "./backend/commands";
import { emit } from "./backend/events";
import { log } from "./backend/log";
import { asString } from "./backend/platform";
import { shell } from "./backend/state";

interface Filter {
  name: string;
  extensions: string[];
}

interface OpenOptions {
  multiple?: boolean;
  directory?: boolean;
  defaultPath?: string;
  filters?: Filter[];
}

/** The app's main window; set by `installShell`. */
let mainWindow: BrowserWindow | null = null;
export const getMainWindow = () => mainWindow;

/** `defaultPath` may be a file path (a suggested name) or a folder. */
function startingFolder(defaultPath?: string): string | undefined {
  if (!defaultPath) return undefined;
  return /\.[A-Za-z0-9]{1,8}$/.test(basename(defaultPath)) ? dirname(defaultPath) : defaultPath;
}

async function dialogOpen({ options = {} }: { options?: OpenOptions }): Promise<string | string[] | null> {
  const directory = options.directory === true;
  const exts = (options.filters ?? []).flatMap((f) => f.extensions).filter((e) => e && e !== "*");
  const paths = await Utils.openFileDialog({
    startingFolder: startingFolder(options.defaultPath),
    allowedFileTypes: directory || exts.length === 0 ? "*" : exts.join(","),
    canChooseFiles: !directory,
    canChooseDirectory: directory,
    allowsMultipleSelection: options.multiple === true,
  });
  const chosen = paths.filter(Boolean);
  if (chosen.length === 0) return null;
  return options.multiple ? chosen : chosen[0];
}

/**
 * Electrobun has no "save as" panel, so this asks AppleScript's `choose file name` (the standard Save
 * sheet). Returns null if cancelled.
 */
async function dialogSave({ options = {} }: { options?: { defaultPath?: string; title?: string; filters?: Filter[] } }): Promise<string | null> {
  const name = options.defaultPath ? basename(options.defaultPath) : "untitled";
  const folder = options.defaultPath && /\.[A-Za-z0-9]{1,8}$/.test(name) ? dirname(options.defaultPath) : options.defaultPath;
  const script = [
    "tell current application to activate",
    `set f to choose file name with prompt ${asString(options.title ?? "Save")} default name ${asString(name)}${folder && folder.startsWith("/") ? ` default location (POSIX file ${asString(folder)})` : ""}`,
    "POSIX path of f",
  ].join("\n");
  const proc = Bun.spawn(["/usr/bin/osascript", "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) return null; // "User canceled." (-128)
  let path = out.trim();
  if (!path) return null;
  // The panel doesn't append the suggested extension on its own.
  const ext = extname(name);
  if (ext && !extname(path)) path += ext;
  return path;
}

async function dialogAsk({
  message,
  title,
  kind,
  okLabel,
  cancelLabel,
}: {
  message: string;
  title?: string;
  kind?: "info" | "warning" | "error";
  okLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  const { response } = await Utils.showMessageBox({
    type: kind ?? "question",
    title: title ?? "",
    message,
    buttons: [okLabel ?? "OK", cancelLabel ?? "Cancel"],
    defaultId: 0,
    cancelId: 1,
  });
  return response === 0;
}

function must(ok: boolean, what: string) {
  if (!ok) throw new Error(`Could not open ${what}`);
}

export function showMain(route?: string): void {
  const win = mainWindow;
  if (!win) return;
  try {
    win.show();
    win.unminimize();
    win.activate();
  } catch (e) {
    log.warn("showing the main window:", e);
  }
  if (route) emit("navigate", route);
}

/** Wire the backend's shell hooks and the shell-level commands to Electrobun. */
export function installShell(win: BrowserWindow, hooks: { refreshTray: () => void; overlayShow: (pos: "top" | "bottom" | "hidden") => void; overlayHide: () => void }): void {
  mainWindow = win;
  Object.assign(shell, {
    notify: (title: string, body: string) => Utils.showNotification({ title, body }),
    showMain,
    refreshTray: hooks.refreshTray,
    setDockVisible: (show: boolean) => Utils.setDockIconVisible(show),
    overlayShow: hooks.overlayShow,
    overlayHide: hooks.overlayHide,
    copyText: (text: string) => Utils.clipboardWriteText(text),
    setLaunchAtLogin: (enabled: boolean) => {
      try {
        if (!setLaunchAtLogin(enabled) && enabled) log.warn("launch at login needs the installed app; skipped");
      } catch (e) {
        log.warn("launch at login:", e);
      }
    },
    appVersion: () => version,
  });
  void Updater.localInfo
    .version()
    .then((v) => (version = v || version))
    .catch(() => {});

  register({
    dialog_open: (a) => dialogOpen(a),
    dialog_save: (a) => dialogSave(a),
    dialog_ask: (a) => dialogAsk(a),
    opener_open_url: ({ url }: { url: string }) => {
      if (!/^(https?:|mailto:)/i.test(url)) throw new Error("Refusing to open this URL");
      must(Utils.openExternal(url), "the link");
    },
    opener_open_path: ({ path }: { path: string }) => must(Utils.openPath(path), "the path"),
    opener_reveal: ({ path }: { path: string }) => void Utils.showItemInFolder(path),
    clipboard_write_text: ({ text }: { text: string }) => Utils.clipboardWriteText(text),
    clipboard_read_text: () => Utils.clipboardReadText() ?? null,
  });
}

let version = "0.0.0";
