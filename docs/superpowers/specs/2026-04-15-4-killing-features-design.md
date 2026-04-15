# 4 Killing Features Design Spec

> Date: 2026-04-15
> Status: Approved
> Scope: Outcome Loop, Procedure, Sub-agent Context, Growth One-liner

---

## Overview

Four features that make users feel: "Every agent is a partner that knows me better each day."

```
Session failure happens
    ↓
Kill 1: Outcome detection → outcomes.jsonl + L2 caution candidate
    ↓
Kill 2: Procedure → user says "remember this" → extract from tool calls
    ↓
Kill 3: Sub-agent context → prepareSubagentSpawn() injects L3 + procedure + cautions
    ↓
Kill 4: Growth one-liner → session end summary: "Learned: +1 caution (deploy risk)"
```

Shared infrastructure:
- 2 new JSONL stores: OutcomeStore, ProcedureStore (same pattern as EventStore)
- 2 new MCP tools: `brain_save_procedure` (outcome is automatic, no tool needed)
- 3 modified modules: compress hook, assembler, prepareSubagentSpawn()
- brain_recall gains `## Cautions` and `## Relevant Procedures` sections

---

## Kill 1: Outcome Loop

### User's aha moment

> "Last time I chose blue-green deploy and it broke. This time it proactively
> suggested canary and explained why."

### Why this is a killer

No memory product records outcomes. Mem0 records facts, Hermes records skills.
Nobody records results. This is the jump from personalization (like you) to
improvement (better than you).

### Minimal scope

Only record failures. Success is too noisy; failure has lessons.

### Data flow

```
compress hook fires
  ↓
scanSessionForFailures(recentMessages[])
  ├─ regex scan last N messages (configurable, default 50)
  ├─ match failure patterns (only in tool_result or user messages, NOT assistant):
  │   Tool results: exit code != 0, stderr non-empty, "FAILED" in test output
  │   User corrections: "wrong"|"broke"|"broken"|"redo"|"不對"|"壞了"|"搞砸"|"錯了"|"重做"
  │   Rollback signals: "rollback"|"revert"|"回滾" (in tool_result context only)
  │   Exclusion list: skip matches inside "error handling", "error boundary",
  │     "TypeError docs", "revert commit" (common false positives)
  │   Confidence gate: require 2+ signals in a 6-message window to trigger
  ├─ for each match, extract context window (3 msgs before + 3 after)
  ├─ dedup: skip if same failure_mode recorded in last 24h (Jaccard > 0.8)
  └─ produce OutcomeRecord[]
  ↓
OutcomeStore.append(records)          // write .squeeze/outcomes.jsonl
  ↓
for each failure outcome:
  ingestCandidates(candidateStore,
    [`Last time ${context_summary} caused ${failure_mode}. Consider avoiding.`],
    { source: "outcome" })
  // goes through Memory Candidate flow, NOT directly to MEMORY.md
```

### OutcomeRecord schema

```typescript
interface OutcomeRecord {
  id: string;              // nanoid
  result: "failure";       // v1 only tracks failure
  failure_mode: string;    // matched error type / message summary
  context: string;         // 3+3 message window, truncated to 200 chars
  lesson: string;          // template-generated (no LLM)
  session_id: string;
  timestamp: string;       // ISO-8601
}
```

### Lesson generation (template, no LLM)

- If rollback detected: `"Last time {context} required rollback. Do a dry-run first next time."`
- If error detected: `"Last time {context} hit {error_snippet}. Watch out for {related_op}."`
- If user correction: `"Last time {context} was corrected by user: {user_correction}."`

### brain_recall integration

brain_recall appends a `## Cautions` section at the end:
- Read last 10 failures from outcomes.jsonl
- Keyword overlap match against current recall context
- Return only matched cautions (typically 0-3)
- Format:
  ```
  ## Cautions
  - ⚠️ Last time blue-green deploy failed due to missing migration (2026-03-20)
  - ⚠️ npm test may fail if lockfile is stale — run npm install first
  ```

### New files

| File | Purpose |
|------|---------|
| `src/storage/outcomes.ts` | OutcomeStore — JSONL append/read/search (same pattern as EventStore) |
| `src/outcome/detector.ts` | `scanSessionForFailures()` — regex detection + OutcomeRecord production |

### Modified files

| File | Change |
|------|--------|
| `cli/compress-core.ts` | Call outcome detection at end of compress flow |
| `cli/mcp-server.ts` | brain_recall appends `## Cautions` section |

### Tests

