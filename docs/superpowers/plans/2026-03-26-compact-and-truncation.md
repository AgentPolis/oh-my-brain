# compact() + Tool Truncation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement tool output truncation at ingest, `compact()` to summarize old L1 messages into `dag_nodes`, and assembler history injection so context stays bounded and intelligent as conversations grow.

**Architecture:** Three independent layers built in order — (1) truncation at ingest time, (2) compaction that reads old L1 messages and writes `dag_nodes`, (3) assembler that reads `dag_node` abstracts within budget. Each layer can be tested in isolation. No external LLM dependency: summarizer uses heuristic extraction (user goals + assistant conclusions) so compact() has zero API cost and runs safely during heartbeat.

**Tech Stack:** TypeScript, better-sqlite3, vitest. All existing. No new dependencies.

---

## File Structure

**New files:**
- `src/triage/truncate.ts` — tool output truncation logic
- `src/compact/summarizer.ts` — heuristic summarizer (messages → abstract/overview/detail)
- `src/compact/compactor.ts` — `compact()` implementation (reads messages, writes dag_nodes)
- `src/storage/dag.ts` — `DagStore` class (CRUD for dag_nodes table)
- `test/truncate.test.ts` — truncation unit tests
- `test/compactor.test.ts` — compact() unit tests
- `eval/compact-quality.test.ts` — end-to-end: ingest 60 turns → compact → assemble → verify summaries appear

**Modified files:**
- `src/storage/messages.ts` — add `getCompactable()`, `markCompacted()`, schema migration for `compacted_by` column
- `src/storage/schema.ts` — add `compacted_by` column to messages
- `src/assembly/assembler.ts` — pull `dag_node` abstracts after fresh tail
- `src/engine.ts` — wire `DagStore` into bootstrap, call `compactor.run()` in `compact()`

---

## Chunk 1: Tool Output Truncation

### Task 1: Truncation logic

**Files:**
- Create: `src/triage/truncate.ts`
- Modify: `src/triage/patterns.ts` (export `hintContentType` — already exported, no change needed)

- [ ] **Step 1: Write failing test**

Create `test/truncate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { truncateIfNeeded, TOOL_OUTPUT_MAX_TOKENS } from "../src/triage/truncate.js";

describe("truncateIfNeeded", () => {
  it("passes short content through unchanged", () => {
    const short = "hello world";
    expect(truncateIfNeeded(short, "tool_result")).toBe(short);
  });

  it("passes non-tool content through unchanged even if long", () => {
    const long = "x".repeat(10000);
    expect(truncateIfNeeded(long, "conversation")).toBe(long);
  });

  it("truncates long tool output to token budget", () => {
    // ~4 chars per token, TOOL_OUTPUT_MAX_TOKENS = 400 → 1600 chars budget
    const long = "A".repeat(5000);
    const result = truncateIfNeeded(long, "tool_result");
    expect(result.length).toBeLessThan(2000);
    expect(result).toContain("[truncated");
  });

  it("preserves head and tail of tool output", () => {
    const content = "HEAD " + "noise ".repeat(500) + " TAIL";
    const result = truncateIfNeeded(content, "tool_result");
    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
  });

  it("does not truncate content just under the limit", () => {
    // Use (MAX - 1) * 4 chars to stay safely under limit regardless of ceil rounding
    const underLimit = "x".repeat((TOOL_OUTPUT_MAX_TOKENS - 1) * 4);
    const result = truncateIfNeeded(underLimit, "tool_result");
    expect(result).not.toContain("[truncated");
  });

  it("does not truncate non-tool_result content types even when very long", () => {
    const long = "x".repeat(5000);
    for (const ct of ["conversation", "code", "reasoning", "instruction", "reference"] as const) {
      expect(truncateIfNeeded(long, ct)).toBe(long);
    }
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/truncate.test.ts 2>&1 | tail -10
```
Expected: `Cannot find module '../src/triage/truncate.js'`

