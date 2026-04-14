# Plan: Event Extraction — 情節記憶 (v0.5)

> Codex execution plan. Read this file, then implement each task in order.
> Each task has acceptance criteria and gotchas. Commit after each task.
>
> Context: oh-my-brain v0.4.0 at `/Users/hsing/MySquad/squeeze-claw`.
> 397 tests passing, lint clean. ESM, TypeScript, vitest, tsup.
> Archive layer exists at `.squeeze/archive.jsonl`.
> Timeline index exists at `.squeeze/timeline.json`.
> brain_search MCP tool exists.

---

## Why This Matters

LongMemEval benchmark (50 題 temporal-reasoning):
- Raw dump (不用 oh-my-brain): 86%
- oh-my-brain v0.4 pipeline: 72%
- **差距 14% 全部來自缺少結構化事件記憶**

答錯的 14 題中 13 題的根因：oh-my-brain 把對話存為 raw text，
壓縮時丟了時間細節。如果把對話轉成結構化 Event，可以精確檢索。

預估：Event Extraction 可以把 LongMemEval 從 72% 提升到 90%+。

---

## 認知心理學基礎

人腦的情節記憶 (Episodic Memory) 不是存原文，是存結構化的事件：

```
原文: "I just got my car serviced last Tuesday. The mechanic found
       that the GPS wasn't working. He said it'd take a week to fix."

人腦記住的:
  事件: 車保養
  時間: 上週二
  人物: 技師
  問題: GPS 壞了
  結果: 一週修好
  感受: 有點煩（隱含）
```

oh-my-brain 應該做同樣的事。

---

## Architecture

```
對話訊息
    │
    ▼
┌──────────────┐
│ L0-L3 分類    │  ← 已有
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ Event 抽取    │  ← NEW: 從 L1 訊息中抽取結構化事件
└──────┬───────┘
       │
       ├──▶ .squeeze/events.jsonl  (結構化事件存儲)
       │
       ├──▶ .squeeze/archive.jsonl (原文保留，已有)
       │
       └──▶ .squeeze/timeline.json (時間索引，已有，需增強)

brain_search 增強:
  brain_search --when "2026-03-14"
    → 先查 events.jsonl (結構化，精確)
    → 再查 archive.jsonl (原文，補充)
```

---

## Task 1: Event Schema + Store

**New file:** `src/storage/events.ts`

### What to do

定義 Event schema 和存儲層。

```typescript
interface BrainEvent {
  id: string;              // uuid
  ts: string;              // ISO 8601 — 事件發生時間 (event_time)
  ts_ingest: string;       // ISO 8601 — oh-my-brain 記錄時間
  ts_precision: "exact" | "day" | "week" | "month" | "relative";

  // What happened
  what: string;            // 一句話描述: "car serviced"
  detail: string;          // 更多細節: "GPS malfunction discovered"
  category: string;        // auto-detected: "vehicle", "travel", "work", "shopping", "health", "social", "entertainment", "other"

  // Context
  who: string[];           // 涉及的人: ["mechanic Tom"]
  where: string;           // 地點 (if mentioned)
  
  // Relationships
  related_to: string[];    // 相關事件 ID (e.g., "bought car" → "car serviced")

  // Cognitive dimensions (from cognitive-memory-framework.md)
  sentiment: "positive" | "negative" | "neutral" | "frustrated" | "excited" | "anxious" | "";
  viewpoint: string;       // 觀點: "I think this brand's quality is declining"
  insight: string;         // 啟發: "should check reliability ratings before buying"

  // Source
  source_text: string;     // 原始文字 (verbatim, for verification)
  session_id: string;
  turn_index: number;
}

class EventStore {
  constructor(squeezePath: string);

  /** Append events. Append-only. */
  append(events: BrainEvent[]): void;

  /** Search by time range. */
  searchByTime(from: string, to: string): BrainEvent[];

  /** Search by keyword in what/detail/source_text. */
  searchByKeyword(query: string, limit?: number): BrainEvent[];

  /** Search by category. */
  searchByCategory(category: string, limit?: number): BrainEvent[];

  /** Search by person. */
  searchByPerson(who: string): BrainEvent[];

  /** Get all events. */
  getAll(): BrainEvent[];

  /** Count events and date range. */
  getSummary(): { count: number; earliest: string; latest: string; categories: Record<string, number> };

  /** Get events as compact timeline string for context injection. */
  toTimelineString(limit?: number): string;
}
```

