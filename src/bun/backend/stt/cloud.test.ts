import { expect, test } from "bun:test";
import {
  type RawWord,
  defaultBaseUrl,
  defaultModel,
  errorMessage,
  groupRawWords,
  languageName,
  maxChunkSecs,
  normalizeLanguage,
  oaiMode,
  oaiPrompt,
  parseAssembly,
  parseDeepgram,
  parseElevenlabs,
  parseMuse,
  parseOai,
  parseXai,
  rawWord,
  speakerName,
  speakerOf,
  transcribe,
  truncate,
  validKeyterm,
} from "./cloud";
import type { SttKind, SttProfile } from "../../../lib/types";

const rw = (t: string, s: number, e: number, spk?: string): RawWord => rawWord(t, s, e, spk);

test("speaker labels are normalised", () => {
  expect(speakerName("A")).toBe("Speaker 1");
  expect(speakerName("c")).toBe("Speaker 3");
  expect(speakerName("0")).toBe("Speaker 1");
  expect(speakerName("speaker_1")).toBe("Speaker 2");
  expect(speakerName("unknown")).toBeNull();
  expect(speakerName("agent")).toBe("agent");
  expect(speakerOf({ speaker: 2 })).toBe("Speaker 3");
  expect(speakerOf({ speaker: null })).toBeUndefined();
});

test("languages are normalised", () => {
  expect(normalizeLanguage("english")).toBe("en");
  expect(normalizeLanguage("eng")).toBe("en");
  expect(normalizeLanguage("en_us")).toBe("en");
  expect(normalizeLanguage("es-MX")).toBe("es");
  expect(normalizeLanguage("xx")).toBe("xx");
  expect(languageName("fr")).toBe("French");
});

test("groups words on gap and speaker", () => {
  const segs = groupRawWords([
    rw("Hello", 0, 400, "Speaker 1"),
    rw("there.", 450, 900, "Speaker 1"),
    rw("Hi", 950, 1200, "Speaker 2"), // speaker change
    rw("again", 3000, 3400, "Speaker 2"), // gap > 0.8 s
  ]);
  expect(segs.map((s) => s.text)).toEqual(["Hello there.", "Hi", "again"]);
  expect(segs[0].start_ms).toBe(0);
  expect(segs[0].end_ms).toBe(900);
  expect(segs[0].words.length).toBe(2);
  expect(segs[1].speaker).toBe("Speaker 2");
});

test("long segments break only at sentence end", () => {
  // 40 words, 0.3 s each, contiguous; a period after word 35.
  const words = Array.from({ length: 40 }, (_, i) => rw(i === 34 ? "end." : "word", i * 300, i * 300 + 280));
  const segs = groupRawWords(words);
  expect(segs.length).toBe(2);
  expect(segs[0].words.length).toBe(35);
  expect(segs[0].text.endsWith("end.")).toBe(true);
});

test("glued words have no spaces", () => {
  const a = rw("你", 0, 100);
  a.glue = true;
  const b = rw("好", 100, 200);
  b.glue = true;
  expect(groupRawWords([a, b])[0].text).toBe("你好");
});

test("error messages are extracted and truncated", () => {
  expect(errorMessage('{"error":{"message":"bad key","type":"auth"}}')).toBe("bad key");
  expect(errorMessage('{"err_code":"X","err_msg":"nope"}')).toBe("nope");
  expect(errorMessage('{"detail":{"status":"invalid","message":"quota"}}')).toBe("quota");
  expect(errorMessage('{"error":"plain"}')).toBe("plain");
  expect(errorMessage("gateway timeout")).toBe("gateway timeout");
  expect(Array.from(truncate("x".repeat(500), 400)).length).toBe(401);
});

