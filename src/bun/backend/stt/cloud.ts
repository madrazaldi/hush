// Cloud speech-to-text providers: OpenAI-compatible, xAI, Meta Muse, Deepgram, ElevenLabs and AssemblyAI.
//
// Every provider takes one WAV chunk and returns a Transcript; `transcribe` splits long audio at
// silences, runs the chunks sequentially and stitches the results with corrected timestamps. Response
// parsers are pure functions over parsed JSON so they can be unit-tested without network access.

import type { SttKind, SttProfile } from "../../../lib/types";
import { SAMPLE_RATE, splitAtSilences, wavBytes } from "../audio/wav";
import {
  type Seg,
  type SttOptions,
  type Transcript,
  type Word,
  emptyTranscript,
  extendTranscript,
  offsetTranscript,
  textFromSegments,
} from "./types";

type J = any;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe 16 kHz mono PCM with a cloud provider. Long audio is chunked per provider upload limits;
 * `progress` receives 0..1 after each chunk.
 */
export async function transcribe(
  profile: SttProfile,
  pcm: Float32Array,
  opts: SttOptions,
  progress: (p: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  if (profile.kind === "local") throw new Error("local models are not handled by the cloud transcriber");
  progress(0);
  if (pcm.length === 0) {
    progress(1);
    return emptyTranscript();
  }
  const cx = new Ctx(profile, opts, signal);
  const chunks = splitAtSilences(pcm, maxChunkSecs(profile.kind) * SAMPLE_RATE);
  const total = chunks.length;
  const out = emptyTranscript();
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error("Cancelled");
    const [start, slice] = chunks[i];
    let t: Transcript;
    try {
      t = await cx.transcribeChunk(wavBytes(slice, SAMPLE_RATE), samplesToMs(slice.length));
    } catch (e) {
      if (signal?.aborted) throw new Error("Cancelled");
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(total > 1 ? `${msg} (chunk ${i + 1}/${total})` : msg);
    }
    extendTranscript(out, offsetTranscript(t, samplesToMs(start)));
    progress((i + 1) / total);
  }
  return out;
}

/**
 * Validate credentials: transcribes a short generated tone (an empty transcript counts as success).
 * AssemblyAI is checked with a cheap list call instead.
 */
export async function testProfile(profile: SttProfile): Promise<string> {
  const cx = new Ctx(profile, defaultOpts());
  if (profile.kind === "assemblyai") {
    await cx.send(`${cx.base()}/transcript?limit=1`, { headers: { authorization: profile.api_key } }, "AssemblyAI");
  } else {
    const n = Math.floor((SAMPLE_RATE * 3) / 2);
    const tone = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
    await transcribe(profile, tone, defaultOpts(), () => {});
  }
  return `${providerName(profile.kind)} accepted the request (model ${cx.model()})`;
}

const defaultOpts = (): SttOptions => ({ language: null, vocabulary: [], prompt: null, diarize: false, numSpeakers: null, translate: false });

/** Default model id for a provider (shown as a placeholder in settings). */
export function defaultModel(kind: SttKind): string {
  switch (kind) {
    case "local":
      return "";
    case "openai_compatible":
      return "gpt-4o-transcribe";
    case "xai":
      return "grok-voice-transcribe-2.0";
    case "muse":
      return "muse-voice-transcribe-1.0";
    case "deepgram":
      return "nova-3";
    case "elevenlabs":
      return "scribe_v2";
    case "assemblyai":
      return "universal-3-5-pro";
  }
}

