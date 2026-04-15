/**
 * Directive Retention Benchmark
 *
 * Tests: after 100+ turns, can squeeze-claw still recall L3 directives
 * injected at the beginning?
 *
 * Target: >95% retention.
 *
 * Run: npx vitest run eval/directive-retention.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget } from "../src/types.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DB_PATH = join(tmpdir(), `squeeze-retention-${Date.now()}.db`);

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch {}
  }
}

const DIRECTIVES = [
  "Always use TypeScript strict mode",
  "Never use console.log in production code",
  "Always write unit tests before implementation",
  "Never commit directly to main branch",
  "Always validate user input at API boundaries",
  "Never store passwords in plain text",
  "Always use parameterized queries for SQL",
  "Never expose internal error details to users",
  "Always use HTTPS for external API calls",
  "Remember that our deployment target is Node.js 20",
];

describe("Directive Retention after 100+ turns", () => {
  let engine: SqueezeContextEngine;

  beforeEach(async () => {
    engine = new SqueezeContextEngine();
    await engine.bootstrap(DB_PATH);
  });

  afterEach(async () => {
    await engine.close();
    cleanup(DB_PATH);
  });

  it("should retain >95% of directives after 100 turns of mixed content", async () => {
    // ── Phase 1: Inject 10 directives in turns 1-10 ──────────
    for (let i = 0; i < DIRECTIVES.length; i++) {
      await engine.ingest({ role: "user", content: DIRECTIVES[i] });
      await engine.ingest({ role: "assistant", content: "Understood, I'll follow that." });
    }

    // ── Phase 2: Run 100 turns of mixed noise + real content ─
    for (let turn = 11; turn <= 110; turn++) {
      const turnType = turn % 5;

      if (turnType === 0) {
        // Noise
        await engine.ingest({ role: "user", content: "ok" });
      } else if (turnType === 1) {
        // Tool result
        await engine.ingest({ role: "tool", content: `Output from tool call #${turn}: processed ${turn} items successfully` });
      } else if (turnType === 2) {
        // Code
        await engine.ingest({
          role: "assistant",
          content: `\`\`\`typescript\nfunction handler${turn}(req: Request) {\n  return new Response('ok ${turn}');\n}\n\`\`\``,
        });
      } else if (turnType === 3) {
        // Question
        await engine.ingest({ role: "user", content: `How should I implement feature ${turn}?` });
        await engine.ingest({ role: "assistant", content: `For feature ${turn}, I'd recommend using a strategy pattern with dependency injection.` });
      } else {
        // Noise ack
        await engine.ingest({ role: "user", content: "thanks" });
      }
    }

    // ── Phase 3: Assemble context and check directive presence ─
    const assembled = await engine.assemble(budget(50000));

    // Check how many directives are in the assembled context
    const assembledText = assembled.messages.map((m) => m.content).join("\n");
    let retained = 0;
    const retainedList: string[] = [];
    const lostList: string[] = [];

    for (const directive of DIRECTIVES) {
      // Check if the directive's key content is present
      const keyPhrase = directive.replace(/^(Always |Never |Remember that )/, "").slice(0, 30);
      if (assembledText.includes(directive) || assembledText.toLowerCase().includes(keyPhrase.toLowerCase())) {
        retained++;
        retainedList.push(`  ✅ ${directive}`);
      } else {
        lostList.push(`  ❌ ${directive}`);
      }
    }

    const retentionRate = (retained / DIRECTIVES.length) * 100;

    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  DIRECTIVE RETENTION after 100 turns          ║");
    console.log("╠══════════════════════════════════════════════╣");
    console.log(`║  Directives injected:  ${DIRECTIVES.length}`);
    console.log(`║  Directives retained:  ${retained}`);
    console.log(`║  Retention rate:       ${retentionRate.toFixed(0)}%`);
    console.log(`║  Total messages ingested: ${await engine.getMessageStore().getMaxTurn()}`);
    console.log(`║  Assembled messages:   ${assembled.messages.length}`);
    console.log("║──────────────────────────────────────────────║");
    if (retainedList.length) {
      console.log("║  Retained:");
      retainedList.forEach((l) => console.log(`║  ${l}`));
    }
    if (lostList.length) {
      console.log("║  Lost:");
      lostList.forEach((l) => console.log(`║  ${l}`));
    }
    console.log("╚══════════════════════════════════════════════╝\n");

    // Target: >95%
    expect(retentionRate).toBeGreaterThanOrEqual(95);
    // All directives should be in the directive store
    const storeDirectives = await engine.getDirectiveStore().getActiveDirectives();
    expect(storeDirectives.length).toBe(DIRECTIVES.length);
  });
});
