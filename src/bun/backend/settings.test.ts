import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initPaths, settingsFile } from "./paths";
import { LOCAL_PROFILE, defaultSettings, loadSettings, migrate, normalize, parseSettings, saveSettings } from "./settings";

const dirs: string[] = [];
function root() {
  const d = mkdtempSync(join(tmpdir(), "hush-settings-"));
  dirs.push(d);
  initPaths(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("legacy auto enhance needs consent", () => {
  const legacy = parseSettings({ meetings: { auto_enhance: true } });
  expect(legacy.meetings.auto_enhance && !legacy.meetings.auto_enhance_confirmed).toBe(true);
  migrate(legacy);
  normalize(legacy);
  expect(legacy.meetings.auto_enhance).toBe(false);

  const chosen = defaultSettings();
  chosen.meetings.auto_enhance = true;
  normalize(chosen);
  expect(chosen.meetings.auto_enhance_confirmed).toBe(true);
});

test("missing and partial files fall back to defaults", () => {
  root();
  const s = loadSettings();
  expect(s.dictation.hotkey).toBe("Fn");
  expect(s.stt_profiles[0].id).toBe(LOCAL_PROFILE);
  writeFileSync(settingsFile(), '{"general": {"theme": "dark"}, "vocabulary": ["Hush"]}');
  const p = loadSettings();
  expect(p.general.theme).toBe("dark");
  expect(p.general.show_in_dock).toBe(true);
  expect(p.vocabulary).toEqual(["Hush"]);
});

test("save is private, pretty and round trips", () => {
  root();
  const s = defaultSettings();
  s.vocabulary = ["a", "b"];
  s.replacements = [{ from: "x", to: "y" }];
  saveSettings(s);
  expect(statSync(settingsFile()).mode & 0o777).toBe(0o600);
  const text = readFileSync(settingsFile(), "utf8");
  expect(text).toContain('\n  "general"');
  expect(loadSettings().replacements).toEqual([{ from: "x", to: "y" }]);
});

test("corrupt settings do not crash and keep a backup", () => {
  root();
  writeFileSync(settingsFile(), "{ not json");
  const s = loadSettings();
  expect(s.dictation.enabled).toBe(true);
});
