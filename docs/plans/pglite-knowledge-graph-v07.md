# Plan: PGLite + Knowledge Graph (v0.7)

> Codex execution plan. Read this file, then implement each task in order.
> Each task has acceptance criteria and gotchas. Commit after each task.
>
> Context: oh-my-brain v0.6.1 at `/Users/hsing/MySquad/squeeze-claw`.
> 511 tests passing, lint clean. Currently uses better-sqlite3 for
> directives/preferences/messages. JSONL files for events/archive/actions.
>
> **This is a foundational architecture change:**
> 1. Replace better-sqlite3 with PGLite (embedded PostgreSQL)
> 2. Add a unified knowledge graph (nodes + edges)
> 3. Add db abstraction layer (PGLite now, Supabase later)
>
> Why: Enterprise scalability. "Used SQLite" is an attack vector
> competitors will use. PGLite is real PostgreSQL (zero setup) that
> can migrate to Supabase/managed Postgres with zero code changes.

---

## Architecture Before vs After

```
BEFORE (v0.6.1):
  .squeeze/memory.db          ← better-sqlite3 (directives, preferences, messages, dag)
  .squeeze/archive.jsonl      ← append-only file
  .squeeze/events.jsonl       ← append-only file
  .squeeze/actions.jsonl      ← append-only file
  .squeeze/candidates.json    ← JSON file
  .squeeze/relations.json     ← JSON file
  .squeeze/schemas.json       ← JSON file
  .squeeze/habits.json        ← JSON file
  .squeeze/timeline.json      ← JSON file
  MEMORY.md                   ← portable plain text

  Problems:
  - 7 different storage formats (SQLite + JSONL + JSON)
  - No unified query across stores
  - Can't do graph traversal
  - Can't scale to team/enterprise use
  - "Uses SQLite" is an attack surface

AFTER (v0.7):
  .squeeze/brain.pg/          ← PGLite data directory (real PostgreSQL)
    ├── All tables in one database
    ├── graph_nodes + graph_edges (knowledge graph)
    ├── pgvector extension ready (for future embedding search)
    └── Same SQL works on Supabase (zero migration effort)
  MEMORY.md                   ← portable plain text (unchanged)

  Gains:
  - One database for everything
  - Unified knowledge graph with real SQL queries
  - graph traversal via recursive CTE
  - PGLite → Supabase migration = change connection string
  - "Uses PostgreSQL" sounds enterprise-grade
```

---

## Task 1: DB Abstraction Layer

**New file:** `src/storage/db.ts`

### What to do

Create an abstraction layer so all database access goes through an
interface. This is the foundation — every subsequent task uses it.

```typescript
/**
 * Database abstraction for oh-my-brain.
 * Currently backed by PGLite (embedded PostgreSQL).
 * Can be swapped to Supabase/managed PostgreSQL by implementing
 * the same interface with a pg client.
 */

export interface BrainDB {
  /** Run a query that returns rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Run a statement that doesn't return rows (INSERT, UPDATE, DELETE). */
  exec(sql: string, params?: unknown[]): Promise<void>;

  /** Run multiple statements in a transaction. */
  transaction(fn: (db: BrainDB) => Promise<void>): Promise<void>;

  /** Close the database connection. */
  close(): Promise<void>;

  /** Get the engine name for diagnostics. */
  readonly engine: "pglite" | "postgres" | "supabase";
}

export interface BrainDBFactory {
  /** Create or open a database at the given path. */
  create(dataDir: string): Promise<BrainDB>;
}
```

**PGLite implementation:**

```typescript
import { PGlite } from "@electric-sql/pglite";

export class PGLiteDB implements BrainDB {
  readonly engine = "pglite" as const;
  private db: PGlite;

  constructor(db: PGlite) {
    this.db = db;
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.db.query<T>(sql, params);
    return result.rows;
  }

  async exec(sql: string, params?: unknown[]): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction(fn: (db: BrainDB) => Promise<void>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const wrappedTx: BrainDB = {
        engine: "pglite",
        query: async (sql, params) => (await tx.query(sql, params)).rows,
        exec: async (sql) => { await tx.exec(sql); },
        transaction: async (innerFn) => innerFn(wrappedTx),
        close: async () => {},
      };
      await fn(wrappedTx);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export const pgliteFactory: BrainDBFactory = {
  async create(dataDir: string): Promise<BrainDB> {
    const db = new PGlite(dataDir);
    return new PGLiteDB(db);
  },
};
```

