# Plan: Relation Memory + Schema Detection (v0.6)

> Codex execution plan. Read this file, then implement each task in order.
> Each task has acceptance criteria and gotchas. Commit after each task.
>
> Context: oh-my-brain v0.5.0 at `/Users/hsing/MySquad/squeeze-claw`.
> 454 tests passing, lint clean. ESM, TypeScript, vitest, tsup.
> Cognitive memory types already implemented: Directive, Preference,
> Event, Viewpoint, Sentiment, Habit.
>
> This plan completes the cognitive memory framework by adding the
> final two types: Relation (social cognition) and Schema (cognitive
> frameworks).

---

## LongMemEval Benchmark Tracking

每個版本的 benchmark 差異是產品故事的一部分：

```
v0.3.1 (directives only, 壓縮=刪除):     74% (37/50)
v0.4.0 (+ archive, 壓縮=另存):           72% (36/50)
v0.5.0 (+ events/viewpoints/habits):     ???  ← 正在跑
v0.6.0 (+ relations/schemas):            ???  ← 本次目標
```

---

## Task 1: Relation Memory — 信任鏈 + 社交認知

**New file:** `cli/relation-store.ts`
**Also touches:** `cli/event-extractor.ts`, `cli/mcp-server.ts`, `cli/compress-core.ts`

### What to do

關係記憶不是記「Tom 是工程師」（那是 Fact/Event）。
關係記憶是記信任鏈、影響力、互動模式：

```
Tom 推薦了 Redis → 我用了 → 很好用 → trust(Tom, high, tech)
Alice 的建議導致 bug → trust(Alice, low, architecture)
Bob 每次 code review 都很仔細 → trust(Bob, high, code-review)
用戶總是接受 mentor 的建議 → influence(mentor, high)
```

**Schema:**

```typescript
interface Relation {
  id: string;
  person: string;           // "Tom", "Alice", "my manager"
  relation_type: "trust" | "influence" | "collaboration" | "conflict";
  domain: string;           // "tech", "architecture", "code-review", "general"
  level: "high" | "medium" | "low";
  evidence: string[];       // event IDs or source texts that support this
  last_updated: string;     // ISO 8601
  notes: string;            // "recommended Redis, it worked well"
}

class RelationStore {
  constructor(squeezePath: string);

  /** Add or update a relation. If person+domain exists, update level. */
  upsert(relation: Relation): void;

  /** Get all relations for a person. */
  getByPerson(person: string): Relation[];

  /** Get all high-trust relations. */
  getTrusted(domain?: string): Relation[];

  /** Get all relations as compact string for context injection. */
  toCompactString(): string;

  /** Get all relations. */
  getAll(): Relation[];

  /** Summary stats. */
  getSummary(): { total: number; people: number; high_trust: number };
}
```

**Storage:** `.squeeze/relations.json` — small file, overwritten on
update (not append-only, relations are mutable — trust changes).

**toCompactString() output:**

```
People you trust:
  Tom (tech: high) — recommended Redis, worked well
  Bob (code-review: high) — thorough reviewer
People to verify:
  Alice (architecture: low) — past suggestion caused bug
```

**Detection from events and conversations:**

In `cli/event-extractor.ts`, when extracting events that mention
people, also detect relation signals:

```typescript
// Positive signals → trust++
const TRUST_POSITIVE = [
  /\b(\w+)(?:'s| his| her) (?:advice|recommendation|suggestion) (?:was|worked|helped)/i,
  /\bthanks to (\w+)/i,
  /\b(\w+) (?:helped|saved|fixed|solved)/i,
  /\bagree with (\w+)/i,
  /\b(\w+) was right/i,
];

// Negative signals → trust--
const TRUST_NEGATIVE = [
  /\b(\w+)(?:'s| his| her) (?:advice|suggestion) (?:caused|broke|failed)/i,
  /\bdisagree with (\w+)/i,
  /\b(\w+) was wrong/i,
  /\bignored (\w+)(?:'s| his| her) advice/i,
];

// Influence signals
const INFLUENCE = [
  /\b(\w+) (?:told|advised|suggested|recommended|said) (?:I|we|that)/i,
  /\bmy (?:mentor|boss|manager|lead) (\w+)/i,
];
```

**Relation evolution:**

Relations are not static. They evolve with each interaction:

