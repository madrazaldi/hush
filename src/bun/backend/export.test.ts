import { expect, test } from "bun:test";
import { newRecording } from "./db";
import { exportRecording, mergeSpeakerRuns, shortTs, subtitleCues, ts, wrapLines } from "./export";

test("srt timestamps", () => {
  expect(ts(3_723_456, ",")).toBe("01:02:03,456");
  expect(shortTs(3_723_456)).toBe("1:02:03");
  expect(shortTs(65_000)).toBe("01:05");
});

test("cues split long segments", () => {
  const s = { start_ms: 0, end_ms: 10_000, text: "word ".repeat(60).trim() };
  const cues = subtitleCues([s], 42);
  expect(cues.length).toBeGreaterThan(1);
  expect(cues.every((c) => Array.from(c.text).length <= 84)).toBe(true);
  expect(cues[cues.length - 1].end_ms).toBe(10_000);
});

test("cues use word timings when present", () => {
  const words = Array.from({ length: 40 }, (_, i) => ({ start_ms: i * 100, end_ms: i * 100 + 90, text: "alpha" }));
  const cues = subtitleCues([{ start_ms: 0, end_ms: 4000, text: words.map((w) => w.text).join(" "), words, speaker: "Me" }], 42);
  expect(cues.length).toBeGreaterThan(1);
  expect(cues[0].start_ms).toBe(0);
  expect(cues[0].speaker).toBe("Me");
});

test("wraps near the middle", () => {
  expect(wrapLines("short", 42)).toBe("short");
  expect(wrapLines("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk lll", 20)).toContain("\n");
});

test("merges same-speaker runs", () => {
  const m = mergeSpeakerRuns([
    { start_ms: 0, end_ms: 1000, text: "Hi", speaker: "Me", words: [{ start_ms: 0, end_ms: 1, text: "Hi" }] },
    { start_ms: 1500, end_ms: 2000, text: "there", speaker: "Me" },
    { start_ms: 2100, end_ms: 3000, text: "Hello", speaker: "Them" },
  ]);
  expect(m.map((s) => s.text)).toEqual(["Hi there", "Hello"]);
  expect(m[0].end_ms).toBe(2000);
  expect(m[0].words).toBeUndefined();
});

const rec = newRecording({
  id: "r",
  kind: "meeting",
  title: "Standup",
  status: "ready",
  duration_ms: 65_000,
  speakers: { Them: "Ann" },
  enhanced: "## Notes",
  segments: [
    { start_ms: 0, end_ms: 2000, text: "Hello", speaker: "Me" },
    { start_ms: 3000, end_ms: 5000, text: 'Say "hi"', speaker: "Them" },
  ],
});

test("text, markdown, subtitle, csv and json formats", () => {
  expect(exportRecording(rec, { format: "txt" })).toBe("[00:00] Me: Hello\n\n[00:03] Ann: Say \"hi\"\n");
  expect(exportRecording(rec, { format: "txt", timestamps: false, speakers: false })).toBe('Hello\n\nSay "hi"\n');
  const md = exportRecording(rec, { format: "md" });
  expect(md).toContain("# Standup");
  expect(md).toContain("· 01:05*");
  expect(md).toContain("## Notes\n\n## Transcript");
  expect(md).toContain("`00:03` **Ann:** Say");
  expect(exportRecording(rec, { format: "srt" })).toContain("1\n00:00:00,000 --> 00:00:02,000\nMe: Hello");
  const vtt = exportRecording(rec, { format: "vtt" });
  expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
  expect(vtt).toContain("<v Ann>Say");
  expect(exportRecording(rec, { format: "csv" })).toContain('00:03,00:05,"Ann","Say ""hi"""');
  const json = JSON.parse(exportRecording(rec, { format: "json" }));
  expect(json.title).toBe("Standup");
  expect(json.segments.length).toBe(2);
  expect(() => exportRecording(rec, { format: "pdf" as never })).toThrow("unknown export format");
});