### Acceptance criteria

- `BrainDB` interface defined with query, exec, transaction, close
- `PGLiteDB` implements the interface using `@electric-sql/pglite`
- Factory creates a PGLite database at a given directory
- Simple test: create db, exec CREATE TABLE, query SELECT
- New test file: `test/db.test.ts` with at least 8 tests

### Gotchas

- **PGLite is async.** All methods return Promises. The current
  better-sqlite3 code is sync. Migration (Task 3) needs to add
  async/await throughout.
- **Install:** `npm install @electric-sql/pglite`
- **PGLite stores data in a directory**, not a single file like
  SQLite. Use `.squeeze/brain.pg/` as the data directory.
- **PGLite parameterized queries use $1, $2** (PostgreSQL style),
  not `?` (SQLite style). All queries need conversion.

---

## Task 2: Schema Migration — PostgreSQL version

**New file:** `src/storage/pg-schema.ts`

### What to do

Translate the existing SQLite schema to PostgreSQL and add the
knowledge graph tables.

```sql
-- Existing tables (translated from SQLite)
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  content_type TEXT NOT NULL DEFAULT 'conversation',
  confidence REAL NOT NULL DEFAULT 0.5,
  turn_index INTEGER NOT NULL DEFAULT 0,
  compacted_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS directives (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source_msg_id INTEGER,
  confirmed_by_user BOOLEAN DEFAULT FALSE,
  superseded_by INTEGER,
  superseded_at TIMESTAMPTZ,
  evidence_text TEXT,
  evidence_turn INTEGER,
  event_time TIMESTAMPTZ,
  last_referenced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS preferences (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  source_msg_id INTEGER,
  superseded_by INTEGER,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dag_nodes (
  id SERIAL PRIMARY KEY,
  abstract TEXT NOT NULL,
  overview TEXT,
  detail TEXT,
  source_ids TEXT,
  min_turn INTEGER,
  max_turn INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- NEW: Knowledge Graph tables
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,          -- 'event', 'directive', 'person', 'viewpoint', 'habit', 'schema'
  label TEXT NOT NULL,
  detail TEXT,
  ts TIMESTAMPTZ,
  ts_precision TEXT DEFAULT 'exact',
  category TEXT,
  sentiment TEXT,
  source_id TEXT,              -- references the original store entry
  metadata JSONB,              -- flexible extra data
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,           -- 'caused', 'triggered', 'involved_in', 'supersedes', 'refines', 'contradicts', 'trust', 'scopedTo'
  confidence REAL DEFAULT 0.5,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(type);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_ts ON graph_nodes(ts);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_category ON graph_nodes(category);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_type ON graph_edges(type);

-- NEW: Unified events table (replaces events.jsonl)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ,
  ts_ingest TIMESTAMPTZ DEFAULT NOW(),
  ts_precision TEXT DEFAULT 'exact',
  what TEXT NOT NULL,
  detail TEXT,
  category TEXT,
  who TEXT[],                   -- PostgreSQL array type!
  "where" TEXT,
  sentiment TEXT,
  viewpoint TEXT,
  insight TEXT,
  source_text TEXT,
  session_id TEXT,
  turn_index INTEGER,
  graph_node_id TEXT REFERENCES graph_nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(category);

-- NEW: Archive table (replaces archive.jsonl)
CREATE TABLE IF NOT EXISTS archive (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ,
  ts_ingest TIMESTAMPTZ DEFAULT NOW(),
  role TEXT,
  content TEXT NOT NULL,
  summary TEXT,
  level INTEGER,
  turn_index INTEGER,
  session_id TEXT,
  tags TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_archive_ts ON archive(ts);

-- NEW: Relations table (replaces relations.json)
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  person TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  domain TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'medium',
  evidence TEXT[],
  notes TEXT,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  graph_node_id TEXT REFERENCES graph_nodes(id)
);

-- NEW: Habits table (replaces habits.json)
CREATE TABLE IF NOT EXISTS habits (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  evidence TEXT[],
  occurrences INTEGER DEFAULT 0,
  first_seen TIMESTAMPTZ DEFAULT NOW(),
  graph_node_id TEXT REFERENCES graph_nodes(id)
);

-- NEW: Schemas table (replaces schemas.json)
CREATE TABLE IF NOT EXISTS schemas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT[],
  category TEXT,
  confidence REAL DEFAULT 0.5,
  first_detected TIMESTAMPTZ DEFAULT NOW(),
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  graph_node_id TEXT REFERENCES graph_nodes(id)
);
```

