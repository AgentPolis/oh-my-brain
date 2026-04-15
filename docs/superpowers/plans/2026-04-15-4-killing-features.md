# 4 Killing Features Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add outcome loop, procedure extraction, sub-agent personal context, and growth one-liner to oh-my-brain.

**Architecture:** Four features sharing 2 new JSONL stores (OutcomeStore, ProcedureStore) following EventStore pattern. Outcome detection runs in compress hook via regex. Procedure extraction is user-triggered via MCP tool. Sub-agent context injects L3 + procedure + cautions into prepareSubagentSpawn(). Growth one-liner outputs to stdout at session end.

**Tech Stack:** TypeScript, vitest, PGLite (existing stores), JSONL (new stores), nanoid

**Spec:** `docs/superpowers/specs/2026-04-15-4-killing-features-design.md`

---

## Chunk 1: Types + OutcomeStore + ProcedureStore

### Task 1: Add new types to types.ts

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add OutcomeRecord, ProcedureRecord, ProcedureStep, SessionStats types**

Append after the `ContextEngineFactory` type at end of file:

```typescript
// ── Outcome Loop ────────────────────────────────────────────────

export interface OutcomeRecord {
  id: string;
  result: "failure";
  failure_mode: string;
  context: string;
  lesson: string;
  session_id: string;
  timestamp: string;
}

// ── Procedure ───────────────────────────────────────────────────

export interface ProcedureStep {
  order: number;
  action: string;
  tool?: string;
}

export interface ProcedureRecord {
  id: string;
  title: string;
  trigger: string;
  steps: ProcedureStep[];
  pitfalls: string[];
  verification: string[];
  status: "candidate" | "approved" | "archived";
  source_session_id: string;
  created_at: string;
  updated_at: string;
}

// ── Growth One-liner ────────────────────────────────────────────

export interface SessionStats {
  new_directives: number;
  new_preferences: number;
  new_outcomes: OutcomeRecord[];
  new_procedures: number;
}
```

- [ ] **Step 2: Add subagentPersonalContextMaxTokens to SqueezeConfig**

In the `SqueezeConfig` interface, add after `dagSummaryLOD`:

```typescript
  subagentPersonalContextMaxTokens: number;
```

In `DEFAULT_CONFIG`, add after `dagSummaryLOD: true`:

```typescript
  subagentPersonalContextMaxTokens: 2000,
```

- [ ] **Step 3: Verify types compile**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/types.ts
git commit -m "feat: add OutcomeRecord, ProcedureRecord, SessionStats types"
```

---

### Task 2: Create OutcomeStore

**Files:**
- Create: `src/storage/outcomes.ts`
- Create: `test/outcomes.test.ts`

- [ ] **Step 1: Write failing tests for OutcomeStore**

Create `test/outcomes.test.ts`. Follow the EventStore test pattern (`test/events.test.ts`): temp dir, beforeEach/afterEach cleanup, makeStore helper.

```typescript
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OutcomeStore } from "../src/storage/outcomes.js";
import type { OutcomeRecord } from "../src/types.js";