- [ ] **Step 3: Implement `src/triage/truncate.ts`**

```typescript
import { estimateTokens } from "../assembly/budget.js";
import type { ContentType } from "../types.js";

/** Max tokens for a stored tool result. ~400 tokens ≈ a screenful of output. */
export const TOOL_OUTPUT_MAX_TOKENS = 400;

/**
 * Truncate tool output that would exceed TOOL_OUTPUT_MAX_TOKENS.
 * Keeps the head (70%) and tail (20%), inserts a marker in the middle.
 * Non-tool content is never truncated here.
 */
export function truncateIfNeeded(content: string, contentType: ContentType): string {
  if (contentType !== "tool_result") return content;
  if (estimateTokens(content) <= TOOL_OUTPUT_MAX_TOKENS) return content;

  const totalChars = content.length;
  const headChars = Math.floor(totalChars * 0.70);
  const tailChars = Math.floor(totalChars * 0.20);
  const skipped = totalChars - headChars - tailChars;

  const head = content.slice(0, headChars);
  const tail = content.slice(totalChars - tailChars);
  const skippedTokens = estimateTokens(content.slice(headChars, totalChars - tailChars));

  return `${head}\n... [truncated ${skippedTokens} tokens, ${skipped} chars] ...\n${tail}`;
}
```

- [ ] **Step 4: Run to confirm PASS**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/truncate.test.ts 2>&1 | tail -10
```
Expected: `6 passed`

- [ ] **Step 5: Wire truncation into ingest**

In `src/storage/messages.ts`, modify `insert()`:

```typescript
// Add import at top:
import { truncateIfNeeded } from "../triage/truncate.js";

// In insert(), before the db.prepare call, add:
insert(msg: Message, turnIndex: number, cls: Classification): number {
  if (cls.level === Level.Discard) return -1;

  // Truncate tool outputs before storage
  const content = truncateIfNeeded(msg.content, cls.contentType);

  const result = this.db
    .prepare(
      `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(msg.role, content, cls.level, cls.contentType, cls.confidence, turnIndex);
    //              ^^^^^^^ was msg.content

  return Number(result.lastInsertRowid);
}
```

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test 2>&1 | tail -15
```
Expected: all tests pass (truncation is additive, shouldn't break existing tests)

- [ ] **Step 7: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/triage/truncate.ts test/truncate.test.ts src/storage/messages.ts
git commit -m "feat: truncate tool output at ingest (max 400 tokens, keep head+tail)"
```

---

## Chunk 2: DagStore + Schema

### Task 2: Schema migration + DagStore

**Files:**
- Modify: `src/storage/schema.ts` — add `compacted_by` to messages
- Create: `src/storage/dag.ts` — `DagStore` class

- [ ] **Step 1: Write failing test**

Create `test/compactor.test.ts` (partial — just DagStore for now):

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/schema.js";
import { DagStore } from "../src/storage/dag.js";

let db: Database.Database;
let dagStore: DagStore;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  dagStore = new DagStore(db);
});

afterEach(() => db.close());

