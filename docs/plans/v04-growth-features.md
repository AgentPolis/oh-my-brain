# Plan: v0.4 Growth Features — Decision Benchmark + Quiz + Diff

> Codex execution plan. Run AFTER memory-architecture-v2.md is complete.
> Prerequisite: v0.4.0 with archive + brain_search must be implemented.
>
> Context: oh-my-brain v0.4.0 at `/Users/hsing/MySquad/squeeze-claw`.
> ESM, TypeScript, vitest, tsup. MCP server at `cli/mcp-server.ts`.

---

## Task 1: Decision Replay 獨立 Benchmark Package

**Goal:** 把 Decision Replay 包裝成任何記憶系統都能跑的開源 benchmark。
定義 benchmark 的人贏了規則制定權。

**Files:** `eval/decision-replay/` (restructure), `eval/decision-replay/README.md` (new)

### What to do

**1a. 擴充 scenarios 到 20+**

在 `eval/decision-replay/scenarios/builtin.yaml` 裡加到 20 個以上，
覆蓋 5 種決策類型（每種至少 4 個）：

Categories and example scenarios:

**architecture (4+):**
- build-vs-buy-memory (existing)
- monolith-vs-split (existing)
- sql-vs-nosql: "Your app has relational data but needs to scale reads.
  PostgreSQL with read replicas or switch to DynamoDB?"
- sync-vs-async: "Payment processing: synchronous API call or async
  queue with webhook callback?"

**security (4+):**
- ship-without-guard (existing)
- dependency-vulnerability: "A critical CVE in a dependency. The fix
  requires upgrading 3 major versions. Patch and pin, or upgrade?"
- api-key-in-env: "Team member committed an API key. Rotate + revoke
  immediately (breaking deploys) or wait for the next release?"
- auth-model: "New microservice needs auth. JWT tokens (stateless) or
  session-based (stateful with Redis)?"

**scope/tradeoff (4+):**
- user-feedback-conflict (existing)
- feature-vs-debt: "Sprint planning: build the feature sales promised,
  or fix the flaky test suite that fails 1 in 10 runs?"
- mvp-scope: "3 weeks to launch. Feature list has 12 items. Which 5
  ship in v1?"
- backward-compat: "New API version is cleaner but breaks 3 existing
  integrations. Ship breaking change or maintain both?"

**operations (4+):**
- governance-centralized (existing)
- incident-response: "Production is down. Root cause unclear. Quick
  restart (fixes symptom) or full investigation (20 min downtime)?"
- hiring-priority: "Budget for 1 hire. Senior backend or junior
  fullstack? Team is 3 backend engineers."
- migration-strategy: "Migrating from Heroku to AWS. Big bang (1 day
  downtime) or gradual (2 weeks, more complexity)?"

**communication (4+):**
- bad-news-delivery: "Feature will miss the deadline by 2 weeks. Tell
  stakeholders now (early, incomplete info) or wait until you have a
  revised plan?"
- code-review-conflict: "Senior dev strongly disagrees with your
  architecture choice in a PR review. Push back or accommodate?"
- meeting-vs-async: "Cross-team alignment needed. Schedule a 1-hour
  meeting or write an RFC and collect async feedback?"
- chinese-or-english: "Team is mixed Chinese/English speakers.
  Internal docs in which language?"

**1b. Scenario schema 標準化**

Add a JSON Schema file at `eval/decision-replay/schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["id", "category", "situation", "options", "expected_decision", "rationale"],
  "properties": {
    "id": { "type": "string" },
    "category": { "enum": ["architecture", "security", "scope", "tradeoff", "operations", "communication"] },
    "situation": { "type": "string", "minLength": 50 },
    "options": { "type": "array", "items": { "type": "string" }, "minItems": 2 },
    "expected_decision": { "type": "string" },
    "rationale": { "type": "string" },
    "relevant_directives": { "type": "array", "items": { "type": "string" } },
    "difficulty": { "enum": ["easy", "medium", "hard"] }
  }
}
```

**1c. Adapter interface for other memory systems**

Add `eval/decision-replay/adapter.ts`:

