// Electrobun hook (postBuild for the app bundle, postWrap for its self-extracting wrapper): adds the
// Info.plist keys that have no entitlement mapping in electrobun.config.ts.
//   NSAudioCaptureUsageDescription  - system audio capture (the other side of a meeting)
//   NSAppleEventsUsageDescription   - reading the frontmost app for dictation styles

import { existsSync } from "node:fs";
import { join } from "node:path";

const KEYS: Record<string, string> = {
  NSAudioCaptureUsageDescription: "Hush captures system audio so it can transcribe the other side of your meetings.",
  NSAppleEventsUsageDescription: "Hush reads the frontmost app to adapt dictation style and inserts text where you are typing.",
};

function plistBuddy(plist: string, command: string): { ok: boolean; out: string } {
  const p = Bun.spawnSync(["/usr/libexec/PlistBuddy", "-c", command, plist], { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

export default function postWrap() {
  const dir = process.env.ELECTROBUN_BUILD_DIR;
  const name = process.env.ELECTROBUN_APP_NAME;
  const bundle = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH || (dir && name ? join(dir, `${name}.app`) : "");
  if (!bundle) throw new Error("post-wrap: ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME are not set");
  const plist = join(bundle, "Contents", "Info.plist");
  if (!existsSync(plist)) throw new Error(`post-wrap: ${plist} does not exist`);
  for (const [key, text] of Object.entries(KEYS)) {
    if (plistBuddy(plist, `Print :${key}`).ok) plistBuddy(plist, `Set :${key} ${JSON.stringify(text)}`);
    else if (!plistBuddy(plist, `Add :${key} string ${JSON.stringify(text)}`).ok) throw new Error(`post-wrap: could not add ${key}`);
  }
  console.log(`post-wrap: patched ${plist}`);
}
