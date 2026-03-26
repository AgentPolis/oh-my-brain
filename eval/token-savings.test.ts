/**
 * Token Savings Benchmark
 *
 * Compares squeeze-claw vs baseline (keep-everything) on identical sessions.
 * Measures: total tokens assembled, % saved, what was kept vs discarded.
 *
 * Run: npx vitest run eval/token-savings.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import type { Message, TokenBudget } from "../src/types.js";
import { estimateTokens } from "../src/assembly/budget.js";
import { codingSession, noisySession } from "./simulate-session.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DB_PATH = join(tmpdir(), `squeeze-bench-${Date.now()}.db`);

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch {}
  }
}

describe("Token Savings: squeeze-claw vs keep-everything", () => {
  let engine: SqueezeContextEngine;

  beforeEach(async () => {
    engine = new SqueezeContextEngine();
    await engine.bootstrap(DB_PATH);
  });

  afterEach(() => {
    engine.close();
    cleanup(DB_PATH);
  });

  it("coding session (50 turns): should save >30% tokens", async () => {
    const session = codingSession();

    // ── Baseline: total tokens if we keep everything ──────────
    const baselineTokens = session.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0
    );

    // ── Squeeze: ingest all, then assemble ────────────────────
    for (const msg of session.messages) {
      await engine.ingest(msg);
    }

    const assembled = await engine.assemble(budget(baselineTokens));
    const squeezeTokens = assembled.tokenCount;

    // ── Results ───────────────────────────────────────────────
    const savings = ((baselineTokens - squeezeTokens) / baselineTokens) * 100;
    const counts = engine.getMessageStore().countByLevel();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  CODING SESSION (50 turns) — Token Savings ║");
    console.log("╠══════════════════════════════════════════╣");
    console.log(`║  Messages total:     ${session.messages.length.toString().padStart(6)}`);
    console.log(`║  Baseline tokens:    ${baselineTokens.toString().padStart(6)}`);
    console.log(`║  Squeeze tokens:     ${squeezeTokens.toString().padStart(6)}`);
    console.log(`║  Tokens saved:       ${(baselineTokens - squeezeTokens).toString().padStart(6)}  (${savings.toFixed(1)}%)`);
    console.log("║──────────────────────────────────────────║");
    console.log(`║  L0 discarded:       ${(counts.L0 ?? 0).toString().padStart(6)}`);
    console.log(`║  L1 observations:    ${(counts.L1 ?? 0).toString().padStart(6)}`);
    console.log(`║  L2 preferences:     ${(counts.L2 ?? 0).toString().padStart(6)}`);
    console.log(`║  L3 directives:      ${(counts.L3 ?? 0).toString().padStart(6)}`);
    console.log(`║  Assembled messages: ${assembled.messages.length.toString().padStart(6)}`);
    console.log(`║  Task type:          ${assembled.metadata.taskType.padStart(6)}`);
    console.log("╚══════════════════════════════════════════╝\n");

    // Squeeze should save at least 30%
    expect(savings).toBeGreaterThan(30);
    // Directives should survive
    expect(assembled.metadata.directiveCount).toBeGreaterThan(0);
  });

  it("noisy session (80% noise): should save >60% tokens", async () => {
    const session = noisySession();

    const baselineTokens = session.messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content),
      0
    );

    for (const msg of session.messages) {
      await engine.ingest(msg);
    }

    const assembled = await engine.assemble(budget(baselineTokens));
    const squeezeTokens = assembled.tokenCount;
    const savings = ((baselineTokens - squeezeTokens) / baselineTokens) * 100;
    const counts = engine.getMessageStore().countByLevel();

    console.log("\n╔══════════════════════════════════════════╗");
    console.log("║  NOISY SESSION (80% noise) — Token Savings ║");
    console.log("╠══════════════════════════════════════════╣");
    console.log(`║  Messages total:     ${session.messages.length.toString().padStart(6)}`);
    console.log(`║  Baseline tokens:    ${baselineTokens.toString().padStart(6)}`);
    console.log(`║  Squeeze tokens:     ${squeezeTokens.toString().padStart(6)}`);
    console.log(`║  Tokens saved:       ${(baselineTokens - squeezeTokens).toString().padStart(6)}  (${savings.toFixed(1)}%)`);
    console.log("║──────────────────────────────────────────║");
    console.log(`║  L0 discarded:       ${(counts.L0 ?? 0).toString().padStart(6)}`);
    console.log(`║  L1 observations:    ${(counts.L1 ?? 0).toString().padStart(6)}`);
    console.log(`║  L2 preferences:     ${(counts.L2 ?? 0).toString().padStart(6)}`);
    console.log(`║  L3 directives:      ${(counts.L3 ?? 0).toString().padStart(6)}`);
    console.log(`║  Assembled messages: ${assembled.messages.length.toString().padStart(6)}`);
    console.log("╚══════════════════════════════════════════╝\n");

    expect(savings).toBeGreaterThan(60);
    expect(assembled.metadata.directiveCount).toBeGreaterThan(0);
  });
});