test("selects the openai mode", () => {
  const openai = "https://api.openai.com/v1";
  expect(oaiMode(openai, "whisper-1")).toBe("verbose");
  expect(oaiMode("https://api.groq.com/openai/v1", "whisper-large-v3-turbo")).toBe("verbose");
  expect(oaiMode(openai, "gpt-4o-transcribe-diarize")).toBe("diarized");
  expect(oaiMode(openai, "gpt-4o-transcribe")).toBe("plain");
  expect(oaiMode("https://api.mistral.ai/v1", "voxtral-mini-latest")).toBe("mistral");
  expect(oaiMode("http://localhost:8080/v1", "ggml-large-v3")).toBe("plain");
});

test("builds the prompt with vocabulary", () => {
  expect(oaiPrompt({ prompt: "Meeting about Rust." }, ["Tauri", "Hush"])).toBe("Meeting about Rust. Vocabulary: Tauri, Hush");
  expect(oaiPrompt({ prompt: null }, [])).toBeNull();
});

test("parses openai verbose_json", () => {
  const v = {
    language: "english",
    duration: 5.0,
    text: "Hello world. Bye.",
    segments: [
      { id: 0, start: 0.0, end: 2.0, text: " Hello world." },
      { id: 1, start: 2.5, end: 3.5, text: " Bye." },
    ],
    words: [
      { word: "Hello", start: 0.0, end: 0.5 },
      { word: "world", start: 0.6, end: 1.2 },
      { word: "Bye", start: 2.5, end: 3.0 },
    ],
  };
  const t = parseOai(v, 5000);
  expect(t.language).toBe("en");
  expect(t.segments.length).toBe(2);
  expect(t.segments[0].text).toBe("Hello world.");
  expect(t.segments[0].words.length).toBe(2);
  expect(t.segments[1].words[0].start_ms).toBe(2500);
  expect(t.text).toBe("Hello world. Bye.");
});

test("parses openai diarized and mistral", () => {
  const v = {
    task: "transcribe",
    duration: 4.0,
    text: "A: hi B: yo",
    segments: [
      { id: "s1", start: 0.0, end: 1.0, text: "hi", speaker: "A", type: "transcript.text.segment" },
      { id: "s2", start: 1.2, end: 2.0, text: "yo", speaker: "B", type: "transcript.text.segment" },
    ],
  };
  const t = parseOai(v, 4000);
  expect(t.segments[0].speaker).toBe("Speaker 1");
  expect(t.segments[1].speaker).toBe("Speaker 2");
  const m = { text: "bonjour", language: "fr", segments: [{ start: 0.0, end: 1.0, text: "bonjour", speaker_id: "speaker_0" }] };
  const t2 = parseOai(m, 1000);
  expect(t2.segments[0].speaker).toBe("Speaker 1");
  expect(t2.language).toBe("fr");
});

test("parses openai plain json as a single segment", () => {
  const t = parseOai({ text: " Just text. ", languages: [{ code: "de" }] }, 7000);
  expect(t.text).toBe("Just text.");
  expect(t.language).toBe("de");
  expect([t.segments[0].start_ms, t.segments[0].end_ms]).toEqual([0, 7000]);
  expect(parseOai({ text: "" }, 1000).segments).toEqual([]);
});

test("parses xai words with speakers", () => {
  const v = {
    text: "Hello there. Hi.",
    language: "en",
    duration: 3.0,
    words: [
      { text: "Hello", start: 0.0, end: 0.4, confidence: 0.9, speaker: 0 },
      { text: "there.", start: 0.5, end: 0.9, speaker: 0 },
      { text: "Hi.", start: 1.2, end: 1.5, speaker: 1 },
    ],
  };
  const t = parseXai(v, 3000);
  expect(t.segments.length).toBe(2);
  expect(t.segments[0].text).toBe("Hello there.");
  expect(t.segments[0].speaker).toBe("Speaker 1");
  expect(t.segments[1].speaker).toBe("Speaker 2");
  expect(t.segments[1].start_ms).toBe(1200);
});