```typescript
function updateRelation(
  store: RelationStore,
  person: string,
  signal: "positive" | "negative",
  domain: string,
  evidence: string
): void {
  const existing = store.getByPerson(person)
    .find(r => r.domain === domain);

  if (existing) {
    // Adjust level based on signal
    if (signal === "positive" && existing.level === "low") existing.level = "medium";
    if (signal === "positive" && existing.level === "medium") existing.level = "high";
    if (signal === "negative" && existing.level === "high") existing.level = "medium";
    if (signal === "negative" && existing.level === "medium") existing.level = "low";
    existing.evidence.push(evidence);
    existing.last_updated = new Date().toISOString();
    store.upsert(existing);
  } else {
    // New relation
    store.upsert({
      id: randomUUID(),
      person,
      relation_type: "trust",
      domain,
      level: signal === "positive" ? "medium" : "low",
      evidence: [evidence],
      last_updated: new Date().toISOString(),
      notes: evidence.slice(0, 100),
    });
  }
}
```

### Acceptance criteria

- RelationStore can upsert, query by person, query trusted
- Trust level adjusts up/down based on positive/negative signals
- Relation detection from conversations extracts person + signal
- `toCompactString()` shows trusted and verify-needed people
- Relations stored in `.squeeze/relations.json`
- New test: `test/relation-store.test.ts` with at least 10 tests

### Gotchas

- **Person names are tricky.** "Tom" and "my mechanic Tom" should
  map to the same person. Normalize: extract the proper noun only.
- **Don't create relations from assistant messages.** Only from user
  messages — the user is the one who has trust relationships.
- **Relations are mutable.** Unlike events (append-only), relations
  change over time. Use upsert, not append.
- **Default trust is "medium".** Don't assume high or low until
  there's evidence.
- **Domain matters.** You can trust someone on tech but not on
  architecture. domain-scoped trust.

---

## Task 2: Schema Detection — 認知框架

**New file:** `cli/schema-detector.ts`
**Also touches:** `cli/compress-core.ts`, `cli/mcp-server.ts`

### What to do

Schemas are recurring patterns in how the user approaches problems.
They're inferred from Habits + Events + Directives, not stated
explicitly.

```
Example:
  Habit: "always writes tests first" (from 5 events)
  Habit: "always checks error handling in reviews" (from 4 events)
  Habit: "always looks at naming in reviews" (from 3 events)
  Directive: "well-tested code is non-negotiable"

  → Schema: "Code Review Framework"
    Steps: 1) error handling 2) naming 3) test coverage
    Source: inferred from 12 events + 1 directive

Example:
  Habit: "always checks team size before architecture decisions"
  Habit: "prefers monolith for small teams"
  Directive: "keep everything in one package until team > 3"
  Event: "chose monolith over microservices (3 times)"

  → Schema: "Architecture Decision Framework"
    Steps: 1) check team size 2) if < 5, monolith 3) if > 5, consider splitting
    Source: inferred from 3 habits + 1 directive + 3 events
```

**Schema definition:**

```typescript
interface CognitiveSchema {
  id: string;
  name: string;            // "Code Review Framework"
  description: string;     // one-line summary
  steps: string[];         // ordered steps in the framework
  evidence: {
    habits: string[];      // habit IDs that support this
    directives: string[];  // directive texts
    events: string[];      // event IDs
  };
  confidence: number;      // 0-1, based on evidence count
  category: string;        // "code-review", "architecture", "deployment", etc.
  first_detected: string;
  last_updated: string;
}

class SchemaStore {
  constructor(squeezePath: string);

  /** Add or update a schema. */
  upsert(schema: CognitiveSchema): void;

  /** Get all schemas. */
  getAll(): CognitiveSchema[];

  /** Get schema by category. */
  getByCategory(category: string): CognitiveSchema[];

  /** Compact string for context injection. */
  toCompactString(): string;

  /** Summary stats. */
  getSummary(): { total: number; categories: string[] };
}
```

**Storage:** `.squeeze/schemas.json`

**Detection algorithm:**

```typescript
function detectSchemas(
  habits: Habit[],
  directives: string[],
  events: BrainEvent[],
  existingSchemas: CognitiveSchema[]
): CognitiveSchema[] {
  // Step 1: Group habits by category
  // e.g., all habits related to "code review" → potential schema

  // Step 2: Find directives that match the same category
  // e.g., "well-tested code is non-negotiable" → code review category

  // Step 3: Find recurring event sequences
  // e.g., user always does X before Y before Z

  // Step 4: If a category has 2+ habits + 1+ directive → schema candidate

  // Step 5: Extract ordered steps from the evidence
  // Habits become steps, directives become constraints

  // Step 6: Check against existingSchemas — don't re-propose
}
```