```typescript
/**
 * Any memory system can implement this interface to be benchmarked.
 * oh-my-brain ships a built-in adapter. Others can write their own.
 */
export interface MemoryAdapter {
  /** Name of the system being tested */
  name: string;

  /** Load directives/rules from the memory system */
  loadContext(): Promise<string>;

  /** Ask a question with the loaded context. Returns the answer. */
  ask(prompt: string): Promise<string>;
}
```

Built-in adapters:
- `OhMyBrainAdapter` — reads MEMORY.md via brain_recall
- `RawContextAdapter` — baseline: dump all text (no memory system)

**1d. README for the benchmark**

`eval/decision-replay/README.md`:

```markdown
# DecisionEval — Does your AI agent think like you?

Every memory benchmark measures retrieval: "did the agent remember
what you said?" DecisionEval measures something harder: "does the
agent make the same decisions you would?"

## Quick start
\`\`\`bash
npx decision-eval --dry-run          # preview scenarios
npx decision-eval                    # run with claude
npx decision-eval --tool codex       # run with codex
\`\`\`

## Scores (2026-04-14)
| System       | Decision Match | Note |
|-------------|---------------|------|
| oh-my-brain | 85%           | with L3 directives loaded |
| Raw context | 40%           | no memory system, just guessing |
| (your system)| ?%           | implement MemoryAdapter to test |

## Add your own scenarios
Put YAML files in `scenarios/custom/`. Schema: [schema.json](schema.json)
```

### Acceptance criteria

- 20+ scenarios in builtin.yaml across all 6 categories (min 3 each)
- JSON schema validates all scenarios
- Adapter interface defined with OhMyBrainAdapter + RawContextAdapter
- `oh-my-brain eval --dry-run` prints 20+ scenarios
- `oh-my-brain eval` runs and reports per-category breakdown
- README.md in eval/decision-replay/
- New tests for schema validation + adapter loading

### Gotchas

- **Scenarios must be opinionated.** Each scenario has ONE expected
  answer. This is the point — it tests alignment with a specific
  person's judgment, not general wisdom.
- **relevant_directives can be empty.** Some scenarios test whether
  the agent defaults to a reasonable choice WITHOUT specific directives.
- **Category "communication" is new.** Update the brain_quiz category
  enum to include it.

---

## Task 2: brain_quiz 擴充 + Share

**File:** `cli/mcp-server.ts`, `cli/brain.ts`

### What to do

**2a. brain_quiz uses the expanded scenario pool (Task 1)**

Already wired from v0.3.1 — just verify it picks from the 20+ pool.

**2b. Add `oh-my-brain quiz` CLI command**

Interactive mode that runs brain_quiz scenarios in the terminal:

```bash
oh-my-brain quiz

🧠 Brain Quiz — Does your AI think like you?

Scenario 1/5: Build vs Buy
Your agent system needs a memory layer. Mem0 costs $19/mo...

Your directives say: "Build core differentiators in-house"
Expected: Build in-house
Your AI answered: Build in-house ✅

Scenario 2/5: Ship without guard
...

Result: 4/5 (80%) Decision Match 🧠
```

**2c. Add `--share` flag**

```bash
oh-my-brain quiz --share

Result: 4/5 (80%) Decision Match 🧠

Share this:
─────────────────────────────────
My AI scored 80% on Decision Match 🧠
4/5 decisions matched my judgment.
Tested with oh-my-brain: https://github.com/AgentPolis/oh-my-brain
#DecisionMatch #AIMemory
─────────────────────────────────

Copied to clipboard! (or: pipe to pbcopy)
```

**2d. Quiz history tracking**

Append quiz results to `.squeeze/quiz-history.jsonl`:

```json
{"ts":"2026-04-14T10:00:00Z","total":5,"correct":4,"score":80,"scenarios":["build-vs-buy","ship-without-guard",...]}
```

Show trend in brain_status:
```
quiz_history: 3 runs, avg 78%, trend ↑
```

### Acceptance criteria

- `oh-my-brain quiz` runs 5 random scenarios interactively
- `oh-my-brain quiz --share` produces shareable text
- Quiz results tracked in `.squeeze/quiz-history.jsonl`
- brain_status shows quiz history summary
- Quiz uses expanded scenario pool from Task 1