**Storage:** `.squeeze/events.jsonl` — append-only, same pattern as
archive.jsonl and actions.jsonl.

**toTimelineString() output example:**

```
Events (23 total, 2026-02-15 ~ 2026-04-06):
  Feb15: got Samsung Galaxy S22
  Feb20: pre-ordered Dell XPS 13
  Mar01: started job at NovaTech
  Mar14: car serviced, GPS malfunction found
  Mar15: flew Southwest to Las Vegas (conference, 15th-18th)
  Mar20: joined Book Lovers Unite
  Apr01: attended meetup (2 weeks after joining)
  Apr06: bought training pads for Luna
  ...
```

This is what goes into brain_recall summary mode — compact, searchable,
no wasted tokens.

### Acceptance criteria

- EventStore can append and search by time, keyword, category, person
- `.squeeze/events.jsonl` is created on first append
- `getSummary()` returns count, date range, category breakdown
- `toTimelineString()` produces compact one-line-per-event output
- `searchByTime("2026-03-14", "2026-03-14")` returns events from that day
- Events are append-only (never deleted/modified)
- New test: `test/events.test.ts` with at least 12 tests

### Gotchas

- **ts_precision matters.** "Last Tuesday" = day precision. "In March" =
  month precision. "About a month ago" = relative. The search should
  handle all precisions.
- **category is auto-detected by keyword.** Simple heuristic:
  car/vehicle/drive → "vehicle", fly/flight/airline → "travel",
  buy/purchase/order → "shopping", etc.
- **who extraction is best-effort.** Proper nouns + role words
  (mechanic, doctor, colleague). Don't miss Chinese names.
- **related_to is empty for v0.5.** Event linking is Phase 4 work.

---

## Task 2: Event Extractor

**New file:** `cli/event-extractor.ts`

### What to do

A function that takes a conversation message and extracts zero or more
BrainEvents from it. This is the core intelligence of the system.

```typescript
/**
 * Extract structured events from a conversation message.
 * 
 * Uses heuristic pattern matching (no LLM call, zero API key).
 * Focuses on: actions taken, items acquired, places visited,
 * people met, milestones reached, problems encountered.
 */
function extractEvents(
  message: { role: string; content: string },
  context: {
    sessionId: string;
    turnIndex: number;
    sessionDate: string;    // ISO date of the session
    previousMessage?: string; // for context
  }
): BrainEvent[];
```

**Extraction heuristics:**