describe("OutcomeStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-outcomes-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(): OutcomeStore {
    return new OutcomeStore(join(tmp, ".squeeze"));
  }

  function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
    return {
      id: overrides.id ?? "out-1",
      result: "failure",
      failure_mode: overrides.failure_mode ?? "exit code 1",
      context: overrides.context ?? "npm test failed in deploy step",
      lesson: overrides.lesson ?? "Run npm install before npm test",
      session_id: overrides.session_id ?? "sess-1",
      timestamp: overrides.timestamp ?? "2026-04-15T10:00:00.000Z",
    };
  }

  it("returns [] when outcomes.jsonl does not exist", () => {
    const store = makeStore();
    expect(store.getAll()).toEqual([]);
  });

  it("creates outcomes.jsonl on first append", () => {
    const store = makeStore();
    store.append([makeOutcome()]);
    expect(existsSync(join(tmp, ".squeeze", "outcomes.jsonl"))).toBe(true);
  });

  it("round-trips: append then getAll returns same records", () => {
    const store = makeStore();
    const record = makeOutcome({ id: "out-42" });
    store.append([record]);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("out-42");
    expect(all[0].failure_mode).toBe("exit code 1");
  });

  it("appends without overwriting existing entries", () => {
    const store = makeStore();
    store.append([makeOutcome({ id: "out-1" })]);
    store.append([makeOutcome({ id: "out-2" })]);
    expect(store.getAll()).toHaveLength(2);
  });

  it("findRelevant matches by keyword overlap", () => {
    const store = makeStore();
    store.append([
      makeOutcome({ id: "out-1", failure_mode: "deploy rollback", context: "blue-green deploy failed" }),
      makeOutcome({ id: "out-2", failure_mode: "test timeout", context: "jest hung on CI" }),
    ]);
    const matches = store.findRelevant("deploy to production", 3);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].id).toBe("out-1");
  });

  it("findRelevant returns empty for no keyword match", () => {
    const store = makeStore();
    store.append([makeOutcome({ failure_mode: "deploy rollback" })]);
    expect(store.findRelevant("database migration", 3)).toHaveLength(0);
  });

  it("getRecent returns last N outcomes", () => {
    const store = makeStore();
    store.append([
      makeOutcome({ id: "out-1", timestamp: "2026-04-14T10:00:00.000Z" }),
      makeOutcome({ id: "out-2", timestamp: "2026-04-15T10:00:00.000Z" }),
      makeOutcome({ id: "out-3", timestamp: "2026-04-15T12:00:00.000Z" }),
    ]);
    const recent = store.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe("out-3");
  });

  it("isDuplicate returns true for same failure_mode within 24h", () => {
    const store = makeStore();
    store.append([makeOutcome({
      failure_mode: "exit code 1",
      timestamp: "2026-04-15T10:00:00.000Z",
    })]);
    expect(store.isDuplicate("exit code 1", "2026-04-15T20:00:00.000Z")).toBe(true);
  });

  it("isDuplicate returns false after 24h", () => {
    const store = makeStore();
    store.append([makeOutcome({
      failure_mode: "exit code 1",
      timestamp: "2026-04-14T10:00:00.000Z",
    })]);
    expect(store.isDuplicate("exit code 1", "2026-04-15T20:00:00.000Z")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/outcomes.test.ts`
Expected: FAIL — cannot find module `../src/storage/outcomes.js`

- [ ] **Step 3: Implement OutcomeStore**

Create `src/storage/outcomes.ts` following EventStore pattern:

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { OutcomeRecord } from "../types.js";

const OUTCOMES_FILE = "outcomes.jsonl";

export class OutcomeStore {
  private squeezePath: string;
  private outcomesPath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.outcomesPath = join(squeezePath, OUTCOMES_FILE);
  }

  append(records: OutcomeRecord[]): void {
    if (records.length === 0) return;
    mkdirSync(this.squeezePath, { recursive: true });
    const serialized = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    appendFileSync(this.outcomesPath, serialized);
  }

  getAll(): OutcomeRecord[] {
    if (!existsSync(this.outcomesPath)) return [];
    const raw = readFileSync(this.outcomesPath, "utf8");
    if (!raw.trim()) return [];
    const records: OutcomeRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as OutcomeRecord);
      } catch {
        continue;
      }
    }
    return records;
  }

  getRecent(limit: number): OutcomeRecord[] {
    return this.getAll()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  findRelevant(taskDescription: string, limit: number): OutcomeRecord[] {
    const keywords = taskDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return [];

    const scored = this.getAll().map((record) => {
      const text = `${record.failure_mode} ${record.context} ${record.lesson}`.toLowerCase();
      const matches = keywords.filter((kw) => text.includes(kw)).length;
      return { record, score: matches / keywords.length };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.record);
  }

  isDuplicate(failureMode: string, currentTimestamp: string): boolean {
    const current = Date.parse(currentTimestamp);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const normalized = failureMode.toLowerCase().trim();
    return this.getAll().some((r) => {
      const age = current - Date.parse(r.timestamp);
      return age >= 0 && age < DAY_MS && r.failure_mode.toLowerCase().trim() === normalized;
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/outcomes.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/storage/outcomes.ts test/outcomes.test.ts
git commit -m "feat: add OutcomeStore with JSONL persistence and keyword search"
```

---

### Task 3: Create ProcedureStore

**Files:**
- Create: `src/storage/procedures.ts`
- Create: `test/procedures.test.ts`

- [ ] **Step 1: Write failing tests for ProcedureStore**

Create `test/procedures.test.ts`:

```typescript
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ProcedureStore } from "../src/storage/procedures.js";
import type { ProcedureRecord } from "../src/types.js";

describe("ProcedureStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-procedures-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(): ProcedureStore {
    return new ProcedureStore(join(tmp, ".squeeze"));
  }

  function makeProcedure(overrides: Partial<ProcedureRecord> = {}): ProcedureRecord {
    return {
      id: overrides.id ?? "proc-1",
      title: overrides.title ?? "Production Deploy",
      trigger: overrides.trigger ?? "deploy to production",
      steps: overrides.steps ?? [
        { order: 1, action: "Run smoke test", tool: "bash" },
        { order: 2, action: "Deploy canary 10%", tool: "bash" },
      ],
      pitfalls: overrides.pitfalls ?? ["Don't skip migration check"],
      verification: overrides.verification ?? ["Run health check endpoint"],
      status: overrides.status ?? "candidate",
      source_session_id: overrides.source_session_id ?? "sess-1",
      created_at: overrides.created_at ?? "2026-04-15T10:00:00.000Z",
      updated_at: overrides.updated_at ?? "2026-04-15T10:00:00.000Z",
    };
  }

  it("returns [] when procedures.jsonl does not exist", () => {
    const store = makeStore();
    expect(store.getAll()).toEqual([]);
  });

  it("creates procedures.jsonl on first append", () => {
    const store = makeStore();
    store.append(makeProcedure());
    expect(existsSync(join(tmp, ".squeeze", "procedures.jsonl"))).toBe(true);
  });

  it("round-trips: append then getAll", () => {
    const store = makeStore();
    store.append(makeProcedure({ id: "proc-42" }));
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("proc-42");
    expect(all[0].steps).toHaveLength(2);
  });

  it("getApproved returns only approved procedures", () => {
    const store = makeStore();
    store.append(makeProcedure({ id: "proc-1", status: "candidate" }));
    store.append(makeProcedure({ id: "proc-2", status: "approved" }));
    store.append(makeProcedure({ id: "proc-3", status: "archived" }));
    const approved = store.getApproved();
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe("proc-2");
  });

  it("findApprovedByTrigger matches by keyword overlap", () => {
    const store = makeStore();
    store.append(makeProcedure({ id: "proc-1", trigger: "deploy to production", status: "approved" }));
    store.append(makeProcedure({ id: "proc-2", trigger: "run database migration", status: "approved" }));
    const match = store.findApprovedByTrigger("deploy the app to production");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("proc-1");
  });

  it("findApprovedByTrigger returns null for no match", () => {
    const store = makeStore();
    store.append(makeProcedure({ trigger: "deploy to production", status: "approved" }));
    expect(store.findApprovedByTrigger("write unit tests")).toBeNull();
  });

  it("findApprovedByTrigger ignores non-approved procedures", () => {
    const store = makeStore();
    store.append(makeProcedure({ trigger: "deploy to production", status: "candidate" }));
    expect(store.findApprovedByTrigger("deploy to production")).toBeNull();
  });

  it("updateStatus transitions candidate to approved", () => {
    const store = makeStore();
    store.append(makeProcedure({ id: "proc-1", status: "candidate" }));
    const updated = store.updateStatus("proc-1", "approved");
    expect(updated).toBe(true);
    expect(store.getAll()[0].status).toBe("approved");
  });

  it("updateStatus returns false for unknown id", () => {
    const store = makeStore();
    expect(store.updateStatus("nonexistent", "approved")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/procedures.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement ProcedureStore**

Create `src/storage/procedures.ts`:

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProcedureRecord } from "../types.js";

const PROCEDURES_FILE = "procedures.jsonl";

export class ProcedureStore {
  private squeezePath: string;
  private proceduresPath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.proceduresPath = join(squeezePath, PROCEDURES_FILE);
  }

  append(record: ProcedureRecord): void {
    mkdirSync(this.squeezePath, { recursive: true });
    appendFileSync(this.proceduresPath, `${JSON.stringify(record)}\n`);
  }

  getAll(): ProcedureRecord[] {
    if (!existsSync(this.proceduresPath)) return [];
    const raw = readFileSync(this.proceduresPath, "utf8");
    if (!raw.trim()) return [];
    const records: ProcedureRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as ProcedureRecord);
      } catch {
        continue;
      }
    }
    return records;
  }

  getApproved(): ProcedureRecord[] {
    return this.getAll().filter((r) => r.status === "approved");
  }

  findApprovedByTrigger(taskDescription: string): ProcedureRecord | null {
    const keywords = taskDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return null;

    let best: ProcedureRecord | null = null;
    let bestScore = 0;

    for (const proc of this.getApproved()) {
      const triggerWords = proc.trigger.toLowerCase().split(/\s+/);
      const matches = keywords.filter((kw) => triggerWords.some((tw) => tw.includes(kw))).length;
      const score = matches / keywords.length;
      if (score > bestScore && score > 0.3) {
        best = proc;
        bestScore = score;
      }
    }
    return best;
  }

  updateStatus(id: string, status: ProcedureRecord["status"]): boolean {
    const all = this.getAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    all[idx].status = status;
    all[idx].updated_at = new Date().toISOString();
    mkdirSync(this.squeezePath, { recursive: true });
    writeFileSync(this.proceduresPath, all.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/procedures.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/storage/procedures.ts test/procedures.test.ts
git commit -m "feat: add ProcedureStore with JSONL persistence, trigger matching, status updates"
```

---

## Chunk 2: Outcome Detector + Procedure Extractor

### Task 4: Create outcome detector

**Files:**
- Create: `src/outcome/detector.ts`
- Create: `test/outcome-detector.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/outcome-detector.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { scanSessionForFailures, generateLesson } from "../src/outcome/detector.js";

describe("scanSessionForFailures", () => {
  function msg(role: "user" | "assistant" | "tool", content: string) {
    return { role, content };
  }

  it("detects failure when tool_result has exit code 1 and user says broke", () => {
    const messages = [
      msg("user", "deploy to production"),
      msg("assistant", "Running deploy script..."),
      msg("tool", "Error: exit code 1\nCommand failed"),
      msg("user", "it broke, rollback"),
      msg("assistant", "Rolling back..."),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe("failure");
    expect(outcomes[0].failure_mode).toContain("exit code");
  });

  it("detects Chinese failure signals", () => {
    const messages = [
      msg("user", "部署到 production"),
      msg("tool", "ERROR: connection refused"),
      msg("user", "壞了，趕快回滾"),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(1);
  });

  it("ignores single error mention in assistant message", () => {
    const messages = [
      msg("user", "how do I handle errors?"),
      msg("assistant", "You should use try/catch for error handling"),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(0);
  });

  it("ignores 'error handling' in code discussion (exclusion list)", () => {
    const messages = [
      msg("user", "add error handling to the API"),
      msg("tool", "Updated error boundary component"),
      msg("user", "looks good"),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(0);
  });

  it("returns [] for clean session", () => {
    const messages = [
      msg("user", "write a function"),
      msg("assistant", "Here is the function"),
      msg("tool", "Tests passed"),
    ];
    expect(scanSessionForFailures(messages, "sess-1")).toHaveLength(0);
  });

  it("returns [] for empty messages array", () => {
    expect(scanSessionForFailures([], "sess-1")).toHaveLength(0);
  });
});

describe("generateLesson", () => {
  it("generates rollback lesson", () => {
    const lesson = generateLesson("rollback", "deploy failed", "blue-green deploy");
    expect(lesson).toContain("rollback");
    expect(lesson).toContain("dry-run");
  });

  it("generates error lesson", () => {
    const lesson = generateLesson("error", "ENOENT", "file operation");
    expect(lesson).toContain("ENOENT");
  });

  it("generates user correction lesson", () => {
    const lesson = generateLesson("correction", "wrong approach", "use canary instead");
    expect(lesson).toContain("corrected");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/outcome-detector.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement outcome detector**

Create `src/outcome/detector.ts`:

```typescript
import { randomUUID } from "crypto";
import type { OutcomeRecord } from "../types.js";

interface SimpleMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

// Only match in tool_result or user messages, NOT assistant
const TOOL_FAILURE_PATTERNS = [
  /exit code [1-9]\d*/i,
  /\bFAILED\b/,
  /\bERROR\b.*(?:refused|timeout|ENOENT|EACCES|EPERM)/i,
  /\bstderr\b.{0,50}\S/i,
];

const USER_CORRECTION_PATTERNS = [
  /\b(?:wrong|broke|broken|redo)\b/i,
  /不對|壞了|搞砸|錯了|重做/,
];

const ROLLBACK_PATTERNS = [
  /\b(?:rollback|revert|回滾)\b/i,
];

// Skip matches containing these (false positives)
const EXCLUSIONS = [
  /error\s+handling/i,
  /error\s+boundary/i,
  /TypeError\s+docs?/i,
  /revert\s+commit/i,
  /error\s+message/i,
  /error\s+code/i,
];

const WINDOW_SIZE = 6; // 6-message window for confidence gate

export function scanSessionForFailures(
  messages: SimpleMessage[],
  sessionId: string,
  maxMessages = 50
): OutcomeRecord[] {
  if (messages.length === 0) return [];

  const recent = messages.slice(-maxMessages);
  const outcomes: OutcomeRecord[] = [];

  // Scan with sliding window
  for (let i = 0; i < recent.length; i++) {
    const windowStart = Math.max(0, i - 3);
    const windowEnd = Math.min(recent.length, i + 4);
    const window = recent.slice(windowStart, windowEnd);

    // Count signals in window (only from tool/user messages)
    let signals = 0;
    let failureType: "rollback" | "error" | "correction" = "error";
    let failureDetail = "";

    for (const m of window) {
      if (m.role === "assistant" || m.role === "system") continue;

      const text = m.content;

      // Check exclusions first
      if (EXCLUSIONS.some((ex) => ex.test(text))) continue;

      for (const pattern of TOOL_FAILURE_PATTERNS) {
        if (m.role === "tool" && pattern.test(text)) {
          signals++;
          failureType = "error";
          failureDetail = text.slice(0, 100);
          break;
        }
      }

      for (const pattern of USER_CORRECTION_PATTERNS) {
        if (m.role === "user" && pattern.test(text)) {
          signals++;
          failureType = "correction";
          failureDetail = text.slice(0, 100);
          break;
        }
      }

      for (const pattern of ROLLBACK_PATTERNS) {
        if (pattern.test(text)) {
          signals++;
          failureType = "rollback";
          failureDetail = text.slice(0, 100);
          break;
        }
      }
    }

    // Confidence gate: require 2+ signals
    if (signals >= 2) {
      const contextText = window
        .map((m) => `[${m.role}] ${m.content.slice(0, 50)}`)
        .join(" | ")
        .slice(0, 200);

      outcomes.push({
        id: randomUUID().slice(0, 12),
        result: "failure",
        failure_mode: failureDetail,
        context: contextText,
        lesson: generateLesson(failureType, failureDetail, contextText),
        session_id: sessionId,
        timestamp: new Date().toISOString(),
      });

      // Skip ahead past this window to avoid duplicate detections
      i = windowEnd - 1;
    }
  }

  return outcomes;
}

export function generateLesson(
  type: "rollback" | "error" | "correction",
  detail: string,
  context: string
): string {
  const shortContext = context.slice(0, 80);
  switch (type) {
    case "rollback":
      return `Last time ${shortContext} required rollback. Do a dry-run first next time.`;
    case "error":
      return `Last time ${shortContext} hit ${detail.slice(0, 50)}. Watch out for this.`;
    case "correction":
      return `Last time ${shortContext} was corrected by user: ${detail.slice(0, 50)}.`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/outcome-detector.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/outcome/detector.ts test/outcome-detector.test.ts
git commit -m "feat: add outcome detector with regex failure scanning and lesson templates"
```

---

### Task 5: Create procedure extractor

**Files:**
- Create: `src/procedure/extractor.ts`
- Create: `test/procedure-extractor.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/procedure-extractor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { extractProcedure } from "../src/procedure/extractor.js";

describe("extractProcedure", () => {
  // Simulate session messages with tool_use patterns
  function toolMsg(tool: string, action: string, result?: string) {
    return [
      { role: "assistant" as const, content: `Using ${tool}: ${action}` },
      { role: "tool" as const, content: result ?? `Success: ${action}` },
    ];
  }

  function errorRetryMsgs(tool: string, errorMsg: string, retryAction: string) {
    return [
      { role: "assistant" as const, content: `Using ${tool}: initial attempt` },
      { role: "tool" as const, content: `Error: ${errorMsg}` },
      { role: "assistant" as const, content: `Using ${tool}: ${retryAction}` },
      { role: "tool" as const, content: `Success: ${retryAction}` },
    ];
  }

  it("extracts steps from 5 tool calls in order", () => {
    const messages = [
      ...toolMsg("bash", "npm install"),
      ...toolMsg("bash", "npm run build"),
      ...toolMsg("edit", "update config"),
      ...toolMsg("bash", "npm test"),
      ...toolMsg("bash", "npm run deploy"),
    ];
    const proc = extractProcedure(messages, "Deploy App", "deploy", "sess-1");
    expect(proc.steps).toHaveLength(5);
    expect(proc.steps[0].order).toBe(1);
    expect(proc.steps[0].action).toContain("npm install");
    expect(proc.steps[4].action).toContain("npm run deploy");
  });

  it("extracts pitfall from error→retry sequence", () => {
    const messages = [
      ...toolMsg("bash", "npm install"),
      ...errorRetryMsgs("bash", "ENOENT package.json", "cd project && npm install"),
      ...toolMsg("bash", "npm test"),
    ];
    const proc = extractProcedure(messages, "Setup", "setup project", "sess-1");
    expect(proc.pitfalls.length).toBeGreaterThanOrEqual(1);
    expect(proc.pitfalls[0]).toContain("ENOENT");
  });

  it("extracts verification from final test/check steps", () => {
    const messages = [
      ...toolMsg("bash", "npm run build"),
      ...toolMsg("bash", "npm test", "All 42 tests passed"),
      ...toolMsg("bash", "curl health check", "HTTP 200 OK"),
    ];
    const proc = extractProcedure(messages, "Build", "build and verify", "sess-1");
    expect(proc.verification.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty procedure for no tool calls", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
    ];
    const proc = extractProcedure(messages, "Empty", "nothing", "sess-1");
    expect(proc.steps).toHaveLength(0);
  });

  it("sets status to candidate", () => {
    const messages = [...toolMsg("bash", "npm test")];
    const proc = extractProcedure(messages, "Test", "run tests", "sess-1");
    expect(proc.status).toBe("candidate");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/procedure-extractor.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement procedure extractor**

Create `src/procedure/extractor.ts`:

```typescript
import { randomUUID } from "crypto";
import type { ProcedureRecord, ProcedureStep } from "../types.js";

interface SimpleMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

const TOOL_USE_PATTERN = /Using (\w+):\s*(.+)/;
const ERROR_PATTERN = /^Error:|^ERROR:|exit code [1-9]|ENOENT|EACCES|failed/im;
const VERIFY_KEYWORDS = /\b(?:test|check|verify|assert|confirm|health|passed|HTTP [23]\d{2})\b/i;

export function extractProcedure(
  messages: SimpleMessage[],
  title: string,
  trigger: string,
  sessionId: string
): ProcedureRecord {
  const steps: ProcedureStep[] = [];
  const pitfalls: string[] = [];
  const verification: string[] = [];

  let stepOrder = 0;
  let lastWasError = false;
  let lastErrorMsg = "";

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    // Detect tool use from assistant messages
    if (m.role === "assistant") {
      const match = m.content.match(TOOL_USE_PATTERN);
      if (match) {
        stepOrder++;
        const tool = match[1];
        const action = match[2].slice(0, 100);
        steps.push({ order: stepOrder, action, tool });

        // Check if next message (tool result) is an error
        const next = messages[i + 1];
        if (next?.role === "tool" && ERROR_PATTERN.test(next.content)) {
          lastWasError = true;
          lastErrorMsg = next.content.slice(0, 100);
        } else if (lastWasError) {
          // This step is the retry after an error
          pitfalls.push(
            `${lastErrorMsg.slice(0, 60)} — retry was: ${action.slice(0, 60)}`
          );
          lastWasError = false;
          lastErrorMsg = "";
        } else {
          lastWasError = false;
        }
      }
    }
  }

  // Extract verification from last 3 tool results that match verify keywords
  const toolResults = messages.filter((m) => m.role === "tool");
  const lastFew = toolResults.slice(-3);
  for (const tr of lastFew) {
    if (VERIFY_KEYWORDS.test(tr.content)) {
      verification.push(tr.content.slice(0, 100));
    }
  }

  const now = new Date().toISOString();
  return {
    id: nanoid(12),
    title,
    trigger,
    steps,
    pitfalls,
    verification,
    status: "candidate",
    source_session_id: sessionId,
    created_at: now,
    updated_at: now,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/procedure-extractor.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/procedure/extractor.ts test/procedure-extractor.test.ts
git commit -m "feat: add procedure extractor — tool call sequence to ProcedureRecord"
```

---

## Chunk 3: MCP Tools + Compress Hook Integration

### Task 6: Add brain_save_procedure and brain_procedures MCP tools

**Files:**
- Modify: `cli/mcp-server.ts`

- [ ] **Step 1: Import new stores at top of mcp-server.ts**

Add these imports near the existing store imports:

```typescript
import { OutcomeStore } from "../src/storage/outcomes.js";
import { ProcedureStore } from "../src/storage/procedures.js";
import { extractProcedure } from "../src/procedure/extractor.js";
import { findSessionJsonl, parseSessionEntries } from "./compress-core.js";
```

- [ ] **Step 2: Initialize OutcomeStore and ProcedureStore alongside existing stores**

Find where EventStore is initialized (look for `new EventStore`) and add nearby:

```typescript
const outcomeStore = new OutcomeStore(squeezePath);
const procedureStore = new ProcedureStore(squeezePath);
```

- [ ] **Step 3: Add brain_save_procedure tool definition**

Add to the tool definitions array (follow existing tool pattern):

```typescript
{
  name: "brain_save_procedure",
  description: "Save the current session's workflow as a reusable procedure. Call this when the user says 'remember this workflow' or similar.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short title for the procedure (e.g., 'Production Deploy')" },
      trigger: { type: "string", description: "Task description that should trigger this procedure (e.g., 'deploy to production')" },
    },
    required: ["title", "trigger"],
  },
}
```

- [ ] **Step 4: Add brain_save_procedure handler**

In the tool call handler switch/if chain:

```typescript
if (toolName === "brain_save_procedure") {
  const { title, trigger } = args as { title: string; trigger: string };
  // Read current session messages from Claude Code's session JSONL
  // findSessionJsonl and parseSessionEntries are exported from compress-core.ts
  const sessionPath = findSessionJsonl(root);
  if (!sessionPath) {
    return toolResult("Error: Could not find current session file. Procedure not saved.");
  }
  const entries = parseSessionEntries(sessionPath);
  // Convert SessionEntry[] to SimpleMessage[] for extractProcedure
  const sessionMessages = entries
    .filter((e) => e.message && (e.type === "user" || e.type === "assistant" || e.type === "tool_result"))
    .map((e) => ({
      role: (e.type === "tool_result" ? "tool" : e.type) as "user" | "assistant" | "tool",
      content: typeof e.message!.content === "string"
        ? e.message!.content
        : JSON.stringify(e.message!.content),
    }));
  const procedure = extractProcedure(sessionMessages, title, trigger, sessionId ?? "unknown");
  procedureStore.append(procedure);
  return toolResult(`Procedure '${title}' saved as candidate (id: ${procedure.id}, ${procedure.steps.length} steps). Review with brain_procedures.`);
}
```

Note: The exact session message retrieval depends on how mcp-server.ts currently accesses session data. Check the existing `brain_recall` handler for the pattern. If session JSONL isn't directly accessible from MCP server, read from the session messages that the MCP server has already ingested during the current session.

- [ ] **Step 5: Add brain_procedures tool definition**

```typescript
{
  name: "brain_procedures",
  description: "List, approve, or archive saved procedures.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "approve", "archive"], description: "Action to perform" },
      id: { type: "string", description: "Procedure ID (required for approve/archive)" },
    },
    required: ["action"],
  },
}
```

- [ ] **Step 6: Add brain_procedures handler**

```typescript
if (toolName === "brain_procedures") {
  const { action, id } = args as { action: string; id?: string };
  if (action === "list") {
    const all = procedureStore.getAll().filter((p) => p.status !== "archived");
    if (all.length === 0) return toolResult("No procedures saved yet.");
    const lines = all.map((p) =>
      `[${p.status}] ${p.id} — ${p.title} (${p.steps.length} steps, trigger: "${p.trigger}")`
    );
    return toolResult(lines.join("\n"));
  }
  if (action === "approve" || action === "archive") {
    if (!id) return toolResult("Error: id is required for approve/archive");
    const ok = procedureStore.updateStatus(id, action === "approve" ? "approved" : "archived");
    return toolResult(ok ? `Procedure ${id} ${action}d.` : `Procedure ${id} not found.`);
  }
  return toolResult("Unknown action. Use: list, approve, archive");
}
```

- [ ] **Step 7: Add cautions and procedures sections to brain_recall handler**

Find the existing `brain_recall` handler. At the end of its output assembly, append:

```typescript
// Append keyword-matched cautions from outcome store (max 3)
// Use the recall output text as context for keyword matching
const matchedCautions = outcomeStore.findRelevant(output, 3);
if (matchedCautions.length > 0) {
  const cautionLines = matchedCautions.map(
    (o) => `- ⚠️ ${o.lesson} (${o.timestamp.slice(0, 10)})`
  );
  output += `\n\n## Cautions\n${cautionLines.join("\n")}`;
}

// Append keyword-matched procedure (max 1)
// Extract task context from the recall output to match against triggers
const matchedProc = procedureStore.findApprovedByTrigger(output);
if (matchedProc) {
  const steps = matchedProc.steps.map((s) => `${s.order}. ${s.action}`).join("\n");
  const pitfalls = matchedProc.pitfalls.map((pf) => `⚠️ Pitfall: ${pf}`).join("\n");
  const verifications = matchedProc.verification.map((v) => `✅ Verify: ${v}`).join("\n");
  output += `\n\n## Relevant Procedures\n### ${matchedProc.title}\n${steps}`;
  if (pitfalls) output += `\n${pitfalls}`;
  if (verifications) output += `\n${verifications}`;
}
```

- [ ] **Step 8: Verify MCP server compiles**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add cli/mcp-server.ts
git commit -m "feat: add brain_save_procedure, brain_procedures MCP tools + cautions/procedures in brain_recall"
```

---

### Task 7: Integrate outcome detection into compress hook

**Files:**
- Modify: `cli/compress-core.ts`

- [ ] **Step 1: Read compress-core.ts to understand current flow**

Read: `cli/compress-core.ts`
Identify: where the compress flow ends, where session messages are parsed, session ID.

- [ ] **Step 2: Import outcome detector and store**

Add imports at top:

```typescript
import { scanSessionForFailures } from "../src/outcome/detector.js";
import { OutcomeStore } from "../src/storage/outcomes.js";
import { ingestCandidates, loadCandidateStore } from "./candidates.js";
```

- [ ] **Step 3: Add outcome detection at end of compress flow**

After the existing compress logic completes, add:

```typescript
// --- Outcome detection ---
const outcomeStore = new OutcomeStore(squeezePath);
const outcomes = scanSessionForFailures(sessionMessages, sessionId);
// Dedup against recent outcomes
const newOutcomes = outcomes.filter(
  (o) => !outcomeStore.isDuplicate(o.failure_mode, o.timestamp)
);
if (newOutcomes.length > 0) {
  outcomeStore.append(newOutcomes);
  // Generate caution candidates
  const candidateStore = loadCandidateStore(cwd);  // takes projectRoot, NOT squeezePath
  const cautionTexts = newOutcomes.map((o) => o.lesson);
  ingestCandidates(candidateStore, cautionTexts, { source: "claude", projectRoot: cwd });
}
```

The exact variable names (`squeezePath`, `sessionMessages`, `sessionId`) depend on what's already in scope in compress-core.ts. Read the file first to use the correct names.

- [ ] **Step 4: Verify compress compiles**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add cli/compress-core.ts
git commit -m "feat: integrate outcome detection into compress hook"
```

---

## Chunk 4: Sub-agent Context + Growth One-liner

### Task 8: Implement sub-agent personal context

**Files:**
- Modify: `src/engine.ts`
- Modify: `src/assembly/assembler.ts`
- Create: `test/subagent-context.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/subagent-context.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { formatPersonalContext } from "../src/assembly/assembler.js";
import type { DirectiveRecord, ProcedureRecord, OutcomeRecord } from "../src/types.js";

describe("formatPersonalContext", () => {
  function makeDirective(key: string, value: string): DirectiveRecord {
    return {
      id: 1, key, value, sourceMsgId: null, createdAt: "", eventTime: "",
      confirmedByUser: true, evidenceText: null, evidenceTurn: null,
      lastReferencedAt: null, supersededBy: null, supersededAt: null,
    };
  }

  function makeProcedure(): ProcedureRecord {
    return {
      id: "proc-1", title: "Production Deploy", trigger: "deploy",
      steps: [
        { order: 1, action: "Run smoke test", tool: "bash" },
        { order: 2, action: "Deploy canary 10%", tool: "bash" },
      ],
      pitfalls: ["Don't skip migration check"],
      verification: ["Run health check"],
      status: "approved", source_session_id: "sess-1",
      created_at: "", updated_at: "",
    };
  }

  function makeOutcome(): OutcomeRecord {
    return {
      id: "out-1", result: "failure",
      failure_mode: "blue-green deploy failed",
      context: "deploy step", lesson: "Use canary instead",
      session_id: "sess-1", timestamp: "2026-03-20T10:00:00Z",
    };
  }

  it("includes all sections when all data present", () => {
    const output = formatPersonalContext(
      [makeDirective("rule_1", "Always run tests")],
      makeProcedure(),
      [makeOutcome()]
    );
    expect(output).toContain("<personal-context>");
    expect(output).toContain("## Your Rules");
    expect(output).toContain("Always run tests");
    expect(output).toContain("## Procedure: Production Deploy");
    expect(output).toContain("Run smoke test");
    expect(output).toContain("## Cautions");
    expect(output).toContain("Use canary instead");
    expect(output).toContain("</personal-context>");
  });

  it("omits Procedure section when no match", () => {
    const output = formatPersonalContext(
      [makeDirective("rule_1", "Always run tests")],
      null,
      [makeOutcome()]
    );
    expect(output).toContain("## Your Rules");
    expect(output).not.toContain("## Procedure:");
    expect(output).toContain("## Cautions");
  });

  it("omits Cautions section when no cautions", () => {
    const output = formatPersonalContext(
      [makeDirective("rule_1", "Always run tests")],
      makeProcedure(),
      []
    );
    expect(output).toContain("## Your Rules");
    expect(output).toContain("## Procedure:");
    expect(output).not.toContain("## Cautions");
  });

  it("wraps output in personal-context tags", () => {
    const output = formatPersonalContext([makeDirective("k", "v")], null, []);
    expect(output.startsWith("<personal-context>")).toBe(true);
    expect(output.endsWith("</personal-context>")).toBe(true);
  });

  it("respects token cap — truncates cautions and procedure when over limit", () => {
    // Create many directives to approach the limit
    const manyDirectives = Array.from({ length: 30 }, (_, i) =>
      makeDirective(`rule_${i}`, `This is a moderately long directive rule number ${i} that takes up tokens`)
    );
    const proc = makeProcedure();
    const cautions = [makeOutcome(), makeOutcome(), makeOutcome()];
    // With a tight token cap, should truncate
    const output = formatPersonalContext(manyDirectives, proc, cautions, 500);
    // Should still have personal-context tags
    expect(output).toContain("<personal-context>");
    // Cautions should be reduced (max 1 after truncation)
    const cautionMatches = output.match(/⚠️.*Use canary/g);
    expect(cautionMatches?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/subagent-context.test.ts`
Expected: FAIL — formatPersonalContext not exported

- [ ] **Step 3: Add formatPersonalContext to assembler.ts**

Append to `src/assembly/assembler.ts`:

```typescript
export function formatPersonalContext(
  directives: DirectiveRecord[],
  procedure: ProcedureRecord | null,
  cautions: OutcomeRecord[],
  maxTokens = 2000
): string {
  const sections: string[] = [];

  // Rules section (always included)
  if (directives.length > 0) {
    const rules = directives.map((d) => `- ${d.value}`).join("\n");
    sections.push(`## Your Rules\n${rules}`);
  }

  // Procedure section (optional)
  if (procedure) {
    const steps = procedure.steps.map((s) => `${s.order}. ${s.action}`).join("\n");
    const pitfalls = procedure.pitfalls.map((p) => `⚠️ Pitfall: ${p}`).join("\n");
    let procSection = `## Procedure: ${procedure.title}\n${steps}`;
    if (pitfalls) procSection += `\n${pitfalls}`;
    sections.push(procSection);
  }

  // Cautions section (optional)
  if (cautions.length > 0) {
    const cautionLines = cautions
      .map((c) => `- ⚠️ ${c.lesson} (${c.timestamp.slice(0, 10)})`)
      .join("\n");
    sections.push(`## Cautions\n${cautionLines}`);
  }

  let body = sections.join("\n\n");

  // Token cap: truncate if needed
  let tokenEstimate = estimateTokens(body);
  if (tokenEstimate > maxTokens && cautions.length > 1) {
    // Reduce cautions to 1
    const reduced = cautions.slice(0, 1);
    const cautionLines = reduced
      .map((c) => `- ⚠️ ${c.lesson} (${c.timestamp.slice(0, 10)})`)
      .join("\n");
    sections[sections.length - 1] = `## Cautions\n${cautionLines}`;
    body = sections.join("\n\n");
    tokenEstimate = estimateTokens(body);
  }

  if (tokenEstimate > maxTokens && procedure) {
    // Reduce procedure to title + pitfalls only
    const pitfalls = procedure.pitfalls.map((p) => `⚠️ Pitfall: ${p}`).join("\n");
    const procIdx = sections.findIndex((s) => s.startsWith("## Procedure:"));
    if (procIdx >= 0) {
      sections[procIdx] = `## Procedure: ${procedure.title}\n${pitfalls || "(see full procedure)"}`;
      body = sections.join("\n\n");
    }
  }

  return `<personal-context>\n${body}\n</personal-context>`;
}
```

Add the import for `OutcomeRecord` and `ProcedureRecord` at top of assembler.ts:

```typescript
import type { OutcomeRecord, ProcedureRecord } from "../types.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/subagent-context.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Update engine.ts — add stores and implement prepareSubagentSpawn**

In `src/engine.ts`:

1. Add imports:
```typescript
import { OutcomeStore } from "./storage/outcomes.js";
import { ProcedureStore } from "./storage/procedures.js";
import { formatPersonalContext } from "./assembly/assembler.js";
import { dirname, join } from "path";
```

2. Add private fields after existing ones:
```typescript
private outcomeStore!: OutcomeStore;
private procedureStore!: ProcedureStore;
private _subagentTaskHint?: string;
private squeezePath!: string;
```

3. In `_initStores()` (NOT in bootstrap — so bootstrapWithDb also gets these), add at the end:
```typescript
// JSONL-based stores need squeezePath; set a default if not yet set
if (!this.squeezePath) {
  this.squeezePath = join(process.cwd(), ".squeeze");
}
this.outcomeStore = new OutcomeStore(this.squeezePath);
this.procedureStore = new ProcedureStore(this.squeezePath);
```
Then in `bootstrap(dbPath)`, BEFORE `await this._initStores()`, add:
```typescript
this.squeezePath = join(dirname(dbPath), ".squeeze");
```

4. Add setter:
```typescript
setSubagentTaskHint(description: string): void {
  this._subagentTaskHint = description;
}
```

5. Replace `prepareSubagentSpawn`:
```typescript
async prepareSubagentSpawn(parentContext: AssembledContext): Promise<AssembledContext> {
  const taskDescription = this._subagentTaskHint;
  this._subagentTaskHint = undefined;

  const directives = this.memoryEnabled
    ? await this.directives.getActiveDirectives()
    : [];

  const matchedProcedure = taskDescription
    ? this.procedureStore.findApprovedByTrigger(taskDescription)
    : null;

  const cautions = taskDescription
    ? this.outcomeStore.findRelevant(taskDescription, 3)
    : [];

  const personalBlock = formatPersonalContext(
    directives,
    matchedProcedure,
    cautions,
    this.config.subagentPersonalContextMaxTokens
  );

  const halfBudget: TokenBudget = {
    maxTokens: Math.floor(parentContext.tokenCount * 0.5),
    usedTokens: 0,
    available: Math.floor(parentContext.tokenCount * 0.5),
  };

  const assembled = await this.assemble(halfBudget);
  // Prepend personal context as system message
  assembled.messages.unshift({ role: "system", content: personalBlock });
  assembled.tokenCount += estimateTokens(personalBlock);
  return assembled;
}
```

Add import for `estimateTokens`:
```typescript
import { allocateBudget, setTokenCounter, estimateTokens } from "./assembly/budget.js";
```

6. Add public getters for new stores:
```typescript
getOutcomeStore(): OutcomeStore { return this.outcomeStore; }
getProcedureStore(): ProcedureStore { return this.procedureStore; }
```

- [ ] **Step 6: Verify compilation**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/engine.ts src/assembly/assembler.ts test/subagent-context.test.ts
git commit -m "feat: implement sub-agent personal context — L3 + procedure + cautions injection"
```

---

### Task 9: Create growth one-liner

**Files:**
- Create: `src/growth/one-liner.ts`
- Create: `test/growth-oneliner.test.ts`
- Modify: `cli/compress-core.ts`

- [ ] **Step 1: Write failing tests**

Create `test/growth-oneliner.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildGrowthOneLiner } from "../src/growth/one-liner.js";
import type { SessionStats, OutcomeRecord } from "../src/types.js";

describe("buildGrowthOneLiner", () => {
  function makeOutcome(ctx: string): OutcomeRecord {
    return {
      id: "out-1", result: "failure", failure_mode: ctx,
      context: ctx, lesson: `Avoid ${ctx}`,
      session_id: "s1", timestamp: "2026-04-15T10:00:00Z",
    };
  }

  it("produces string with outcome and procedure fragments", () => {
    const stats: SessionStats = {
      new_directives: 0,
      new_preferences: 0,
      new_outcomes: [makeOutcome("deploy failure")],
      new_procedures: 1,
    };
    const result = buildGrowthOneLiner(stats, false);
    expect(result).toContain("+1 caution");
    expect(result).toContain("+1 procedure");
  });

  it("returns empty string when nothing learned", () => {
    const stats: SessionStats = {
      new_directives: 0,
      new_preferences: 0,
      new_outcomes: [],
      new_procedures: 0,
    };
    expect(buildGrowthOneLiner(stats, false)).toBe("");
  });

  it("includes count and summary for multiple outcomes", () => {
    const stats: SessionStats = {
      new_directives: 0,
      new_preferences: 0,
      new_outcomes: [
        makeOutcome("deploy failure"),
        makeOutcome("test timeout"),
        makeOutcome("build error"),
      ],
      new_procedures: 0,
    };
    const result = buildGrowthOneLiner(stats, false);
    expect(result).toContain("+3 caution");
  });

  it("uses Chinese when isChinese=true", () => {
    const stats: SessionStats = {
      new_directives: 1,
      new_preferences: 0,
      new_outcomes: [],
      new_procedures: 0,
    };
    const result = buildGrowthOneLiner(stats, true);
    expect(result).toContain("本次學到");
  });

  it("uses English when isChinese=false", () => {
    const stats: SessionStats = {
      new_directives: 1,
      new_preferences: 0,
      new_outcomes: [],
      new_procedures: 0,
    };
    const result = buildGrowthOneLiner(stats, false);
    expect(result).toContain("Learned");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/growth-oneliner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement growth one-liner**

Create `src/growth/one-liner.ts`:

```typescript
import type { SessionStats } from "../types.js";

export function buildGrowthOneLiner(stats: SessionStats, isChinese: boolean): string {
  const fragments: string[] = [];

  if (stats.new_outcomes.length > 0) {
    const n = stats.new_outcomes.length;
    const summary = stats.new_outcomes[0].failure_mode.slice(0, 30);
    fragments.push(
      isChinese
        ? `+${n} caution（${summary}）`
        : `+${n} caution (${summary})`
    );
  }

  if (stats.new_directives > 0) {
    fragments.push(
      isChinese
        ? `+${stats.new_directives} directive`
        : `+${stats.new_directives} directive`
    );
  }

  if (stats.new_preferences > 0) {
    fragments.push(
      isChinese
        ? `+${stats.new_preferences} preference`
        : `+${stats.new_preferences} preference`
    );
  }

  if (stats.new_procedures > 0) {
    fragments.push(
      isChinese
        ? `+${stats.new_procedures} procedure candidate`
        : `+${stats.new_procedures} procedure candidate`
    );
  }

  if (fragments.length === 0) return "";

  const joiner = isChinese ? "，" : ", ";
  const prefix = isChinese ? "🧠 本次學到：" : "🧠 Learned: ";
  return `${prefix}${fragments.join(joiner)}`;
}

export function detectChinese(messages: Array<{ role: string; content: string }>): boolean {
  const userMessages = messages.filter((m) => m.role === "user");
  if (userMessages.length === 0) return false;
  const totalChars = userMessages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars === 0) return false;
  const cjkChars = userMessages.reduce((sum, m) => {
    const matches = m.content.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g);
    return sum + (matches?.length ?? 0);
  }, 0);
  return cjkChars / totalChars > 0.3;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/growth-oneliner.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Integrate growth one-liner into compress hook**

In `cli/compress-core.ts`, after the outcome detection code (added in Task 7):

```typescript
import { buildGrowthOneLiner, detectChinese } from "../src/growth/one-liner.js";
import type { SessionStats } from "../src/types.js";

// ... at end of compress flow, after outcome detection ...

// --- Growth one-liner ---
// Count directives/preferences written in this session from the compress flow
// directivesWritten and preferencesWritten are already tracked in compress-core's main()
// Pass them into this section. If not available, default to 0.
const sessionStats: SessionStats = {
  new_directives: directivesWritten ?? 0,
  new_preferences: preferencesWritten ?? 0,
  new_outcomes: newOutcomes ?? [],
  new_procedures: 0, // Procedures are user-triggered via MCP, compress flow doesn't create them
};
const isChinese = detectChinese(sessionMessages);
const growthLine = buildGrowthOneLiner(sessionStats, isChinese);
if (growthLine) {
  // Write to growth journal
  const journalPath = join(squeezePath, "growth-journal.jsonl");
  appendFileSync(journalPath, JSON.stringify({
    ts: new Date().toISOString(),
    kind: "session-end",
    summary: growthLine,
    stats: sessionStats,
  }) + "\n");
  // Output to stdout (shown by Claude Code)
  console.log(growthLine);
}
```

- [ ] **Step 6: Verify compilation**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
cd /Users/hsing/MySquad/squeeze-claw
git add src/growth/one-liner.ts test/growth-oneliner.test.ts cli/compress-core.ts
git commit -m "feat: add growth one-liner — session-end learning summary"
```

---

### Task 10: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run all new tests**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run test/outcomes.test.ts test/procedures.test.ts test/outcome-detector.test.ts test/procedure-extractor.test.ts test/subagent-context.test.ts test/growth-oneliner.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Run full test suite to check for regressions**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx vitest run`
Expected: All existing tests still PASS, no regressions

- [ ] **Step 3: Run type check**

Run: `cd /Users/hsing/MySquad/squeeze-claw && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Final commit if any fixes needed**

If any test fixes were needed, commit them:
```bash
cd /Users/hsing/MySquad/squeeze-claw
git add -A
git commit -m "fix: resolve test/type issues from 4 killing features integration"
```
