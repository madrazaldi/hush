// SQLite storage for dictation history and recordings (files + meetings). Same schema, same
// `user_version` migration scheme and same JSON column formats as the Rust build, so an existing
// `hush.db` opens unchanged.

import { Database } from "bun:sqlite";
import type { ChatMessage, Dictation, Recording, RecordingSummary, Segment, Stats } from "../../lib/types";

const MIGRATIONS: string[] = [
  `
    CREATE TABLE dictations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'dictation',
        raw_text TEXT NOT NULL,
        text TEXT NOT NULL,
        app TEXT,
        style TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        stt TEXT,
        llm TEXT,
        audio_path TEXT,
        error TEXT
    );
    CREATE INDEX dictations_created ON dictations(created_at DESC);

    CREATE TABLE recordings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        source TEXT,
        media_path TEXT,
        audio_path TEXT,
        language TEXT,
        segments TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        enhanced TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        template_id TEXT,
        speakers TEXT NOT NULL DEFAULT '{}',
        chat TEXT NOT NULL DEFAULT '[]',
        stt TEXT,
        starred INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX recordings_kind_created ON recordings(kind, created_at DESC);
    `,
];

export const nowMs = () => Date.now();

/** A fresh blank recording for the given kind; callers fill in the rest. */
export function newRecording(init: Partial<Recording> & Pick<Recording, "id" | "kind" | "title" | "status">): Recording {
  const t = nowMs();
  return {
    created_at: t,
    updated_at: t,
    duration_ms: 0,
    progress: 0,
    error: null,
    source: null,
    media_path: null,
    audio_path: null,
    language: null,
    segments: [],
    notes: "",
    enhanced: "",
    summary: "",
    template_id: null,
    speakers: {},
    chat: [],
    stt: null,
    starred: false,
    ...init,
  };
}

/** Segments are stored without null speakers and empty word lists (the Rust serializer skipped them). */
function cleanSegment(s: Segment): Segment {
  const out: Segment = { start_ms: s.start_ms, end_ms: s.end_ms, text: s.text };
  if (s.speaker) out.speaker = s.speaker;
  if (s.words && s.words.length > 0) out.words = s.words;
  return out;
}

function fromJson<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string") return fallback;
  try {
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

type Row = Record<string, any>;

const REC_COLS =
  "id, kind, title, created_at, updated_at, duration_ms, status, progress, error, source, media_path, audio_path, language, segments, notes, enhanced, summary, template_id, speakers, chat, stt, starred";

function recordingRow(r: Row): Recording {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    created_at: r.created_at,
    updated_at: r.updated_at,
    duration_ms: r.duration_ms,
    status: r.status,
    progress: r.progress,
    error: r.error ?? null,
    source: r.source ?? null,
    media_path: r.media_path ?? null,
    audio_path: r.audio_path ?? null,
    language: r.language ?? null,
    segments: fromJson<Segment[]>(r.segments, []),
    notes: r.notes,
    enhanced: r.enhanced,
    summary: r.summary,
    template_id: r.template_id ?? null,
    speakers: fromJson<Record<string, string>>(r.speakers, {}),
    chat: fromJson<ChatMessage[]>(r.chat, []),
    stt: r.stt ?? null,
    starred: r.starred !== 0,
  };
}

function dictationRow(r: Row): Dictation {
  return {
    id: r.id,
    created_at: r.created_at,
    kind: r.kind,
    raw_text: r.raw_text,
    text: r.text,
    app: r.app ?? null,
    style: r.style ?? null,
    duration_ms: r.duration_ms,
    stt: r.stt ?? null,
    llm: r.llm ?? null,
    audio_path: r.audio_path ?? null,
    error: r.error ?? null,
  };
}

export class Db {
  private conn: Database;

  constructor(path: string) {
    this.conn = new Database(path, { create: true });
    this.conn.exec("PRAGMA journal_mode = WAL");
    this.conn.exec("PRAGMA synchronous = NORMAL");
    const version = (this.conn.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.conn.exec(MIGRATIONS[i]);
      this.conn.exec(`PRAGMA user_version = ${i + 1}`);
    }
    // Recordings interrupted by a crash or quit can't resume mid-stream.
    this.conn.run(
      "UPDATE recordings SET status='error', error='Interrupted (the app was closed)' WHERE status IN ('processing','queued') AND kind='file'",
    );
    this.conn.run("UPDATE recordings SET status='ready' WHERE status IN ('recording','processing') AND kind='meeting'");
  }

