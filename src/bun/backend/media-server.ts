// A token-guarded loopback HTTP server for the webview: streams local audio/video with Range support
// (replacing Tauri's asset protocol) and accepts uploads of dropped files (CEF hands the page no file
// paths, so a drop is copied into the media directory and then added like any imported file).

import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { log } from "./log";
import { mediaDir, rootDir } from "./paths";

export interface MediaServer {
  /** `http://127.0.0.1:<port>/<token>` */
  baseUrl: string;
  stop(): void;
}

export interface MediaServerOptions {
  /** Whether a file outside the data directory may be served (it belongs to a recording). */
  isKnownMedia: (path: string) => boolean;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
  "access-control-allow-headers": "range, content-type",
  "access-control-expose-headers": "content-range, accept-ranges, content-length",
};

const TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

const reply = (status: number, body?: BodyInit | null, headers: Record<string, string> = {}) =>
  new Response(body ?? null, { status, headers: { ...CORS, ...headers } });

/** Parse a single `bytes=a-b` range. Returns null when absent, "bad" when unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "bad" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "bad" : { start, end };
}

export function startMediaServer(opts: MediaServerOptions): MediaServer {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  const root = realpathSync(rootDir());

  const allowed = (path: string): string | null => {
    if (!path.startsWith("/")) return null;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return null;
    }
    if (real === root || real.startsWith(`${root}/`)) return real;
    return opts.isKnownMedia(path) || opts.isKnownMedia(real) ? real : null;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS") return reply(204);
      const url = new URL(req.url);
      const [, t, route] = url.pathname.split("/");
      if (t !== token) return reply(404);

      if (route === "file" && (req.method === "GET" || req.method === "HEAD")) {
        const real = allowed(url.searchParams.get("path") ?? "");
        if (!real) return reply(403);
        let size: number;
        try {
          const st = statSync(real);
          if (!st.isFile()) return reply(404);
          size = st.size;
        } catch {
          return reply(404);
        }
        const ext = real.split(".").pop()?.toLowerCase() ?? "";
        const type = TYPES[ext] ?? "application/octet-stream";
        const range = parseRange(req.headers.get("range"), size);
        if (range === "bad") return reply(416, null, { "content-range": `bytes */${size}` });
        const file = Bun.file(real);
        if (range) {
          const body = req.method === "HEAD" ? null : file.slice(range.start, range.end + 1);
          return reply(206, body, {
            "content-type": type,
            "accept-ranges": "bytes",
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
            "content-length": String(range.end - range.start + 1),
          });
        }
        return reply(200, req.method === "HEAD" ? null : file, { "content-type": type, "accept-ranges": "bytes", "content-length": String(size) });
      }

      if (route === "upload" && req.method === "POST") {
        const name = basename(url.searchParams.get("name") ?? "") || "dropped";
        const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-120);
        // One folder per upload: the file keeps its own name (it becomes the recording's title).
        const folder = join(mediaDir(), crypto.randomUUID().slice(0, 8));
        const dest = join(folder, safe);
        try {
          if (!req.body) return reply(400);
          mkdirSync(folder, { recursive: true });
          await Bun.write(dest, new Response(req.body));
        } catch (e) {
          rmSync(folder, { recursive: true, force: true });
          log.warn("upload failed:", e);
          return reply(500, String(e));
        }
        return reply(200, JSON.stringify({ path: resolve(dest) }), { "content-type": "application/json" });
      }
      return reply(404);
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}/${token}`;
  log.info("media server on", `http://127.0.0.1:${server.port}`);
  return { baseUrl, stop: () => server.stop(true) };
}
