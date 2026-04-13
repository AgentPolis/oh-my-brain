# Plan: Memory Architecture v2 — 壓縮 ≠ 刪除

> Codex execution plan. Read this file, then implement each task in order.
> Each task has acceptance criteria and gotchas. Commit after each task.
>
> Context: oh-my-brain v0.3.1 is at `/Users/hsing/MySquad/squeeze-claw`.
> 347 tests passing, lint clean. The codebase uses ESM (`"type": "module"`),
> TypeScript, vitest, tsup for build.
>
> **Problem:** oh-my-brain 的 L1 壓縮目前是「丟掉中間」。LongMemEval
> temporal-reasoning 測試 74%（raw dump 86%），因為壓縮丟了時間細節。
>
> **Solution:** 壓縮 = 另存 + 建索引 + 按需檢索。不是刪除。

---

## Positioning (from v0.3.1 plan, locked)

oh-my-brain 是 agent 的大腦基礎設施，不是另一個 agent。

**核心洞察：** 人腦不是刪除記憶，是把記憶從工作記憶移到長期記憶，
需要的時候知道怎麼想起來。oh-my-brain 應該做一樣的事。

**目標：** LongMemEval 從 74% → 90%+，啟動 token 成本不增加。

---

## Background

### 現狀（v0.3.1）

```
訊息 → L0-L3 分級 → L1 壓縮 = 保留頭尾，丟掉中間 → 沒了
                   → L2/L3 永遠保留

啟動: ~100 tokens (summary mode)
全載: ~2,000 tokens (50 directives)
LongMemEval: 74% (temporal-reasoning, 50 questions)
```

問題：壓縮 = 刪除。Agent 問「上個月 14 號發生什麼」，答不出來。

### 目標（v0.4）

```
訊息 → L0-L3 分級 → L3 directives: 永遠在 context
                   → L2 preferences: 永遠在 context
                   → L1 observations: 摘要在 context + 原文存 archive
                   → L0 noise: 丟棄

啟動 (~100 tokens):
  "你有 47 條 directive, 23 條 preference, 156 段歷史對話。
   時間: 2026-03-25 ~ 2026-04-13。
   用 brain_recall --type X 查規則。
   用 brain_search --when '2026-04-06' 查歷史。"

Agent 需要細節時:
  brain_search --when "2026-04-06" → 從 archive 撈那天的原文
  brain_search --query "car service" → 語意搜索 archive

結果: 啟動 token 不變，但能回答任何時間相關的問題。
```

### 業界參考

