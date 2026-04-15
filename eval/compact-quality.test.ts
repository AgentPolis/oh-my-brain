import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget } from "../src/types.js";

const LARGE_BUDGET: TokenBudget = { maxTokens: 8000, usedTokens: 0, available: 8000 };

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-quality-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("end-to-end: compact + assemble with history", () => {
  it("history summaries appear in assembled context after compact()", async () => {
    const engine = new SqueezeContextEngine();
    await engine.bootstrap(makeTempDir());

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

    // Summary content should reference early turn content
    const allContent = ctx.messages.map(m => m.content).join(" ");
    expect(allContent).toMatch(/jwt|auth/i);

    await engine.close();
  });

  it("summaryCount is 0 when compact() has never been called, even if old messages exist", async () => {
    const engine = new SqueezeContextEngine();
    await engine.bootstrap(makeTempDir());

    for (let t = 1; t <= 30; t++) {
      await engine.afterTurn({
        userMessage: { role: "user", content: `msg ${t}` },
        assistantMessage: { role: "assistant", content: `done ${t}` },
        turnIndex: t,
      });
    }

    // compact() never called
    const ctx = await engine.assemble(LARGE_BUDGET);
    expect(ctx.metadata.summaryCount).toBe(0);

    await engine.close();
  });
});