`test/outcome-detector.test.ts`:
- Given mock messages with exit code 1 + user says "broke" → detects 1 failure (2 signals)
- Given mock messages with "壞了" + error in tool result → detects 1 failure (Chinese)
- Given single "error" mention in assistant message → detects 0 (assistant-only, below threshold)
- Given "error handling" in code discussion → detects 0 (exclusion list)
- Given clean session (no errors) → detects 0 failures
- Given empty messages array → returns []
- Dedup: same failure_mode within 24h → skipped
- Lesson template produces valid string
- Caution candidate is ingested into candidate store

---

## Kill 2: Procedure

### User's aha moment

> "I didn't teach it the deploy workflow, but it remembered my steps from
> last time, including to run smoke test first."

### Why this is a killer

This is Hermes Skills System's core capability. Without procedural memory,
brain can only help agents "know you", not "do work for you".

### Minimal scope

Only explicit trigger: user says "remember this workflow" → agent calls
`brain_save_procedure`. No automatic detection (too complex for v1).

### Data flow

```
Agent calls brain_save_procedure({ title, trigger })
  ↓
Read current session messages from session JSONL file
  (via findSessionJsonl() + parseSessionEntries() from compress-core.ts,
   NOT ArchiveStore — archive only has past sessions, not current)
  ↓
extractProcedure(messages[])
  ├─ filter tool_use / tool_result messages
  ├─ extract steps[] in order
  ├─ extract pitfalls[] from error→retry sequences
  ├─ extract verification[] from final check/test/assert steps
  └─ produce ProcedureRecord (status: "candidate")
  ↓
ProcedureStore.append(record)    // write .squeeze/procedures.jsonl
  ↓
Return "Procedure '{title}' saved as candidate. Use brain_candidates to review."
```

### ProcedureRecord schema

```typescript
interface ProcedureRecord {
  id: string;              // nanoid
  title: string;           // user-provided title
  trigger: string;         // what task description triggers this procedure
  steps: ProcedureStep[];
  pitfalls: string[];      // from error/retry sequences
  verification: string[];  // from assert/test/check steps
  status: "candidate" | "approved" | "archived";
  source_session_id: string;
  created_at: string;
  updated_at: string;
}

interface ProcedureStep {
  order: number;
  action: string;          // human-readable description
  tool?: string;           // which tool was used (bash, edit, etc.)
}
```

### extractProcedure logic

1. Scan session messages for tool_use blocks
2. Each tool call → one step: `{ order: N, action: "Ran npm test", tool: "bash" }`
3. Consecutive error + retry → pitfall: `"npm test may fail if lockfile stale, run npm install first"`
4. Last 3 steps containing test/verify/assert/check/confirm keywords → verification

### brain_recall integration

brain_recall appends `## Relevant Procedures` section:
- Read approved procedures from procedures.jsonl
- Keyword overlap match trigger against current recall context
- Return 0-1 matched procedures
- Format:
  ```
  ## Relevant Procedures
  ### Production Deploy
  1. Run smoke test suite
  2. Deploy canary at 10%
  3. Monitor 15 minutes
  4. Full rollout
  ⚠️ Pitfall: Don't skip migration check
  ✅ Verify: Run health check endpoint after rollout
  ```

### Procedure review