describe("DagStore", () => {
  it("inserts a dag node and retrieves it", () => {
    const id = dagStore.insert({
      parentId: null,
      abstract: "User asked about authentication",
      overview: "Decided to use JWT. Rejected sessions due to scale.",
      detail: "Full conversation...",
      sourceIds: [1, 2, 3],
      level: 1,
    });
    expect(id).toBeGreaterThan(0);

    const nodes = dagStore.getAll();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].abstract).toBe("User asked about authentication");
    expect(nodes[0].sourceIds).toEqual([1, 2, 3]);
  });

  it("getAbstracts returns summaries ordered by creation", () => {
    dagStore.insert({ parentId: null, abstract: "A", overview: "", detail: "", sourceIds: [1], level: 1 });
    dagStore.insert({ parentId: null, abstract: "B", overview: "", detail: "", sourceIds: [2], level: 1 });
    const abstracts = dagStore.getAbstracts(10);
    expect(abstracts.map(n => n.abstract)).toEqual(["A", "B"]);
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -10
```
Expected: `Cannot find module '../src/storage/dag.js'`

- [ ] **Step 3: Add `compacted_by` to schema with version bump**

`CREATE TABLE IF NOT EXISTS` silently skips DDL on existing databases. We need a
version-gated `ALTER TABLE` path. Bump `SCHEMA_VERSION` from 1 to 2 and add a migration.

In `src/storage/schema.ts`:

```typescript
// Change:
export const SCHEMA_VERSION = 2;  // was 1

// In initSchema(), add to messages CREATE TABLE block after `created_at`:
//   compacted_by   INTEGER REFERENCES dag_nodes(id)

// After db.exec() for the main schema, add the migration guard:
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
```

Also add to `migrateFromLosslessClaw` for lossless-claw databases:
```typescript
if (!colNames.has("compacted_by")) {
  db.exec(`ALTER TABLE messages ADD COLUMN compacted_by INTEGER REFERENCES dag_nodes(id)`);
}
```

- [ ] **Step 4: Create `src/storage/dag.ts`**

```typescript
/**
 * DagStore — CRUD for dag_nodes (L1 summary tree).
 */

import type Database from "better-sqlite3";
import type { DagNode, Level } from "../types.js";

interface InsertInput {
  parentId: number | null;
  abstract: string;
  overview: string;
  detail: string;
  sourceIds: number[];   // message row IDs (not turn numbers)
  minTurn: number;       // first turn_index in this batch (for human-readable labels)
  maxTurn: number;       // last turn_index in this batch
  level: Level | number;
}

export class DagStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insert(node: InsertInput): number {
    // dag_nodes.abstract stores the turn range as a JSON prefix for display:
    // stored as-is; minTurn/maxTurn are stored in source_ids metadata
    const sourceMeta = JSON.stringify({ ids: node.sourceIds, minTurn: node.minTurn, maxTurn: node.maxTurn });
    const result = this.db
      .prepare(
        `INSERT INTO dag_nodes (parent_id, abstract, overview, detail, source_ids, level)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        node.parentId,
        node.abstract,
        node.overview,
        node.detail,
        sourceMeta,   // JSON with {ids, minTurn, maxTurn}
        node.level
      );
    return Number(result.lastInsertRowid);
  }

  getAll(): DagNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM dag_nodes ORDER BY id`)
      .all() as RawRow[];
    return rows.map(toNode);
  }

  /** Get the N most recent abstract summaries (for assembler injection). */
  getAbstracts(limit: number): DagNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM dag_nodes ORDER BY id DESC LIMIT ?`)
      .all(limit) as RawRow[];
    return rows.reverse().map(toNode);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as n FROM dag_nodes`).get() as { n: number };
    return row.n;
  }
}

interface RawRow {
  id: number;
  parent_id: number | null;
  abstract: string;
  overview: string;
  detail: string;
  source_ids: string;
  level: number;
  created_at: string;
}

function toNode(row: RawRow): DagNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    abstract: row.abstract,
    overview: row.overview,
    detail: row.detail,
    sourceIds: JSON.parse(row.source_ids) as number[],
    level: row.level as Level,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 5: Run to confirm PASS**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -10
```
Expected: `DagStore: 2 passed`

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test 2>&1 | tail -5
```
Expected: all existing tests still pass

- [ ] **Step 7: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/storage/dag.ts src/storage/schema.ts test/compactor.test.ts
git commit -m "feat: DagStore + compacted_by column for dag_nodes"
```

---

## Chunk 3: Summarizer + MessageStore compaction methods

### Task 3: Heuristic summarizer

**Files:**
- Create: `src/compact/summarizer.ts`

- [ ] **Step 1: Write failing test**

**Append** the following to `test/compactor.test.ts` (do not replace the file — add after the existing DagStore describe block):

```typescript
import { summarize } from "../src/compact/summarizer.js";
import type { StoredMessage } from "../src/types.js";
import { Level } from "../src/types.js";

