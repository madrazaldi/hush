import { expect, test } from "bun:test";
import { isBleed, namedSegments, norm, normalizedLevenshtein } from "./text";

const seg = (text: string, start_ms: number, end_ms: number, speaker?: string) => ({ start_ms, end_ms, text, speaker });

test("normalizes punctuation and case", () => {
  expect(norm("  Hello,   WORLD! It's 5 o'clock.")).toBe("hello world its 5 oclock");
});

test("levenshtein similarity", () => {
  expect(normalizedLevenshtein("kitten", "sitting")).toBeCloseTo(1 - 3 / 7);
  expect(normalizedLevenshtein("", "")).toBe(1);
  expect(normalizedLevenshtein("abc", "")).toBe(0);
});

test("mic text that repeats overlapping system text is bleed", () => {
  const them = [seg("so the quarterly numbers look good", 1000, 4000, "Them")];
  expect(isBleed(seg("so the quarterly numbers look good", 1200, 4100, "Me"), them)).toBe(true);
  expect(isBleed(seg("so the quarterly numbers look gud", 1200, 4100, "Me"), them)).toBe(true);
  // different words, far in time, or too short to judge
  expect(isBleed(seg("I disagree completely about that", 1200, 4100, "Me"), them)).toBe(false);
  expect(isBleed(seg("so the quarterly numbers look good", 20_000, 24_000, "Me"), them)).toBe(false);
  expect(isBleed(seg("ok", 1200, 1500, "Me"), them)).toBe(false);
});

test("named segments swap speaker labels and drop words", () => {
  const out = namedSegments({
    speakers: { Them: "Ann", Me: " " },
    segments: [{ ...seg("hi", 0, 1, "Them"), words: [{ start_ms: 0, end_ms: 1, text: "hi" }] }, seg("yo", 1, 2, "Me")],
  });
  expect(out).toEqual([seg("hi", 0, 1, "Ann"), seg("yo", 1, 2, "Me")]);
});
