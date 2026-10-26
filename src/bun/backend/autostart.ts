// Launch at login through a per-user LaunchAgent (no helper app or Login Items API needed).

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_IDENTIFIER } from "./paths";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `/Applications/Hush.app` for a process running from `/Applications/Hush.app/Contents/...`, else null. */
export function bundlePathOf(execPath: string): string | null {
  const i = execPath.indexOf(".app/");
  return i < 0 ? null : execPath.slice(0, i + 4);
}

export function plistFor(bundle: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${APP_IDENTIFIER}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-a</string>
    <string>${esc(bundle)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

export const agentPath = (home = homedir()) => join(home, "Library", "LaunchAgents", `${APP_IDENTIFIER}.plist`);

/** Older (Tauri-era) builds registered the agent under the product name. */
const legacyAgentPath = (home = homedir()) => join(home, "Library", "LaunchAgents", "Hush.plist");

/**
 * Turn launch-at-login on or off. Enabling only works from an installed `.app` (a dev run has nothing to
 * relaunch); returns false in that case.
 */
export function setLaunchAtLogin(enabled: boolean, execPath = process.execPath, home = homedir()): boolean {
  const file = agentPath(home);
  rmSync(legacyAgentPath(home), { force: true });
  if (!enabled) {
    rmSync(file, { force: true });
    return true;
  }
  const bundle = bundlePathOf(execPath);
  if (!bundle) return false;
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(file, plistFor(bundle));
  return true;
}

export const isLaunchAtLoginEnabled = (home = homedir()) => existsSync(agentPath(home));