### Gotchas

- **Interactive mode needs TTY detection.** If not TTY, run all 5
  non-interactively and print results at end.
- **The quiz delegates to codex/claude for answering.** Same
  architecture as Decision Replay eval — zero API key.
- **5 scenarios per quiz is enough.** Don't overwhelm. Random sample
  from the 20+ pool, no repeats within a quiz session.

---

## Task 3: Memory Diff — oh-my-brain diff

**File:** `cli/brain.ts` (new subcommand), `cli/diff.ts` (new)

### What to do

CLI command that shows what your brain learned recently.

```bash
oh-my-brain diff                    # default: last 7 days
oh-my-brain diff --since "3 days"
oh-my-brain diff --since "2026-04-01"
```

**Implementation:**

Read `.squeeze/actions.jsonl` and compute deltas:

```typescript
interface DiffReport {
  period: { from: string; to: string };
  added: {
    directives: number;      // RememberDirective actions
    auto_saved: number;      // from compress hook (high confidence)
    candidates_approved: number; // PromoteCandidate actions
  };
  removed: {
    retired: number;         // RetireDirective actions
    rejected: number;        // RejectCandidate actions
  };
  pending: {
    candidates: number;      // current pending count
    merge_proposals: number; // current pending merges
    conflicts: number;       // contradicts links
  };
  growth: {
    rate_per_day: number;    // directives added per day
    trend: "growing" | "stable" | "shrinking";
    total_directives: number;
  };
  // If archive exists (v0.4):
  archive?: {
    new_entries: number;
    total_entries: number;
  };
}
```

**Output format:**

```
oh-my-brain diff (last 7 days)
──────────────────────────────
+ 3 new directives learned
  + 2 auto-saved (high confidence)
  + 1 approved from candidates
- 1 directive retired
⏳ 2 candidates waiting for review
⚠ 1 conflict detected

Growth: 0.4 directives/day (stable)
Total: 47 directives, ~1,880 tokens

Archive: +156 conversations archived
         Total: 892 entries (2026-03-25 ~ 2026-04-14)
```

**MCP tool: brain_diff**

```typescript
{
  name: "brain_diff",
  description:
    "Show what the brain learned recently. Returns a summary of " +
    "new directives, retired rules, pending candidates, growth " +
    "rate, and archive stats for a given time period.",
  inputSchema: {
    type: "object",
    properties: {
      since: {
        type: "string",
        description: "Time period. Default: '7 days'. Examples: '3 days', '2026-04-01', 'last month'.",
      },
    },
  },
}
```

### Acceptance criteria

- `oh-my-brain diff` shows last 7 days by default
- `oh-my-brain diff --since "3 days"` parses relative dates
- Shows: added, removed, pending, growth rate, trend
- Includes archive stats if archive exists
- `brain_diff` MCP tool returns same data
- Growth trend: "growing" if rate > 0.5/day, "stable" if 0.1-0.5,
  "shrinking" if < 0.1
- New test: `test/diff.test.ts` with at least 6 tests

### Gotchas

- **Actions.jsonl is the source of truth.** Don't duplicate counting
  logic — walk the action log and filter by timestamp.
- **Auto-saved vs approved:** distinguish by action kind.
  RememberDirective from compress hook = auto-saved.
  PromoteCandidate = approved from candidates.
- **Growth trend needs at least 3 days of data.** If fewer, show
  "insufficient data" instead of a misleading trend.

---

## Execution order

```
Task 1 (Decision Replay benchmark)  — no dependencies
Task 2 (brain_quiz expansion)       — depends on Task 1 (scenario pool)
Task 3 (Memory Diff)                — no dependencies

Tasks 1 and 3 can run in parallel.
Task 2 after Task 1.
```

## Verification

After all tasks:

```bash
npm run lint
npm run test:run
npm run build
node dist/cli/brain.js eval --dry-run  # should print 20+ scenarios
node dist/cli/brain.js quiz            # interactive quiz
node dist/cli/brain.js diff            # memory diff
```
