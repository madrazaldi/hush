// Local model catalog (GGUF models for transcribe-cpp) and downloads.
//
// The catalog is derived from Handy's (MIT) curated catalog: each entry pins a Hugging Face revision and
// sha256, with a static mirror as fallback.

import { createWriteStream, existsSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import catalogJson from "../../../../resources/models.json";
import type { CatalogModel, ModelStatus } from "../../../lib/types";
import { log } from "../log";
import { modelsDir } from "../paths";

interface Catalog {
  mirrors: string[];
  models: CatalogModel[];
}

const CATALOG = catalogJson as unknown as Catalog;

export const catalog = (): CatalogModel[] => CATALOG.models;
export const find = (id: string): CatalogModel | undefined => CATALOG.models.find((m) => m.id === id);
export const modelPath = (m: CatalogModel): string => join(modelsDir(), m.filename);

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export const isDownloaded = (id: string): boolean => {
  const m = find(id);
  return m ? isFile(modelPath(m)) : false;
};

/** Resolve a model id to a file on disk. Accepts catalog ids or absolute paths to custom GGUF / ggml `.bin` files. */
export function resolve(id: string): string {
  const m = find(id);
  if (m) {
    const p = modelPath(m);
    if (isFile(p)) return p;
    throw new Error(`Model "${m.name}" is not downloaded yet. Download it in Settings → Models.`);
  }
  if (isFile(id)) return id;
  throw new Error(`Unknown local model "${id}"`);
}

interface Active {
  ctl: AbortController;
  progress: number;
}
const downloads = new Map<string, Active>();

export function statuses(): ModelStatus[] {
  return CATALOG.models.map((m) => ({
    ...m,
    downloaded: isFile(modelPath(m)),
    downloading: downloads.get(m.id)?.progress ?? null,
  }));
}

export function cancelDownload(id: string): void {
  downloads.get(id)?.ctl.abort();
}

/** Delete a downloaded model file. The caller evicts it from the helper's cache. */
export function remove(id: string): void {
  const m = find(id);
  if (!m) throw new Error("unknown model");
  const p = modelPath(m);
  if (existsSync(p)) unlinkSync(p);
}

/** Download a catalog model, reporting progress (0..1). Verifies sha256. */
export async function download(id: string, onProgress: (p: number) => void): Promise<void> {
  const m = find(id);
  if (!m) throw new Error(`unknown model ${id}`);
  if (isFile(modelPath(m))) return;
  if (downloads.has(id)) throw new Error("already downloading");
  const active: Active = { ctl: new AbortController(), progress: 0 };
  downloads.set(id, active);
  try {
    await downloadInner(m, active, (p) => {
      active.progress = p;
      onProgress(p);
    });
  } finally {
    downloads.delete(id);
  }
}

async function downloadInner(m: CatalogModel, active: Active, onProgress: (p: number) => void): Promise<void> {
  const urls = [`https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.filename}`];
  for (const b of CATALOG.mirrors) urls.push(`${b.replace(/\/+$/, "")}/${m.repo}/${m.revision}/${m.filename}`);
  const dest = modelPath(m);
  const part = `${dest.replace(/\.[^./]*$/, "")}.part`;
  let lastErr: Error = new Error("no download sources");
  for (const url of urls) {
    if (active.ctl.signal.aborted) throw new Error("cancelled");
    try {
      await fetchTo(url, part, m, active.ctl.signal, onProgress);
      renameSync(part, dest);
      onProgress(1);
      return;
    } catch (e) {
      log.warn(`download from ${url} failed:`, e);
      rmSync(part, { force: true });
      if (active.ctl.signal.aborted) throw new Error("cancelled");
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr;
}

async function fetchTo(url: string, part: string, m: CatalogModel, signal: AbortSignal, onProgress: (p: number) => void): Promise<void> {
  const resp = await fetch(url, { signal });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  const total = Math.max(1, Number(resp.headers.get("content-length")) || m.size_bytes);
  const body = resp.body as unknown as AsyncIterable<Uint8Array>;
  const hasher = new Bun.CryptoHasher("sha256");
  let done = 0;
  let lastReport = 0;
  // pipeline() handles backpressure and turns write errors (disk full, unwritable folder) into a rejection.
  await pipeline(async function* () {
    for await (const chunk of body) {
      hasher.update(chunk);
      done += chunk.length;
      const p = Math.min(done / total, 0.999);
      if (p - lastReport >= 0.005) {
        lastReport = p;
        onProgress(p);
      }
      yield chunk;
    }
  }, createWriteStream(part));
  if (signal.aborted) throw new Error("cancelled");
  const digest = hasher.digest("hex");
  if (m.sha256 && digest !== m.sha256) throw new Error("checksum mismatch");
}
