import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import { Level } from "../src/types.js";
import type { TokenBudget, Turn } from "../src/types.js";
import { getTestDB, cleanTables, releaseTestDB } from "./helpers/db.js";
import type { BrainDB } from "../src/storage/db.js";

function budget(available: number): TokenBudget {
  return { maxTokens: available, usedTokens: 0, available };
}

describe("SqueezeContextEngine", () => {
  let engine: SqueezeContextEngine;
  let db: BrainDB;

  beforeAll(async () => {
    db = await getTestDB();
  });

  beforeEach(async () => {
    await cleanTables(db);
    engine = new SqueezeContextEngine();
    await engine.bootstrapWithDb(db);
  });

  afterAll(async () => {
    await releaseTestDB();
  });

  it("bootstraps successfully", async () => {
    const status = await engine.getStatus() as any;
    expect(status.turnIndex).toBe(0);
    expect(status.degraded).toBe(false);
  });

  it("exposes correct engine info", () => {
    expect(engine.info.id).toBe("oh-my-brain");
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it("discards L0 noise messages", async () => {
    await engine.ingest({ role: "user", content: "ok" });
    await engine.ingest({ role: "user", content: "thanks" });

    const counts = await engine.getMessageStore().countByLevel();
    expect(counts.L0).toBe(0); // discarded, not stored
    expect(counts.L1).toBe(0);
  });

  it("stores regular messages as L1", async () => {
    await engine.ingest({ role: "user", content: "Can you help me with this bug?" });

    const counts = await engine.getMessageStore().countByLevel();
    expect(counts.L1).toBe(1);
  });

  it("extracts L3 directives", async () => {
    await engine.ingest({ role: "user", content: "Always use TypeScript for new files" });

    const directives = await engine.getDirectiveStore().getActiveDirectives();
    expect(directives.length).toBe(1);
    expect(directives[0].value).toContain("Always use TypeScript");
  });

  it("stores multiple directives", async () => {
    await engine.ingest({ role: "user", content: "Always use spaces for indentation" });
    await engine.ingest({ role: "user", content: "Never push directly to main" });

    const allDirectives = await engine.getMessageStore().getByLevel(Level.Directive);
    expect(allDirectives.length).toBe(2);
  });

  it("assembles context within budget", async () => {
    await engine.ingest({ role: "user", content: "Hello, I need help" });
    await engine.ingest({ role: "assistant", content: "Sure, what do you need?" });
    await engine.ingest({ role: "user", content: "Fix the login bug in auth.ts" });
    await engine.ingest({ role: "user", content: "Always run tests before committing" });

    const assembled = await engine.assemble(budget(10000));

    expect(assembled.messages.length).toBeGreaterThan(0);
    expect(assembled.tokenCount).toBeLessThanOrEqual(10000);
    expect(assembled.metadata.taskType).toBeDefined();
    expect(assembled.metadata.degraded).toBe(false);
  });

  it("respects memory off mode", async () => {
    await engine.ingest({ role: "user", content: "Always use TDD" });

    engine.setMemoryEnabled(false);
    const assembled = await engine.assemble(budget(10000));

    expect(assembled.metadata.directiveCount).toBe(0);
    expect(assembled.metadata.preferenceCount).toBe(0);
  });

  it("handles multi-turn conversation", async () => {
    for (let i = 1; i <= 50; i++) {
      await engine.ingest({ role: "user", content: `Turn ${i}: working on feature #${i}` });
      await engine.ingest({ role: "assistant", content: `Helping with feature #${i}` });
    }

    const assembled = await engine.assemble(budget(5000));

    expect(assembled.messages.length).toBeLessThan(100);
    expect(assembled.tokenCount).toBeLessThanOrEqual(5000);
  });

  it("detects task type from messages", async () => {
    await engine.ingest({ role: "user", content: "Error: TypeError at line 42 in foo.ts" });
    await engine.ingest({ role: "tool", content: "stack trace: Error at foo.ts:42" });

    const assembled = await engine.assemble(budget(10000));
    expect(["debug", "coding"]).toContain(assembled.metadata.taskType);
  });

  it("afterTurn processes turn messages", async () => {
    await engine.ingest({ role: "user", content: "Help me debug" });

    const turn: Turn = {
      userMessage: { role: "user", content: "Help me debug" },
      assistantMessage: { role: "assistant", content: "Looking at the error..." },
      toolMessages: [{ role: "tool", content: "Error: not found" }],
      turnIndex: 1,
    };

    await engine.afterTurn(turn);

    // Assistant + tool messages should be ingested
    const counts = await engine.getMessageStore().countByLevel();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });
});
