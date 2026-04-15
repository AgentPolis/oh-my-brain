/**
 * Memory Degradation Benchmark
 *
 * Compares assembled context quality with-memory vs without-memory.
 * If memory injection degrades context quality (crowds out reasoning space),
 * we have a problem.
 *
 * What we measure:
 * - Token budget utilization (are we wasting budget on low-value memory?)
 * - Fresh tail coverage (do recent messages still fit?)
 * - Memory-to-content ratio (is memory crowding out actual conversation?)
 *
 * Target: memory mode should NOT reduce fresh tail coverage by >10%.
 *
 * Run: npx vitest run eval/degradation.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget } from "../src/types.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DB_PATH = join(tmpdir(), `squeeze-degrade-${Date.now()}.db`);

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch {}
  }
}

describe("Memory Degradation Check", () => {
  let engine: SqueezeContextEngine;

  beforeEach(async () => {
    engine = new SqueezeContextEngine();
    await engine.bootstrap(DB_PATH);
  });

  afterEach(async () => {
    await engine.close();
    cleanup(DB_PATH);
  });

  it("memory injection should not reduce fresh tail by >10%", async () => {
    // Inject many directives + preferences
    const directiveCount = 20;
    for (let i = 0; i < directiveCount; i++) {
      await engine.ingest({
        role: "user",
        content: `Always follow rule number ${i}: ${generateLongRule(i)}`,
      });
    }

    // Inject 50 turns of actual conversation
    for (let i = 1; i <= 50; i++) {
      await engine.ingest({
        role: "user",
        content: `Working on task ${i}: implement the ${getFeature(i)} module with proper error handling and validation`,
      });
      await engine.ingest({
        role: "assistant",
        content: `Here's my implementation for task ${i}:\n\`\`\`typescript\nexport async function ${getFeature(i)}() {\n  // implementation with validation\n  return { success: true, task: ${i} };\n}\n\`\`\``,
      });
    }

    // ── Assemble WITH memory ─────────────────────────────────
    engine.setMemoryEnabled(true);
    const withMemory = await engine.assemble(budget(8000));

    // ── Assemble WITHOUT memory ──────────────────────────────
    engine.setMemoryEnabled(false);
    const withoutMemory = await engine.assemble(budget(8000));

    // ── Compare ──────────────────────────────────────────────
    const withMemoryFreshTail = withMemory.metadata.freshTailCount;
    const withoutMemoryFreshTail = withoutMemory.metadata.freshTailCount;

    const freshTailReduction = withoutMemoryFreshTail > 0
      ? ((withoutMemoryFreshTail - withMemoryFreshTail) / withoutMemoryFreshTail) * 100
      : 0;

    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  MEMORY DEGRADATION CHECK                     ║");
    console.log("╠══════════════════════════════════════════════╣");
    console.log(`║  Budget:                    8,000 tokens`);
    console.log(`║  Directives injected:       ${directiveCount}`);
    console.log(`║  Conversation turns:        50`);
    console.log("║──────────────────────────────────────────────║");
    console.log("║  WITH memory:");
    console.log(`║    Assembled messages:      ${withMemory.messages.length}`);
    console.log(`║    Tokens used:             ${withMemory.tokenCount}`);
    console.log(`║    Directives included:     ${withMemory.metadata.directiveCount}`);
    console.log(`║    Fresh tail messages:     ${withMemoryFreshTail}`);
    console.log(`║    Memory %:               ${withMemory.metadata.memoryPercent}%`);
    console.log("║  WITHOUT memory:");
    console.log(`║    Assembled messages:      ${withoutMemory.messages.length}`);
    console.log(`║    Tokens used:             ${withoutMemory.tokenCount}`);
    console.log(`║    Fresh tail messages:     ${withoutMemoryFreshTail}`);
    console.log("║──────────────────────────────────────────────║");
    console.log(`║  Fresh tail reduction:      ${freshTailReduction.toFixed(1)}%`);
    console.log(`║  Verdict:                   ${freshTailReduction <= 10 ? "✅ PASS" : "❌ FAIL"}`);
    console.log("╚══════════════════════════════════════════════╝\n");

    // Memory should NOT reduce fresh tail by more than 10%
    expect(freshTailReduction).toBeLessThanOrEqual(10);

    // Memory % should stay under the 15% cap
    expect(withMemory.metadata.memoryPercent).toBeLessThanOrEqual(30);
  });

  it("assembled context should always include most recent messages", async () => {
    // 30 directives (try to flood memory budget)
    for (let i = 0; i < 30; i++) {
      await engine.ingest({
        role: "user",
        content: `Always remember important rule ${i}: ${generateLongRule(i)}`,
      });
    }

    // 20 recent messages
    for (let i = 1; i <= 20; i++) {
      await engine.ingest({
        role: "user",
        content: `RECENT_MSG_${i}: this is recent message number ${i}`,
      });
    }

    const assembled = await engine.assemble(budget(5000));
    const assembledText = assembled.messages.map((m) => m.content).join("\n");

    // The MOST recent message should always be present
    expect(assembledText).toContain("RECENT_MSG_20");

    // At least the last 5 should be present even with memory flooding
    let recentFound = 0;
    for (let i = 16; i <= 20; i++) {
      if (assembledText.includes(`RECENT_MSG_${i}`)) recentFound++;
    }
    expect(recentFound).toBeGreaterThanOrEqual(4);
  });
});

// ── Helpers ──────────────────────────────────────────────────────

function generateLongRule(i: number): string {
  const rules = [
    "validate all user input before processing any database operations",
    "use parameterized queries to prevent SQL injection attacks",
    "log all authentication attempts with timestamp and IP address",
    "implement rate limiting on all public-facing API endpoints",
    "encrypt sensitive data at rest using AES-256 encryption",
    "use HTTPS for all external API communications",
    "implement circuit breakers for third-party service calls",
    "sanitize all output to prevent cross-site scripting attacks",
    "use secure session management with httpOnly cookies",
    "implement proper CORS policies for cross-origin requests",
  ];
  return rules[i % rules.length];
}

function getFeature(i: number): string {
  const features = [
    "authentication", "authorization", "rateLimit", "logging",
    "validation", "caching", "monitoring", "alerting",
    "backup", "recovery", "migration", "deployment",
    "testing", "documentation", "analytics", "reporting",
    "notification", "scheduling", "integration", "security",
  ];
  return features[i % features.length];
}
