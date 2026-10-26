import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_RATE, writeF32File } from "./audio/wav";
import { Db } from "./db";
import { Dictation, pickStyle } from "./dictation";
import { onEvent } from "./events";
import { type Native, setNative } from "./native";
import { initPaths } from "./paths";
import { defaultSettings } from "./settings";
import { initState } from "./state";

const dir = mkdtempSync(join(tmpdir(), "hush-dict-"));
let server: ReturnType<typeof Bun.serve>;
let dictation: Dictation;
let events: [string, any][] = [];
let off = () => {};

class FakeNative {
  pasted: string[] = [];
  started: string[] = [];
  stopped: string[] = [];
  entered: boolean[] = [];
  cancelEnabled: boolean[] = [];
  bound: unknown[] = [];
  on() {
    return () => {};
  }
  onRestart() {
    return () => {};
  }
  onCrash() {
    return () => {};
  }
  async captureStart(p: { id: string; path: string }) {
    this.started.push(p.id);
    // A speech-like amplitude-modulated tone, 1.5 s.
    const pcm = Float32Array.from({ length: SAMPLE_RATE * 1.5 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / SAMPLE_RATE)));
    writeF32File(p.path, pcm);
    return { device: "fake", sample_rate: SAMPLE_RATE };
  }
  async captureStop(id: string) {
    this.stopped.push(id);
    return { samples: 0 };
  }
  async paste(text: string) {
    this.pasted.push(text);
    return { done: true };
  }
  async type(text: string) {
    this.pasted.push(text);
    return { done: true };
  }
  async enter(command: boolean) {
    this.entered.push(command);
  }
  async hotkeysSetCancel(on: boolean) {
    this.cancelEnabled.push(on);
  }
  async hotkeysBind(b: unknown[]) {
    this.bound = b;
    return [];
  }
  async inputCancel() {}
  async selectedText() {
    return "the selection";
  }
}
let fake: FakeNative;

beforeAll(() => {
  initPaths(dir);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.formData();
      return Response.json({ language: "english", text: "um hello new line there", segments: [{ start: 0, end: 1.5, text: " um hello new line there" }] });
    },
  });
  const settings = defaultSettings();
  settings.stt_profiles = [{ id: "mock", name: "Mock", kind: "openai_compatible", model: "whisper-1", base_url: `http://localhost:${server.port}/v1`, api_key: "k" }];
  settings.dictation.stt_profile = "mock";
  settings.dictation.sounds = false;
  settings.dictation.llm_enabled = false;
  settings.dictation.mute_system_audio = false;
  settings.dictation.paste_method = "paste";
  settings.dictation.auto_submit = "off";
  settings.dictation.trailing_space = true;
  settings.dictation.remove_fillers = true;
  dictation = new Dictation();
  initState({ settings, db: new Db(join(dir, "t.db")), dictation, meetings: null as any, files: null as any, llmTasks: new Map() });
  off = onEvent((e, p) => events.push([e, p]));
});
beforeEach(() => {
  fake = new FakeNative();
  setNative(fake as unknown as Native);
  events = [];
});
afterAll(() => {
  off();
  setNative(null);
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const phases = () => events.filter(([e]) => e === "dictation:state").map(([, p]) => p.phase);
const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

test("toggle records, transcribes, cleans up and pastes", async () => {
  const { settings } = await import("./state");
  settings().dictation.activation = "toggle";
  await dictation.toggle();
  expect(phases()).toEqual(["recording"]);
  expect(fake.cancelEnabled).toEqual([true]);
  expect(dictation.isBusy()).toBe(true);
  await dictation.toggle();
  await waitFor(() => !dictation.isBusy());
  // Fillers removed, the spoken "new line" became a line break, a trailing space was added.
  expect(fake.pasted).toEqual(["Hello\nThere "]);
  expect(phases()).toEqual(["recording", "processing", "done"]);
  expect(fake.stopped).toEqual(fake.started);
  const row = events.find(([e]) => e === "dictation:new")![1];
  expect(row.raw_text).toBe("um hello new line there");
  expect(row.kind).toBe("dictation");
  expect(fake.cancelEnabled.at(-1)).toBe(false);
});

test("push to talk: release ends the recording; a release before the mic opened records nothing", async () => {
  const { settings } = await import("./state");
  settings().dictation.activation = "push_to_talk";
  dictation.onHotkey("dictate", true);
  await waitFor(() => dictation.isRecording());
  dictation.onHotkey("dictate", false);
  await waitFor(() => !dictation.isBusy() && fake.pasted.length === 1);

  // Pressed and released within the same tick: the release lands while the mic is "opening".
  fake.pasted = [];
  dictation.onHotkey("dictate", true);
  dictation.onHotkey("dictate", false);
  await waitFor(() => !dictation.isBusy());
  expect(fake.pasted).toEqual([]);
  expect(fake.stopped.length).toBe(fake.started.length);
});

test("hybrid: a quick tap latches, the next press stops", async () => {
  const { settings } = await import("./state");
  settings().dictation.activation = "hybrid";
  settings().dictation.hold_ms = 5000;
  dictation.onHotkey("dictate", true);
  await waitFor(() => dictation.isRecording());
  dictation.onHotkey("dictate", false);
  expect(events.filter(([e, p]) => e === "dictation:state" && p.latched).length).toBe(1);
  expect(dictation.isRecording()).toBe(true);
  dictation.onHotkey("dictate", true);
  await waitFor(() => fake.pasted.length === 1);
  await waitFor(() => !dictation.isBusy());
});

test("cancel discards the recording", async () => {
  const { settings } = await import("./state");
  settings().dictation.activation = "toggle";
  await dictation.toggle();
  dictation.onHotkey("cancel", true);
  expect(dictation.isBusy()).toBe(false);
  await waitFor(() => fake.stopped.length === 1);
  await Bun.sleep(50);
  expect(fake.pasted).toEqual([]);
  expect(phases().at(-1)).toBe("idle");
});

test("style is picked by app name or bundle id, falling back to the default", () => {
  const s = defaultSettings();
  s.dictation.styles = [
    { id: "a", name: "Chat", prompt: "p", apps: ["Slack", "com.hnc.Discord"], builtin: false },
    { id: "b", name: "Default", prompt: "p", apps: [], builtin: false },
  ];
  s.dictation.default_style = "b";
  expect(pickStyle(s, { name: "slack", bundle_id: "" })?.id).toBe("a");
  expect(pickStyle(s, { name: "Discord", bundle_id: "com.hnc.discord" })?.id).toBe("a");
  expect(pickStyle(s, { name: "Notes", bundle_id: "com.apple.Notes" })?.id).toBe("b");
});
