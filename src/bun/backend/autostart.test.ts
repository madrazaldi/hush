import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPath, bundlePathOf, isLaunchAtLoginEnabled, setLaunchAtLogin } from "./autostart";

test("finds the app bundle from the executable path", () => {
  expect(bundlePathOf("/Applications/Hush.app/Contents/MacOS/bun")).toBe("/Applications/Hush.app");
  expect(bundlePathOf("/Users/me/.bun/bin/bun")).toBeNull();
});

test("writes and removes the LaunchAgent", () => {
  const home = mkdtempSync(join(tmpdir(), "hush-home-"));
  try {
    expect(setLaunchAtLogin(true, "/Users/me/.bun/bin/bun", home)).toBe(false);
    expect(isLaunchAtLoginEnabled(home)).toBe(false);
    expect(setLaunchAtLogin(true, "/Applications/Hush & Co.app/Contents/MacOS/bun", home)).toBe(true);
    const plist = readFileSync(agentPath(home), "utf8");
    expect(plist).toContain("<string>/Applications/Hush &amp; Co.app</string>");
    expect(plist).toContain("com.hush.app");
    expect(setLaunchAtLogin(false, "", home)).toBe(true);
    expect(existsSync(agentPath(home))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