**Simplified v0.6 approach (no sequence mining):**

For v0.6, detect schemas from **co-occurring habits in the same domain**:

```typescript
function detectSchemas(habits: Habit[], directives: string[]): CognitiveSchema[] {
  // Group habits by their event category
  const byCategory = new Map<string, Habit[]>();
  for (const h of habits) {
    const cat = inferCategory(h.pattern); // reuse detectEventCategory
    const group = byCategory.get(cat) ?? [];
    group.push(h);
    byCategory.set(cat, group);
  }

  const schemas: CognitiveSchema[] = [];
  for (const [category, categoryHabits] of byCategory) {
    if (categoryHabits.length < 2) continue; // need 2+ habits for a schema

    // Find matching directives
    const matchingDirectives = directives.filter(d =>
      inferCategory(d) === category
    );

    schemas.push({
      id: randomUUID(),
      name: `${capitalize(category)} Framework`,
      description: `How you approach ${category} decisions`,
      steps: categoryHabits.map(h => h.pattern),
      evidence: {
        habits: categoryHabits.map(h => h.id),
        directives: matchingDirectives,
        events: categoryHabits.flatMap(h => h.evidence),
      },
      confidence: Math.min(1, 0.4 + categoryHabits.length * 0.15),
      category,
      first_detected: new Date().toISOString(),
      last_updated: new Date().toISOString(),
    });
  }

  return schemas;
}
```

**toCompactString() output:**

```
Your decision frameworks:
  Code Review: error handling → naming → test coverage (confidence: 0.85)
  Architecture: check team size → monolith if < 5 → split if > 5 (confidence: 0.7)
```

### Acceptance criteria

- SchemaStore can upsert, query by category
- Schema detection requires 2+ habits in same category
- Matching directives are included as evidence
- Confidence scales with evidence count
- `toCompactString()` shows frameworks with steps
- New schemas become Memory Candidates with `SCHEMA:` prefix
- New test: `test/schema-detector.test.ts` with at least 8 tests

### Gotchas

- **Schemas are high-level.** Don't create a schema for every pair
  of habits. Require 2+ habits + 1 matching directive minimum.
- **inferCategory reuses detectEventCategory from event-extractor.ts.**
  Export it if not already exported.
- **Schema steps are ordered by habit confidence** (most confident first).
- **Don't over-detect.** If user has 2 habits about travel ("flies
  United" + "prefers aisle seat"), that's preferences, not a framework.
  Schemas should describe **decision processes**, not preferences.
  Filter: steps must contain action words (check, verify, review,
  evaluate, compare, ensure).

---

## Task 3: brain_search + brain_recall Integration

**File:** `cli/mcp-server.ts`

### What to do

**brain_search new args:**

```typescript
{
  // existing: when, query, who, category, limit
  relation: {
    type: "string",
    description: "Search by relationship. Example: 'trusted' returns high-trust people.",
    enum: ["trusted", "verify", "all"],
  },
  schema: {
    type: "string",
    description: "Get a decision framework by category. Example: 'code-review'.",
  },
}
```

**brain_recall summary update:**

```
You have 47 directives, 23 events, 5 viewpoints, 3 habits.

People: Tom (tech: high trust) | Alice (arch: verify) | Bob (reviews: high trust)
Frameworks: Code Review (3 steps) | Architecture (3 steps)

Use brain_search --relation trusted for trusted people.
Use brain_search --schema "code-review" for your code review framework.
```

This costs ~40 tokens extra. Total summary ~150 tokens.

**brain_status update:**

```
relations_total: 3
relations_high_trust: 2
schemas_total: 2
```

### Acceptance criteria

- brain_search --relation "trusted" returns high-trust people
- brain_search --schema "code-review" returns the framework steps
- brain_recall summary includes people + frameworks
- brain_status includes relation + schema counts
- Existing tests updated

---

## Task 4: Compress Pipeline Integration

**File:** `cli/compress-core.ts`

### What to do

Wire relation detection + schema detection into the compress pipeline.

After event extraction (Task 3 of v0.5 plan):