  close(): void {
    this.conn.close();
  }

  // ---------- dictations ----------

  insertDictation(d: Dictation): void {
    this.conn.run(
      `INSERT INTO dictations (id, created_at, kind, raw_text, text, app, style, duration_ms, stt, llm, audio_path, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, d.created_at, d.kind, d.raw_text, d.text, d.app, d.style, d.duration_ms, d.stt, d.llm, d.audio_path, d.error],
    );
  }

  listDictations(query: string, limit: number, offset: number): Dictation[] {
    const rows = this.conn
      .query(
        `SELECT id, created_at, kind, raw_text, text, app, style, duration_ms, stt, llm, audio_path, error
         FROM dictations WHERE (?1 = '' OR text LIKE '%' || ?1 || '%' OR raw_text LIKE '%' || ?1 || '%')
         ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`,
      )
      .all(query, limit, offset) as Row[];
    return rows.map(dictationRow);
  }

  lastDictation(): Dictation | null {
    return this.listDictations("", 1, 0)[0] ?? null;
  }

  /** Delete one dictation; returns its audio path (if any) so the caller can remove the file. */
  deleteDictation(id: string): string | null {
    const row = this.conn.query("SELECT audio_path FROM dictations WHERE id=?1").get(id) as Row | null;
    this.conn.run("DELETE FROM dictations WHERE id=?1", [id]);
    return row?.audio_path ?? null;
  }

  clearDictations(): string[] {
    const rows = this.conn.query("SELECT audio_path FROM dictations WHERE audio_path IS NOT NULL").all() as Row[];
    this.conn.run("DELETE FROM dictations");
    return rows.map((r) => r.audio_path as string);
  }

  /** Delete dictations older than `days`; returns audio paths to remove. */
  pruneDictations(days: number): string[] {
    if (days === 0) return [];
    const cutoff = nowMs() - days * 86_400_000;
    const rows = this.conn
      .query("SELECT audio_path FROM dictations WHERE created_at < ?1 AND audio_path IS NOT NULL")
      .all(cutoff) as Row[];
    this.conn.run("DELETE FROM dictations WHERE created_at < ?1", [cutoff]);
    return rows.map((r) => r.audio_path as string);
  }

  // ---------- recordings ----------

  upsertRecording(rec: Recording): void {
    this.conn.run(
      `INSERT OR REPLACE INTO recordings (${REC_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rec.id,
        rec.kind,
        rec.title,
        rec.created_at,
        nowMs(),
        rec.duration_ms,
        rec.status,
        rec.progress,
        rec.error,
        rec.source,
        rec.media_path,
        rec.audio_path,
        rec.language,
        JSON.stringify(rec.segments.map(cleanSegment)),
        rec.notes,
        rec.enhanced,
        rec.summary,
        rec.template_id,
        JSON.stringify(rec.speakers),
        JSON.stringify(rec.chat),
        rec.stt,
        rec.starred ? 1 : 0,
      ],
    );
  }

  getRecording(id: string): Recording | null {
    const row = this.conn.query(`SELECT ${REC_COLS} FROM recordings WHERE id=?1`).get(id) as Row | null;
    return row ? recordingRow(row) : null;
  }

  /** Read-modify-write. Synchronous, so nothing can interleave; a missing row is not resurrected. */
  updateRecording(id: string, f: (rec: Recording) => void): Recording | null {
    const rec = this.getRecording(id);
    if (!rec) return null;
    f(rec);
    this.upsertRecording(rec);
    return rec;
  }

  setStatus(id: string, status: string, progress: number, error: string | null): void {
    this.conn.run("UPDATE recordings SET status=?2, progress=?3, error=?4, updated_at=?5 WHERE id=?1", [
      id,
      status,
      progress,
      error,
      nowMs(),
    ]);
  }

  listRecordings(kind: string, query: string): RecordingSummary[] {
    const rows = this.conn
      .query(
        `SELECT id, kind, title, created_at, duration_ms, status, progress, error,
                CASE WHEN enhanced != '' THEN substr(enhanced, 1, 240)
                     WHEN summary != '' THEN substr(summary, 1, 240)
                     WHEN notes != '' THEN substr(notes, 1, 240)
                     ELSE substr(segments, 1, 600) END AS preview,
                starred, source
         FROM recordings
         WHERE (?1 = '' OR kind = ?1)
           AND (?2 = '' OR title LIKE '%' || ?2 || '%' OR notes LIKE '%' || ?2 || '%'
                OR enhanced LIKE '%' || ?2 || '%' OR segments LIKE '%' || ?2 || '%')
         ORDER BY created_at DESC`,
      )
      .all(kind, query) as Row[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      created_at: r.created_at,
      duration_ms: r.duration_ms,
      status: r.status,
      progress: r.progress,
      error: r.error ?? null,
      preview: previewText(r.preview ?? ""),
      starred: r.starred !== 0,
      source: r.source ?? null,
    }));
  }

  /** Delete a recording, returning the removed row so the caller can clean up its files. */
  deleteRecording(id: string): Recording | null {
    const rec = this.getRecording(id);
    this.conn.run("DELETE FROM recordings WHERE id=?1", [id]);
    return rec;
  }

  /** Whether any recording references `path` or a file under it (translated copies share media). */
  mediaInUse(path: string): boolean {
    const under = `${path.replace(/\/+$/, "")}/%`;
    const row = this.conn
      .query(
        `SELECT EXISTS(SELECT 1 FROM recordings
           WHERE media_path = ?1 OR audio_path = ?1 OR media_path LIKE ?2 OR audio_path LIKE ?2) AS used`,
      )
      .get(path, under) as Row;
    return row.used !== 0;
  }

  stats(): Stats {
    const d = this.conn
      .query("SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms),0) AS ms FROM dictations WHERE kind='dictation'")
      .get() as Row;
    let words = 0;
    for (const r of this.conn.query("SELECT text FROM dictations").all() as Row[]) {
      words += String(r.text).split(/\s+/).filter(Boolean).length;
    }
    const count = (kind: string) =>
      this.conn.query("SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms),0) AS ms FROM recordings WHERE kind=?1").get(kind) as Row;
    const files = count("file");
    const meetings = count("meeting");

    // Consecutive days (ending today or yesterday) with any activity.
    const dayRows = this.conn
      .query(
        `SELECT DISTINCT date(created_at/1000, 'unixepoch', 'localtime') AS d FROM
           (SELECT created_at FROM dictations UNION ALL SELECT created_at FROM recordings)
         ORDER BY 1 DESC LIMIT 400`,
      )
      .all() as Row[];
    const dayNum = (s: string): number | null => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 : null;
    };
    const days = dayRows.map((r) => dayNum(String(r.d))).filter((n): n is number => n !== null);
    const now = new Date();
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000;
    let streak = 0;
    if (days.length > 0 && today - days[0] <= 1) {
      let expect = days[0];
      for (const x of days) {
        if (x !== expect) break;
        streak++;
        expect--;
      }
    }
    return {
      dictation_count: d.n,
      dictation_words: words,
      dictation_ms: d.ms,
      file_count: files.n,
      meeting_count: meetings.n,
      transcribed_ms: files.ms + meetings.ms + d.ms,
      streak_days: streak,
    };
  }
}

/** Turn a preview column (Markdown, or raw segments JSON) into plain text. */
export function previewText(raw: string): string {
  const t = raw.trimStart();
  let s: string;
  if (t.startsWith("[")) {
    // Partial JSON: pull out "text" values.
    s = "";
    for (const part of t.split('"text":"').slice(1)) {
      const end = part.indexOf('"');
      if (end >= 0) s += `${part.slice(0, end)} `;
    }
  } else {
    s = t
      .split("\n")
      .map((l) => l.replace(/^[#\-*> ]+/, "").trim())
      .filter((l) => l !== "")
      .join(" ");
  }
  return Array.from(s).slice(0, 200).join("");
}
