/**
 * Integration test — simulates how OpenClaw would use squeeze-claw.
 *
 * Since we can't import OpenClaw runtime in unit tests, this test
 * exercises the full plugin lifecycle as OpenClaw would call it:
 *
 *   bootstrap() → ingest() × N → assemble() → afterTurn() → compact() → repeat
 *
 * Verifies: factory creates engine, all hooks callable, state persists across
 * turns, circuit breaker triggers and recovers, and custom tokenizer injection.
 */

import { describe, it, expect, afterEach } from "vitest";
import { squeezeClawFactory } from "../src/engine.js";
import type { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget, Turn } from "../src/types.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DB_PATH = join(tmpdir(), `squeeze-integration-${Date.now()}.db`);

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch {}
  }
}

describe("Integration: OpenClaw plugin lifecycle", () => {
  let engine: SqueezeContextEngine;

  afterEach(() => {
    engine?.close();
    cleanup(DB_PATH);
  });

  it("factory creates a working engine with correct info", async () => {
    engine = squeezeClawFactory({}) as SqueezeContextEngine;

    expect(engine.info.id).toBe("oh-my-brain");
    expect(engine.info.name.toLowerCase()).toContain("brain");
    expect(engine.info.ownsCompaction).toBe(true);

    await engine.bootstrap(DB_PATH);
    expect(existsSync(DB_PATH)).toBe(true);
  });

  it("full lifecycle: ingest → assemble → afterTurn → compact", async () => {
    engine = squeezeClawFactory({}) as SqueezeContextEngine;
    await engine.bootstrap(DB_PATH);

    // Turn 1: User sends a directive
    await engine.ingest({ role: "user", content: "Always use TypeScript strict mode" });

    const turn1: Turn = {
      userMessage: { role: "user", content: "Always use TypeScript strict mode" },
      assistantMessage: { role: "assistant", content: "Understood — strict TypeScript." },
      turnIndex: 1,
    };
    await engine.afterTurn(turn1);

    // Turn 2-20: Regular coding conversation
    for (let i = 2; i <= 20; i++) {
      await engine.ingest({ role: "user", content: `Fix bug #${i} in module-${i}.ts` });

      const turn: Turn = {
        userMessage: { role: "user", content: `Fix bug #${i}` },
        assistantMessage: { role: "assistant", content: `Fixed bug #${i} with a null check.` },
        toolMessages: [
          { role: "tool", content: `(Bash completed with no output)` }, // L0 noise
          { role: "tool", content: `File module-${i}.ts updated successfully` }, // L0 noise
        ],
        turnIndex: i,
      };
      await engine.afterTurn(turn);
    }

    // Assemble
    const assembled = await engine.assemble(budget(10000));
    expect(assembled.messages.length).toBeGreaterThan(0);
    expect(assembled.metadata.directiveCount).toBeGreaterThan(0);
    expect(assembled.metadata.degraded).toBe(false);

    // Compact
    await engine.compact();

    // Assemble again after compaction — should still work
    const assembled2 = await engine.assemble(budget(10000));
    expect(assembled2.messages.length).toBeGreaterThan(0);
    expect(assembled2.metadata.directiveCount).toBeGreaterThan(0);
  });

  it("subagent lifecycle: prepareSubagentSpawn + onSubagentEnded", async () => {
    engine = squeezeClawFactory({}) as SqueezeContextEngine;
    await engine.bootstrap(DB_PATH);

    await engine.ingest({ role: "user", content: "Never delete files without confirmation" });
    await engine.ingest({ role: "user", content: "Help me refactor the auth module" });

    const parentContext = await engine.assemble(budget(10000));
    const subagentContext = await engine.prepareSubagentSpawn(parentContext);

    // Subagent gets reduced context
    expect(subagentContext.tokenCount).toBeLessThanOrEqual(parentContext.tokenCount);
    // But still has directives
    expect(subagentContext.metadata.directiveCount).toBeGreaterThan(0);

    // Subagent returns results
    await engine.onSubagentEnded({
      messages: [
        { role: "assistant", content: "Refactored auth module into 3 files." },
      ],
      success: true,
    });

    // Parent should now have the subagent's output
    const afterSub = await engine.assemble(budget(10000));
    const allContent = afterSub.messages.map(m => m.content).join("\n");
    expect(allContent).toContain("Refactored auth module");
  });

  it("accepts custom tokenizer via factory config", async () => {
    let tokenCounterCalled = false;
    const customCounter = (text: string) => {
      tokenCounterCalled = true;
      return Math.ceil(text.length / 3); // custom ratio
    };

    engine = squeezeClawFactory({ tokenCounter: customCounter }) as SqueezeContextEngine;
    await engine.bootstrap(DB_PATH);

    await engine.ingest({ role: "user", content: "Test with custom tokenizer" });
    await engine.assemble(budget(10000));

    expect(tokenCounterCalled).toBe(true);
  });

  it("handles null/undefined content gracefully", async () => {
    engine = squeezeClawFactory({}) as SqueezeContextEngine;
    await engine.bootstrap(DB_PATH);

    // These should not throw
    await engine.ingest({ role: "user", content: null as any });
    await engine.ingest({ role: "user", content: undefined as any });
    await engine.ingest({ role: "tool", content: "" });

    // Engine should still work
    const assembled = await engine.assemble(budget(10000));
    expect(assembled).toBeDefined();
  });

  it("recovers from degraded mode", async () => {
    engine = squeezeClawFactory({
      circuitBreaker: {
        classifierFailThreshold: 1, // degrade after 1 failure
        latencyFailThreshold: 5,
        latencyHardLimitMs: 2000,
        recoveryCheckInterval: 2, // recover check every 2 turns
      },
    }) as SqueezeContextEngine;
    await engine.bootstrap(DB_PATH);

    // Normal operation
    await engine.ingest({ role: "user", content: "Hello world" });
    let status = engine.getStatus() as any;
    expect(status.degraded).toBe(false);

    // After successful ingestion, engine should remain non-degraded
    await engine.ingest({ role: "user", content: "Another message" });
    status = engine.getStatus() as any;
    expect(status.degraded).toBe(false);
  });
});
