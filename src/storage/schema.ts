/**
 * SQLite schema for oh-my-brain.
 * Extends lossless-claw compatible structure with L-level columns,
 * preference store, directive store, and DAG LOD tiers.
 */

import type Database from "better-sqlite3";

export const SCHEMA_VERSION = 4;

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000"); // 5s retry on SQLITE_BUSY

  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Raw messages with semantic tags
    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      role         TEXT    NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content      TEXT    NOT NULL,
      level        INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 0 AND 3),
      content_type TEXT    NOT NULL DEFAULT 'conversation'
                          CHECK(content_type IN ('code','tool_result','reasoning','instruction','reference','conversation')),
      confidence   REAL    NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0.0 AND 1.0),
      turn_index   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      compacted_by INTEGER REFERENCES dag_nodes(id)
    );

    -- DAG summary nodes with LOD tiers
    CREATE TABLE IF NOT EXISTS dag_nodes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id   INTEGER REFERENCES dag_nodes(id),
      abstract    TEXT    NOT NULL DEFAULT '',
      overview    TEXT    NOT NULL DEFAULT '',
      detail      TEXT    NOT NULL DEFAULT '',
      source_ids  TEXT    NOT NULL DEFAULT '[]',
      level       INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 0 AND 3),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- L2 Preference store
    CREATE TABLE IF NOT EXISTS preferences (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT    NOT NULL,
      value          TEXT    NOT NULL,
      confidence     REAL    NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0.0 AND 1.0),
      source_msg_id  INTEGER REFERENCES messages(id),
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      superseded_by  INTEGER REFERENCES preferences(id),
      superseded_at  TEXT
    );

    -- L3 Directive store
    CREATE TABLE IF NOT EXISTS directives (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      key               TEXT    NOT NULL,
      value             TEXT    NOT NULL,
      source_msg_id     INTEGER REFERENCES messages(id),
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      confirmed_by_user INTEGER NOT NULL DEFAULT 0,
      evidence_text     TEXT,
      evidence_turn     INTEGER,
      last_referenced_at TEXT   NOT NULL DEFAULT (datetime('now')),
      superseded_by     INTEGER REFERENCES directives(id),
      superseded_at     TEXT
    );

    -- L1 mention counts for promotion tracking
    CREATE TABLE IF NOT EXISTS mention_counts (
      msg_id      INTEGER PRIMARY KEY REFERENCES messages(id),
      key         TEXT    NOT NULL,
      count       INTEGER NOT NULL DEFAULT 1,
      last_turn   INTEGER NOT NULL DEFAULT 0
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_level      ON messages(level);
    CREATE INDEX IF NOT EXISTS idx_messages_turn       ON messages(turn_index);
    CREATE INDEX IF NOT EXISTS idx_messages_type       ON messages(content_type);
    CREATE INDEX IF NOT EXISTS idx_dag_parent          ON dag_nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_dag_level           ON dag_nodes(level);
    CREATE INDEX IF NOT EXISTS idx_preferences_key     ON preferences(key) WHERE superseded_by IS NULL;
    CREATE INDEX IF NOT EXISTS idx_directives_key      ON directives(key)  WHERE superseded_by IS NULL;
  `);

  // Version-gated migrations
  const currentVersion = (db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
    .get() as { value: string } | undefined)?.value ?? "1";

  if (Number(currentVersion) < 2) {
    const cols = (db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>)
      .map(c => c.name);
    if (!cols.includes("compacted_by")) {
      db.exec(`ALTER TABLE messages ADD COLUMN compacted_by INTEGER REFERENCES dag_nodes(id)`);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '2')`).run();
  }

  if (Number(currentVersion) < 3) {
    const cols = (db.prepare(`PRAGMA table_info(directives)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    if (!cols.includes("evidence_text")) {
      db.exec(`ALTER TABLE directives ADD COLUMN evidence_text TEXT`);
    }
    if (!cols.includes("evidence_turn")) {
      db.exec(`ALTER TABLE directives ADD COLUMN evidence_turn INTEGER`);
    }
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '3')`).run();
  }

  if (Number(currentVersion) < 4) {
    const cols = (db.prepare(`PRAGMA table_info(directives)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    if (!cols.includes("last_referenced_at")) {
      db.exec(`ALTER TABLE directives ADD COLUMN last_referenced_at TEXT`);
      db.exec(
        `UPDATE directives
         SET last_referenced_at = COALESCE(last_referenced_at, created_at)
         WHERE last_referenced_at IS NULL`
      );
    }
    db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '4')`).run();
  }

  // Persist current schema version after migrations.
  db.prepare(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)`
  ).run(String(SCHEMA_VERSION));
}

/**
 * Check database integrity. Returns true if OK.
 */
export function checkIntegrity(db: Database.Database): boolean {
  const result = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  return result.length === 1 && result[0].integrity_check === "ok";
}

/**
 * Migrate from lossless-claw database.
 * Adds oh-my-brain columns to existing tables if they don't exist.
 */
export function migrateFromLosslessClaw(db: Database.Database): void {
  const existingColumns = db
    .prepare(`PRAGMA table_info(messages)`)
    .all() as Array<{ name: string }>;

  const colNames = new Set(existingColumns.map((c) => c.name));

  if (!colNames.has("level")) {
    db.exec(`ALTER TABLE messages ADD COLUMN level INTEGER NOT NULL DEFAULT 1`);
  }
  if (!colNames.has("content_type")) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'conversation'`
    );
  }
  if (!colNames.has("confidence")) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5`
    );
  }
  if (!colNames.has("turn_index")) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN turn_index INTEGER NOT NULL DEFAULT 0`
    );
  }
  if (!colNames.has("compacted_by")) {
    db.exec(`ALTER TABLE messages ADD COLUMN compacted_by INTEGER REFERENCES dag_nodes(id)`);
  }

  // Create tables that don't exist in lossless-claw
  initSchema(db);
}
