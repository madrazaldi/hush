import { expect, test } from "bun:test";
import { chatRequest, dictationRequest, rules, transcriptForLlm } from "./ai";

test("fillers", () => {
  expect(rules.removeFillers("um so I think uh the the plan works")).toBe("So I think the plan works");
});

test("fillers keep spoken line breaks", () => {
  const text = rules.removeFillers(rules.spokenCommands("hello um new paragraph uh world new line done"));
  expect(text).toBe("Hello\n\nWorld\nDone");
});

test("replacements", () => {
  const r = [{ from: "my email", to: "me@example.com" }];
  expect(rules.applyReplacements("send it to My Email please", r)).toBe("send it to me@example.com please");
  expect(rules.applyReplacements("myemails", r)).toBe("myemails");
});

test("replacements respect unicode word boundaries", () => {
  const r = [{ from: "cafe", to: "X" }];
  expect(rules.applyReplacements("cafés cafe", r)).toBe("cafés X");
});

test("transcript rendering groups by speaker", () => {
  const t = transcriptForLlm([
    { start_ms: 1000, end_ms: 2000, text: "Hi", speaker: "Me" },
    { start_ms: 2000, end_ms: 3000, text: "there", speaker: "Me" },
    { start_ms: 65_500, end_ms: 66_000, text: "Hello", speaker: "Them" },
  ]);
  expect(t).toBe("[00:01] Me: Hi there\n[01:05] Them: Hello");
});

test("dictation prompt carries style, app and vocabulary", () => {
  const style = { id: "c", name: "Clean", prompt: "Tidy.", apps: [], builtin: true };
  const req = dictationRequest(style, "hi", { appName: "Slack", vocabulary: ["Hush", "Whisper"] });
  expect(req.system).toContain("Style: Clean\nTidy.");
  expect(req.system).toContain('"Slack"');
  expect(req.system).toContain("Hush, Whisper");
  expect(req.messages[0].content).toBe("<dictation>\nhi\n</dictation>");
  expect(req.temperature).toBe(0.2);
});

test("chat request appends the question and notes", () => {
  const req = chatRequest("Standup", [], "my notes", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }], "c?");
  expect(req.messages.map((m) => m.content)).toEqual(["a", "b", "c?"]);
  expect(req.system).toContain('"Standup"');
  expect(req.system).toContain("<notes>\nmy notes\n</notes>");
});