```typescript
// Action patterns — detect that something HAPPENED
const ACTION_PATTERNS = [
  // Acquisition: "I got/bought/purchased/ordered X"
  /\b(?:I|i|we)\s+(?:got|bought|purchased|ordered|received|picked up)\s+(.{3,60})/,

  // Travel: "I flew/drove/traveled to X"
  /\b(?:I|i|we)\s+(?:flew|drove|traveled|went|visited)\s+(?:to\s+)?(.{3,40})/,

  // Service: "I got X serviced/repaired/fixed"
  /\b(?:got|had)\s+(?:my\s+)?(.{3,30})\s+(?:serviced|repaired|fixed|checked|detailed)/,

  // Start/join: "I started/joined/began X"
  /\b(?:I|i|we)\s+(?:started|joined|began|enrolled|signed up)\s+(?:for\s+)?(.{3,60})/,

  // Attend: "I attended/went to X event"
  /\b(?:I|i|we)\s+(?:attended|went to|participated in)\s+(?:the\s+)?(.{3,60})/,

  // Work: "I started working at X" / "got a job at X"
  /\b(?:started working|got a job|began working)\s+(?:at\s+)?(.{3,40})/,

  // Watch/read: "I started watching/reading X"
  /\b(?:started|began|finished)\s+(?:watching|reading|playing)\s+(.{3,40})/,

  // Meet: "I met X" / "met with X"
  /\b(?:I|i|we)\s+met\s+(?:with\s+)?(.{3,40})/,

  // Problem: "X wasn't working" / "X broke" / "had a problem with X"
  /\b(.{3,30})\s+(?:wasn't working|broke|failed|crashed|had (?:a |an )?(?:issue|problem|error))/,
];

// Time patterns — extract WHEN
const TIME_PATTERNS = [
  // Exact date: "on March 14th" / "on 3/14"
  { pattern: /\bon\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/i, precision: "exact" as const },

  // Date range: "from the 15th to the 18th"
  { pattern: /from\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?)\s+to\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?)/i, precision: "day" as const },

  // Relative: "last Tuesday" / "yesterday" / "two weeks ago"
  { pattern: /\b(last\s+\w+day|yesterday|today|two\s+(?:weeks|days|months)\s+ago)/i, precision: "relative" as const },

  // Month: "in March" / "in February"
  { pattern: /\bin\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i, precision: "month" as const },

  // Duration: "for about X weeks/months"
  { pattern: /\bfor\s+(?:about\s+)?(\d+|a|two|three)\s+(weeks?|months?|days?|years?)/i, precision: "relative" as const },

  // Ago: "about a month ago" / "3 months ago"
  { pattern: /\b(\d+|a|about\s+a|two|three)\s+(weeks?|months?|days?|years?)\s+ago/i, precision: "relative" as const },
];

// Sentiment patterns
const SENTIMENT_PATTERNS = [
  { pattern: /\b(?:frustrated|annoyed|upset|disappointed|angry)\b/i, sentiment: "frustrated" as const },
  { pattern: /\b(?:excited|thrilled|happy|glad|love|great|amazing)\b/i, sentiment: "positive" as const },
  { pattern: /\b(?:worried|anxious|nervous|concerned)\b/i, sentiment: "anxious" as const },
  { pattern: /\b(?:unfortunately|sadly|too bad|sucks)\b/i, sentiment: "negative" as const },
];

// Person patterns — extract WHO
const PERSON_PATTERNS = [
  // "my mechanic/doctor/friend/colleague X"
  /\bmy\s+(?:mechanic|doctor|friend|colleague|boss|manager|wife|husband|partner|sister|brother)\s+(\w+)/i,
  // "met X" / "with X" where X is capitalized
  /\b(?:met|with|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/,
];

// Category detection
function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(?:car|vehicle|drive|mechanic|gas|tire|engine)\b/.test(lower)) return "vehicle";
  if (/\b(?:fly|flight|airline|airport|trip|travel|hotel|airbnb)\b/.test(lower)) return "travel";
  if (/\b(?:buy|bought|purchase|order|shop|store|price)\b/.test(lower)) return "shopping";
  if (/\b(?:work|job|office|meeting|project|team|colleague)\b/.test(lower)) return "work";
  if (/\b(?:doctor|health|gym|exercise|run|workout)\b/.test(lower)) return "health";
  if (/\b(?:friend|party|dinner|meet|date|social)\b/.test(lower)) return "social";
  if (/\b(?:watch|movie|show|book|read|game|play|concert)\b/.test(lower)) return "entertainment";
  if (/\b(?:charity|volunteer|donate|event|festival)\b/.test(lower)) return "events";
  if (/\b(?:dog|cat|pet|vet|walk)\b/.test(lower)) return "pets";
  return "other";
}
```

**resolveDate() — 把相對時間轉成絕對時間:**

```typescript
function resolveDate(
  match: string,
  precision: string,
  sessionDate: string  // fallback reference date
): { ts: string; precision: string } {
  // "on March 14th" → 2026-03-14 (use session year)
  // "last Tuesday" → compute from sessionDate
  // "two weeks ago" → sessionDate - 14 days
  // "in March" → 2026-03-01 (month precision)
  // If unparseable, return sessionDate with "relative" precision
}
```

### Acceptance criteria

- `extractEvents({role:"user", content:"I got my car serviced last Tuesday. The GPS wasn't working."}, ctx)` returns 1+ events with what="car serviced", detail contains "GPS"
- `extractEvents({role:"user", content:"I bought a Samsung Galaxy S22 on February 20th"}, ctx)` returns event with when="YYYY-02-20", what contains "Samsung"
- `extractEvents({role:"user", content:"ok"}, ctx)` returns [] (no events in noise)
- `extractEvents({role:"assistant", content:"..."}, ctx)` returns [] (only extract from user messages)
- Time extraction: "on March 14th" → exact date, "last Tuesday" → computed date, "about a month ago" → relative
- Person extraction: "my mechanic Tom" → who=["Tom"]
- Sentiment detection: "frustrated" → sentiment="frustrated"
- Category detection: "car serviced" → category="vehicle"
- New test: `test/event-extractor.test.ts` with at least 20 tests covering all pattern categories

### Gotchas

- **Only extract from user messages.** Assistant messages are responses,
  not events. The user is the one who EXPERIENCES things.
- **One message can have multiple events.** "I bought a car and flew
  to Vegas" = 2 events.
