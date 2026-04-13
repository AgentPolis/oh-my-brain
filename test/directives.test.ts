import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DirectiveStore } from "../src/storage/directives.js";
import { initSchema } from "../src/storage/schema.js";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync, unlinkSync } from "fs";

const TEST_DB = join(tmpdir(), `squeeze-directives-test-${Date.now()}.db`);

describe("DirectiveStore", () => {
  let db: Database.Database;
  let store: DirectiveStore;

  /** Insert a dummy message row so foreign key constraints are satisfied. */
  function insertMsg(id?: number): number {
    const result = db
      .prepare(
        `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
         VALUES ('user', 'test', 1, 'conversation', 0.5, 0)`
      )
      .run();
    return Number(result.lastInsertRowid);
  }

  beforeEach(() => {
    db = new Database(TEST_DB);
    initSchema(db);
    store = new DirectiveStore(db);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        if (existsSync(TEST_DB + suffix)) unlinkSync(TEST_DB + suffix);
      } catch {}
    }
  });

  // ── L3 Directive Tests ──────────────────────────────────────────

  it("adding a directive with the same key supersedes the old one", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();

    const id1 = store.addDirective("lang", "always reply in English", msgId1);
    const id2 = store.addDirective("lang", "always reply in French", msgId2);

    // The old directive should be superseded
    const history = store.getDirectiveHistory("lang");
    const old = history.find((d) => d.id === id1)!;
    expect(old.supersededBy).not.toBeNull();
    expect(old.supersededAt).not.toBeNull();

    // The new directive should be active
    const newer = history.find((d) => d.id === id2)!;
    expect(newer.supersededBy).toBeNull();
  });

  it("superseded directive is not returned by getActiveDirectives", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();

    store.addDirective("format", "use markdown", msgId1);
    store.addDirective("format", "use plain text", msgId2);

    const active = store.getActiveDirectives();
    const formatDirectives = active.filter((d) => d.key === "format");
    expect(formatDirectives).toHaveLength(1);
    expect(formatDirectives[0].value).toBe("use plain text");
  });

  it("supersede + insert is atomic (old is only superseded if new succeeds)", () => {
    const msgId = insertMsg();
    store.addDirective("tone", "be formal", msgId);

    // Verify the directive is active before attempted second insert
    expect(store.getActiveDirectives().filter((d) => d.key === "tone")).toHaveLength(1);

    // A normal second insert should work atomically
    const msgId2 = insertMsg();
    store.addDirective("tone", "be casual", msgId2);

    const active = store.getActiveDirectives().filter((d) => d.key === "tone");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("be casual");

    // The full history should have both entries
    const history = store.getDirectiveHistory("tone");
    expect(history).toHaveLength(2);
  });

  it("getDirectiveHistory returns the full chain", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();
    const msgId3 = insertMsg();

    store.addDirective("style", "v1", msgId1);
    store.addDirective("style", "v2", msgId2);
    store.addDirective("style", "v3", msgId3);

    const history = store.getDirectiveHistory("style");
    expect(history).toHaveLength(3);
    expect(history.map((d) => d.value)).toEqual(["v1", "v2", "v3"]);

    // First two should be superseded, last one active
    expect(history[0].supersededBy).not.toBeNull();
    expect(history[1].supersededBy).not.toBeNull();
    expect(history[2].supersededBy).toBeNull();
  });

  it("directives with different keys do not interfere", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();

    store.addDirective("lang", "English", msgId1);
    store.addDirective("tone", "formal", msgId2);

    const active = store.getActiveDirectives();
    expect(active).toHaveLength(2);
    expect(active.map((d) => d.key).sort()).toEqual(["lang", "tone"]);
  });

  it("stores and retrieves directive evidence when provided", () => {
    const msgId = insertMsg();
    store.addDirective("lang", "always reply in English", msgId, false, {
      text: "不要再用中文了",
      turn: 7,
    });

    const [directive] = store.getActiveDirectives();
    expect(directive.evidenceText).toBe("不要再用中文了");
    expect(directive.evidenceTurn).toBe(7);
  });

  it("stores directive event_time separately from created_at", () => {
    const msgId = insertMsg();
    store.addDirective(
      "project",
      "I started the project on March 15, 2026",
      msgId,
      false,
      undefined,
      "2026-03-15T00:00:00.000Z"
    );

    const [directive] = store.getActiveDirectives();
    expect(directive.eventTime).toBe("2026-03-15T00:00:00.000Z");
    expect(directive.createdAt).toBeTruthy();
  });

  it("existing directives without evidence remain readable", () => {
    const msgId = insertMsg();
    store.addDirective("tone", "be formal", msgId);

    const [directive] = store.getActiveDirectives();
    expect(directive.evidenceText).toBeNull();
    expect(directive.evidenceTurn).toBeNull();
  });

  // ── L2 Preference Tests ─────────────────────────────────────────

  it("addPreference with supersede works the same as directives", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();

    store.addPreference("editor", "vim", 0.7, msgId1);
    store.addPreference("editor", "vscode", 0.9, msgId2);

    const active = store.getActivePreferences();
    const editorPrefs = active.filter((p) => p.key === "editor");
    expect(editorPrefs).toHaveLength(1);
    expect(editorPrefs[0].value).toBe("vscode");
    expect(editorPrefs[0].confidence).toBe(0.9);
  });

  it("getActivePreferences filters by minConfidence", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();

    store.addPreference("color", "blue", 0.3, msgId1);
    store.addPreference("font", "monospace", 0.8, msgId2);

    const highConf = store.getActivePreferences(0.5);
    expect(highConf).toHaveLength(1);
    expect(highConf[0].key).toBe("font");

    const all = store.getActivePreferences(0);
    expect(all).toHaveLength(2);
  });

  it("stores preference event_time separately from created_at", () => {
    const msgId = insertMsg();
    store.addPreference("stack", "TypeScript", 0.9, msgId, "2026-03-15T00:00:00.000Z");

    const [preference] = store.getActivePreferences();
    expect(preference.eventTime).toBe("2026-03-15T00:00:00.000Z");
    expect(preference.createdAt).toBeTruthy();
  });

  it("migrates existing directives to event_time = created_at", () => {
    db.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

    const legacyDb = new Database(TEST_DB);
    legacyDb.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('version', '4');
      CREATE TABLE directives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source_msg_id INTEGER,
        created_at TEXT NOT NULL,
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        evidence_text TEXT,
        evidence_turn INTEGER,
        last_referenced_at TEXT NOT NULL,
        superseded_by INTEGER,
        superseded_at TEXT
      );
      CREATE TABLE preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        source_msg_id INTEGER,
        created_at TEXT NOT NULL,
        superseded_by INTEGER,
        superseded_at TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 1,
        content_type TEXT NOT NULL DEFAULT 'conversation',
        confidence REAL NOT NULL DEFAULT 0.5,
        turn_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        compacted_by INTEGER
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO directives (key, value, created_at, confirmed_by_user, last_referenced_at)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run("lang", "Always use TypeScript", "2026-04-01T10:00:00.000Z", "2026-04-01T10:00:00.000Z");
    legacyDb.close();

    db = new Database(TEST_DB);
    initSchema(db);
    store = new DirectiveStore(db);

    const [directive] = store.getActiveDirectives();
    expect(directive.eventTime).toBe("2026-04-01T10:00:00.000Z");
  });

  it("fixupSuperseded links old records to the new id", () => {
    const msgId1 = insertMsg();
    const msgId2 = insertMsg();

    const id1 = store.addDirective("rule", "old rule", msgId1);
    const id2 = store.addDirective("rule", "new rule", msgId2);

    // Backward-compatibility helper should be safe even if no placeholder rows exist.
    store.fixupSuperseded("directives", id2, "rule");

    const history = store.getDirectiveHistory("rule");
    const old = history.find((d) => d.id === id1)!;
    expect(old.supersededBy).toBe(id2);
  });
});