function makeMsg(role: StoredMessage["role"], content: string, turnIndex = 0): StoredMessage {
  return { id: 0, role, content, level: Level.Observation, contentType: "conversation", confidence: 0.6, turnIndex, createdAt: "" };
}

describe("summarize", () => {
  it("produces abstract, overview, detail from messages", () => {
    const msgs: StoredMessage[] = [
      makeMsg("user", "Can you help me set up JWT authentication?", 1),
      makeMsg("assistant", "I'll implement JWT. We'll need jsonwebtoken and a secret key.", 1),
      makeMsg("user", "Use RS256 not HS256 for production.", 2),
      makeMsg("assistant", "Done. Created auth middleware using RS256.", 2),
    ];
    const result = summarize(msgs);
    expect(result.abstract.length).toBeGreaterThan(0);
    expect(result.abstract.length).toBeLessThan(200);   // one-liner
    expect(result.overview.length).toBeGreaterThan(0);
    expect(result.detail.length).toBeGreaterThan(0);
    // Abstract should reflect the main topic
    expect(result.abstract.toLowerCase()).toMatch(/jwt|auth/);
  });

  it("handles empty input gracefully", () => {
    const result = summarize([]);
    expect(result.abstract).toBe("[empty batch]");
  });

  it("abstract is always shorter than overview", () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "user" : "assistant", `message ${i} about topic X`, i)
    );
    const result = summarize(msgs);
    expect(result.abstract.length).toBeLessThanOrEqual(result.overview.length);
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -10
```
Expected: `Cannot find module '../src/compact/summarizer.js'`

- [ ] **Step 3: Implement `src/compact/summarizer.ts`**

```typescript
/**
 * Heuristic summarizer for L1 message batches.
 *
 * No LLM required — extracts user goals and assistant conclusions
 * using signal words. Suitable for heartbeat/background compaction.
 * Can be replaced by an LLM pass (Haiku) when API access is available.
 */

import type { StoredMessage } from "../types.js";

export interface Summary {
  abstract: string;   // one-liner (<150 chars)
  overview: string;   // key facts, decisions (~300 chars)
  detail: string;     // full concatenated content (reference)
}

const CONCLUSION_SIGNALS = /\b(done|completed|created|implemented|decided|chose|will use|using|fixed|set up)\b/i;
const GOAL_SIGNALS = /\b(can you|help me|how do|please|need to|want to|should|could you)\b/i;

export function summarize(messages: StoredMessage[]): Summary {
  if (messages.length === 0) {
    return { abstract: "[empty batch]", overview: "", detail: "" };
  }

  const userMsgs = messages.filter(m => m.role === "user");
  const assistantMsgs = messages.filter(m => m.role === "assistant");

  // Abstract: first user message, trimmed to 120 chars
  const firstUser = userMsgs[0]?.content ?? messages[0].content;
  const abstract = firstUser.replace(/\s+/g, " ").trim().slice(0, 120) +
    (firstUser.length > 120 ? "…" : "");

  // Overview: goal sentences + conclusion sentences
  const goalSentences = userMsgs
    .flatMap(m => splitSentences(m.content))
    .filter(s => GOAL_SIGNALS.test(s))
    .slice(0, 3);

  const conclusionSentences = assistantMsgs
    .flatMap(m => splitSentences(m.content))
    .filter(s => CONCLUSION_SIGNALS.test(s))
    .slice(0, 3);

  const overviewParts = [...goalSentences, ...conclusionSentences];
  const overview = overviewParts.length > 0
    ? overviewParts.join(" ").slice(0, 600)
    : messages.slice(0, 3).map(m => `${m.role}: ${m.content.slice(0, 80)}`).join("\n");

  // Detail: full content for reference (assembler won't inject this by default)
  const detail = messages
    .map(m => `[${m.role} turn=${m.turnIndex}] ${m.content}`)
    .join("\n\n");

  return { abstract, overview, detail };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10 && s.length < 300);
}
```

- [ ] **Step 4: Run to confirm PASS**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -15
```
Expected: `DagStore: 2 passed, summarize: 3 passed`