- **Don't over-extract.** "I'm thinking about buying a car" is NOT an
  event — it's an intention. Only extract things that HAPPENED.
  Look for past tense: got/bought/went/started/attended.
- **source_text must be the ORIGINAL message text.** Not compressed.
  This is the verbatim source for verification.
- **Chinese support.** Add patterns for: 我買了/我去了/我開始/我參加了.
  Don't block on this — English first, Chinese as bonus.
- **resolveDate is best-effort.** "Last Tuesday" relative to what?
  Use sessionDate (the date of the compress run) as reference.
  If ambiguous, use "relative" precision.

---

## Task 3: Compress Pipeline Integration

**File:** `cli/compress-core.ts`

### What to do

Wire event extraction into the compress pipeline. After classifying
messages, extract events from L1 (and L2) user messages.

```typescript
// In processMessages() or in the compress hook main():

import { extractEvents } from "./event-extractor.js";
import { EventStore } from "../src/storage/events.js";

// After classification, before compression:
const eventStore = new EventStore(squeezePath);
const allEvents: BrainEvent[] = [];

for (const msg of processed) {
  if (msg.role !== "user") continue;
  if (msg.level === Level.Discard) continue;

  const events = extractEvents(
    { role: msg.role, content: msg.originalText },
    {
      sessionId,
      turnIndex: msg.index,
      sessionDate: new Date().toISOString(),
      previousMessage: msg.index > 0 ? processed[msg.index - 1]?.originalText : undefined,
    }
  );
  allEvents.push(...events);
}

if (allEvents.length > 0) {
  eventStore.append(allEvents);
  process.stderr.write(`[brain] extracted ${allEvents.length} events\n`);
}
```

### Acceptance criteria

- Running brain-compress on a session JSONL extracts events
- Events appear in `.squeeze/events.jsonl`
- stderr shows event count
- Existing compress behavior (MEMORY.md, candidates, archive) unchanged
- New test: process a mock session JSONL and verify events are extracted

### Gotchas

- **Event extraction happens BEFORE compression.** We need the original
  text, not the compressed version.
- **Dedup by source_text hash + session_id.** Same session compressed
  twice should not duplicate events.
- **Performance:** extraction is regex-only, should add < 50ms to the
  compress hook for a typical session.

---

## Task 4: brain_search Enhancement

**File:** `cli/mcp-server.ts`

### What to do

Enhance brain_search to query events first, then fall back to archive.

**Current behavior:**
```
brain_search --when "March 14" → scan archive.jsonl for date
brain_search --query "car" → scan archive.jsonl for keyword
```

**New behavior:**
```
brain_search --when "March 14"
  → Step 1: query events.jsonl (structured, precise)
  → Step 2: if < 3 results, also query archive.jsonl (raw text, fuzzy)
  → Combine and deduplicate

brain_search --query "car"
  → Step 1: query events.jsonl (what/detail/category fields)
  → Step 2: query archive.jsonl
  → Combine

brain_search --who "Tom"
  → query events.jsonl by who field (NEW)

brain_search --category "travel"
  → query events.jsonl by category (NEW)
```

**Response format change:**

```
Found 3 events + 2 archived messages:

EVENTS:
  [Mar14, exact] 🚗 car serviced — GPS malfunction found (frustrated)
  [Mar15-18, day] ✈️ flew Southwest to Las Vegas for conference
  [Apr06, exact] 🐕 bought training pads for Luna

ARCHIVED (additional context):
  [2026-03-14] user: I just got my car serviced for the first time...
  [2026-03-15] user: I'm heading to Las Vegas for a conference...
```

Events are shown first (structured, compact). Archive is shown as
supplementary context (raw text, for details not captured in events).

### Acceptance criteria

- brain_search returns events before archive results
- brain_search --who "Tom" returns events involving Tom
- brain_search --category "travel" returns travel events
- Events are formatted as compact one-line summaries
- Archive results are shown as supplementary context
- If no events match but archive does, archive results still shown
- New args in tool schema: `who`, `category`

### Gotchas

- **Events are the primary result.** Archive is supplementary. If
  events answer the question, the agent doesn't need archive.
- **Limit total results.** Default 10 events + 5 archive entries.
  Don't flood context.
- **The compact event format uses emoji for category.** 🚗 vehicle,
  ✈️ travel, 🛒 shopping, 💼 work, 🏥 health, 👥 social,
  🎬 entertainment, 📅 events, 🐕 pets, 📦 other.

