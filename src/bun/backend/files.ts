// File & link transcription: a sequential job queue. (Exporters are in export.ts.)

import { mkdirSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { Recording } from "../../lib/types";
import * as ai from "./ai";
import { decodeFile, downloadUrl } from "./audio/decode";
import { SAMPLE_RATE } from "./audio/wav";
import { newRecording } from "./db";
import * as llm from "./llm";
import { errMsg, log } from "./log";
import { transcribeAudio } from "./meetings";
import { mediaDir } from "./paths";
import { llmFor, sttFor } from "./settings";
import { emit, settings, st } from "./state";
import * as stt from "./stt";
import { defaultSttOptions } from "./stt/types";

export interface Progress {
  id: string;
  status: string;
  /** decoding | downloading | transcribing | summarizing */
  stage: string;
  progress: number;
  error: string | null;
}

function progressEvent(id: string, status: string, stage: string, progress: number, error: string | null = null) {
  const p: Progress = { id, status, stage, progress, error };
  emit("recording:progress", p);
}

interface Entry {
  generation: number;
  ctl: AbortController;
}

export class FileQueue {
  private queue: string[] = [];
  /** One entry per queued or running job, created at enqueue time so queued jobs can be cancelled too. */
  private cancels = new Map<string, Entry>();
  private running: { id: string; ctl: AbortController } | null = null;
  private generation = 0;
  private pumping = false;

  enqueue(id: string): void {
    st().db.setStatus(id, "queued", 0, null);
    progressEvent(id, "queued", "", 0);
    this.cancels.set(id, { generation: this.generation++, ctl: new AbortController() });
    this.queue.push(id);
    void this.pump();
  }

  cancel(id: string): void {
    const queued = this.cancels.get(id);
    this.cancels.delete(id);
    queued?.ctl.abort();
    // A running job reports its own cancellation; a queued one never will.
    if (this.running?.id === id) {
      this.running.ctl.abort();
    } else if (queued) {
      st().db.setStatus(id, "error", 0, "Cancelled");
      progressEvent(id, "error", "", 0, "Cancelled");
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let id = this.queue.shift(); id !== undefined; id = this.queue.shift()) {
        // Jobs cancelled (or already run) while queued have no live controller.
        const entry = this.cancels.get(id);
        if (!entry || entry.ctl.signal.aborted) continue;
        this.running = { id, ctl: entry.ctl };
        let err: unknown = null;
        const job = runJob(id, entry.ctl.signal);
        job.catch(() => {});
        const aborted = new Promise<never>((_, reject) => {
          const fail = () => reject(new Error("Cancelled"));
          if (entry.ctl.signal.aborted) fail();
          else entry.ctl.signal.addEventListener("abort", fail, { once: true });
        });
        try {
          await Promise.race([job, aborted]);
        } catch (e) {
          err = e;
        }
        this.running = null;
        // Only forget our own entry: the job may have been re-queued meanwhile.
        if (this.cancels.get(id)?.generation === entry.generation) this.cancels.delete(id);
        if (err !== null) {
          const msg = entry.ctl.signal.aborted ? "Cancelled" : errMsg(err);
          log.error(`file job ${id}: ${msg}`);
          try {
            st().db.setStatus(id, "error", 0, msg);
          } catch (e) {
            log.error("could not record the failure:", e);
          }
          progressEvent(id, "error", "", 0, msg);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Create a recording row for a local file and queue it. */
  addFile(path: string): Recording {
    let ok = false;
    try {
      ok = statSync(path).isFile();
    } catch {
      // not there
    }
    if (!ok) throw new Error(`${path} is not a file`);
    const title = basename(path, extname(path)) || "Untitled";
    const rec = this.newRec(title, path, path);
    st().db.upsertRecording(rec);
    this.enqueue(rec.id);
    return rec;
  }

  addUrl(url: string): Recording {
    url = url.trim();
    if (!(url.startsWith("http://") || url.startsWith("https://"))) throw new Error("Enter a full http(s) link");
    const rec = this.newRec(url, url, null);
    st().db.upsertRecording(rec);
    this.enqueue(rec.id);
    return rec;
  }

  private newRec(title: string, source: string, mediaPath: string | null): Recording {
    return newRecording({
      id: crypto.randomUUID(),
      kind: "file",
      title,
      status: "queued",
      source,
      media_path: mediaPath,
      stt: settings().files.stt_profile,
    });
  }
}

const cancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw new Error("Cancelled");
};

async function runJob(id: string, signal: AbortSignal): Promise<void> {
  const state = st();
  const s = settings();
  let rec = state.db.getRecording(id);
  if (!rec) throw new Error("recording vanished");

  // 1. Fetch remote media.
  if (!rec.media_path) {
    const url = rec.source ?? "";
    state.db.setStatus(id, "processing", 0, null);
    progressEvent(id, "processing", "downloading", 0);
    mkdirSync(mediaDir(), { recursive: true });
    const dl = await downloadUrl(url, mediaDir(), signal);
    cancelled(signal);
    rec = state.db.updateRecording(id, (r) => {
      r.media_path = dl.path;
      r.title = dl.title;
    });
    if (!rec) throw new Error("recording vanished");
    emit("recording:updated", id);
  }

  const profile = sttFor(s, rec.stt ?? s.files.stt_profile);
  const opts = defaultSttOptions({ language: rec.language ?? s.files.language, vocabulary: s.vocabulary, diarize: s.files.diarize });
  let last = 0;
  const progress = (p: number) => {
    if (p - last >= 0.01 || p >= 1) {
      last = p;
      state.db.setStatus(id, "processing", p, null);
      progressEvent(id, "processing", "transcribing", p);
    }
  };
  const media = rec.media_path ?? "";

  let transcript: stt.Transcript;
  let durationMs: number;
  if (rec.kind === "meeting") {
    // Meeting audio keeps mic and system audio on separate channels.
    state.db.setStatus(id, "processing", 0, null);
    progressEvent(id, "processing", "transcribing", 0);
    transcript = await transcribeAudio(media, profile, opts, progress, signal);
    durationMs = rec.duration_ms;
  } else {
    // 2. Decode.
    state.db.setStatus(id, "processing", 0, null);
    progressEvent(id, "processing", "decoding", 0);
    const pcm = await decodeFile(media, signal);
    cancelled(signal);
    if (pcm.length === 0) throw new Error("No audio found in this file");
    durationMs = Math.trunc((pcm.length * 1000) / SAMPLE_RATE);

    // 3. Transcribe.
    progressEvent(id, "processing", "transcribing", 0);
    transcript = await stt.transcribe(profile, pcm, opts, progress, signal);
  }
  cancelled(signal);

  let segments = transcript.segments;
  if (segments.length === 0 && transcript.text !== "") {
    segments = [{ start_ms: 0, end_ms: durationMs, text: transcript.text, words: [] }];
  }
  state.db.updateRecording(id, (r) => {
    r.segments = segments;
    r.duration_ms = durationMs;
    r.language = transcript.language ?? r.language;
    r.status = "ready";
    r.progress = 1;
    r.error = null;
    r.stt = profile.id;
  });
  progressEvent(id, "ready", "", 1);

  // 4. Optional summary.
  const llmProfile = llmFor(s, s.files.llm_profile);
  if (s.files.auto_summarize && segments.length > 0 && llmProfile) {
    progressEvent(id, "ready", "summarizing", 1);
    try {
      const summary = await llm.complete(llmProfile, ai.summaryRequest(rec.title, segments), { signal });
      state.db.updateRecording(id, (r) => {
        r.summary = summary;
      });
    } catch (e) {
      log.warn("auto-summary failed:", e);
    }
    progressEvent(id, "ready", "", 1);
  }
  emit("recording:updated", id);
}
