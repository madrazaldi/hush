//! SQLite storage for dictation history and recordings (files + meetings).

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::llm::ChatMessage;
use crate::stt::Segment;

pub struct Db {
    conn: Mutex<Connection>,
}

const MIGRATIONS: &[&str] = &[
    r#"
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
    "#,
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dictation {
    pub id: String,
    pub created_at: i64,
    pub kind: String,
    pub raw_text: String,
    pub text: String,
    pub app: Option<String>,
    pub style: Option<String>,
    pub duration_ms: i64,
    pub stt: Option<String>,
    pub llm: Option<String>,
    pub audio_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Recording {
    pub id: String,
    /// "file" or "meeting"
    pub kind: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub duration_ms: i64,
    /// queued | recording | processing | ready | error
    pub status: String,
    pub progress: f64,
    pub error: Option<String>,
    pub source: Option<String>,
    pub media_path: Option<String>,
    pub audio_path: Option<String>,
    pub language: Option<String>,
    pub segments: Vec<Segment>,
    pub notes: String,
    pub enhanced: String,
    pub summary: String,
    pub template_id: Option<String>,
    /// Speaker label → display name overrides.
    pub speakers: std::collections::BTreeMap<String, String>,
    pub chat: Vec<ChatMessage>,
    pub stt: Option<String>,
    pub starred: bool,
}

/// Lightweight row for list views (no segments / chat).
#[derive(Debug, Clone, Serialize)]
pub struct RecordingSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub created_at: i64,
    pub duration_ms: i64,
    pub status: String,
    pub progress: f64,
    pub error: Option<String>,
    pub preview: String,
    pub starred: bool,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub dictation_count: i64,
    pub dictation_words: i64,
    pub dictation_ms: i64,
    pub file_count: i64,
    pub meeting_count: i64,
    pub transcribed_ms: i64,
    pub streak_days: i64,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

fn from_json<T: for<'de> Deserialize<'de> + Default>(s: Option<String>) -> T {
    s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

impl Db {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, m) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(m)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        // Recordings interrupted by a crash or quit can't resume mid-stream.
        conn.execute(
            "UPDATE recordings SET status='error', error='Interrupted (the app was closed)' WHERE status IN ('processing','queued') AND kind='file'",
            [],
        )?;
        conn.execute("UPDATE recordings SET status='ready' WHERE status IN ('recording','processing') AND kind='meeting'", [])?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ---------- dictations ----------

    pub fn insert_dictation(&self, d: &Dictation) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO dictations (id, created_at, kind, raw_text, text, app, style, duration_ms, stt, llm, audio_path, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![d.id, d.created_at, d.kind, d.raw_text, d.text, d.app, d.style, d.duration_ms, d.stt, d.llm, d.audio_path, d.error],
        )?;
        Ok(())
    }

    fn dictation_row(r: &Row) -> rusqlite::Result<Dictation> {
        Ok(Dictation {
            id: r.get(0)?,
            created_at: r.get(1)?,
            kind: r.get(2)?,
            raw_text: r.get(3)?,
            text: r.get(4)?,
            app: r.get(5)?,
            style: r.get(6)?,
            duration_ms: r.get(7)?,
            stt: r.get(8)?,
            llm: r.get(9)?,
            audio_path: r.get(10)?,
            error: r.get(11)?,
        })
    }

    pub fn list_dictations(&self, query: &str, limit: i64, offset: i64) -> Result<Vec<Dictation>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, created_at, kind, raw_text, text, app, style, duration_ms, stt, llm, audio_path, error
             FROM dictations WHERE (?1 = '' OR text LIKE '%' || ?1 || '%' OR raw_text LIKE '%' || ?1 || '%')
             ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![query, limit, offset], Self::dictation_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn last_dictation(&self) -> Result<Option<Dictation>> {
        Ok(self.list_dictations("", 1, 0)?.into_iter().next())
    }

    pub fn delete_dictation(&self, id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let audio: Option<Option<String>> =
            conn.query_row("SELECT audio_path FROM dictations WHERE id=?1", [id], |r| r.get(0)).optional()?;
        conn.execute("DELETE FROM dictations WHERE id=?1", [id])?;
        Ok(audio.flatten())
    }

    pub fn clear_dictations(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT audio_path FROM dictations WHERE audio_path IS NOT NULL")?;
        let paths = stmt.query_map([], |r| r.get::<_, String>(0))?.flatten().collect();
        conn.execute("DELETE FROM dictations", [])?;
        Ok(paths)
    }

    /// Delete dictations older than `days`; returns audio paths to remove.
    pub fn prune_dictations(&self, days: u32) -> Result<Vec<String>> {
        if days == 0 {
            return Ok(Vec::new());
        }
        let cutoff = now_ms() - days as i64 * 86_400_000;
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT audio_path FROM dictations WHERE created_at < ?1 AND audio_path IS NOT NULL")?;
        let paths = stmt.query_map([cutoff], |r| r.get::<_, String>(0))?.flatten().collect();
        conn.execute("DELETE FROM dictations WHERE created_at < ?1", [cutoff])?;
        Ok(paths)
    }

    // ---------- recordings ----------

    const REC_COLS: &'static str = "id, kind, title, created_at, updated_at, duration_ms, status, progress, error, source, media_path, \
        audio_path, language, segments, notes, enhanced, summary, template_id, speakers, chat, stt, starred";

    fn recording_row(r: &Row) -> rusqlite::Result<Recording> {
        Ok(Recording {
            id: r.get(0)?,
            kind: r.get(1)?,
            title: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
            duration_ms: r.get(5)?,
            status: r.get(6)?,
            progress: r.get(7)?,
            error: r.get(8)?,
            source: r.get(9)?,
            media_path: r.get(10)?,
            audio_path: r.get(11)?,
            language: r.get(12)?,
            segments: from_json(r.get(13)?),
            notes: r.get(14)?,
            enhanced: r.get(15)?,
            summary: r.get(16)?,
            template_id: r.get(17)?,
            speakers: from_json(r.get(18)?),
            chat: from_json(r.get(19)?),
            stt: r.get(20)?,
            starred: r.get::<_, i64>(21)? != 0,
        })
    }

    pub fn upsert_recording(&self, rec: &Recording) -> Result<()> {
        self.conn.lock().execute(
            &format!(
                "INSERT OR REPLACE INTO recordings ({}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)",
                Self::REC_COLS
            ),
            params![
                rec.id,
                rec.kind,
                rec.title,
                rec.created_at,
                now_ms(),
                rec.duration_ms,
                rec.status,
                rec.progress,
                rec.error,
                rec.source,
                rec.media_path,
                rec.audio_path,
                rec.language,
                json(&rec.segments),
                rec.notes,
                rec.enhanced,
                rec.summary,
                rec.template_id,
                json(&rec.speakers),
                json(&rec.chat),
                rec.stt,
                rec.starred as i64,
            ],
        )?;
        Ok(())
    }

    pub fn get_recording(&self, id: &str) -> Result<Option<Recording>> {
        let conn = self.conn.lock();
        Ok(conn
            .query_row(&format!("SELECT {} FROM recordings WHERE id=?1", Self::REC_COLS), [id], Self::recording_row)
            .optional()?)
    }

    /// Read-modify-write a recording under the connection lock's protection.
    pub fn update_recording(&self, id: &str, f: impl FnOnce(&mut Recording)) -> Result<Option<Recording>> {
        let Some(mut rec) = self.get_recording(id)? else { return Ok(None) };
        f(&mut rec);
        self.upsert_recording(&rec)?;
        Ok(Some(rec))
    }

    pub fn set_status(&self, id: &str, status: &str, progress: f64, error: Option<&str>) -> Result<()> {
        self.conn.lock().execute(
            "UPDATE recordings SET status=?2, progress=?3, error=?4, updated_at=?5 WHERE id=?1",
            params![id, status, progress, error, now_ms()],
        )?;
        Ok(())
    }

    pub fn list_recordings(&self, kind: &str, query: &str) -> Result<Vec<RecordingSummary>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, kind, title, created_at, duration_ms, status, progress, error,
                    CASE WHEN enhanced != '' THEN substr(enhanced, 1, 240)
                         WHEN summary != '' THEN substr(summary, 1, 240)
                         WHEN notes != '' THEN substr(notes, 1, 240)
                         ELSE substr(segments, 1, 600) END,
                    starred, source
             FROM recordings
             WHERE (?1 = '' OR kind = ?1)
               AND (?2 = '' OR title LIKE '%' || ?2 || '%' OR notes LIKE '%' || ?2 || '%'
                    OR enhanced LIKE '%' || ?2 || '%' OR segments LIKE '%' || ?2 || '%')
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map(params![kind, query], |r| {
            let raw: String = r.get::<_, Option<String>>(8)?.unwrap_or_default();
            Ok(RecordingSummary {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                created_at: r.get(3)?,
                duration_ms: r.get(4)?,
                status: r.get(5)?,
                progress: r.get(6)?,
                error: r.get(7)?,
                preview: preview_text(&raw),
                starred: r.get::<_, i64>(9)? != 0,
                source: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn delete_recording(&self, id: &str) -> Result<Option<Recording>> {
        let rec = self.get_recording(id)?;
        self.conn.lock().execute("DELETE FROM recordings WHERE id=?1", [id])?;
        Ok(rec)
    }

    pub fn stats(&self) -> Result<Stats> {
        let conn = self.conn.lock();
        let (dictation_count, dictation_ms): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(duration_ms),0) FROM dictations WHERE kind='dictation'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut words = 0i64;
        {
            let mut stmt = conn.prepare("SELECT text FROM dictations")?;
            for t in stmt.query_map([], |r| r.get::<_, String>(0))?.flatten() {
                words += t.split_whitespace().count() as i64;
            }
        }
        let count = |kind: &str| -> rusqlite::Result<(i64, i64)> {
            conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(duration_ms),0) FROM recordings WHERE kind=?1",
                [kind],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        };
        let (file_count, file_ms) = count("file")?;
        let (meeting_count, meeting_ms) = count("meeting")?;

        // Consecutive days (ending today or yesterday) with any activity.
        let mut days: Vec<i64> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT date(created_at/1000, 'unixepoch', 'localtime') FROM
                   (SELECT created_at FROM dictations UNION ALL SELECT created_at FROM recordings)
                 ORDER BY 1 DESC LIMIT 400",
            )?;
            for d in stmt.query_map([], |r| r.get::<_, String>(0))?.flatten() {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d") {
                    days.push(date.num_days_from_ce() as i64);
                }
            }
        }
        use chrono::Datelike;
        let today = chrono::Local::now().date_naive().num_days_from_ce() as i64;
        let mut streak = 0;
        if let Some(&first) = days.first() {
            if today - first <= 1 {
                let mut expect = first;
                for d in days {
                    if d == expect {
                        streak += 1;
                        expect -= 1;
                    } else {
                        break;
                    }
                }
            }
        }
        Ok(Stats {
            dictation_count,
            dictation_words: words,
            dictation_ms,
            file_count,
            meeting_count,
            transcribed_ms: file_ms + meeting_ms + dictation_ms,
            streak_days: streak,
        })
    }
}

/// Turn a preview column (Markdown, or raw segments JSON) into plain text.
fn preview_text(raw: &str) -> String {
    let t = raw.trim_start();
    let s = if t.starts_with('[') {
        // Partial JSON: pull out "text" values.
        let mut out = String::new();
        for part in t.split("\"text\":\"").skip(1) {
            if let Some(end) = part.find('"') {
                out.push_str(&part[..end]);
                out.push(' ');
            }
        }
        out
    } else {
        t.lines()
            .map(|l| l.trim_start_matches(['#', '-', '*', ' ', '>']).trim())
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    };
    s.chars().take(200).collect()
}