/** Default API base URL for a provider. */
export function defaultBaseUrl(kind: SttKind): string {
  switch (kind) {
    case "local":
      return "";
    case "openai_compatible":
      return "https://api.openai.com/v1";
    case "xai":
      return "https://api.x.ai/v1";
    case "muse":
      return "https://api.meta.ai/v1";
    case "deepgram":
      return "https://api.deepgram.com/v1";
    case "elevenlabs":
      return "https://api.elevenlabs.io/v1";
    case "assemblyai":
      return "https://api.assemblyai.com/v2";
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Maximum chunk length in seconds, chosen to stay under each provider's upload cap. */
export function maxChunkSecs(kind: SttKind): number {
  switch (kind) {
    case "openai_compatible":
      return 10 * 60; // 25 MB cap; 10 min of 16-bit WAV is ~19 MB
    case "muse":
      return 9 * 60 + 30; // 10 min / 32 MB cap
    default:
      return 30 * 60;
  }
}

export function providerName(kind: SttKind): string {
  switch (kind) {
    case "local":
      return "Local";
    case "openai_compatible":
      return "OpenAI-compatible API";
    case "xai":
      return "xAI";
    case "muse":
      return "Meta Muse";
    case "deepgram":
      return "Deepgram";
    case "elevenlabs":
      return "ElevenLabs";
    case "assemblyai":
      return "AssemblyAI";
  }
}

const samplesToMs = (samples: number) => Math.trunc((samples * 1000) / SAMPLE_RATE);

const REQUEST_TIMEOUT_MS = 15 * 60_000;

/** Per-request context shared by the provider implementations. */
class Ctx {
  constructor(
    readonly p: SttProfile,
    readonly o: SttOptions,
    readonly signal?: AbortSignal,
  ) {}

  base(): string {
    const b = this.p.base_url.trim().replace(/\/+$/, "");
    return b === "" ? defaultBaseUrl(this.p.kind) : b;
  }

  model(): string {
    const m = this.p.model.trim();
    return m === "" ? defaultModel(this.p.kind) : m;
  }

  /** Explicit language code, or null for auto-detect. */
  language(): string | null {
    const l = this.o.language?.trim().toLowerCase();
    return l && l !== "auto" ? l : null;
  }

  vocabulary(): string[] {
    return this.o.vocabulary.map((t) => t.trim()).filter((t) => t !== "");
  }

  /** Send a request, returning parsed JSON or throwing an error with status + provider message. */
  async send(url: string, init: RequestInit, what: string): Promise<J> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal });
    } catch (e) {
      if (this.signal?.aborted) throw new Error("Cancelled");
      throw new Error(`${what}: request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let body: string;
    try {
      body = await resp.text();
    } catch (e) {
      throw new Error(`${what}: failed to read response: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) {
      throw new Error(`${what} returned ${resp.status} ${resp.statusText}: ${truncate(errorMessage(body), 400)}`);
    }
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`${what}: unexpected response (${e instanceof Error ? e.message : e}): ${truncate(body, 200)}`);
    }
  }

  transcribeChunk(wav: Buffer, durMs: number): Promise<Transcript> {
    switch (this.p.kind) {
      case "local":
        throw new Error("local models are not handled by the cloud transcriber");
      case "openai_compatible":
        return this.openai(wav, durMs);
      case "xai":
        return this.xai(wav, durMs);
      case "muse":
        return this.muse(wav, durMs);
      case "deepgram":
        return this.deepgram(wav, durMs);
      case "elevenlabs":
        return this.elevenlabs(wav, durMs);
      case "assemblyai":
        return this.assemblyai(wav, durMs);
    }
  }

  // ---- OpenAI-compatible (OpenAI, Groq, Mistral, local servers) ----

  async openai(wav: Buffer, durMs: number): Promise<Transcript> {
    const base = this.base();
    const lb = base.toLowerCase();
    let model = this.p.model.trim();
    if (model === "") model = lb.includes("mistral") ? "voxtral-mini-latest" : lb.includes("groq") ? "whisper-large-v3-turbo" : this.model();
    const mode = oaiMode(base, model);
    const translate = this.o.translate;
    if (translate && mode !== "verbose") throw new Error(`translation to English requires a Whisper model (got "${model}")`);
    const vocab = this.vocabulary();
    const form = new FormData();
    form.append("model", model);
    switch (mode) {
      case "verbose":
        form.append("response_format", "verbose_json");
        form.append("timestamp_granularities[]", "segment");
        form.append("timestamp_granularities[]", "word");
        break;
      case "diarized":
        form.append("response_format", "diarized_json");
        form.append("chunking_strategy", "auto");
        break;
      case "mistral":
        form.append("timestamp_granularities", "segment");
        if (this.o.diarize) form.append("diarize", "true");
        for (const term of vocab.slice(0, 100)) form.append("context_bias", term);
        break;
      case "plain":
        form.append("response_format", "json");
        break;
    }
    // Mistral rejects `language` with timestamps; gpt-transcribe replaced it with `languages`.
    const sendLang = !translate && mode !== "mistral" && !model.startsWith("gpt-transcribe");
    const lang = this.language();
    if (lang && sendLang) form.append("language", lang);
    if (mode === "verbose" || mode === "plain") {
      const p = oaiPrompt(this.o, vocab);
      if (p) form.append("prompt", p);
    }
    form.append("file", wavPart(wav), "audio.wav");
    const path = translate ? "audio/translations" : "audio/transcriptions";
    const headers: Record<string, string> = {};
    if (this.p.api_key.trim() !== "") headers.Authorization = `Bearer ${this.p.api_key.trim()}`;
    const v = await this.send(`${base}/${path}`, { method: "POST", headers, body: form }, providerName(this.p.kind));
    return parseOai(v, durMs);
  }

  // ---- xAI ----

  async xai(wav: Buffer, durMs: number): Promise<Transcript> {
    const form = new FormData();
    // The REST endpoint has no model field today; only forward an explicit override.
    const model = this.p.model.trim();
    if (model !== "" && model !== defaultModel("xai")) form.append("model", model);
    const l = this.language();
    if (l) {
      if (XAI_FORMAT_LANGS.includes(l)) form.append("format", "true");
      form.append("language", l);
    }
    if (this.o.diarize) form.append("diarize", "true");
    for (const term of this.vocabulary().slice(0, 100)) form.append("keyterm", truncate(term, 50));
    // `file` must be the last field.
    form.append("file", wavPart(wav), "audio.wav");
    const v = await this.send(`${this.base()}/stt`, { method: "POST", headers: { Authorization: `Bearer ${this.p.api_key.trim()}` }, body: form }, "xAI");
    return parseXai(v, durMs);
  }

  // ---- Meta Muse Voice Transcribe ----

  async muse(wav: Buffer, durMs: number): Promise<Transcript> {
    const request: J = {
      model: this.model(),
      audioEncoding: "WAV",
      mode: this.o.diarize ? "DIARIZATION" : "ENDPOINTING",
    };
    const vocab = this.vocabulary();
    if (vocab.length > 0) request.keywords = vocab;
    const language = this.language();
    const name = language ? languageName(language) : null;
    if (name) request.languageBias = [name];
    const form = new FormData();
    form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
    form.append("audio", wavPart(wav), "audio.wav");
    const v = await this.send(
      `${this.base()}/asr/transcribe`,
      { method: "POST", headers: { Authorization: `Bearer ${this.p.api_key.trim()}`, Accept: "application/json" }, body: form },
      "Meta Muse",
    );
    return parseMuse(v, durMs, language);
  }

  // ---- Deepgram ----

  async deepgram(wav: Buffer, durMs: number): Promise<Transcript> {
    const model = this.model();
    const q = new URLSearchParams([
      ["model", model],
      ["smart_format", "true"],
      ["punctuate", "true"],
      ["utterances", "true"],
    ]);
    if (this.o.diarize) q.append("diarize", "true");
    const l = this.language();
    if (l) q.append("language", l);
    else q.append("detect_language", "true");
    // `keyterm` is Nova-3 only; older models use the legacy `keywords`.
    const key = model.startsWith("nova-3") ? "keyterm" : "keywords";
    for (const t of this.vocabulary().slice(0, 100)) q.append(key, t);
    const v = await this.send(
      `${this.base()}/listen?${q}`,
      { method: "POST", headers: { Authorization: `Token ${this.p.api_key.trim()}`, "Content-Type": "audio/wav" }, body: wav as BodyInit },
      "Deepgram",
    );
    return parseDeepgram(v, durMs);
  }

  // ---- ElevenLabs ----

  async elevenlabs(wav: Buffer, durMs: number): Promise<Transcript> {
    const form = new FormData();
    form.append("model_id", this.model());
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    form.append("diarize", String(this.o.diarize));
    if (this.o.numSpeakers !== null && this.o.diarize) form.append("num_speakers", String(Math.min(32, Math.max(1, this.o.numSpeakers))));
    const l = this.language();
    if (l) form.append("language_code", l);
    for (const term of this.vocabulary().filter(validKeyterm).slice(0, 1000)) form.append("keyterms", term);
    form.append("file", wavPart(wav), "audio.wav");
    const v = await this.send(`${this.base()}/speech-to-text`, { method: "POST", headers: { "xi-api-key": this.p.api_key.trim() }, body: form }, "ElevenLabs");
    return parseElevenlabs(v, this.o.diarize, durMs);
  }

  // ---- AssemblyAI ----

  async assemblyai(wav: Buffer, durMs: number): Promise<Transcript> {
    const base = this.base();
    const key = this.p.api_key.trim();
    const uploaded = await this.send(
      `${base}/upload`,
      { method: "POST", headers: { authorization: key, "Content-Type": "application/octet-stream" }, body: wav as BodyInit },
      "AssemblyAI upload",
    );
    const audioUrl = jstr(uploaded, "upload_url");
    if (!audioUrl) throw new Error("AssemblyAI upload returned no upload_url");

    // Default (or the default model named explicitly) keeps the documented fallback chain.
    const custom = this.p.model.trim();
    const useDefault = custom === "" || custom === defaultModel("assemblyai");
    const models = useDefault ? [defaultModel("assemblyai"), "universal-2"] : [custom];
    const body: J = { audio_url: audioUrl, speech_models: models };
    const l = this.language();
    if (l) body.language_code = l;
    else body.language_detection = true;
    if (this.o.diarize) {
      body.speaker_labels = true;
      if (this.o.numSpeakers !== null) body.speakers_expected = Math.max(1, this.o.numSpeakers);
    }
    const vocab = this.vocabulary().slice(0, 200);
    const prompt = this.o.prompt?.trim();
    if (vocab.length > 0) body.keyterms_prompt = vocab;
    else if (prompt && useDefault) body.prompt = prompt; // Universal-3.5 Pro only

    const created = await this.send(
      `${base}/transcript`,
      { method: "POST", headers: { authorization: key, "Content-Type": "application/json" }, body: JSON.stringify(body) },
      "AssemblyAI",
    );
    const id = jstr(created, "id");
    if (!id) throw new Error("AssemblyAI returned no transcript id");
    const started = Date.now();
    for (;;) {
      await sleep(ASSEMBLY_POLL_MS, this.signal);
      const v = await this.send(`${base}/transcript/${id}`, { headers: { authorization: key } }, "AssemblyAI");
      const status = jstr(v, "status");
      if (status === "completed") return parseAssembly(v, durMs);
      if (status === "error") {
        const msg = jstr(v, "error") ?? "unknown error";
        // A silent chunk is not a failure.
        if (msg.includes("no spoken audio")) return emptyTranscript();
        throw new Error(`AssemblyAI transcription failed: ${truncate(msg, 400)}`);
      }
      if (Date.now() - started > ASSEMBLY_TIMEOUT_MS) throw new Error("AssemblyAI transcription timed out after 30 minutes");
    }
  }
}