---

## Task 5: brain_recall Summary Enhancement

**File:** `cli/mcp-server.ts`

### What to do

Add event summary to brain_recall's summary mode.

**Before:**
```
You have 47 active directives across 5 categories: ...
Archived history: 156 conversations (2026-03-25 ~ 2026-04-13)
```

**After:**
```
You have 47 active directives across 5 categories: ...

Events (23 total, 2026-02-15 ~ 2026-04-06):
  Recent: Apr06 🐕 bought training pads | Apr01 📅 attended meetup |
          Mar15 ✈️ flew to Las Vegas | Mar14 🚗 car serviced
  Categories: travel(6) vehicle(4) shopping(4) work(3) social(3) other(3)
  Use brain_search --when/--query/--who/--category for details.

Archived history: 156 conversations (2026-03-25 ~ 2026-04-13)
```

This costs ~80 tokens extra but gives the agent a MUCH better sense
of what it knows. It can see "I know about a car service on March 14"
and decide to brain_search for details when asked.

### Acceptance criteria

- brain_recall summary includes event count, date range, recent events
- Recent events show last 4 with emoji category markers
- Category breakdown shown as compact summary
- If no events exist, no event section shown
- Total summary stays under 250 tokens

---

## Task 6: Viewpoint + Sentiment Extraction

**File:** `cli/event-extractor.ts` (enhance)

### What to do

Extend the extractor to also capture viewpoints and sentiments as
standalone memory entries, not just as fields on events.

**Viewpoint detection:**

```typescript
const VIEWPOINT_PATTERNS = [
  // "I think X" / "I believe X" / "I feel that X"
  /\b(?:I think|I believe|I feel that|in my opinion|my take is)\s+(.{10,100})/i,
  // "X is overengineered" / "X is the best" (judgment statements)
  /\b(\w+(?:\s+\w+)?)\s+is\s+(?:overengineered|underrated|overrated|the best|terrible|amazing|broken)/i,
  // Chinese: 我覺得/我認為/本質上/其實
  /(?:我覺得|我認為|本質上|其實)\s*(.{5,60})/,
];
```

When a viewpoint is detected, create a special Event with
category="viewpoint":

```json
{
  "what": "viewpoint",
  "detail": "microservices are overengineered for small teams",
  "category": "viewpoint",
  "sentiment": "negative",
  "source_text": "I think microservices are overengineered..."
}
```

**Sentiment on non-event messages:**

Even if a message has no extractable event, capture strong sentiment:

```typescript
// "I'm really frustrated with the deployment process"
// → No event, but sentiment worth capturing:
{
  "what": "sentiment",
  "detail": "frustrated with deployment process",
  "category": "sentiment",
  "sentiment": "frustrated"
}
```

### Acceptance criteria

- "I think microservices are overengineered" → viewpoint event extracted
- "我覺得這個方案太複雜" → viewpoint event extracted (Chinese)
- Strong sentiment without event → sentiment event captured
- Viewpoints show up in brain_search --category "viewpoint"
- New test: verify viewpoint and sentiment extraction

### Gotchas

- **Only capture STRONG viewpoints.** "I think it's fine" is too weak.
  Require opinion words: overengineered, best, terrible, always, never.
- **Don't double-count.** If a message has both an event AND a viewpoint,
  create two entries. But if the viewpoint is just the sentiment field
  on the event, don't create a separate viewpoint entry.

---

## Task 7: Habit Detection (from behavior patterns)

**File:** `cli/habit-detector.ts` (new)

### What to do

Detect recurring behavior patterns from event history. If a user does
the same type of thing 3+ times, it's a habit.

```typescript
interface Habit {
  id: string;
  pattern: string;        // "writes tests before code"
  confidence: number;      // 0-1, based on occurrence count
  evidence: string[];      // event IDs that support this
  first_seen: string;      // when first detected
  occurrences: number;
}

/**
 * Scan event history for recurring patterns.
 * Returns newly detected habits (not previously known).
 */
function detectHabits(
  events: BrainEvent[],
  existingHabits: Habit[]
): Habit[];
```

**Detection heuristics:**