```typescript
export async function initPgSchema(db: BrainDB): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
```

### Acceptance criteria

- All existing tables translated to PostgreSQL syntax
- Knowledge graph tables (graph_nodes, graph_edges) created
- Events, archive, relations, habits, schemas tables created
- All tables have appropriate indexes
- PostgreSQL-specific features used: TIMESTAMPTZ, TEXT[], JSONB, SERIAL
- `initPgSchema(db)` is idempotent (IF NOT EXISTS everywhere)
- New test: verify schema creation on a fresh PGLite db

### Gotchas

- **PostgreSQL syntax differences from SQLite:**
  - `AUTOINCREMENT` → `SERIAL`
  - `BOOLEAN` is a real type (not INTEGER)
  - `TEXT[]` is a real array type
  - `JSONB` for flexible metadata
  - `TIMESTAMPTZ` instead of TEXT for dates
  - `$1, $2` instead of `?` for params
- **"where" is a reserved word in SQL.** Quote it: `"where"`.
- **graph_node_id links everything.** Events, relations, habits,
  schemas all point back to their graph node. This is how the
  knowledge graph unifies everything.

---

## Task 3: Migrate Stores to BrainDB

**Files:** `src/storage/messages.ts`, `src/storage/directives.ts`,
`src/storage/dag.ts`, `src/engine.ts`, `src/storage/schema.ts`

### What to do

Replace all `better-sqlite3` usage with the `BrainDB` interface.

**Key changes:**

1. All methods become `async`
2. `?` params become `$1, $2, ...`
3. `db.prepare(sql).run(...)` becomes `await db.exec(sql, [...])`
4. `db.prepare(sql).all(...)` becomes `await db.query(sql, [...])`
5. `db.prepare(sql).get(...)` becomes `(await db.query(sql, [...]))[0]`

**Example migration:**

```typescript
// BEFORE (better-sqlite3, sync):
addDirective(key: string, value: string, sourceMsgId: number): void {
  this.db.prepare(
    "INSERT INTO directives (key, value, source_msg_id) VALUES (?, ?, ?)"
  ).run(key, value, sourceMsgId);
}

// AFTER (BrainDB, async):
async addDirective(key: string, value: string, sourceMsgId: number): Promise<void> {
  await this.db.exec(
    "INSERT INTO directives (key, value, source_msg_id) VALUES ($1, $2, $3)",
    [key, value, sourceMsgId]
  );
}
```

**Engine changes:**

`SqueezeContextEngine` methods that call stores must become async.
The ContextEngine interface methods are already async (return Promise),
so this is mostly adding await.

`bootstrap(dbPath)` changes:

```typescript
// BEFORE:
async bootstrap(dbPath: string): Promise<void> {
  this.db = new Database(dbPath);
  initSchema(this.db);
  this.messages = new MessageStore(this.db);
  ...
}

// AFTER:
async bootstrap(dbPath: string): Promise<void> {
  this.brainDb = await pgliteFactory.create(dbPath);
  await initPgSchema(this.brainDb);
  this.messages = new MessageStore(this.brainDb);
  ...
}
```

### Acceptance criteria

- All `better-sqlite3` imports removed from src/ and cli/ files
- All store methods are async
- All SQL uses PostgreSQL syntax ($1 params, PostgreSQL types)
- Engine bootstrap creates PGLite database
- All existing tests pass (updated to use async/await)
- `npm uninstall better-sqlite3` — no more native binary dependency!
- Build succeeds without better-sqlite3

### Gotchas

- **This is the biggest task.** Touch every store file + engine + tests.
  But it's mechanical — find/replace `?` with `$N`, add async/await.
- **better-sqlite3 is sync, PGLite is async.** Every caller up the
  chain needs async/await. This cascades through the codebase.
- **Tests need async setup/teardown.** Each test creates a PGLite
  in-memory db (or temp dir), needs cleanup.