const ASSEMBLY_POLL_MS = 2000;
const ASSEMBLY_TIMEOUT_MS = 30 * 60_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Cancelled"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("Cancelled"));
      },
      { once: true },
    );
  });
}

const wavPart = (wav: Uint8Array) => new Blob([wav as BlobPart], { type: "audio/wav" });

/** Extract a human-readable message from the various provider error shapes. */
export function errorMessage(body: string): string {
  const find = (v: J): string | null => {
    if (typeof v === "string") return v.trim() !== "" ? v.trim() : null;
    if (Array.isArray(v)) {
      for (const x of v) {
        const r = find(x);
        if (r) return r;
      }
      return null;
    }
    if (v && typeof v === "object") {
      for (const k of ["message", "err_msg", "error", "detail", "msg"]) {
        if (k in v) {
          const r = find(v[k]);
          if (r) return r;
        }
      }
    }
    return null;
  };
  try {
    return find(JSON.parse(body)) ?? body.trim();
  } catch {
    return body.trim();
  }
}

export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max).join("")}…`;
}

/** Keep the last `max` characters (Whisper only looks at the tail of a prompt). */
function tailChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.slice(Math.max(0, chars.length - max)).join("");
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

const jstr = (v: J, key: string): string | null => (typeof v?.[key] === "string" ? v[key] : null);
const jf = (v: J, key: string): number | null => (typeof v?.[key] === "number" ? v[key] : null);
const arr = (v: J, key: string): J[] => (Array.isArray(v?.[key]) ? v[key] : []);
const secsMs = (secs: number) => Math.round(secs * 1000);
/** Seconds-based `start`/`end` pair of a JSON object, in ms. */
const spanSecs = (v: J): [number, number] => [secsMs(jf(v, "start") ?? 0), secsMs(jf(v, "end") ?? 0)];
/** Millisecond-based `start`/`end` pair of a JSON object. */
const spanMs = (v: J): [number, number] => [Math.round(jf(v, "start") ?? 0), Math.round(jf(v, "end") ?? 0)];

/** Raw speaker label from `speaker` / `speaker_id` / `speaker_label`, normalised. */
export function speakerOf(v: J): string | undefined {
  for (const k of ["speaker", "speaker_id", "speaker_label"]) {
    const x = v?.[k];
    if (typeof x === "string") return speakerName(x) ?? undefined;
    if (typeof x === "number") return speakerName(String(x)) ?? undefined;
  }
  return undefined;
}

/**
 * Map provider speaker labels to "Speaker N": letters (`A` -> 1) and trailing 0-based indices
 * (`0`, `speaker_0` -> 1). Other labels are kept verbatim.
 */
export function speakerName(raw: string): string | null {
  const r = raw.trim();
  const lr = r.toLowerCase();
  if (r === "" || lr === "unknown" || lr === "null") return null;
  if (/^[A-Za-z]$/.test(r)) return `Speaker ${r.toUpperCase().charCodeAt(0) - 64}`;
  const digits = /\d+$/.exec(r)?.[0];
  if (digits !== undefined) return `Speaker ${Number(digits) + 1}`;
  return r;
}

/** (ISO 639-1, ISO 639-3, English name) for the languages we normalise. */
const LANGS: [string, string, string][] = [
  ["en", "eng", "English"],
  ["es", "spa", "Spanish"],
  ["fr", "fra", "French"],
  ["de", "deu", "German"],
  ["it", "ita", "Italian"],
  ["pt", "por", "Portuguese"],
  ["nl", "nld", "Dutch"],
  ["ru", "rus", "Russian"],
  ["zh", "zho", "Chinese"],
  ["ja", "jpn", "Japanese"],
  ["ko", "kor", "Korean"],
  ["ar", "ara", "Arabic"],
  ["hi", "hin", "Hindi"],
  ["tr", "tur", "Turkish"],
  ["pl", "pol", "Polish"],
  ["uk", "ukr", "Ukrainian"],
  ["sv", "swe", "Swedish"],
  ["vi", "vie", "Vietnamese"],
  ["id", "ind", "Indonesian"],
];

/** Normalise "english", "eng", "en_us", "es-MX" ... to a bare ISO 639-1 code when known. */
export function normalizeLanguage(raw: string): string {
  const base = raw.trim().toLowerCase().split(/[_-]/)[0] ?? "";
  const hit = LANGS.find(([a, b, n]) => base === a || base === b || base === n.toLowerCase());
  return hit ? hit[0] : base;
}

export function languageName(code: string): string | null {
  const c = normalizeLanguage(code);
  return LANGS.find((t) => t[0] === c)?.[2] ?? null;
}

// ---------------------------------------------------------------------------
// Transcript assembly
// ---------------------------------------------------------------------------

/** A word as reported by a provider, before grouping into segments. */
export interface RawWord {
  text: string;
  start_ms: number;
  end_ms: number;
  speaker?: string;
  /** Attach to the previous word without a space (CJK-style tokens). */
  glue: boolean;
}

export const rawWord = (text: string, start_ms: number, end_ms: number, speaker?: string): RawWord => ({
  text: text.trim(),
  start_ms,
  end_ms,
  speaker,
  glue: false,
});

const GAP_MS = 800;
const SOFT_MS = 12_000;
const SOFT_WORDS = 30;
const HARD_MS = 30_000;
const HARD_WORDS = 80;

const endsSentence = (text: string) => /[.!?。！？…]$/.test(text.replace(/["')”’]+$/, ""));

/**
 * Group words into segments: break on speaker change, on a gap > 0.8 s, on a sentence end once the
 * segment passes ~12 s / ~30 words, or at a hard cap.
 */
export function groupRawWords(words: RawWord[]): Seg[] {
  const out: Seg[] = [];
  let cur: Seg | null = null;
  for (const w of words) {
    if (w.text === "") continue;
    if (cur) {
      const dur = cur.end_ms - cur.start_ms;
      const n = cur.words.length;
      const soft = (dur >= SOFT_MS || n >= SOFT_WORDS) && endsSentence(cur.text);
      const hard = dur >= HARD_MS || n >= HARD_WORDS;
      if (cur.speaker !== w.speaker || w.start_ms - cur.end_ms > GAP_MS || soft || hard) {
        out.push(cur);
        cur = null;
      }
    }
    if (!cur) {
      cur = { start_ms: w.start_ms, end_ms: w.end_ms, text: "", words: [] };
      if (w.speaker) cur.speaker = w.speaker;
    }
    if (cur.text !== "" && !w.glue) cur.text += " ";
    cur.text += w.text;
    cur.end_ms = Math.max(cur.end_ms, w.end_ms);
    cur.words.push({ start_ms: w.start_ms, end_ms: w.end_ms, text: w.text });
  }
  if (cur) out.push(cur);
  return out;
}

/** Distribute time-ordered words over existing segments by start time. */
function attachWords(segs: Seg[], words: RawWord[]): void {
  let i = 0;
  for (const w of words) {
    if (w.text === "") continue;
    while (i + 1 < segs.length && w.start_ms >= segs[i].end_ms) i++;
    segs[i].words.push({ start_ms: w.start_ms, end_ms: w.end_ms, text: w.text });
  }
}

/** One segment spanning the whole chunk (providers that return only text). */
function single(text: string, durMs: number): Seg[] {
  const t = text.trim();
  return t === "" ? [] : [{ start_ms: 0, end_ms: durMs, text: t, words: [] }];
}

/** Build a transcript, preferring the provider's full text over joined segments. */
function finish(text: string | null, language: string | null | undefined, segments: Seg[]): Transcript {
  const t: Transcript = { text: "", language: language ? language : null, segments };
  const s = text?.trim();
  t.text = s ? s : textFromSegments(t);
  return t;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible parsing
// ---------------------------------------------------------------------------

export type OaiMode = "verbose" | "diarized" | "mistral" | "plain";

export function oaiMode(base: string, model: string): OaiMode {
  const b = base.toLowerCase();
  const m = model.toLowerCase();
  if (b.includes("mistral")) return "mistral";
  if (m.includes("diarize")) return "diarized";
  if (m.includes("whisper") || b.includes("groq")) return "verbose";
  return "plain";
}

/** `prompt` field: user prompt plus vocabulary, capped to Whisper's ~224 tokens. */
export function oaiPrompt(o: Pick<SttOptions, "prompt">, vocab: string[]): string | null {
  const parts: string[] = [];
  const p = o.prompt?.trim();
  if (p) parts.push(p);
  if (vocab.length > 0) parts.push(`Vocabulary: ${vocab.join(", ")}`);
  return parts.length > 0 ? tailChars(parts.join(" "), 800) : null;
}

/** Parse `verbose_json`, `diarized_json`, Mistral and plain `json` responses. */
export function parseOai(v: J, durMs: number): Transcript {
  let segments: Seg[] = [];
  for (const s of arr(v, "segments")) {
    const text = jstr(s, "text")?.trim();
    if (!text) continue;
    const [start_ms, end_ms] = spanSecs(s);
    const seg: Seg = { start_ms, end_ms, text, words: [] };
    const spk = speakerOf(s);
    if (spk) seg.speaker = spk;
    segments.push(seg);
  }
  const words: RawWord[] = [];
  for (const w of arr(v, "words")) {
    const t = jstr(w, "word") ?? jstr(w, "text");
    if (t === null) continue;
    const [s, e] = spanSecs(w);
    words.push(rawWord(t, s, e));
  }
  const text = jstr(v, "text");
  if (segments.length === 0) segments = words.length === 0 ? single(text ?? "", durMs) : groupRawWords(words);
  else attachWords(segments, words);
  const lang = jstr(v, "language") ?? jstr(arr(v, "languages")[0], "code");
  return finish(text, lang === null ? null : normalizeLanguage(lang), segments);
}

// ---------------------------------------------------------------------------
// xAI
// ---------------------------------------------------------------------------

/** Languages for which xAI can apply inverse text normalisation (`format=true`). */
const XAI_FORMAT_LANGS = ["ar", "de", "en", "es", "fr", "ja", "pt", "ru", "sv", "vi", "zh"];

export function parseXai(v: J, durMs: number): Transcript {
  const words: RawWord[] = [];
  for (const w of arr(v, "words")) {
    const t = jstr(w, "text");
    if (t === null) continue;
    const [s, e] = spanSecs(w);
    words.push(rawWord(t, s, e, speakerOf(w)));
  }
  const text = jstr(v, "text");
  const segments = words.length === 0 ? single(text ?? "", durMs) : groupRawWords(words);
  const lang = jstr(v, "language");
  return finish(text, lang === null ? null : normalizeLanguage(lang), segments);
}

// ---------------------------------------------------------------------------
// Meta Muse
// ---------------------------------------------------------------------------

/**
 * Parse a Muse `TranscribeResponse` (`transcript`, `audioDurationMs`, `turns[]` with
 * `startMs`/`endMs`/`transcript`/`speaker`), tolerating alternate field names.
 */
export function parseMuse(v: J, durMs: number, language: string | null): Transcript {
  const timeMs = (t: J, msKeys: string[], secKeys: string[]): number => {
    for (const k of msKeys) {
      const x = jf(t, k);
      if (x !== null) return Math.round(x);
    }
    for (const k of secKeys) {
      const x = jf(t, k);
      if (x !== null) return secsMs(x);
    }
    return 0;
  };
  const turns = ["turns", "segments", "results"].map((k) => arr(v, k)).find((a) => a.length > 0) ?? [];
  let segments: Seg[] = [];
  for (const t of turns) {
    const text = (jstr(t, "transcript") ?? jstr(t, "text"))?.trim();
    if (!text) continue;
    const seg: Seg = {
      start_ms: timeMs(t, ["startMs", "start_ms"], ["start", "startTime", "start_time"]),
      end_ms: timeMs(t, ["endMs", "end_ms"], ["end", "endTime", "end_time"]),
      text,
      words: [],
    };
    const spk = speakerOf(t);
    if (spk) seg.speaker = spk;
    segments.push(seg);
  }
  const text = jstr(v, "transcript") ?? jstr(v, "text");
  if (segments.length === 0) {
    const d = jf(v, "audioDurationMs");
    segments = single(text ?? "", d === null ? durMs : Math.round(d));
  }
  return finish(text, language, segments);
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

export function parseDeepgram(v: J, durMs: number): Transcript {
  const alt = v?.results?.channels?.[0]?.alternatives?.[0];
  const detected = v?.results?.channels?.[0]?.detected_language;
  const language = typeof detected === "string" ? normalizeLanguage(detected) : null;
  const utterances: J[] = Array.isArray(v?.results?.utterances) ? v.results.utterances : [];
  let segments: Seg[] = [];
  for (const u of utterances) {
    const text = jstr(u, "transcript")?.trim();
    if (text === undefined) continue;
    const [start_ms, end_ms] = spanSecs(u);
    const words: Word[] = [];
    for (const w of arr(u, "words")) {
      const t = jstr(w, "punctuated_word") ?? jstr(w, "word");
      if (t === null) continue;
      const [s, e] = spanSecs(w);
      words.push({ start_ms: s, end_ms: e, text: t });
    }
    if (text === "") continue;
    const seg: Seg = { start_ms, end_ms, text, words };
    const spk = speakerOf(u);
    if (spk) seg.speaker = spk;
    segments.push(seg);
  }
  const text = alt ? jstr(alt, "transcript") : null;
  if (segments.length === 0) {
    const words: RawWord[] = [];
    for (const w of alt ? arr(alt, "words") : []) {
      const t = jstr(w, "punctuated_word") ?? jstr(w, "word");
      if (t === null) continue;
      const [s, e] = spanSecs(w);
      words.push(rawWord(t, s, e, speakerOf(w)));
    }
    segments = words.length === 0 ? single(text ?? "", durMs) : groupRawWords(words);
  }
  return finish(text, language, segments);
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

/** ElevenLabs keyterms: < 50 chars, <= 5 words, none of `<>{}[]\``. */
export function validKeyterm(t: string): boolean {
  return Array.from(t).length < 50 && t.split(/\s+/).filter(Boolean).length <= 5 && !/[<>{}[\]`]/.test(t);
}

/** Parse a Scribe response: `words[]` of type word/spacing/audio_event (seconds). */
export function parseElevenlabs(v: J, diarize: boolean, durMs: number): Transcript {
  const items = arr(v, "words");
  // Without spacing tokens (e.g. CJK) words are glued; if none exist at all, fall back to spaces.
  const hasSpacing = items.some((w) => jstr(w, "type") === "spacing");
  const words: RawWord[] = [];
  let spaceBefore = true;
  for (const w of items) {
    const ty = jstr(w, "type") ?? "word";
    if (ty === "spacing") spaceBefore = true;
    else if (ty === "word") {
      const text = jstr(w, "text");
      if (text === null) continue;
      const [s, e] = spanSecs(w);
      const rw = rawWord(text, s, e, diarize ? speakerOf(w) : undefined);
      rw.glue = hasSpacing && !spaceBefore;
      words.push(rw);
      spaceBefore = false;
    }
  }
  const text = jstr(v, "text");
  const segments = words.length === 0 ? single(text ?? "", durMs) : groupRawWords(words);
  const lang = jstr(v, "language_code");
  return finish(text, lang === null ? null : normalizeLanguage(lang), segments);
}

// ---------------------------------------------------------------------------
// AssemblyAI
// ---------------------------------------------------------------------------

/** Parse an AssemblyAI transcript (millisecond timestamps, speaker letters). */
export function parseAssembly(v: J, durMs: number): Transcript {
  let segments: Seg[] = [];
  for (const u of arr(v, "utterances")) {
    const text = jstr(u, "text")?.trim();
    if (!text) continue;
    const [start_ms, end_ms] = spanMs(u);
    const words: Word[] = [];
    for (const w of arr(u, "words")) {
      const t = jstr(w, "text");
      if (t === null) continue;
      const [s, e] = spanMs(w);
      words.push({ start_ms: s, end_ms: e, text: t.trim() });
    }
    const seg: Seg = { start_ms, end_ms, text, words };
    const spk = speakerOf(u);
    if (spk) seg.speaker = spk;
    segments.push(seg);
  }
  const text = jstr(v, "text");
  if (segments.length === 0) {
    const words: RawWord[] = [];
    for (const w of arr(v, "words")) {
      const t = jstr(w, "text");
      if (t === null) continue;
      const [s, e] = spanMs(w);
      words.push(rawWord(t, s, e, speakerOf(w)));
    }
    segments = words.length === 0 ? single(text ?? "", durMs) : groupRawWords(words);
  }
  const lang = jstr(v, "language_code");
  return finish(text, lang === null ? null : normalizeLanguage(lang), segments);
}