| 系統 | 架構 | 啟發 |
|------|------|------|
| [Zep](https://arxiv.org/abs/2501.13956) | Episode→Entity→Community 三層 + bitemporal 時間戳 | 時間索引 + 事實抽取 |
| [Letta/MemGPT](https://docs.letta.com/) | Core(RAM) + Recall(搜索) + Archival(倉庫) | Agent 自己決定何時翻倉庫 |
| [MemPalace](https://github.com/milla-jovovich/mempalace) | Drawer(原文) + Closet(壓縮) + 170 token 啟動 | 原文永遠可回溯 |

oh-my-brain v0.4 = Zep 的時間索引 + Letta 的按需檢索 + 自己的 L0-L3 分級。

---

## Task 1: Archive Layer — 壓縮不再刪除

**File:** `src/compact/compactor.ts`, `src/storage/archive.ts` (new)

### What to do

創建 archive 存儲層。當 L1 訊息被壓縮時，原文保存到 archive，
不再丟棄。

**New file: `src/storage/archive.ts`**

```typescript
interface ArchiveEntry {
  id: string;           // uuid
  ts: string;           // ISO 8601, event time (when it happened)
  ingest_ts: string;    // ISO 8601, ingest time (when oh-my-brain saw it)
  role: "user" | "assistant";
  content: string;      // original full text, never truncated
  summary: string;      // compressed version (what goes into context)
  level: number;        // L0-L3 at time of archival
  turn_index: number;   // position in conversation
  session_id?: string;  // which session this came from
  tags: string[];       // extracted entities/topics for search
}

class ArchiveStore {
  constructor(squeezePath: string);

  /** Append entries. Append-only, never mutate. */
  append(entries: ArchiveEntry[]): void;

  /** Search by time range. Returns entries within [from, to]. */
  searchByTime(from: string, to: string): ArchiveEntry[];

  /** Search by keyword. Case-insensitive substring in content. */
  searchByKeyword(query: string, limit?: number): ArchiveEntry[];

  /** Get all entries for a specific session. */
  getBySession(sessionId: string): ArchiveEntry[];

  /** Count and date range summary (for brain_recall summary mode). */
  getSummary(): { count: number; earliest: string; latest: string };
}
```

**Storage format:** `.squeeze/archive.jsonl` — append-only, one JSON
object per line. Same pattern as `actions.jsonl`.

Why JSONL not SQLite: archive grows unbounded. JSONL is append-only,
no schema migrations, easy to backup/inspect. SQLite is for structured
queries (directives, preferences). Archive is for scan/filter.

**Compactor change:**

In `src/compact/compactor.ts`, when L1 messages are compacted:

```typescript
// BEFORE (v0.3.1): original text is lost after compression
const compressedText = compressText(originalText);

// AFTER (v0.4): original text archived before compression
archive.append({
  id: uuid(),
  ts: extractTimestamp(message),  // from conversation context
  ingest_ts: new Date().toISOString(),
  role: message.role,
  content: message.originalText,    // FULL TEXT preserved
  summary: compressedText,          // compressed version
  level: message.level,
  turn_index: message.turnIndex,
  tags: extractTags(message.originalText),  // simple keyword extraction
});
```

### Acceptance criteria

- L1 messages that get compressed have their original text in archive
- `.squeeze/archive.jsonl` is created on first compaction
- `ArchiveStore.searchByTime("2026-04-06", "2026-04-06")` returns
  entries from that date
- `ArchiveStore.searchByKeyword("car service")` returns matching entries
- `ArchiveStore.getSummary()` returns count + date range
- Archive is append-only — no entry is ever deleted or modified
- Existing tests still pass (archive is additive, no behavior change)
- New test file: `test/archive.test.ts` with at least 10 tests

### Gotchas

- **extractTimestamp is heuristic.** Conversation messages don't always
  have explicit timestamps. Use the session start time + turn index
  to estimate. For MCP writes, use `new Date().toISOString()`.
- **extractTags is simple keyword extraction.** Not NLP. Split on
  whitespace, filter stopwords, keep nouns > 3 chars. Chinese: split
  on common delimiters. Good enough for keyword search.
- **Archive grows forever.** Add a `--max-archive-mb` config (default
  100MB). When exceeded, oldest entries are dropped. But this is a
  soft limit — never lose L3 or L2 content.
- **Do NOT archive L0 messages.** They are noise. Only archive L1+.
- **Do NOT archive L3/L2 directives.** They are already preserved
  in the directive store and MEMORY.md. Archiving them would be
  redundant.

---

## Task 2: Timeline Index — 知道什麼時候發生什麼

**File:** `src/storage/timeline.ts` (new)

### What to do

Build a lightweight time index over the archive. This is what makes
`brain_search --when` fast.

```typescript
interface TimelineEntry {
  ts: string;           // ISO 8601 date (day granularity)
  count: number;        // how many archive entries on this day
  topics: string[];     // top-3 topics extracted from that day's entries
  summary: string;      // one-line summary of that day (50 chars max)
}

class TimelineIndex {
  constructor(squeezePath: string);

  /** Rebuild from archive.jsonl. Idempotent. */
  rebuild(): void;

  /** Get timeline entries for a date range. */
  range(from: string, to: string): TimelineEntry[];

  /** Get the full timeline as a compact string for context injection.
   *  Example: "Mar25: 12 msgs (car service, TypeScript setup)
   *           Mar26: 8 msgs (code review, deployment)
   *           ..." */
  toCompactString(): string;

  /** Date range of all entries. */
  bounds(): { earliest: string; latest: string } | null;
}
```

**Storage:** `.squeeze/timeline.json` — rebuilt from archive on each
compress run. Small file (one entry per day, max ~365 entries/year).

**Integration with compress hook:**

After the archive append in Task 1, rebuild the timeline index:

```typescript
// In compress-core.ts main(), after archive writes:
const timeline = new TimelineIndex(squeezePath);
timeline.rebuild();
```

### Acceptance criteria

- `timeline.rebuild()` produces correct day-level summaries from archive
- `timeline.range("2026-04-01", "2026-04-07")` returns entries for
  that week
- `timeline.toCompactString()` produces a readable one-line-per-day
  format
- Timeline survives archive growth (no n² behavior)
- New test: `test/timeline.test.ts` with at least 8 tests

### Gotchas

- **Day granularity is deliberate.** Hour-level would be too noisy
  for the summary. Day-level keeps the timeline compact.
- **Topics extraction reuses tags from archive entries.** Count tag
  frequency per day, keep top 3.
- **Timeline rebuild is idempotent.** Can run multiple times without
  duplicating entries. Overwrite the whole file each time.
- **The compact string must be < 500 chars for a typical month.**
  This goes into brain_recall summary mode. If a user has 6 months
  of history, show the last 30 days + "and N earlier days."

---

## Task 3: Bitemporal Timestamps — 事件時間 vs 寫入時間

**File:** `src/storage/schema.ts`, `src/storage/directives.ts`,
`cli/compress-core.ts`

### What to do

Add bitemporal timestamps to directives and preferences. Inspired by
[Zep's bitemporal model](https://arxiv.org/abs/2501.13956).

**Two timestamps for every fact:**
- `event_time` — when the fact became true ("I switched to TypeScript
  on March 15th")
- `ingest_time` — when oh-my-brain learned about it (always `now()`)

This enables queries like:
- "What were my rules last month?" (filter by event_time)
- "What did I add to my brain this week?" (filter by ingest_time)
- "This rule was added April 1 but it was about something that
  happened March 15" (event_time ≠ ingest_time)

**Schema change:**

```sql
ALTER TABLE directives ADD COLUMN event_time TEXT;
-- ingest_time already exists as created_at
```

For new directives, `event_time` defaults to `ingest_time` (usually
they're the same). The compress hook can detect temporal references
in the source message and set `event_time` accordingly:

```typescript
function extractEventTime(text: string, fallback: string): string {
  // Simple patterns: "on March 15", "last Tuesday", "yesterday"
  // Returns ISO date string or fallback
  const dateMatch = text.match(
    /\b(on\s+)?(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/i
  );
  if (dateMatch) {
    const parsed = new Date(dateMatch[2]);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}
```

### Acceptance criteria

- New directives have both `event_time` and `created_at` (ingest_time)
- Existing directives get `event_time = created_at` on migration
- `brain_recall --with-evidence` shows event_time when available
- `brain_search --when` uses event_time for filtering
- Schema migration is backward-compatible
- New test: verify event_time extraction from temporal phrases

### Gotchas

- **extractEventTime is best-effort.** Most directives won't have
  temporal references. Default to ingest_time. Don't crash on
  unparseable dates.
- **Chinese temporal phrases** (「上個月」「上禮拜二」) need separate
  regex patterns. Start with English-only for v0.4, add Chinese in
  v0.4.1.
- **Don't over-engineer the date parser.** It's a heuristic. If
  someone says "always use TypeScript" there's no event_time — just
  use ingest_time. The value is for facts that ARE temporal, like
  "I started the project on March 15."

---

## Task 4: brain_search MCP Tool — 按需檢索

**File:** `cli/mcp-server.ts`

### What to do

Add a new MCP tool that lets agents search the archive on demand.
This is the "go to the warehouse and look it up" capability.

```typescript
{
  name: "brain_search",
  description:
    "Search archived conversation history by time or keyword. " +
    "Use this when you need specific details that aren't in the " +
    "active directives — dates, events, decisions, conversations. " +
    "The archive preserves full text of past conversations that " +
    "were compressed out of active context.",
  inputSchema: {
    type: "object",
    properties: {
      when: {
        type: "string",
        description:
          "Date or date range. Examples: '2026-04-06', " +
          "'2026-04-01..2026-04-07', 'last week', 'last month'.",
      },
      query: {
        type: "string",
        description: "Keyword search. Case-insensitive.",
      },
      limit: {
        type: "number",
        description: "Max results to return. Default: 10.",
      },
    },
  },
}
```

**Handler logic:**

```typescript
function handleBrainSearch(args): ToolContent[] {
  const archive = new ArchiveStore(squeezePath());

  if (args.when) {
    const { from, to } = parseDateRange(args.when);
    const entries = archive.searchByTime(from, to);
    return formatArchiveResults(entries, args.limit ?? 10);
  }

  if (args.query) {
    const entries = archive.searchByKeyword(args.query, args.limit ?? 10);
    return formatArchiveResults(entries, args.limit ?? 10);
  }

  // No args: return timeline summary
  const timeline = new TimelineIndex(squeezePath());
  return textResult(timeline.toCompactString());
}
```

**parseDateRange** handles:
- Exact date: `"2026-04-06"` → from=to=that day
- Range: `"2026-04-01..2026-04-07"` → from..to
- Relative: `"last week"` → 7 days ago..today
- Relative: `"last month"` → 30 days ago..today

**formatArchiveResults** returns:

```
Found 5 entries (2026-04-06):

[2026-04-06 14:32] user: I just got my car serviced for the first
  time. The mechanic said the GPS system wasn't functioning correctly...

[2026-04-06 15:10] assistant: That sounds frustrating! The GPS issue
  might be related to...
```

### Acceptance criteria

- `brain_search --when "2026-04-06"` returns archive entries from that day
- `brain_search --query "car service"` returns matching entries
- `brain_search` with no args returns timeline summary
- `brain_search --when "last week"` parses relative dates correctly
- Results are limited by `--limit` (default 10)
- Results include timestamps, role, and full original text
- New test: verify search by time, keyword, and relative dates

### Gotchas

- **brain_search returns FULL original text.** Not compressed. This
  is the whole point — when the agent needs details, it gets details.
  But respect the `--limit` to avoid flooding context.
- **Relative date parsing is timezone-naive.** Use local date, not
  UTC. "Last week" means 7 calendar days ago in the user's timezone.
- **Empty archive is not an error.** Return "No archived conversations
  yet. Use oh-my-brain for a few sessions to build history."
- **This tool should NOT be called on every session start.** Only
  when the agent needs specific details. The brain_recall tool
  description should mention: "For specific dates or events, use
  brain_search instead."

---

## Task 5: Update brain_recall Summary Mode

**File:** `cli/mcp-server.ts`
**Function:** `handleBrainRecall()` — summary mode

### What to do

Include timeline information in the brain_recall summary so the agent
knows what history is available and how to access it.

**Before (v0.3.1):**
```
You have 47 active directives across 5 categories:
  CodingPreference (12) | SecurityRule (8) | ...
Use brain_recall with type=<category> to load specific rules.
Use brain_recall with mode=all to load everything.
```

**After (v0.4):**
```
You have 47 active directives across 5 categories:
  CodingPreference (12) | SecurityRule (8) | ...
Use brain_recall with type=<category> to load specific rules.
Use brain_recall with mode=all to load everything.

Archived history: 156 conversations (2026-03-25 ~ 2026-04-13)
Recent: Apr13 (8 msgs: code review, deployment) | Apr12 (12 msgs: memory architecture) | Apr11 (5 msgs: testing)
Use brain_search to look up specific dates or topics.
```

**Implementation:**

```typescript
// In handleBrainRecall, after category summary:
const archive = new ArchiveStore(squeezePath());
const summary = archive.getSummary();
const timeline = new TimelineIndex(squeezePath());

if (summary.count > 0) {
  const recent = timeline.range(thirtyDaysAgo(), today())
    .slice(-3)
    .reverse()
    .map(e => `${e.ts.slice(5)} (${e.count} msgs: ${e.topics.join(", ")})`)
    .join(" | ");

  lines.push("");
  lines.push(`Archived history: ${summary.count} conversations (${summary.earliest.slice(0,10)} ~ ${summary.latest.slice(0,10)})`);
  lines.push(`Recent: ${recent}`);
  lines.push("Use brain_search to look up specific dates or topics.");
}
```

### Acceptance criteria

- brain_recall summary includes archive count + date range
- brain_recall summary includes last 3 days with topics
- If no archive exists, no archive section in summary
- Total summary stays under 200 tokens
- Existing tests updated for new summary format

### Gotchas

- **Keep it compact.** The archive summary adds maybe 3 lines / ~50
  tokens. The whole point of summary mode is low token cost.
- **The timeline entries come from Task 2.** If timeline.json doesn't
  exist yet (no compress run since v0.4), skip the archive section.

---

## Task 6: Update brain_recall Tool Description

**File:** `cli/mcp-server.ts`

### What to do

Update brain_recall's tool description to mention brain_search for
temporal/detail queries.

```typescript
description:
  "Recall active directives (L3) from the project brain. Call at session start. " +
  "For specific dates, events, or conversation details, use brain_search instead. " +
  "AGENT BEHAVIOR: ..."
```

Also update brain_status to include archive stats:

```
archive_entries: 156
archive_date_range: 2026-03-25 ~ 2026-04-13
archive_size_kb: 342
```

### Acceptance criteria

- brain_recall description mentions brain_search
- brain_status includes archive stats
- New test: verify archive stats in brain_status

---

## Task 7: Compress Pipeline Integration

**File:** `cli/compress-core.ts`

### What to do

Wire the archive + timeline into the existing compress hook so it
runs automatically on every Claude Code session end.

**In compress hook `main()`:**

```typescript
// After existing L1 compression:
const archive = new ArchiveStore(squeezePath);

// Archive L1 messages before they get compressed
const l1Messages = processed.filter(m => m.level === Level.Observation);
const archiveEntries = l1Messages.map(m => ({
  id: randomUUID(),
  ts: sessionStartTime,  // from session metadata
  ingest_ts: new Date().toISOString(),
  role: m.role,
  content: m.originalText,
  summary: m.compressedText,
  level: m.level,
  turn_index: m.index,
  session_id: sessionId,
  tags: extractTags(m.originalText),
}));

archive.append(archiveEntries);

// Rebuild timeline
const timeline = new TimelineIndex(squeezePath);
timeline.rebuild();

process.stderr.write(
  `[brain] archived ${archiveEntries.length} messages, ` +
  `timeline: ${timeline.bounds()?.earliest} ~ ${timeline.bounds()?.latest}\n`
);
```

### Acceptance criteria

- Running brain-compress archives L1 messages before compression
- Timeline is rebuilt after each compress run
- archive.jsonl grows with each session
- Existing compress behavior (MEMORY.md writes, candidates, etc.)
  is unchanged
- stderr output shows archive stats

### Gotchas

- **Session start time:** The session JSONL may not have explicit
  timestamps. Use the file's mtime as a proxy if needed.
- **Idempotent:** If the same session is compressed twice (e.g.,
  retry after error), archive entries should be deduped by content
  hash + session_id.
- **Performance:** archiving + timeline rebuild should add < 100ms
  to the compress hook. JSONL append is O(1). Timeline rebuild is
  O(n) on archive size but archive.jsonl is read sequentially.

---

## Task 8: README + CHANGELOG + Tests

**Files:** `README.md`, `CHANGELOG.md`, `TODOS.md`

### What to do

1. **README "What it does" section** — update compression description:

   ```markdown
   - **L1 Observation** — Regular messages and tool results. Compressed
     summaries stay in active context; **full text archived** for
     on-demand retrieval via `brain_search`. Nothing is ever deleted.
   ```

2. **README "How it's different" table** — update row:

   ```markdown
   | Compression      | Lossy (data lost)           | Lossless archive — summaries in context, full text searchable |
   | Temporal queries  | Vector similarity only      | Time-indexed archive: brain_search --when "last Tuesday"      |
   ```

3. **CHANGELOG** — add `## [0.4.0]` entry.

4. **Version bump** to `0.4.0` (this is a new architectural primitive,
   not an incremental improvement).

### Acceptance criteria

- README describes the archive + search capability
- CHANGELOG documents the architecture change
- All version strings updated to 0.4.0
- Package.json version is 0.4.0

---

## Execution order

```
Phase A (no dependencies, can run in parallel):
  Task 1 (Archive layer)
  Task 3 (Bitemporal timestamps)

Phase B (depends on Task 1):
  Task 2 (Timeline index)

Phase C (depends on Task 1 + 2):
  Task 4 (brain_search MCP tool)
  Task 5 (brain_recall summary update)
  Task 6 (brain_recall description + brain_status)

Phase D (depends on Task 1 + 2):
  Task 7 (Compress pipeline integration)

Phase E (depends on all above):
  Task 8 (README + CHANGELOG)
```

## Verification

After all tasks:

```bash
npm run lint          # must pass
npm run test:run      # must pass (347 + new tests)
npm run build         # must succeed
node dist/cli/brain.js version   # must print 0.4.0
```

End-to-end smoke test:

```bash
BRAIN_TMP=$(mktemp -d)
OH_MY_BRAIN_PROJECT_ROOT=$BRAIN_TMP node dist/cli/mcp-server.js <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"brain_remember","arguments":{"text":"Always use TypeScript strict mode","source":"test"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"brain_recall","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"brain_search","arguments":{"when":"last week"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"brain_status","arguments":{}}}
RPC
rm -rf $BRAIN_TMP
```

Expected:
- Response 3: summary includes "Archived history" section (if archive exists)
- Response 4: returns archive entries or "No archived conversations yet"
- Response 5: includes `archive_entries`, `archive_date_range`

## LongMemEval Re-test

After implementing, re-run the benchmark:

```bash
cd /tmp/LongMemEval
python3 run_ohmybrain_real.py --limit 50
```

Target: 85%+ (up from 74%). The archive layer should recover most of
the temporal-reasoning accuracy lost to compression, while keeping
startup token cost at ~100 tokens.

## Architecture Diagram

```
                    ┌─────────────────────────────────────────┐
                    │           oh-my-brain v0.4              │
                    ├─────────────────────────────────────────┤
                    │                                         │
  Session ──────▶   │  Compress Pipeline                      │
                    │    ├─ L0-L3 Classification               │
                    │    ├─ L3/L2 → MEMORY.md (never compress) │
                    │    ├─ L1 → Summary in DAG (context)      │
                    │    │   └─ Original → archive.jsonl ←NEW  │
                    │    └─ L0 → discard                       │
                    │                                         │
  MCP ──────────▶   │  Tools                                  │
                    │    ├─ brain_recall (summary ~100 tok)    │
                    │    │   + archive timeline preview        │
                    │    ├─ brain_search (archive retrieval)←NEW│
                    │    ├─ brain_remember                     │
                    │    ├─ brain_candidates                   │
                    │    ├─ brain_quiz                         │
                    │    └─ brain_status (+archive stats)      │
                    │                                         │
                    ├────────── Storage ───────────────────────┤
                    │  MEMORY.md        (L3+L2, portable)     │
                    │  .squeeze/memory.db  (SQLite, structured)│
                    │  .squeeze/archive.jsonl  (L1 full text)←NEW│
                    │  .squeeze/timeline.json  (day index)  ←NEW│
                    │  .squeeze/actions.jsonl   (audit trail)  │
                    │  .squeeze/candidates.json (review queue) │
                    └─────────────────────────────────────────┘

Token Budget:
  啟動:     ~100 tokens (summary + timeline preview)
  按需檢索:  ~500 tokens (brain_search result, limited)
  全載入:   ~2,000 tokens (brain_recall mode=all)
  Archive:  unlimited (on disk, not in context)
```

## Design Decisions

1. **Archive is JSONL, not SQLite.** Archive is append-only, grows
   unbounded, and only needs scan/filter. JSONL is simpler and
   doesn't need schema migrations. SQLite is for structured data
   (directives, preferences) that needs indexed queries.

2. **Timeline is per-day, not per-hour.** Hour-level would be too
   noisy for the summary. A month of daily entries is ~30 lines.

3. **brain_search returns full text.** The whole point is that when
   the agent needs details, it gets the uncompressed original. But
   results are limited (default 10) to avoid flooding context.

4. **Bitemporal is best-effort.** Most messages won't have explicit
   event_time. Default to ingest_time. The value is for the messages
   that DO have temporal references.

5. **Archive never deletes L1 content.** Soft limit via --max-archive-mb
   but default is generous (100MB ≈ ~50K messages). True second brain
   doesn't forget.

6. **v0.4.0, not v0.3.2.** This is a new architectural primitive
   (archive + search), not an incremental feature. Major version bump.