test("parses muse turns", () => {
  const v = {
    sessionId: "s",
    transcript: "Hello. Hi there.",
    audioDurationMs: 4000,
    turns: [
      { turnId: 0, startMs: 100, endMs: 1500, transcript: "Hello.", speaker: "A" },
      { turnId: 1, startMs: 1800, endMs: 3900, transcript: "Hi there.", speaker: "B" },
      { turnId: 2, startMs: 3950, endMs: 4000, transcript: "" },
    ],
  };
  const t = parseMuse(v, 4000, "en");
  expect(t.segments.length).toBe(2);
  expect([t.segments[1].start_ms, t.segments[1].end_ms]).toEqual([1800, 3900]);
  expect(t.segments[1].speaker).toBe("Speaker 2");
  expect(t.language).toBe("en");
  // Tolerant: seconds-based names, no turns at all.
  const alt = { segments: [{ start: 1.5, end: 2.5, text: "x", speaker: "unknown" }] };
  const t2 = parseMuse(alt, 3000, null);
  expect([t2.segments[0].start_ms, t2.segments[0].end_ms]).toEqual([1500, 2500]);
  expect(t2.segments[0].speaker).toBeUndefined();
  const t3 = parseMuse({ transcript: "only text", turns: [] }, 2000, null);
  expect([t3.segments[0].start_ms, t3.segments[0].end_ms]).toEqual([0, 2000]);
});

test("parses deepgram utterances", () => {
  const v = {
    results: {
      channels: [{ detected_language: "en", alternatives: [{ transcript: "hello there hi", words: [] }] }],
      utterances: [
        {
          start: 0.1,
          end: 1.0,
          transcript: "Hello there.",
          speaker: 0,
          words: [
            { word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.5, speaker: 0 },
            { word: "there", punctuated_word: "there.", start: 0.5, end: 1.0, speaker: 0 },
          ],
        },
        { start: 1.5, end: 2.0, transcript: "Hi.", speaker: 1, words: [] },
      ],
    },
  };
  const t = parseDeepgram(v, 2000);
  expect(t.language).toBe("en");
  expect(t.segments.length).toBe(2);
  expect(t.segments[0].words[1].text).toBe("there.");
  expect(t.segments[1].speaker).toBe("Speaker 2");
  expect(t.text).toBe("hello there hi");
});

test("parses deepgram words without utterances", () => {
  const v = {
    results: {
      channels: [
        {
          alternatives: [
            {
              transcript: "hello there",
              words: [
                { word: "hello", start: 0.0, end: 0.4, speaker: 0 },
                { word: "there", start: 0.4, end: 0.8, speaker: 0 },
              ],
            },
          ],
        },
      ],
    },
  };
  const t = parseDeepgram(v, 1000);
  expect(t.segments.length).toBe(1);
  expect(t.segments[0].text).toBe("hello there");
  expect(t.language).toBeNull();
  expect(parseDeepgram({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } }, 1000).segments).toEqual([]);
});

test("parses elevenlabs words and spacing", () => {
  const v = {
    language_code: "eng",
    text: "Hello world. Hi",
    words: [
      { text: "Hello", type: "word", start: 0.0, end: 0.4, speaker_id: "speaker_0" },
      { text: " ", type: "spacing", start: 0.4, end: 0.5, speaker_id: "speaker_0" },
      { text: "world.", type: "word", start: 0.5, end: 0.9, speaker_id: "speaker_0" },
      { text: "(laughter)", type: "audio_event", start: 0.9, end: 1.1 },
      { text: " ", type: "spacing", start: 1.1, end: 1.2 },
      { text: "Hi", type: "word", start: 1.3, end: 1.5, speaker_id: "speaker_1" },
    ],
  };
  const t = parseElevenlabs(v, true, 2000);
  expect(t.language).toBe("en");
  expect(t.segments.length).toBe(2);
  expect(t.segments[0].text).toBe("Hello world.");
  expect(t.segments[1].speaker).toBe("Speaker 2");
  // Without diarization, speakers are dropped and words merge across the speaker change.
  const t2 = parseElevenlabs(v, false, 2000);
  expect(t2.segments.length).toBe(1);
  expect(t2.segments[0].speaker).toBeUndefined();
  expect(validKeyterm("Tauri") && !validKeyterm("a<b") && !validKeyterm("one two three four five six")).toBe(true);
});

