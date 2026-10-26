// Meetings: record the mic ("Me") and system audio ("Them") as separate streams, transcribe them live
// in short VAD-cut chunks, then turn the user's notes + transcript into enhanced notes (Granola-style).
//
// Capture runs in the native helper, which writes rotated raw f32 files; each finished file arrives as a
// `capture.chunk` event, is fed to a Segmenter (VAD, WAV recording, bleed handling) and deleted.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MeetingStatus, Recording, Segment } from "../../../lib/types";
import { SysEnvelope } from "../audio/bleed";
import { SAMPLE_RATE, WavSink, readF32File } from "../audio/wav";
import { newRecording, nowMs } from "../db";
import { log, errMsg } from "../log";
import { native } from "../native";
import { audioDir, scratchDir, spoolDir } from "../paths";
import { meetingAppsFor } from "../platform";
import { sttFor, llmFor } from "../settings";
import { emit, settings, shell, st } from "../state";
import * as stt from "../stt";
import { defaultSttOptions } from "../stt/types";
import { defaultTitle, enhance } from "./enhance";
import { mixMeetingAudio } from "./mix";
import { ChunkQueue, ME, Segmenter, THEM } from "./segmenter";
import { isBleed } from "./text";

export { enhance } from "./enhance";
export { transcribeAudio } from "./mix";
export { namedSegments } from "./text";

/** How often the helper cuts a capture file; also the granularity of the live level and VAD. */
const ROTATE_MS = 500;

interface Active {
  id: string;
  startedAt: number;
  paused: boolean;
  stopping: boolean;
  queue: ChunkQueue;
  env: SysEnvelope;
  me: Segmenter;
  them: Segmenter | null;
  /** Queue and WAV path for the "Them" segmenter, created on the first system audio. */
  themInit: { wav: string | null } | null;
  micId: string;
  sysId: string;
  micOn: boolean;
  systemOn: boolean;
  /** The in-flight system start (it can wait on a permission prompt); never awaited by `start`. */
  systemStart: Promise<void> | null;
  systemError: string | null;
  worker: Promise<void>;
  workerAbort: AbortController;
  dir: string;
  spoolDir: string;
  meWav: string | null;
  themWav: string | null;
  levelTimer: ReturnType<typeof setInterval>;
  unsubs: (() => void)[];
}

export class Meetings {
  private active: Active | null = null;
  /** Held while `start` sets up devices, so two concurrent starts can't both proceed. */
  private starting = false;
  /** Meetings that were stopped but are still transcribing / mixing; they can't be resumed meanwhile. */
  private finalizing = new Set<string>();
  private detected: string[] = [];
  private detectTimer: ReturnType<typeof setInterval> | null = null;

  activeId(): string | null {
    return this.active?.id ?? null;
  }

  status(): MeetingStatus | null {
    const a = this.active;
    if (!a) return null;
    return { id: a.id, elapsed_ms: a.me.durationMs(), paused: a.paused, mic: a.micOn, system: a.systemOn, system_error: a.systemError };
  }

  setPaused(paused: boolean): void {
    if (this.active) this.active.paused = paused;
  }

  /** Start recording into an existing meeting row, or a new one. */
  async start(existing?: string | null, title?: string | null): Promise<Recording> {
    if (this.starting || this.active) throw new Error("A meeting is already being recorded");
    this.starting = true;
    try {
      return await this.startInner(existing ?? null, title ?? null);
    } finally {
      this.starting = false;
    }
  }