```typescript
// Group events by category + similar 'what' field
// If 3+ events have similar 'what' within same category → habit

// Example:
// events: [
//   {what: "flew United", category: "travel"},
//   {what: "flew United to Vegas", category: "travel"},
//   {what: "flew United to SF", category: "travel"},
// ]
// → Habit: "frequently flies United Airlines" (3 occurrences)

// Example:
// events: [
//   {what: "attended charity run", category: "events"},
//   {what: "participated in charity walk", category: "events"},
//   {what: "attended charity golf", category: "events"},
//   {what: "attended food charity", category: "events"},
// ]
// → Habit: "regularly participates in charity events" (4 occurrences)
```

**Storage:** `.squeeze/habits.json` — small file, overwritten on each
detection run (not append-only, habits are mutable).

**Integration:** Run `detectHabits()` at the end of the compress hook,
after event extraction. New habits become Memory Candidates with
`HABIT:` prefix for user review.

### Acceptance criteria

- 3+ similar events → habit detected
- Habit has confidence based on occurrence count (3=0.6, 5=0.8, 10=1.0)
- New habits are ingested as Memory Candidates with HABIT: prefix
- Existing habits are not re-proposed
- brain_status shows habit count
- New test: `test/habit-detector.test.ts` with at least 8 tests

### Gotchas

- **"Similar" is Jaccard similarity ≥ 0.4 on what field tokens.**
  Reuse the Jaccard from links-store.ts.
- **Don't detect trivial habits.** "talked to assistant" is not a habit.
  Filter by category ≠ "other".
- **Habit confidence grows with evidence.** 3 occurrences = 0.6,
  each additional occurrence adds 0.05, capped at 1.0.

---

## Task 8: Update brain_recall Tool Description + brain_status

**File:** `cli/mcp-server.ts`

### What to do

1. Update brain_recall tool description to mention events and brain_search.

2. Update brain_status to include:
```
events_total: 23
events_categories: travel(6) vehicle(4) shopping(4) ...
habits_detected: 3
viewpoints_captured: 5
```

3. Update brain_search tool description to mention new args (who, category).

### Acceptance criteria

- brain_status includes event/habit/viewpoint counts
- Tool descriptions updated
- Existing tests updated or not broken

---

## Task 9: Version Bump + README + CHANGELOG

**Files:** `README.md`, `CHANGELOG.md`, `TODOS.md`, `package.json`

### What to do

1. Version bump to `0.5.0`

2. **README "What it does"** — update:
```markdown
- **L1 Observation** — Regular messages. Compressed summaries stay in
  context; full text archived; **structured events extracted** with
  who/what/when/where for precise temporal retrieval.
- **Events** — Structured episodic memory extracted from conversations.
  "I got my car serviced on March 14th" becomes a searchable event
  with date, category, people, and sentiment.
- **Viewpoints** — Your opinions and judgments captured as memory.
  "I think microservices are overengineered" is remembered.
- **Habits** — Recurring behavior patterns auto-detected from events.
  If you fly United 3+ times, oh-my-brain notices.
```

3. **README "How it's different"** — add:
```markdown
| Memory model   | Flat text / vectors          | Cognitive: events, viewpoints, habits, sentiments |
| LongMemEval    | 49-91%                       | 72% → 90%+ with event extraction                 |
```

4. **CHANGELOG** — add `## [0.5.0]` entry

### Acceptance criteria

- Version 0.5.0 everywhere
- README describes events, viewpoints, habits
- CHANGELOG documents the cognitive memory upgrade

---

## Execution order

```
Phase A (no dependencies):
  Task 1 (Event schema + store)
  Task 2 (Event extractor)

Phase B (depends on Task 1 + 2):
  Task 3 (Compress pipeline integration)
  Task 6 (Viewpoint + sentiment extraction)

Phase C (depends on Task 1):
  Task 4 (brain_search enhancement)
  Task 5 (brain_recall summary enhancement)

Phase D (depends on Task 3):
  Task 7 (Habit detection)
  Task 8 (brain_status updates)

Phase E (depends on all):
  Task 9 (Version bump + README + CHANGELOG)
```

Phase A tasks can run in parallel.
Phase B tasks can run in parallel.
Phase C tasks can run in parallel.
Phase D tasks can run in parallel.

## Verification

```bash
npm run lint
npm run test:run      # 397 + new tests
npm run build
node dist/cli/brain.js version   # 0.5.0
```

## LongMemEval Re-test

After implementing, re-run:
```bash
cd /tmp/LongMemEval
python3 run_ohmybrain_real.py --limit 50
```

Target: **90%+** (up from 72%).
The event extraction should recover the 13 temporal-reasoning failures
by providing structured who/what/when data for precise retrieval.