test("parses assemblyai utterances and words", () => {
  const v = {
    status: "completed",
    text: "Hello. Hi.",
    language_code: "en_us",
    utterances: [
      { start: 250, end: 900, text: "Hello.", speaker: "A", words: [{ text: "Hello.", start: 250, end: 900, speaker: "A" }] },
      { start: 1200, end: 1500, text: "Hi.", speaker: "B", words: [] },
    ],
  };
  const t = parseAssembly(v, 2000);
  expect(t.language).toBe("en");
  expect(t.segments.length).toBe(2);
  expect([t.segments[0].start_ms, t.segments[0].end_ms]).toEqual([250, 900]);
  expect(t.segments[0].words[0].text).toBe("Hello.");
  expect(t.segments[1].speaker).toBe("Speaker 2");

  const w = {
    text: "one two",
    utterances: null,
    words: [
      { text: "one", start: 0, end: 300, speaker: null },
      { text: "two", start: 350, end: 700, speaker: null },
    ],
  };
  const t2 = parseAssembly(w, 1000);
  expect(t2.segments.length).toBe(1);
  expect(t2.segments[0].text).toBe("one two");
  expect(t2.segments[0].speaker).toBeUndefined();
});

test("defaults exist for cloud kinds", () => {
  const kinds: SttKind[] = ["openai_compatible", "xai", "muse", "deepgram", "elevenlabs", "assemblyai"];
  for (const k of kinds) {
    expect(defaultModel(k)).not.toBe("");
    expect(defaultBaseUrl(k).startsWith("https://")).toBe(true);
    expect(maxChunkSecs(k)).toBeLessThanOrEqual(30 * 60);
  }
  expect(maxChunkSecs("muse")).toBeLessThan(600);
});

test("end to end against a local OpenAI-compatible server", async () => {
  const seen = {} as { path: string; auth: string | null; fields: Record<string, string[]>; size: number };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = await req.formData();
      const fields: Record<string, string[]> = {};
      let size = 0;
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") (fields[k] ??= []).push(v);
        else size = (v as Blob).size;
      }
      Object.assign(seen, { path: new URL(req.url).pathname, auth: req.headers.get("authorization"), fields, size });
      return Response.json({ language: "english", text: "Hello.", segments: [{ start: 0, end: 1, text: " Hello." }] });
    },
  });
  try {
    const profile: SttProfile = { id: "x", name: "X", kind: "openai_compatible", model: "whisper-1", base_url: `http://localhost:${server.port}/v1`, api_key: "sk-test" };
    const progress: number[] = [];
    const t = await transcribe(
      profile,
      new Float32Array(16000).fill(0.1),
      { language: "en", vocabulary: ["Hush"], prompt: null, diarize: false, numSpeakers: null, translate: false },
      (p) => progress.push(p),
    );
    expect(t.text).toBe("Hello.");
    expect(t.language).toBe("en");
    expect(progress).toEqual([0, 1]);
    expect(seen.path).toBe("/v1/audio/transcriptions");
    expect(seen.auth).toBe("Bearer sk-test");
    expect(seen.fields.model).toEqual(["whisper-1"]);
    expect(seen.fields["timestamp_granularities[]"]).toEqual(["segment", "word"]);
    expect(seen.fields.language).toEqual(["en"]);
    expect(seen.fields.prompt).toEqual(["Vocabulary: Hush"]);
    expect(seen.size).toBe(44 + 16000 * 2);
    await expect(transcribe({ ...profile, base_url: `http://localhost:${server.port}/v1` }, new Float32Array(10), { language: null, vocabulary: [], prompt: null, diarize: false, numSpeakers: null, translate: true }, () => {})).resolves.toBeDefined();
  } finally {
    server.stop(true);
  }
});
