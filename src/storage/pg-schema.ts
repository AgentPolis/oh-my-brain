/**
 * PostgreSQL schema for oh-my-brain v0.7.
 * Replaces the SQLite schema with PGLite-compatible DDL.
 * Includes knowledge graph tables (graph_nodes, graph_edges)
 * and unified stores (events, archive, relations, habits, schemas).
 */

import type { BrainDB } from "./db.js";

export const PG_SCHEMA_VERSION = 5;

const SCHEMA_SQL = `
  -- Schema version tracking
  CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Raw messages with semantic tags
  CREATE TABLE IF NOT EXISTS messages (
    id           SERIAL PRIMARY KEY,
    role         TEXT    NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content      TEXT    NOT NULL,
    level        INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 0 AND 3),
    content_type TEXT    NOT NULL DEFAULT 'conversation'
                        CHECK(content_type IN ('code','tool_result','reasoning','instruction','reference','conversation')),
    confidence   REAL    NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0.0 AND 1.0),
    turn_index   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    compacted_by INTEGER
  );

  -- DAG summary nodes with LOD tiers
  CREATE TABLE IF NOT EXISTS dag_nodes (
    id          SERIAL PRIMARY KEY,
    parent_id   INTEGER REFERENCES dag_nodes(id),
    abstract    TEXT    NOT NULL DEFAULT '',
    overview    TEXT    NOT NULL DEFAULT '',
    detail      TEXT    NOT NULL DEFAULT '',
    source_ids  TEXT    NOT NULL DEFAULT '[]',
    level       INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 0 AND 3),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- L2 Preference store
  CREATE TABLE IF NOT EXISTS preferences (
    id             SERIAL PRIMARY KEY,
    key            TEXT    NOT NULL,
    value          TEXT    NOT NULL,
    confidence     REAL    NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0.0 AND 1.0),
    source_msg_id  INTEGER REFERENCES messages(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_time     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_by  INTEGER REFERENCES preferences(id),
    superseded_at  TIMESTAMPTZ
  );

  -- L3 Directive store
  CREATE TABLE IF NOT EXISTS directives (
    id                SERIAL PRIMARY KEY,
    key               TEXT    NOT NULL,
    value             TEXT    NOT NULL,
    source_msg_id     INTEGER REFERENCES messages(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_time        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_by_user BOOLEAN NOT NULL DEFAULT FALSE,
    evidence_text     TEXT,
    evidence_turn     INTEGER,
    last_referenced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    superseded_by     INTEGER REFERENCES directives(id),
    superseded_at     TIMESTAMPTZ
  );

  -- L1 mention counts for promotion tracking
  CREATE TABLE IF NOT EXISTS mention_counts (
    msg_id      INTEGER PRIMARY KEY REFERENCES messages(id),
    key         TEXT    NOT NULL,
    count       INTEGER NOT NULL DEFAULT 1,
    last_turn   INTEGER NOT NULL DEFAULT 0
  );

  -- Knowledge Graph tables
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    label      TEXT NOT NULL,
    detail     TEXT,
    ts         TIMESTAMPTZ,
    ts_precision TEXT DEFAULT 'exact',
    category   TEXT,
    sentiment  TEXT,
    source_id  TEXT,
    metadata   JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS graph_edges (
    id         TEXT PRIMARY KEY,
    from_id    TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    to_id      TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    metadata   JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  -- Unified events table (replaces events.jsonl)
  CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    ts            TIMESTAMPTZ,
    ts_ingest     TIMESTAMPTZ DEFAULT NOW(),
    ts_precision  TEXT DEFAULT 'exact',
    what          TEXT NOT NULL,
    detail        TEXT,
    category      TEXT,
    who           TEXT[],
    "where"       TEXT,
    sentiment     TEXT,
    viewpoint     TEXT,
    insight       TEXT,
    source_text   TEXT,
    session_id    TEXT,
    turn_index    INTEGER,
    graph_node_id TEXT REFERENCES graph_nodes(id)
  );

  -- Archive table (replaces archive.jsonl)
  CREATE TABLE IF NOT EXISTS archive (
    id         TEXT PRIMARY KEY,
    ts         TIMESTAMPTZ,
    ts_ingest  TIMESTAMPTZ DEFAULT NOW(),
    role       TEXT,
    content    TEXT NOT NULL,
    summary    TEXT,
    level      INTEGER,
    turn_index INTEGER,
    session_id TEXT,
    tags       TEXT[]
  );

  -- Relations table (replaces relations.json)
  CREATE TABLE IF NOT EXISTS relations (
    id            TEXT PRIMARY KEY,
    person        TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    domain        TEXT NOT NULL,
    level         TEXT NOT NULL DEFAULT 'medium',
    evidence      TEXT[],
    notes         TEXT,
    last_updated  TIMESTAMPTZ DEFAULT NOW(),
    graph_node_id TEXT REFERENCES graph_nodes(id)
  );

  -- Habits table (replaces habits.json)
  CREATE TABLE IF NOT EXISTS habits (
    id            TEXT PRIMARY KEY,
    pattern       TEXT NOT NULL,
    confidence    REAL DEFAULT 0.5,
    evidence      TEXT[],
    occurrences   INTEGER DEFAULT 0,
    first_seen    TIMESTAMPTZ DEFAULT NOW(),
    graph_node_id TEXT REFERENCES graph_nodes(id)
  );

  -- Schemas table (replaces schemas.json)
  CREATE TABLE IF NOT EXISTS schemas (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    description    TEXT,
    steps          TEXT[],
    category       TEXT,
    confidence     REAL DEFAULT 0.5,
    first_detected TIMESTAMPTZ DEFAULT NOW(),
    last_updated   TIMESTAMPTZ DEFAULT NOW(),
    graph_node_id  TEXT REFERENCES graph_nodes(id)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_messages_level      ON messages(level);
  CREATE INDEX IF NOT EXISTS idx_messages_turn       ON messages(turn_index);
  CREATE INDEX IF NOT EXISTS idx_messages_type       ON messages(content_type);
  CREATE INDEX IF NOT EXISTS idx_dag_parent          ON dag_nodes(parent_id);
  CREATE INDEX IF NOT EXISTS idx_dag_level           ON dag_nodes(level);
  CREATE INDEX IF NOT EXISTS idx_preferences_key     ON preferences(key) WHERE superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_directives_key      ON directives(key) WHERE superseded_by IS NULL;
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_type     ON graph_nodes(type);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_ts       ON graph_nodes(ts);
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_category ON graph_nodes(category);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_from     ON graph_edges(from_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_to       ON graph_edges(to_id);
  CREATE INDEX IF NOT EXISTS idx_graph_edges_type     ON graph_edges(type);
  CREATE INDEX IF NOT EXISTS idx_events_ts            ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_category      ON events(category);
  CREATE INDEX IF NOT EXISTS idx_archive_ts           ON archive(ts);
`;

/**
 * Initialize the PostgreSQL schema. Idempotent — safe to call on every startup.
 */
export async function initPgSchema(db: BrainDB): Promise<void> {
  await db.exec(SCHEMA_SQL);

  // Persist current schema version
  await db.exec(
    `INSERT INTO schema_meta (key, value) VALUES ('version', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(PG_SCHEMA_VERSION)],
  );
}

/**
 * Check database health. Returns true if the database responds.
 */
export async function checkPgIntegrity(db: BrainDB): Promise<boolean> {
  const rows = await db.query<{ ok: number }>("SELECT 1 AS ok");
  return rows.length === 1 && rows[0].ok === 1;
}