- **Remove better-sqlite3 from package.json** after migration.
  This eliminates the native binary ABI headache forever.
- **compress-core.ts and mcp-server.ts are CLI entry points.**
  They may need top-level await or async main().

---

## Task 4: Knowledge Graph Population

**New file:** `src/storage/graph.ts`

### What to do

Create the GraphStore that populates and queries the unified
knowledge graph from existing stores.

```typescript
export class GraphStore {
  constructor(private db: BrainDB) {}

  /** Add a node to the graph. */
  async addNode(node: {
    id: string;
    type: string;
    label: string;
    detail?: string;
    ts?: string;
    category?: string;
    sentiment?: string;
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /** Add an edge between two nodes. */
  async addEdge(edge: {
    id: string;
    fromId: string;
    toId: string;
    type: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;

  /** Find nodes connected to a given node (1-hop). */
  async getNeighbors(nodeId: string, edgeType?: string): Promise<GraphNode[]>;

  /** Find path between two nodes (multi-hop, up to maxDepth). */
  async findPath(fromId: string, toId: string, maxDepth?: number): Promise<GraphNode[]>;

  /** Search nodes by type + keyword. */
  async searchNodes(opts: {
    type?: string;
    keyword?: string;
    category?: string;
    limit?: number;
  }): Promise<GraphNode[]>;

  /** Get graph summary for brain_recall. */
  async getSummary(): Promise<{
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
  }>;

  /** Compact timeline string from graph nodes. */
  async toTimelineString(limit?: number): Promise<string>;
}
```

**Graph population** — when events/directives/relations/habits/schemas
are created, also create graph nodes and edges:

```typescript
// When an event is extracted:
await graph.addNode({
  id: `evt-${event.id}`,
  type: "event",
  label: event.what,
  detail: event.detail,
  ts: event.ts,
  category: event.category,
  sentiment: event.sentiment,
});

// Link person to event:
for (const person of event.who) {
  await graph.addNode({ id: `per-${person}`, type: "person", label: person });
  await graph.addEdge({
    id: `edge-${event.id}-${person}`,
    fromId: `per-${person}`,
    toId: `evt-${event.id}`,
    type: "involved_in",
  });
}

// Link event to directive it triggered:
// (if event caused a new directive, link them)
await graph.addEdge({
  id: `edge-${event.id}-${directive.id}`,
  fromId: `evt-${event.id}`,
  toId: `dir-${directive.key}`,
  type: "triggered",
});
```