```typescript
// Relation detection
import { RelationStore, detectRelationSignals } from "./relation-store.js";
const relationStore = new RelationStore(squeezePath);
for (const msg of processed) {
  if (msg.role !== "user") continue;
  const signals = detectRelationSignals(msg.originalText);
  for (const signal of signals) {
    updateRelation(relationStore, signal.person, signal.type, signal.domain, msg.originalText);
  }
}

// Schema detection (runs less frequently — only if habits exist)
import { SchemaStore, detectSchemas } from "./schema-detector.js";
const habits = loadHabits(squeezePath);
if (habits.length >= 2) {
  const schemaStore = new SchemaStore(squeezePath);
  const directives = parseExistingDirectives(readMemory(projectRoot));
  const newSchemas = detectSchemas(habits, [...directives], schemaStore.getAll());
  for (const schema of newSchemas) {
    schemaStore.upsert(schema);
    // Propose as candidate
    ingestCandidates(candidateStore, [`SCHEMA: "${schema.name}" — ${schema.steps.join(" → ")}`], {
      source: "compress", sessionId
    });
  }
}
```

### Acceptance criteria

- Compress hook detects relation signals from user messages
- Compress hook detects schemas when 2+ habits exist
- New schemas are proposed as Memory Candidates with SCHEMA: prefix
- Relations are updated on each compress run
- stderr shows relation + schema counts
- Existing compress behavior unchanged

### Gotchas

- **Schema detection is expensive relative to other steps.**
  Only run when habits.length >= 2 (skip if no habits yet).
- **Relation updates are idempotent.** Same message processed twice
  should not double-count trust signals.

---

## Task 5: Version Bump + README + CHANGELOG

**Files:** `README.md`, `CHANGELOG.md`, `TODOS.md`, `package.json`,
version strings in `cli/brain.ts`, `cli/mcp-server.ts`

### What to do

1. Version bump to `0.6.0`

2. **README "What it does"** — add:
```markdown
- **Relations** — Who you trust and why. "Tom recommended Redis, it
  worked well" builds trust. Agent considers trust when weighing
  conflicting advice.
- **Schemas** — Your decision frameworks, auto-detected from habits.
  "Code Review: error handling → naming → tests" is how YOU do
  reviews. The agent follows your framework, not a generic one.
```

3. **README cognitive coverage table:**
```markdown
| Memory Type | What | Example | Since |
|-------------|------|---------|-------|
| Directive | Explicit rules | "Always use TypeScript" | v0.3 |
| Preference | Stated preferences | "I prefer tabs" | v0.3 |
| Event | Episodic memory | "Car serviced Mar 14, GPS broke" | v0.5 |
| Viewpoint | Opinions | "Microservices are overengineered" | v0.5 |
| Sentiment | Emotions | "Frustrated with deployment" | v0.5 |
| Habit | Behavior patterns | "Always writes tests first" | v0.5 |
| Relation | Trust chains | "Trust Tom on tech, verify Alice on arch" | v0.6 |
| Schema | Decision frameworks | "Code review: errors → naming → tests" | v0.6 |
```

4. **CHANGELOG** — add `## [0.6.0]` entry

5. **Update cognitive-memory-framework.md** — change ❌ to ✅ for
   Relation and Schema

### Acceptance criteria

- Version 0.6.0 everywhere
- README shows full cognitive coverage table
- CHANGELOG documents relation + schema features
- cognitive-memory-framework.md updated

---

## Execution order

```
Phase A (no dependencies, parallel):
  Task 1 (Relation store + detection)
  Task 2 (Schema detection)

Phase B (depends on Task 1 + 2):
  Task 3 (brain_search + brain_recall integration)
  Task 4 (Compress pipeline integration)

Phase C (depends on all):
  Task 5 (Version bump + README + CHANGELOG)
```

## Verification

```bash
npm run lint
npm run test:run      # 454 + new tests
npm run build
node dist/cli/brain.js version   # 0.6.0
```

## Benchmark Note

After implementing, re-run LongMemEval. Relation and Schema memory
types primarily improve Decision Replay scores (not LongMemEval
retrieval scores). Track both:

```
LongMemEval (retrieval): 72% → ? (events help, relations/schemas less so)
Decision Replay (judgment): needs full re-eval with new cognitive context
```

The story for README:
"Each version adds a cognitive dimension. Each dimension improves
a different benchmark. Events improve retrieval. Relations and
schemas improve judgment."
