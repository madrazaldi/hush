// Decode media files to 16 kHz mono f32. macOS's own afconvert handles the common audio formats
// (and the audio track of mp4/mov) in-process-free and fast; `ffmpeg` (if installed) covers video and
// anything afconvert can't read. `yt-dlp` handles URL imports.

import { createWriteStream, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { log } from "../log";
import { childEnv, which } from "../shell-env";
import { SAMPLE_RATE, afconvert, parseWav } from "./wav";

const AFCONVERT_EXTS = ["wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "caf", "mp4", "m4v", "mov", "3gp", "amr"];

export const MEDIA_EXTS = [
  "wav", "mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "aiff", "aif", "caf", "wma", "amr", "webm", "mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp",
];

export const VIDEO_EXTS = ["mp4", "m4v", "mov", "mkv", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "webm"];

const ext = (p: string) => extname(p).slice(1).toLowerCase();

export const isVideo = (p: string) => VIDEO_EXTS.includes(ext(p));
export const ffmpegAvailable = () => which("ffmpeg") !== null;

/**
 * Longest media we decode. The whole file is held as 16 kHz f32 mono (~230 MB per hour), so anything
 * longer is refused rather than risking memory.
 */
export const MAX_DURATION_SECS = 4 * 3600;
const MAX_SAMPLES = MAX_DURATION_SECS * SAMPLE_RATE;
/** Largest file a direct link may download. */
const MAX_DOWNLOAD_BYTES = 4 * 2 ** 30;

export const TOO_LONG = `This file is longer than ${MAX_DURATION_SECS / 3600} hours, which Hush can't transcribe yet`;

class TooLong extends Error {
  constructor() {
    super(TOO_LONG);
  }
}

const checkCancel = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("Cancelled");
};

/** Decode any supported media file to 16 kHz mono samples. `signal` stops the work (and ffmpeg) promptly. */
export async function decodeFile(path: string, signal?: AbortSignal): Promise<Float32Array> {
  checkCancel(signal);
  if (AFCONVERT_EXTS.includes(ext(path))) {
    try {
      const pcm = await decodeAfconvert(path, signal);
      if (pcm.length > 0) return pcm;
      log.warn("afconvert produced no audio for", path);
    } catch (e) {
      checkCancel(signal);
      if (e instanceof TooLong) throw e;
      log.warn("afconvert failed for", path, e);
    }
  }
  return decodeFfmpeg(path, signal);
}

/** Downmix interleaved frames to mono by averaging (afconvert's own `-c 1` just drops channels). */
export function toMono(interleaved: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return interleaved;
  const n = Math.floor(interleaved.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c];
    out[i] = sum / channels;
  }
  return out;
}

async function decodeAfconvert(path: string, signal?: AbortSignal): Promise<Float32Array> {
  const out = join(tmpdir(), `hush-dec-${crypto.randomUUID()}.wav`);
  try {
    const proc = Bun.spawn(
      ["/usr/bin/afconvert", path, "-o", out, "-f", "WAVE", "-d", `LEF32@${SAMPLE_RATE}`],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe", signal },
    );
    const err = new Response(proc.stderr).text();
    const code = await proc.exited;
    checkCancel(signal);
    if (code !== 0) throw new Error(`afconvert failed: ${(await err).trim()}`);
    if (statSync(out).size > MAX_SAMPLES * 4 + 4096) throw new TooLong();
    const w = parseWav(await Bun.file(out).bytes());
    return toMono(w.samples, w.channels);
  } finally {
    rmSync(out, { force: true });
  }
}

async function decodeFfmpeg(path: string, signal?: AbortSignal): Promise<Float32Array> {
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) throw new Error("This format needs ffmpeg. Install it with `brew install ffmpeg`.");
  const proc = Bun.spawn(
    [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "-"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(), signal },
  );
  const stderr = new Response(proc.stderr).text().catch(() => "");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = proc.stdout.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total / 4 > MAX_SAMPLES) {
        proc.kill();
        throw new TooLong();
      }
    }
  } catch (e) {
    checkCancel(signal);
    throw e;
  }
  const code = await proc.exited;
  checkCancel(signal);
  if (code !== 0) throw new Error(`ffmpeg failed: ${(await stderr).trim()}`);
  const bytes = new Uint8Array(total - (total % 4));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, bytes.length - o);
    if (take <= 0) break;
    bytes.set(c.subarray(0, take), o);
    o += take;
  }
  return new Float32Array(bytes.buffer, 0, bytes.length / 4);
}

export interface Downloaded {
  path: string;
  title: string;
}

/** Download the audio track of a URL (YouTube, podcasts, ...) with yt-dlp, or fetch a direct media link. */
export async function downloadUrl(url: string, destDir: string, signal?: AbortSignal): Promise<Downloaded> {
  const stem = crypto.randomUUID();
  let armed = true;
  // Failed or cancelled downloads must not leave partial files behind.
  const cleanup = () => {
    if (!armed) return;
    for (const f of readdirSync(destDir)) if (f.startsWith(`${stem}.`)) rmSync(join(destDir, f), { force: true });
  };
  try {
    // Direct links to media files don't need yt-dlp.
    const lower = url.toLowerCase();
    const pathPart = lower.split(/[?#]/)[0];
    const direct = MEDIA_EXTS.find((e) => pathPart.endsWith(`.${e}`));
    if (direct) {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const tooBig = () => new Error(`This file is too large to download (over ${MAX_DOWNLOAD_BYTES / 2 ** 30} GB)`);
      const len = Number(resp.headers.get("content-length") ?? 0);
      if (len > MAX_DOWNLOAD_BYTES) throw tooBig();
      const dest = join(destDir, `${stem}.${direct}`);
      // Stream to disk rather than buffering the whole body in memory; pipeline() also reports write errors.
      const body = (resp.body ?? []) as unknown as AsyncIterable<Uint8Array>;
      let written = 0;
      await pipeline(async function* () {
        for await (const chunk of body) {
          written += chunk.length;
          if (written > MAX_DOWNLOAD_BYTES) throw tooBig();
          yield chunk;
        }
      }, createWriteStream(dest));
      armed = false;
      return { path: dest, title: basename(pathPart) || "download" };
    }

    const ytdlp = which("yt-dlp");
    if (!ytdlp) throw new Error("Importing from links needs yt-dlp. Install it with `brew install yt-dlp`.");
    const proc = Bun.spawn(
      [
        ytdlp, "--no-playlist", "--no-progress", "--max-filesize", "4G", "-f", "bestaudio/best",
        "--print", "title", "--print", "after_move:filepath", "-o", join(destDir, `${stem}.%(ext)s`),
        // `--` so a URL can never be parsed as an option.
        "--", url,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnv(), signal },
    );
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    checkCancel(signal);
    if (code !== 0) {
      const last = err.split("\n").filter((l) => l.trim() !== "").pop() ?? "unknown error";
      throw new Error(`yt-dlp failed: ${last}`);
    }
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    const path = lines.at(-1)?.trim();
    if (!path) throw new Error("yt-dlp gave no file");
    armed = false;
    return { path, title: lines.length >= 2 ? lines[0].trim() : url };
  } catch (e) {
    cleanup();
    throw e;
  }
}
