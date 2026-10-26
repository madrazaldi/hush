import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, newRecording, nowMs, previewText } from "./db";

const dirs: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), "hush-db-"));
  dirs.push(dir);
  return { dir, db: new Db(join(dir, "t.db")) };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("recording round trip keeps segments and flags", () => {
  const { db } = open();
  const rec = newRecording({
    id: "r1",
    kind: "file",
    title: "T",
    status: "ready",
    segments: [{ start_ms: 0, end_ms: 10, text: "hi", speaker: undefined, words: [] }],
    starred: true,
    speakers: { "Speaker 1": "Ann" },
  });
  db.upsertRecording(rec);
  const got = db.getRecording("r1")!;
  expect(got.starred).toBe(true);
  expect(got.segments).toEqual([{ start_ms: 0, end_ms: 10, text: "hi" }]);
  expect(got.speakers).toEqual({ "Speaker 1": "Ann" });
  expect(db.getRecording("nope")).toBeNull();
});

test("interrupted recordings are repaired on open", () => {
  const { dir, db } = open();
  db.upsertRecording(newRecording({ id: "f", kind: "file", title: "f", status: "processing" }));
  db.upsertRecording(newRecording({ id: "m", kind: "meeting", title: "m", status: "recording" }));
  db.close();
  const again = new Db(join(dir, "t.db"));
  expect(again.getRecording("f")!.status).toBe("error");
  expect(again.getRecording("m")!.status).toBe("ready");
});

test("update does not resurrect a deleted row", () => {
  const { db } = open();
  db.upsertRecording(newRecording({ id: "x", kind: "file", title: "x", status: "ready" }));
  expect(db.updateRecording("x", (r) => (r.title = "y"))!.title).toBe("y");
  db.deleteRecording("x");
  expect(db.updateRecording("x", (r) => (r.title = "z"))).toBeNull();
  expect(db.getRecording("x")).toBeNull();
});

test("list searches and previews", () => {
  const { db } = open();
  db.upsertRecording(newRecording({ id: "a", kind: "meeting", title: "Standup", status: "ready", enhanced: "## Notes\n- shipped it" }));
  db.upsertRecording(
    newRecording({ id: "b", kind: "file", title: "Memo", status: "ready", segments: [{ start_ms: 0, end_ms: 1, text: "budget talk" }] }),
  );
  expect(db.listRecordings("", "").length).toBe(2);
  expect(db.listRecordings("meeting", "")[0].preview).toBe("Notes shipped it");
  const hit = db.listRecordings("", "budget");
  expect(hit.length).toBe(1);
  expect(hit[0].preview).toBe("budget talk ");
});

test("media in use matches exact paths and folders", () => {
  const { db } = open();
  db.upsertRecording(newRecording({ id: "a", kind: "file", title: "a", status: "ready", media_path: "/m/one/a.mp4" }));
  expect(db.mediaInUse("/m/one/a.mp4")).toBe(true);
  expect(db.mediaInUse("/m/one")).toBe(true);
  expect(db.mediaInUse("/m/two")).toBe(false);
});

test("dictation history: search, prune, delete, stats", () => {
  const { db } = open();
  const base = { kind: "dictation", raw_text: "r", app: null, style: null, duration_ms: 1000, stt: null, llm: null, error: null };
  db.insertDictation({ ...base, id: "d1", created_at: nowMs(), text: "hello brave world", audio_path: "/a/1.wav" });
  db.insertDictation({ ...base, id: "d2", created_at: nowMs() - 10 * 86_400_000, text: "old one", audio_path: "/a/2.wav" });
  expect(db.listDictations("brave", 10, 0).map((d) => d.id)).toEqual(["d1"]);
  expect(db.lastDictation()!.id).toBe("d1");
  const s = db.stats();
  expect(s.dictation_count).toBe(2);
  expect(s.dictation_words).toBe(5);
  expect(s.streak_days).toBe(1);
  expect(db.pruneDictations(5)).toEqual(["/a/2.wav"]);
  expect(db.deleteDictation("d1")).toBe("/a/1.wav");
  expect(db.clearDictations()).toEqual([]);
});

test("preview text strips markdown and json", () => {
  expect(previewText('[{"text":"a b"},{"text":"c"}')).toBe("a b c ");
  expect(previewText("# Title\n\n- one\n> two")).toBe("Title one two");
});