Separate MCP tool: `brain_procedures` with `action: list | approve | archive`.
NOT overloading `brain_candidates` — the data shape is fundamentally different
(ProcedureRecord has steps[], pitfalls[], verification[] vs CandidateRecord's flat text).
Approving a procedure changes status in procedures.jsonl, does NOT write to MEMORY.md.

### New files

| File | Purpose |
|------|---------|
| `src/storage/procedures.ts` | ProcedureStore — JSONL append/read/search/updateStatus |
| `src/procedure/extractor.ts` | `extractProcedure()` — tool call sequence → ProcedureRecord |

### Modified files

| File | Change |
|------|--------|
| `cli/mcp-server.ts` | New `brain_save_procedure` tool + brain_recall appends procedures |
| `cli/mcp-server.ts` | New `brain_procedures` tool (list/approve/archive) |

### Tests

`test/procedure-extractor.test.ts`:
- Given 5 tool calls (bash, edit, bash, bash, bash) → produces 5 steps in order
- Given error→retry sequence → extracts pitfall
- Given final "npm test" step → extracts verification
- Given no tool calls → returns empty procedure with warning
- Given no procedures.jsonl file → ProcedureStore.getAll() returns []
- ProcedureStore round-trip: append → read → status matches
- Approve flow via brain_procedures: status transitions from "candidate" to "approved"

---

## Kill 3: Sub-agent Context

### User's aha moment

> "I asked a sub-agent to deploy, and it automatically avoided Asia business
> hours because it knew my rules."

### Why this is a killer

Hermes and all competitors' sub-agents are "memoryless temp workers."
This is a structural differentiator unique to brain-first architecture.

### Minimal scope

Inject L3 directives + 1 matched procedure + top 3 cautions.
No events, relations, or preferences. L3 is enough.

### Implementation

Modify `prepareSubagentSpawn()` in `src/engine.ts`.

**Interface constraint:** `ContextEngine.prepareSubagentSpawn(parentContext)` signature
is NOT modified (it mirrors the OpenClaw plugin slot). Instead, `taskDescription` is
passed via a setter, following the `setMemoryEnabled()` precedent:

```typescript
// New setter on SqueezeContextEngine (does NOT change ContextEngine interface)
setSubagentTaskHint(description: string): void {
  this._subagentTaskHint = description;
}

async prepareSubagentSpawn(
  parentContext: AssembledContext
): Promise<AssembledContext> {
  const taskDescription = this._subagentTaskHint;
  this._subagentTaskHint = undefined; // consume once

  // 1. Gather personal context
  // OutcomeStore and ProcedureStore are JSONL-based (not PGlite).
  // They are initialized in bootstrap() using this.squeezePath
  // (derived from dbPath's parent directory, same as EventStore).
  const directives = await this.directiveStore.getActiveDirectives();
  
  const matchedProcedure = taskDescription
    ? await this.procedureStore.findApprovedByTrigger(taskDescription)
    : null;

  const cautions = taskDescription
    ? await this.outcomeStore.findRelevant(taskDescription, 3)
    : [];

  // 2. Format as plain text block
  const personalBlock = formatPersonalContext(directives, matchedProcedure, cautions);

  // 3. Assemble with half parent budget
  const halfBudget = Math.floor(parentContext.budget.maxTokens * 0.5);
  return assembleSubagentContext(personalBlock, halfBudget);
}
```

**Store initialization:** `OutcomeStore` and `ProcedureStore` are JSONL-based
(like EventStore), not PGlite-based. They need access to `.squeeze/` path.
In `bootstrap(dbPath)`, derive `squeezePath` from dbPath's parent:
```typescript
this.squeezePath = join(dirname(dbPath), '.squeeze');
this.outcomeStore = new OutcomeStore(this.squeezePath);
this.procedureStore = new ProcedureStore(this.squeezePath);
```

**Token cap:** The 2K limit is configurable via `SqueezeConfig.subagentPersonalContextMaxTokens`
(default: 2000). Token counting uses the existing `estimateTokens()` from `budget.ts`.

### formatPersonalContext output

```
<personal-context>
## Your Rules
- Always run smoke test before production deploy
- Never deploy during Asia business hours (UTC+8 09:00-18:00)
- Use TypeScript strict mode

## Procedure: Production Deploy
1. Run smoke test suite
2. Deploy canary at 10%
3. Monitor 15 minutes
4. Full rollout
⚠️ Pitfall: Don't skip migration check

## Cautions
- ⚠️ Last time blue-green deploy failed due to missing migration (2026-03-20)
</personal-context>
```

### Token cap strategy

Target: < 2K tokens for personal block.

If personal context exceeds 2K tokens, truncate in order:
1. Reduce cautions to top 1
2. Reduce procedure to title + pitfalls only (drop steps)
3. L3 directives are never truncated (usually < 20 items < 1K tokens)

### Interface compatibility

`ContextEngine.prepareSubagentSpawn()` signature is NOT changed.
`taskDescription` is passed via `setSubagentTaskHint()` setter (consumed once),
following the `setMemoryEnabled()` precedent in the engine class.

### Modified files

| File | Change |
|------|--------|
| `src/engine.ts` | `prepareSubagentSpawn()` full implementation |
| `src/assembly/assembler.ts` | New `formatPersonalContext()` + `assembleSubagentContext()` |

### Tests

`test/subagent-context.test.ts`:
- Given 5 directives + 1 procedure + 2 cautions → output contains all sections
- Given no procedure match → output has Rules + Cautions only (no Procedure section)
- Given no cautions → output has Rules + Procedure only (no Cautions section)
- Token cap: given 50 directives + long procedure → output < 2K tokens
- Format: output is wrapped in `<personal-context>` tags

---

## Kill 4: Growth One-liner

### User's aha moment

> Session ends, user sees:
> "🧠 Learned: +1 caution (deploy risk), +1 procedure candidate (deploy SOP)"

### Why this matters

User sees one line, knows the system is learning. Hermes shows new skills
appearing in a directory; we show one sentence. Same effect, less noise.

### Minimal scope

One line at session end. No CLI report, no diff, no weekly summary.

### Data flow

```
compress hook tail (after outcome detection)
  ↓
buildGrowthOneLiner(sessionStats)
  ├─ count new directives this session (from action log)
  ├─ count new outcomes this session (from outcome detection result)
  ├─ count new procedure candidates this session
  ├─ count cautions referenced (search session msgs for caution keywords)
  └─ compose one-liner string
  ↓
write to .squeeze/growth-journal.jsonl (existing growth journal)
  ↓
output to stdout (compress hook output is shown by Claude Code)
```

### One-liner format

```
🧠 本次學到：+1 caution（deploy 失敗風險），+1 procedure candidate（deploy SOP）
```

Rules:
- Each growth type is one fragment, joined by `，`
- Types: caution / directive / preference / procedure
- Fragment format: `+N {type}（{summary of most important one}）`
- If nothing learned → output nothing (avoid noise)
- Language detection: if >30% of user messages contain CJK characters → Chinese, else English

### SessionStats interface

```typescript
interface SessionStats {
  new_directives: number;
  new_preferences: number;
  new_outcomes: OutcomeRecord[];
  new_procedures: number;
}
```

Note: `cautions_referenced` tracking (how many times brain_recall cautions were used)
is dropped from v1 — it requires cross-session state tracking that adds complexity
without proportional user value. Can be added later by parsing session JSONL for
brain_recall tool calls.

### New files

| File | Purpose |
|------|---------|
| `src/growth/one-liner.ts` | `buildGrowthOneLiner()` — stats → formatted string |

### Modified files

| File | Change |
|------|--------|
| `cli/compress-core.ts` | Call one-liner builder at end, output to stdout |

### Tests

`test/growth-oneliner.test.ts`:
- Given 1 outcome + 1 procedure → produces string with both fragments
- Given 0 everything → returns empty string (no output)
- Given 3 outcomes → summary shows count + most important one's context
- Chinese session (>30% CJK in user msgs) → Chinese output; else English

---

## Implementation Order

```
Kill 1 (Outcome)  ←→  Kill 2 (Procedure)    // parallel, no dependency
         ↓                    ↓
         └────────┬───────────┘
                  ↓
      Kill 3 (Sub-agent context)              // needs outcome + procedure stores
                  ↓
      Kill 4 (Growth one-liner)               // needs outcome detection result
```

## File Summary

### New files (8)

| File | Lines (est.) |
|------|-------------|
| `src/storage/outcomes.ts` | ~80 |
| `src/storage/procedures.ts` | ~100 |
| `src/outcome/detector.ts` | ~120 |
| `src/procedure/extractor.ts` | ~100 |
| `src/growth/one-liner.ts` | ~60 |
| `test/outcome-detector.test.ts` | ~120 |
| `test/procedure-extractor.test.ts` | ~120 |
| `test/subagent-context.test.ts` | ~80 |
| `test/growth-oneliner.test.ts` | ~60 |

### Modified files (5)

| File | Change |
|------|--------|
| `cli/compress-core.ts` | +outcome detection +growth one-liner at tail |
| `cli/mcp-server.ts` | +brain_save_procedure, +brain_procedures tools, +cautions/procedures in brain_recall |
| `src/engine.ts` | +prepareSubagentSpawn() full impl, +setSubagentTaskHint(), +outcome/procedure store init |
| `src/assembly/assembler.ts` | +formatPersonalContext() +assembleSubagentContext() |
| `src/types.ts` | +OutcomeRecord, +ProcedureRecord, +ProcedureStep, +SessionStats, +SqueezeConfig.subagentPersonalContextMaxTokens |

### Estimated total: ~840 new lines + ~200 modified lines

---

## Eng Review Amendments (2026-04-15)

6 項修改來自 /plan-eng-review + Codex outside voice：

1. **Stale references:** 計畫裡所有 `squeeze-claw` 路徑改成 `oh-my-brain`，`nanoid` 改 `crypto.randomUUID()`
2. **Procedure session access:** `brain_save_procedure` 改用 `recent_tool_calls` 參數（agent 傳 messages），MCP server 不碰 session JSONL
3. **Integration tests:** 加 MCP tool + compress flow 的整合測試（~5 tests in mcp-server.test.ts + compress.test.ts）
4. **Null guard:** `bootstrapWithDb()` 也初始化 outcomeStore/procedureStore；`prepareSubagentSpawn()` 加 null check
5. **Hard trim:** `formatPersonalContext()` 加 hard trim — 如果 L3 directives 超過 token cap，截斷最舊的，加 "(N more omitted)"
6. **Procedure counting:** compress hook 讀 `procedures.jsonl` 比對 timestamp 算 `new_procedures`，而非 hardcode 0