  private async startInner(existing: string | null, title: string | null): Promise<Recording> {
    if (existing && this.finalizing.has(existing)) throw new Error("This meeting is still being processed. Try again in a moment.");
    const state = st();
    const s = settings();

    let previous: { status: string; progress: number } | null = null;
    let rec: Recording | null = null;
    if (existing) {
      rec = state.db.updateRecording(existing, (r) => {
        previous = { status: r.status, progress: r.progress };
        r.status = "recording";
      });
    }
    if (!rec) {
      rec = newRecording({
        id: crypto.randomUUID(),
        kind: "meeting",
        title: title && title.trim() !== "" ? title : defaultTitle(),
        status: "recording",
        template_id: s.meetings.default_template,
        stt: s.meetings.stt_profile,
      });
    }
    // Resuming a meeting appends after what was already recorded.
    const baseMs = Math.max(0, ...rec.segments.map((x) => x.end_ms), rec.duration_ms);
    if (!previous) state.db.upsertRecording(rec);
    const id = rec.id;
    // If devices fail to start, put the row back the way it was.
    const rollback = (e: unknown): never => {
      const prev = previous as { status: string; progress: number } | null;
      try {
        if (prev) state.db.setStatus(id, prev.status, prev.progress, null);
        else state.db.deleteRecording(id);
      } catch (e2) {
        log.error("meeting rollback failed:", e2);
      }
      throw e instanceof Error ? e : new Error(String(e));
    };

    const dir = join(audioDir(), id);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      rollback(e);
    }
    // Each session's files are unique, so a resumed meeting never touches the previous session's.
    const part = `${nowMs()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const keep = s.meetings.keep_audio;
    const wavPath = (name: string) => (keep ? join(dir, `${name}-${part}.wav`) : null);
    const meWav = wavPath("me");
    const themWav = wavPath("them");
    const session = join(spoolDir(), part);

    const queue = new ChunkQueue(id, session, (error) => emit("meeting:error", { id, error }));
    const env = SysEnvelope.live();
    let meSink: WavSink | null = null;
    try {
      meSink = meWav ? new WavSink(meWav, SAMPLE_RATE, 1) : null;
    } catch (e) {
      log.warn("cannot record meeting audio:", e);
    }
    const me = new Segmenter(ME, baseMs, queue, meSink, env);
    const micId = `${id}:mic:${part}`;
    const sysId = `${id}:sys:${part}`;
    const capDir = scratchDir();

    const a: Active = {
      id,
      startedAt: Date.now(),
      paused: false,
      stopping: false,
      queue,
      env,
      me,
      them: null,
      themInit: null,
      micId,
      sysId,
      micOn: false,
      systemOn: false,
      systemStart: null,
      systemError: null,
      worker: Promise.resolve(),
      workerAbort: new AbortController(),
      dir,
      spoolDir: session,
      meWav: meSink ? meWav : null,
      themWav,
      levelTimer: undefined as unknown as ReturnType<typeof setInterval>,
      unsubs: [],
    };

    // Audio chunks from the helper. Handled synchronously and in order, so every chunk announced before
    // `capture.stop` replies has been consumed by the time the stop resolves.
    a.unsubs.push(
      native().on("capture.chunk", (c) => {
        if (c.id !== micId && c.id !== sysId) return;
        let pcm: Float32Array;
        try {
          pcm = readF32File(c.path);
        } catch (e) {
          log.warn("reading capture chunk failed:", e);
          return;
        } finally {
          rmSync(c.path, { force: true });
        }
        if (a.paused) return;
        if (c.id === micId) {
          a.me.push(pcm);
          return;
        }
        if (!a.them) {
          if (!a.themInit || a.stopping) return;
          // The chunk ended just now; the mic stream lags by up to one rotation.
          const chunkMs = Math.trunc((pcm.length * 1000) / SAMPLE_RATE);
          const offset = Math.max(baseMs, a.me.durationMs() - chunkMs + ROTATE_MS / 2);
          let sink: WavSink | null = null;
          try {
            sink = a.themInit.wav ? new WavSink(a.themInit.wav, SAMPLE_RATE, 1) : null;
          } catch (e) {
            log.warn("cannot record system audio:", e);
          }
          if (!sink) a.themWav = null;
          a.them = new Segmenter(THEM, Math.trunc(offset), queue, sink, env);
          a.themInit = null;
        }
        a.them.push(pcm);
      }),
    );
    a.unsubs.push(
      native().onCrash(() => {
        if (a.stopping) return;
        emit("meeting:error", { id, error: "The audio helper stopped unexpectedly. Stop the meeting and start again to keep recording." });
      }),
    );

    try {
      await native().captureStart({ id: micId, source: "mic", device: s.meetings.mic_device, path: join(capDir, `cap-${part}-mic.f32`), rotate_ms: ROTATE_MS });
      a.micOn = true;
    } catch (e) {
      for (const u of a.unsubs) u();
      meSink?.finish();
      rollback(e);
    }

    if (s.meetings.capture_system_audio) {
      a.themInit = { wav: themWav };
      a.systemStart = native()
        .captureStart({ id: sysId, source: "system", path: join(capDir, `cap-${part}-sys.f32`), rotate_ms: ROTATE_MS })
        .then(
          () => {
            if (a.stopping) {
              // The meeting ended while a permission prompt was open.
              void native().captureStop(sysId).catch(() => {});
            } else {
              a.systemOn = true;
            }
          },
          (e) => {
            log.error("system audio:", e);
            a.systemError = errMsg(e);
          },
        );
    }

    a.worker = this.transcribeWorker(a);
    a.levelTimer = setInterval(() => emit("meeting:levels", { me: a.me.level, them: a.them?.level ?? 0 }), 100);
    this.active = a;
    emit("meeting:started", id);
    shell.refreshTray();
    return rec;
  }

  /** Stop recording, finish transcription, and (optionally) enhance notes. */
  stop(): Promise<string> {
    return this.finish(false);
  }

  /**
   * Called when the app quits: finalize the recording's audio and give transcription a few seconds to
   * catch up, but don't start AI work.
   */
  async shutdown(): Promise<void> {
    if (this.active) {
      try {
        await this.finish(true);
      } catch (e) {
        log.error("finishing meeting on quit:", e);
      }
    }
    // A meeting stopped just before quitting may still be saving its audio.
    const deadline = Date.now() + 10_000;
    while (this.finalizing.size > 0 && Date.now() < deadline) await Bun.sleep(50);
  }

  /** Whether quitting now would cut a meeting's recording or saving short. */
  needsShutdown(): boolean {
    return this.active !== null || this.finalizing.size > 0;
  }

  private async finish(quitting: boolean): Promise<string> {
    const a = this.active;
    if (!a) throw new Error("No meeting is being recorded");
    this.active = null;
    const id = a.id;
    this.finalizing.add(id);
    try {
      return await this.finishInner(a, quitting);
    } finally {
      this.finalizing.delete(id);
    }
  }

  private async finishInner(a: Active, quitting: boolean): Promise<string> {
    const state = st();
    const id = a.id;
    // Wall-clock fallback, taken before waiting on devices and transcription.
    const wallMs = Date.now() - a.startedAt;
    // Set before stopping the devices: a system start that resolves later sees it and stops itself.
    a.stopping = true;
    clearInterval(a.levelTimer);
    state.db.setStatus(id, "processing", 0, null);
    emit("meeting:stopped", id);
    shell.refreshTray();

    if (a.micOn) await native().captureStop(a.micId).catch((e) => log.warn("stopping mic capture:", e));
    if (a.systemOn) await native().captureStop(a.sysId).catch((e) => log.warn("stopping system capture:", e));
    for (const u of a.unsubs) u();

    // Flushing the segmenters emits the last utterances; closing the queue then ends the worker.
    const meBase = a.me.offsetMs;
    const meDur = a.me.durationMs();
    const meSink = a.me.finish();
    a.themInit = null;
    const them = a.them;
    a.them = null;
    const themDur = them ? them.durationMs() : 0;
    const themOffset = them ? them.offsetMs : meBase;
    const themSink = them ? them.finish() : null;
    a.queue.close();

    // Finalize the audio first, so it survives even if transcription is cut short. The captured timeline
    // (sample counts) excludes pauses and matches the segment timestamps; fall back to wall time only if
    // nothing was captured.
    const captured = Math.max(meDur, themDur);
    const durationMs = captured > meBase ? captured : meBase + wallMs;
    meSink?.finish();
    themSink?.finish();
    const mixed = await mixMeetingAudio(a.dir, a.meWav, a.themWav, meBase, themOffset - meBase).catch((e) => {
      log.error("mixing meeting audio failed:", e);
      return null;
    });
    state.db.updateRecording(id, (r) => {
      r.duration_ms = durationMs;
      if (mixed) r.audio_path = mixed;
    });

    if (quitting) {
      const done = await Promise.race([a.worker.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!done) {
        log.warn("quitting before the meeting transcript caught up");
        a.workerAbort.abort();
      }
    } else {
      await a.worker;
    }
    rmSync(a.spoolDir, { recursive: true, force: true });

    const rec = state.db.updateRecording(id, (r) => {
      r.segments.sort((x, y) => x.start_ms - y.start_ms);
      r.status = "ready";
    });
    if (!rec) throw new Error("meeting vanished");
    emit("recording:updated", id);

    const s = settings();
    if (!quitting && s.meetings.auto_enhance && rec.segments.length > 0 && llmFor(s, s.meetings.llm_profile)) {
      void enhance(id).catch((e) => {
        log.error("enhance failed:", e);
        emit("meeting:enhance-error", { id, error: errMsg(e) });
      });
    }
    shell.refreshTray();
    return id;
  }

  /** Transcribes queued utterances one at a time and merges them into the recording. */
  private async transcribeWorker(a: Active): Promise<void> {
    const { id, queue } = a;
    for (;;) {
      const chunk = await queue.next();
      if (!chunk) return;
      const pcm = queue.load(chunk.pcm);
      if (a.workerAbort.signal.aborted) continue;
      try {
        await this.transcribeChunk(id, chunk.speaker, chunk.startMs, pcm, a.workerAbort.signal);
      } catch (e) {
        if (a.workerAbort.signal.aborted) continue;
        log.warn("meeting chunk failed:", e);
        emit("meeting:error", { id, error: errMsg(e) });
      }
    }
  }

  private async transcribeChunk(id: string, speaker: string, startMs: number, pcm: Float32Array, signal: AbortSignal): Promise<void> {
    const state = st();
    const s = settings();
    const profileId = state.db.getRecording(id)?.stt ?? s.meetings.stt_profile;
    const profile = sttFor(s, profileId);
    const opts = defaultSttOptions({ language: s.meetings.language, vocabulary: s.vocabulary });
    const t = await stt.transcribe(profile, pcm, opts, () => {}, signal);
    let segs = t.segments;
    if (segs.length === 0 && t.text.trim() !== "") {
      segs = [{ start_ms: 0, end_ms: Math.trunc((pcm.length * 1000) / SAMPLE_RATE), text: t.text.trim(), words: [] }];
    }
    // One live chunk is one utterance; merge model segments for readability.
    if (segs.length > 1) {
      segs = [
        {
          start_ms: segs[0].start_ms,
          end_ms: segs[segs.length - 1].end_ms,
          text: segs.map((x) => x.text.trim()).join(" "),
          words: segs.flatMap((x) => x.words),
        },
      ];
    }
    let added = false;
    state.db.updateRecording(id, (r) => {
      for (const seg of segs) {
        const out: Segment = {
          start_ms: seg.start_ms + startMs,
          end_ms: seg.end_ms + startMs,
          text: seg.text,
          speaker,
          words: seg.words.map((w) => ({ ...w, start_ms: w.start_ms + startMs, end_ms: w.end_ms + startMs })),
        };
        if (out.text.trim() === "" || (speaker === ME && isBleed(out, r.segments))) continue;
        if (speaker === THEM) {
          // Drop mic segments that turn out to be bleed of this one.
          r.segments = r.segments.filter((e) => !(e.speaker === ME && isBleed(e, [out])));
        }
        let pos = r.segments.findIndex((e) => e.start_ms > out.start_ms);
        if (pos < 0) pos = r.segments.length;
        r.segments.splice(pos, 0, out);
        added = true;
      }
    });
    if (added) emit("meeting:transcript", id);
  }

  /** Watch for meeting apps that start using the microphone. */
  startDetection(): void {
    if (this.detectTimer) return;
    let warned = false;
    let busy = false;
    this.detectTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        if (!settings().meetings.detect_meetings || this.active) {
          this.detected = [];
          return;
        }
        const apps = meetingAppsFor(await native().micUsers());
        for (const app of apps) {
          if (!this.detected.includes(app)) {
            emit("meeting:detected", app);
            shell.notify("Meeting detected", `${app} is using your microphone. Open Hush to take notes.`);
          }
        }
        this.detected = apps;
      } catch (e) {
        if (!warned) {
          warned = true;
          log.warn("meeting detection unavailable:", e);
        }
      } finally {
        busy = false;
      }
    }, 4000);
    this.detectTimer.unref?.();
  }

  stopDetection(): void {
    if (this.detectTimer) clearInterval(this.detectTimer);
    this.detectTimer = null;
  }
}