**Multi-hop query** (the thing Hindsight/Zep have that we don't):

```sql
-- Find all events related to a person within 2 hops
WITH RECURSIVE connected AS (
  SELECT to_id AS node_id, 1 AS depth
  FROM graph_edges
  WHERE from_id = $1 AND type = 'involved_in'

  UNION ALL

  SELECT e.to_id, c.depth + 1
  FROM graph_edges e
  JOIN connected c ON e.from_id = c.node_id
  WHERE c.depth < $2
)
SELECT DISTINCT n.*
FROM connected c
JOIN graph_nodes n ON n.id = c.node_id;
```

### Acceptance criteria

- GraphStore can add nodes, add edges, query neighbors
- Multi-hop traversal via recursive CTE works
- searchNodes returns nodes by type/keyword/category
- getSummary returns node/edge counts by type
- Graph is populated when events/directives/relations are created
- New test: `test/graph.test.ts` with at least 12 tests

### Gotchas

- **Node IDs are prefixed by type.** `evt-`, `dir-`, `per-`, `hab-`,
  `sch-`, `vpt-`. This prevents collisions across stores.
- **Don't duplicate data.** Graph nodes have `label` and `sourceId`.
  The detail lives in the original store (events table, directives
  table). Graph is for traversal, not storage.
- **Edge confidence starts at 0.5.** Increases when more evidence
  supports the relationship.

---

## Task 5: brain_search Graph-Powered

**File:** `cli/mcp-server.ts`

### What to do

Enhance brain_search to use the knowledge graph for multi-hop queries.

**New capability — "connected" search:**

```
brain_search --query "Tom"
  → Step 1: Find graph node for Tom
  → Step 2: Find all connected nodes (events, directives)
  → Step 3: Return: "Tom → involved_in → car service (Mar 14)
                      Tom → trust(high, tech)
                      car service → triggered → 'check reliability before buying'"
```

This is what Hindsight does at 91.4%. We can do the same with
PostgreSQL recursive CTE.

**brain_search new arg:**

```typescript
connected: {
  type: "string",
  description: "Find everything connected to this entity (person, event, topic). Uses knowledge graph traversal.",
}
```

### Acceptance criteria

- brain_search --connected "Tom" returns graph neighbors
- Multi-hop results show the relationship chain
- brain_status includes graph_nodes and graph_edges counts
- brain_recall summary includes graph summary

---

## Task 6: JSONL → PostgreSQL Data Migration

**New file:** `cli/migrate-to-pg.ts`

### What to do

One-time migration script that reads existing JSONL/JSON files and
imports them into the new PostgreSQL tables.

```bash
oh-my-brain migrate-to-pg
```

Reads:
- `.squeeze/archive.jsonl` → `archive` table
- `.squeeze/events.jsonl` → `events` table
- `.squeeze/actions.jsonl` → keep as JSONL (audit trail, append-only)
- `.squeeze/relations.json` → `relations` table
- `.squeeze/habits.json` → `habits` table
- `.squeeze/schemas.json` → `schemas` table
- `.squeeze/candidates.json` → keep as JSON (simple, small)

Also:
- Creates graph nodes/edges from all imported data
- Renames old `.squeeze/memory.db` to `.squeeze/memory.db.bak`
- Creates `.squeeze/brain.pg/` with all data

### Acceptance criteria

- `oh-my-brain migrate-to-pg` imports all JSONL/JSON data
- Graph nodes/edges are created for all imported entities
- Old files are preserved as .bak (not deleted)
- Idempotent — running twice doesn't duplicate data
- New test: verify migration from mock JSONL files

---

## Task 7: Version Bump + README + CHANGELOG

**Files:** `README.md`, `CHANGELOG.md`, `package.json`

### What to do

1. Version bump to `0.7.0`

2. **README** — update:
```markdown
## Architecture

oh-my-brain uses PGLite (embedded PostgreSQL) — real PostgreSQL
running in your Node.js process. Zero setup, zero Docker, zero
cloud. But when you need to scale, change one connection string
to migrate to Supabase or any managed PostgreSQL.

- **Knowledge Graph** — Every memory (event, directive, person,
  habit, schema) is a node. Every relationship is an edge.
  Multi-hop traversal finds connections you didn't know existed.
- **PostgreSQL-native** — TEXT[], JSONB, TIMESTAMPTZ, recursive
  CTE, proper indexes. Not SQLite pretending to be a database.
- **Enterprise-ready** — Same schema works on PGLite (local),
  PostgreSQL (self-hosted), or Supabase (managed cloud).
```

3. **CHANGELOG** — add `## [0.7.0]` entry

4. **Remove better-sqlite3 from package.json dependencies**

### Acceptance criteria

- Version 0.7.0 everywhere
- better-sqlite3 not in dependencies
- @electric-sql/pglite in dependencies
- README describes PGLite + knowledge graph

---

## Execution order

```
Phase A:
  Task 1 (DB abstraction layer)

Phase B (depends on Task 1):
  Task 2 (PostgreSQL schema)

Phase C (depends on Task 1 + 2):
  Task 3 (Migrate stores to BrainDB) ← biggest task

Phase D (depends on Task 3):
  Task 4 (Knowledge graph population)
  Task 5 (brain_search graph-powered)
  Task 6 (Data migration script)

Phase E (depends on all):
  Task 7 (Version bump + README)
```

## Verification

```bash
npm run lint
npm run test:run
npm run build
node dist/cli/brain.js version   # 0.7.0
# Verify no better-sqlite3:
node -e "require('better-sqlite3')" 2>&1 | grep -q "Cannot find" && echo "REMOVED OK"
```

## Why This Matters

```
Before (v0.6.1):
  "It uses SQLite" → enterprise concern
  "Can it scale?" → no
  "Knowledge graph?" → no, just flat files

After (v0.7):
  "It uses PostgreSQL" → enterprise approved
  "Can it scale?" → change one connection string → Supabase
  "Knowledge graph?" → yes, unified, with multi-hop traversal
```
