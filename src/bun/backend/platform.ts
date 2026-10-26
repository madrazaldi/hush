// OS integration that needs no native code: frontmost app, feedback sounds, output mute, System
// Settings panes and Finder reveal. Text insertion, hotkeys and permissions live in the native helper.

import { childEnv } from "./shell-env";

export interface FrontApp {
  name: string;
  bundle_id: string;
}

const run = (cmd: string[], timeoutMs = 3000) =>
  Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(timeoutMs) });

/** Parse `lsappinfo info -only bundleid <asn>` output (name is the quoted first token of the first line). */
export function parseLsappinfo(out: string): FrontApp {
  const name = /^"([^"]*)"/m.exec(out)?.[1] ?? /"LSDisplayName"="([^"]*)"/.exec(out)?.[1] ?? "";
  const bundle_id = /bundleID="([^"]*)"/.exec(out)?.[1] ?? /"CFBundleIdentifier"="([^"]*)"/.exec(out)?.[1] ?? "";
  return { name, bundle_id };
}

/** The frontmost application (name + bundle id). Empty when it can't be determined. */
export async function frontApp(): Promise<FrontApp> {
  try {
    const front = run(["/usr/bin/lsappinfo", "front"]);
    const asn = (await new Response(front.stdout).text()).trim();
    if (!asn) return { name: "", bundle_id: "" };
    const info = run(["/usr/bin/lsappinfo", "info", "-only", "name", "-only", "bundleid", asn]);
    return parseLsappinfo(await new Response(info.stdout).text());
  } catch {
    return { name: "", bundle_id: "" };
  }
}

export type Sound = "start" | "stop" | "cancel" | "error";

const SOUND_FILES: Record<Sound, string> = {
  start: "Tink",
  stop: "Pop",
  cancel: "Bottle",
  error: "Basso",
};

/** Play a short system sound without waiting for it. */
export function play(sound: Sound): void {
  try {
    Bun.spawn(["/usr/bin/afplay", "-v", "0.35", `/System/Library/Sounds/${SOUND_FILES[sound]}.aiff`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
  } catch {
    // no sound is not an error
  }
}

async function osascript(script: string): Promise<string | null> {
  try {
    const p = run(["/usr/bin/osascript", "-e", script], 5000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  } catch {
    return null;
  }
}

/** Mute/unmute system output. Returns the previous muted state (null when unknown). */
export async function setOutputMuted(muted: boolean): Promise<boolean | null> {
  const prev = await osascript("output muted of (get volume settings)");
  await osascript(`set volume output muted ${muted}`);
  return prev === null ? null : prev === "true";
}

const PRIVACY_ANCHORS: Record<string, string> = {
  accessibility: "Privacy_Accessibility",
  microphone: "Privacy_Microphone",
  system_audio: "Privacy_AudioCapture",
  input_monitoring: "Privacy_ListenEvent",
};

/** Open a System Settings privacy pane. */
export function openPrivacyPane(pane: string): void {
  const anchor = PRIVACY_ANCHORS[pane] ?? "Privacy";
  Bun.spawn(["/usr/bin/open", `x-apple.systempreferences:com.apple.preference.security?${anchor}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}

/** Reveal a file in Finder. */
export function revealPath(path: string): void {
  Bun.spawn(["/usr/bin/open", "-R", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: childEnv() }).unref();
}

/** Names of meeting apps by bundle id prefix (apps that commonly hold the mic during calls). */
const MEETING_APPS: [string, string][] = [
  ["us.zoom.xos", "Zoom"],
  ["com.microsoft.teams2", "Microsoft Teams"],
  ["com.microsoft.teams", "Microsoft Teams"],
  ["com.apple.FaceTime", "FaceTime"],
  ["com.tinyspeck.slackmacgap", "Slack"],
  ["com.hnc.Discord", "Discord"],
  ["com.cisco.webexmeetingsapp", "Webex"],
  ["com.webex.meetingmanager", "Webex"],
  ["com.google.Chrome", "Google Chrome"],
  ["com.apple.Safari", "Safari"],
  ["company.thebrowser.Browser", "Arc"],
  ["com.brave.Browser", "Brave"],
  ["com.microsoft.edgemac", "Microsoft Edge"],
  ["org.mozilla.firefox", "Firefox"],
  ["net.whatsapp.WhatsApp", "WhatsApp"],
];

/** Display names of the known meeting apps among the bundle ids currently capturing the mic. */
export function meetingAppsFor(bundleIds: string[]): string[] {
  const out: string[] = [];
  for (const b of bundleIds) {
    const hit = MEETING_APPS.find(([prefix]) => b.startsWith(prefix));
    if (hit && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out;
}