- [ ] **Step 5: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/compact/summarizer.ts test/compactor.test.ts
git commit -m "feat: heuristic summarizer for L1 message batches"
```

---

## Chunk 4: Compactor + MessageStore methods

### Task 4: MessageStore compaction queries

**Files:**
- Modify: `src/storage/messages.ts`

- [ ] **Step 1: Write failing test**

**Append** to `test/compactor.test.ts`:

```typescript
import { MessageStore } from "../src/storage/messages.js";

describe("MessageStore compaction methods", () => {
  let msgStore: MessageStore;

  beforeEach(() => {
    msgStore = new MessageStore(db);
  });

  it("getCompactable returns L1 messages older than freshTailTurns", () => {
    // Insert messages at turns 1-30
    for (let t = 1; t <= 30; t++) {
      msgStore.insert(
        { role: "user", content: `message at turn ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    // freshTailTurns = 20, currentTurn = 30 → compactable = turns 1-10
    const compactable = msgStore.getCompactable(30, 20);
    expect(compactable.length).toBeGreaterThan(0);
    expect(compactable.every(m => m.turnIndex <= 10)).toBe(true);
  });

  it("getCompactable excludes already-compacted messages", () => {
    for (let t = 1; t <= 5; t++) {
      msgStore.insert(
        { role: "user", content: `msg ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    const first = msgStore.getCompactable(10, 5);
    msgStore.markCompacted(first.map(m => m.id), 999);

    const second = msgStore.getCompactable(10, 5);
    expect(second).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -10
```
Expected: `getCompactable is not a function`

- [ ] **Step 3: Add methods to `src/storage/messages.ts`**

```typescript
/**
 * Return L1 messages that are old enough to compact.
 * "Old enough" = turn_index <= currentTurn - freshTailTurns
 * Excludes already-compacted messages (compacted_by IS NOT NULL).
 */
getCompactable(currentTurn: number, freshTailTurns: number): StoredMessage[] {
  const cutoffTurn = currentTurn - freshTailTurns;
  if (cutoffTurn <= 0) return [];

  const rows = this.db
    .prepare(
      `SELECT * FROM messages
       WHERE level = ? AND turn_index <= ? AND compacted_by IS NULL
       ORDER BY turn_index, id`
    )
    .all(Level.Observation, cutoffTurn) as RawRow[];
  return rows.map(toStoredMessage);
}

/**
 * Mark messages as compacted (associated with a dag_node).
 */
markCompacted(ids: number[], dagNodeId: number): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  this.db
    .prepare(`UPDATE messages SET compacted_by = ? WHERE id IN (${placeholders})`)
    .run(dagNodeId, ...ids);
}
```

Also add `compacted_by` to the `RawRow` interface in `messages.ts`.
**Do NOT add it to `toStoredMessage`'s return value** — `StoredMessage` type stays unchanged.

```typescript
// In messages.ts — update RawRow only:
interface RawRow {
  id: number;
  role: string;
  content: string;
  level: number;
  content_type: string;
  confidence: number;
  turn_index: number;
  created_at: string;
  compacted_by: number | null;  // ADD THIS — needed so better-sqlite3 doesn't error on the column
}
// toStoredMessage() does NOT change — compacted_by is not part of StoredMessage.
```

- [ ] **Step 4: Run to confirm PASS**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -10
```
Expected: all compactor tests pass

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test 2>&1 | tail -5
```
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/storage/messages.ts test/compactor.test.ts
git commit -m "feat: MessageStore.getCompactable + markCompacted"
```

---

### Task 5: Compactor.run()

**Files:**
- Create: `src/compact/compactor.ts`

- [ ] **Step 1: Write failing test**

**Append** to `test/compactor.test.ts`:

```typescript
import { Compactor } from "../src/compact/compactor.js";

// Task 5 tests use `db` from the outer beforeEach defined at the top of this file.
// Do not move these tests to a separate file without bringing that fixture along.
describe("Compactor.run()", () => {
  it("compacts old L1 messages into dag_nodes", () => {
    const msgStore = new MessageStore(db); // db from outer beforeEach
    const dagStore = new DagStore(db);
    const compactor = new Compactor(msgStore, dagStore, { freshTailTurns: 5, batchTurns: 3 });

    // Insert 20 turns of messages
    for (let t = 1; t <= 20; t++) {
      msgStore.insert(
        { role: "user", content: `user message at turn ${t}, asking about topic ${t % 4}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
      msgStore.insert(
        { role: "assistant", content: `assistant done handling turn ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }

    compactor.run(20);  // currentTurn = 20

    // Expect some dag_nodes created
    expect(dagStore.count()).toBeGreaterThan(0);

    // Expect old messages are marked compacted (turns 1-15)
    const stillCompactable = msgStore.getCompactable(20, 5);
    expect(stillCompactable).toHaveLength(0);
  });

  it("does nothing if no compactable messages", () => {
    const msgStore = new MessageStore(db);
    const dagStore = new DagStore(db);
    const compactor = new Compactor(msgStore, dagStore, { freshTailTurns: 20, batchTurns: 5 });

    // Insert only 5 turns — all within fresh tail window
    for (let t = 1; t <= 5; t++) {
      msgStore.insert(
        { role: "user", content: `msg ${t}` }, t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    compactor.run(5);
    expect(dagStore.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -10
```
Expected: `Cannot find module '../src/compact/compactor.js'`

- [ ] **Step 3: Implement `src/compact/compactor.ts`**

```typescript
/**
 * Compactor — runs compact() logic on old L1 messages.
 *
 * Called from SqueezeContextEngine.compact() (and during heartbeat).
 * Reads uncompacted L1 messages older than freshTailTurns, groups them
 * into batches of batchTurns turns, summarizes each batch, writes dag_nodes.
 */

import type { MessageStore } from "../storage/messages.js";
import type { DagStore } from "../storage/dag.js";
import { summarize } from "./summarizer.js";
import { Level } from "../types.js";

export interface CompactorConfig {
  /** How many recent turns to leave untouched (mirrors SqueezeConfig.freshTailCount turns) */
  freshTailTurns: number;
  /** How many turns to batch into one dag_node */
  batchTurns: number;
}

const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  freshTailTurns: 20,
  batchTurns: 5,
};

export class Compactor {
  private messages: MessageStore;
  private dag: DagStore;
  private config: CompactorConfig;

  constructor(messages: MessageStore, dag: DagStore, config: Partial<CompactorConfig> = {}) {
    this.messages = messages;
    this.dag = dag;
    this.config = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
  }

  /**
   * Compact old L1 messages up to currentTurn - freshTailTurns.
   * Groups by batchTurns, writes one dag_node per batch.
   * Idempotent — already-compacted messages are skipped.
   */
  run(currentTurn: number): void {
    const compactable = this.messages.getCompactable(currentTurn, this.config.freshTailTurns);
    if (compactable.length === 0) return;

    // Group into batches by turn range
    const batches = groupByTurns(compactable, this.config.batchTurns);

    for (const batch of batches) {
      const summary = summarize(batch);
      const maxLevel = Math.max(...batch.map(m => m.level)) as Level;
      const sourceIds = batch.map(m => m.id);

      const nodeId = this.dag.insert({
        parentId: null,
        abstract: summary.abstract,
        overview: summary.overview,
        detail: summary.detail,
        sourceIds,
        minTurn: batch[0].turnIndex,
        maxTurn: batch.at(-1)!.turnIndex,
        level: maxLevel,
      });

      this.messages.markCompacted(sourceIds, nodeId);
    }
  }
}

function groupByTurns<T extends { turnIndex: number }>(
  messages: T[],
  batchTurns: number
): T[][] {
  if (messages.length === 0) return [];

  const minTurn = messages[0].turnIndex;
  const batches: Map<number, T[]> = new Map();

  for (const msg of messages) {
    const bucketKey = Math.floor((msg.turnIndex - minTurn) / batchTurns);
    if (!batches.has(bucketKey)) batches.set(bucketKey, []);
    batches.get(bucketKey)!.push(msg);
  }

  return Array.from(batches.values());
}
```

- [ ] **Step 4: Run to confirm PASS**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- test/compactor.test.ts 2>&1 | tail -15
```
Expected: all compactor tests pass

- [ ] **Step 5: Wire into `engine.ts`**

In `src/engine.ts`:

```typescript
// Add import:
import { Compactor } from "./compact/compactor.js";
import { DagStore } from "./storage/dag.js";

// Add private fields:
private dag!: DagStore;
private compactor!: Compactor;

// In bootstrap(), after MessageStore init:
this.dag = new DagStore(this.db);
this.compactor = new Compactor(this.messages, this.dag, {
  freshTailTurns: this.config.freshTailCount,
  batchTurns: 5,
});

// Replace compact() TODO:
async compact(): Promise<void> {
  this.compactor.run(this.turnIndex);
}
```

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test 2>&1 | tail -5
```
Expected: all tests pass

- [ ] **Step 7: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/compact/compactor.ts src/compact/summarizer.ts src/engine.ts test/compactor.test.ts
git commit -m "feat: implement compact() — batches old L1 messages into dag_nodes"
```

---

## Chunk 5: Assembler History Injection

### Task 6: Pull dag_node abstracts into assembled context

**Files:**
- Modify: `src/assembly/assembler.ts`
- Modify: `src/engine.ts` (pass dagStore to assemble)

- [ ] **Step 1: Write failing test**

Create `eval/compact-quality.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget } from "../src/types.js";

// Note: engine.bootstrap(":memory:") manages its own in-memory DB.
// Do NOT create a separate db fixture here — it would be unused.
const LARGE_BUDGET: TokenBudget = { maxTokens: 8000, usedTokens: 0, available: 8000 };

describe("end-to-end: compact + assemble with history", () => {
  it("history summaries appear in assembled context after compact()", async () => {
    const engine = new SqueezeContextEngine();
    await engine.bootstrap(":memory:");

    // Simulate 60 turns (40 beyond fresh tail of 20)
    for (let t = 1; t <= 60; t++) {
      await engine.afterTurn({
        userMessage: { role: "user", content: `Turn ${t}: user discusses JWT authentication setup` },
        assistantMessage: { role: "assistant", content: `Turn ${t}: Done setting up auth. Using RS256.` },
        turnIndex: t,
      });
    }

    // Run compact
    await engine.compact();

    // Assemble and check summaries appear
    const ctx = await engine.assemble(LARGE_BUDGET);
    expect(ctx.metadata.summaryCount).toBeGreaterThan(0);

    // Summary content should reference early turns
    const allContent = ctx.messages.map(m => m.content).join(" ");
    expect(allContent).toMatch(/jwt|auth|turn [1-9]\b/i);
  });

  it("summaryCount is 0 when compact() has never been called, even if old messages exist", async () => {
    const engine = new SqueezeContextEngine();
    await engine.bootstrap(":memory:");

    for (let t = 1; t <= 30; t++) {
      await engine.afterTurn({
        userMessage: { role: "user", content: `msg ${t}` },
        assistantMessage: { role: "assistant", content: `done ${t}` },
        turnIndex: t,
      });
    }

    const ctx = await engine.assemble(LARGE_BUDGET);
    expect(ctx.metadata.summaryCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm FAIL**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- eval/compact-quality.test.ts 2>&1 | tail -10
```
Expected: first test fails with `summaryCount: 0`

- [ ] **Step 3: Update `AssemblerInput` type and `assemble()` in `src/assembly/assembler.ts`**

Add `dagNodes` to `AssemblerInput`:

```typescript
import type { DagNode } from "../types.js";

export interface AssemblerInput {
  // ... existing fields ...
  dagNodes: DagNode[];   // add this
}
```

In `assemble()`, inject summaries **between step 3 (preferences) and step 4 (fresh tail)**,
using `input.budget.historySummaries` (already allocated in `BudgetAllocation`).
Summaries are system-context and must appear before conversation messages:

```typescript
// 4. History summaries from dag_nodes (oldest first) — injected BEFORE fresh tail
//    Uses the historySummaries budget slice, not the total budget.
let summaryCount = 0;
let summaryTokensUsed = 0;
for (const node of input.dagNodes) {
  const meta = JSON.parse(node.sourceIds as unknown as string) as { minTurn: number; maxTurn: number };
  const summaryText = `[Summary turns ${meta.minTurn}–${meta.maxTurn}]: ${node.abstract}`;
  const summaryTokens = estimateTokens(summaryText);
  if (summaryTokensUsed + summaryTokens > input.budget.historySummaries) break;
  messages.push({ role: "system", content: summaryText });
  tokenCount += summaryTokens;
  summaryTokensUsed += summaryTokens;
  summaryCount++;
}

// 5. Fresh tail (last N messages) — was step 4, now step 5
```

Then update the return `metadata.summaryCount` from `0` to `summaryCount`.

- [ ] **Step 4: Pass dagNodes from engine to assembler**

In `src/engine.ts`, update `assemble()`:

```typescript
async assemble(budget: TokenBudget): Promise<AssembledContext> {
  // ... existing code ...

  const dagNodes = this.dag.getAbstracts(20); // dag is always initialized in bootstrap()

  return assemble({
    // ... existing fields ...
    dagNodes,
  });
}
```

- [ ] **Step 5: Run to confirm PASS**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test -- eval/compact-quality.test.ts 2>&1 | tail -15
```
Expected: both tests pass, `summaryCount > 0` after compact()

- [ ] **Step 6: Run full test suite — everything must pass**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test 2>&1 | tail -10
```
Expected: all existing + new tests pass

- [ ] **Step 7: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/assembly/assembler.ts src/engine.ts eval/compact-quality.test.ts
git commit -m "feat: inject dag_node history summaries into assembled context"
```

---

## Chunk 6: Final verification

- [ ] **Run full eval suite and confirm numbers**

```bash
cd /Users/hsing/MySquad/squeeze-claw && npm test 2>&1
```
Expected:
- All 87 existing tests pass
- New tests: `truncate.test.ts` (5), `compactor.test.ts` (~8), `compact-quality.test.ts` (2)
- Token savings eval still shows >60% savings
- `summaryCount > 0` in assembled context after compact()

- [ ] **Verify `compact()` is called during heartbeat (openclaw integration note)**

In openclaw's heartbeat config (HEARTBEAT.md or openclaw.json), the heartbeat handler should call:
```
/squeeze compact
```
or openclaw's plugin hook: `api.contextEngine.compact()`

This is outside squeeze-claw's scope — it's a one-line change in the openclaw heartbeat config.

- [ ] **Final commit: version bump**

```bash
cd /Users/hsing/MySquad/squeeze-claw
# Update CHANGELOG.md: add [0.2.0] entry
# Update package.json version: 0.1.0 → 0.2.0
git add CHANGELOG.md package.json
git commit -m "chore: bump version to 0.2.0 — compact() + tool truncation"
```
