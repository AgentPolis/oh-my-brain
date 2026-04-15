/**
 * Multi-Turn Benchmark
 *
 * Simulates real usage: ingest → assemble → ingest → assemble → ...
 * Measures per-turn and cumulative token savings vs baseline (keep-everything).
 *
 * Baseline = every turn sends ALL messages so far (no compression).
 * Squeeze  = every turn assembles via squeeze-claw.
 *
 * Also checks: are directives available at EVERY turn, not just the last one?
 *
 * Run: npx vitest run eval/multi-turn.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget } from "../src/types.js";
import { estimateTokens } from "../src/assembly/budget.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DB_PATH = join(tmpdir(), `squeeze-multi-${Date.now()}.db`);

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch {}
  }
}

/** Simulated conversation script — each entry is one turn */
interface TurnScript {
  user: string;
  toolResults?: string[];
  assistant: string;
}

function buildConversation(): TurnScript[] {
  const turns: TurnScript[] = [];

  // Turn 1: directive
  turns.push({
    user: "Always write tests before implementation. Never use any type in TypeScript.",
    assistant: "Understood — TDD approach, strict TypeScript.",
  });

  // Turn 2: preference
  turns.push({
    user: "I prefer functional programming style over OOP.",
    assistant: "Noted, I'll use functions and composition.",
  });

  // Turns 3-12: coding with tool results and acks
  for (let i = 3; i <= 12; i++) {
    turns.push({
      user: i % 3 === 0 ? "ok" : `Fix the bug in module-${i}.ts on line ${i * 10}`,
      toolResults: i % 3 !== 0
        ? [
            `Reading file module-${i}.ts...\n${Array.from({ length: 20 }, (_, j) => `   ${j + 1}→ export function handler${j}() { return ${j}; }`).join("\n")}`,
            `The file module-${i}.ts has been updated successfully`,
          ]
        : undefined,
      assistant:
        i % 3 === 0
          ? "Let me continue."
          : `Fixed the null check on line ${i * 10}. The issue was a missing guard clause.\n\`\`\`typescript\nif (!input) throw new ValidationError('missing input');\n\`\`\``,
    });
  }

  // Turns 13-17: debugging with stack traces
  for (let i = 13; i <= 17; i++) {
    turns.push({
      user: `Test suite failing: ${i === 13 ? "TypeError" : i === 14 ? "ReferenceError" : "AssertionError"} in test ${i}`,
      toolResults: [
        `FAIL test/module-${i}.test.ts\n  ● handler${i} › should validate input\n    TypeError: Cannot read properties of undefined (reading 'id')\n      at Object.<anonymous> (test/module-${i}.test.ts:${i}:15)\n      at processTicksAndRejections (node:internal/process/task_queues:95:5)\n\nTests: 1 failed, ${i} passed, ${i + 1} total`,
      ],
      assistant: `The test mock is missing the 'id' field. Adding it to the setup fixture.`,
    });
  }

  // Turns 18-22: planning (no tools)
  for (let i = 18; i <= 22; i++) {
    turns.push({
      user: i === 18
        ? "What's the architecture plan for the payment module?"
        : i % 2 === 0 ? "sure" : "What about error handling in that design?",
      assistant:
        i === 18
          ? "I recommend a 3-layer architecture:\n1. PaymentGateway (interface layer)\n2. PaymentProcessor (business logic)\n3. PaymentStore (persistence)\n\nEach layer has its own error types and validation."
          : `Error handling: each layer catches and wraps errors with context. The gateway returns user-friendly messages, the processor logs details, the store handles retries.`,
    });
  }

  // Turns 23-32: more coding
  for (let i = 23; i <= 32; i++) {
    turns.push({
      user: `Implement ${["PaymentGateway", "PaymentProcessor", "PaymentStore", "PaymentValidator", "PaymentRouter"][i % 5]}.ts`,
      toolResults: [
        `(Bash completed with no output)`,
        `File created successfully at src/payment/${["gateway", "processor", "store", "validator", "router"][i % 5]}.ts`,
      ],
      assistant: `\`\`\`typescript\nexport class Payment${["Gateway", "Processor", "Store", "Validator", "Router"][i % 5]} {\n  async process(input: PaymentInput): Promise<PaymentResult> {\n    // validate\n    if (!input.amount || input.amount <= 0) throw new ValidationError('invalid amount');\n    // execute\n    const result = await this.execute(input);\n    return { success: true, id: result.id, amount: input.amount };\n  }\n}\n\`\`\``,
    });
  }

  // Turns 33-37: another directive + wrap up
  turns.push({
    user: "Remember that all payment amounts must be in cents, never floating point dollars.",
    assistant: "Noted — all amounts in cents as integers, no floating point.",
  });

  for (let i = 34; i <= 37; i++) {
    turns.push({
      user: "thanks",
      assistant: `Anything else on the payment module?`,
    });
  }

  // Turns 38-40: final coding referencing earlier directive
  for (let i = 38; i <= 40; i++) {
    turns.push({
      user: `Write the test for Payment${["Gateway", "Processor", "Store"][i % 3]}.ts`,
      toolResults: [
        `File created successfully at test/payment/${["gateway", "processor", "store"][i % 3]}.test.ts`,
      ],
      assistant: `\`\`\`typescript\ndescribe('Payment${["Gateway", "Processor", "Store"][i % 3]}', () => {\n  it('should reject non-integer amounts', () => {\n    // amounts must be in cents (integer)\n    expect(() => processor.process({ amount: 1.5 })).toThrow();\n  });\n  it('should process valid payment', async () => {\n    const result = await processor.process({ amount: 1000 }); // $10.00 = 1000 cents\n    expect(result.success).toBe(true);\n  });\n});\n\`\`\``,
    });
  }

  return turns;
}

describe("Multi-Turn Simulation: per-turn token savings", () => {
  let engine: SqueezeContextEngine;

  beforeEach(async () => {
    engine = new SqueezeContextEngine();
    await engine.bootstrap(DB_PATH);
  });

  afterEach(async () => {
    await engine.close();
    cleanup(DB_PATH);
  });

  it("should save tokens cumulatively across 40 turns", async () => {
    const conversation = buildConversation();
    const allMessagesSoFar: string[] = [];

    let baselineCumulative = 0;
    let squeezeCumulative = 0;
    const perTurnData: Array<{
      turn: number;
      baselineTokens: number;
      squeezeTokens: number;
      savings: number;
      directivesPresent: number;
    }> = [];

    for (let t = 0; t < conversation.length; t++) {
      const turn = conversation[t];

      // ── Ingest user message ──────────────────────────────────
      await engine.ingest({ role: "user", content: turn.user });
      allMessagesSoFar.push(turn.user);

      // ── Ingest tool results ──────────────────────────────────
      if (turn.toolResults) {
        for (const tr of turn.toolResults) {
          await engine.ingest({ role: "tool", content: tr });
          allMessagesSoFar.push(tr);
        }
      }

      // ── Baseline: all messages so far ────────────────────────
      const baselineTokens = allMessagesSoFar.reduce(
        (sum, msg) => sum + estimateTokens(msg),
        0
      );

      // ── Squeeze: assemble with budget ────────────────────────
      const assembled = await engine.assemble(budget(100_000));
      const squeezeTokens = assembled.tokenCount;

      baselineCumulative += baselineTokens;
      squeezeCumulative += squeezeTokens;

      const turnSavings = baselineTokens > 0
        ? ((baselineTokens - squeezeTokens) / baselineTokens) * 100
        : 0;

      perTurnData.push({
        turn: t + 1,
        baselineTokens,
        squeezeTokens,
        savings: turnSavings,
        directivesPresent: assembled.metadata.directiveCount,
      });

      // ── Ingest assistant response ────────────────────────────
      await engine.ingest({ role: "assistant", content: turn.assistant });
      allMessagesSoFar.push(turn.assistant);
    }

    // ── Results ────────────────────────────────────────────────
    const totalSavings = ((baselineCumulative - squeezeCumulative) / baselineCumulative) * 100;

    console.log("\n╔═══════════════════════════════════════════════════════════════════╗");
    console.log("║  MULTI-TURN SIMULATION (40 turns) — Per-Turn Token Savings        ║");
    console.log("╠═══════════════════════════════════════════════════════════════════╣");
    console.log("║  Turn │ Baseline │ Squeeze │ Saved  │ Directives                  ║");
    console.log("║───────┼──────────┼─────────┼────────┼─────────────────────────────║");

    // Print every 5th turn + first and last
    for (const d of perTurnData) {
      if (d.turn === 1 || d.turn % 5 === 0 || d.turn === perTurnData.length) {
        console.log(
          `║  ${String(d.turn).padStart(3)}  │ ${String(d.baselineTokens).padStart(6)}   │ ${String(d.squeezeTokens).padStart(5)}   │ ${d.savings.toFixed(0).padStart(4)}%  │ ${d.directivesPresent} active`
        );
      }
    }

    console.log("║═══════════════════════════════════════════════════════════════════║");
    console.log(`║  CUMULATIVE:                                                      ║`);
    console.log(`║    Baseline total tokens (sum of all turns): ${baselineCumulative.toString().padStart(8)}`);
    console.log(`║    Squeeze total tokens (sum of all turns):  ${squeezeCumulative.toString().padStart(8)}`);
    console.log(`║    Total saved:                              ${(baselineCumulative - squeezeCumulative).toString().padStart(8)}  (${totalSavings.toFixed(1)}%)`);
    console.log("║───────────────────────────────────────────────────────────────────║");

    // Cost calculation (Claude Sonnet: $3/M input tokens)
    const baselineCostUSD = (baselineCumulative / 1_000_000) * 3;
    const squeezeCostUSD = (squeezeCumulative / 1_000_000) * 3;
    const savedUSD = baselineCostUSD - squeezeCostUSD;

    console.log(`║  COST (Claude Sonnet $3/M input):                                 ║`);
    console.log(`║    Baseline:  $${baselineCostUSD.toFixed(4)}`);
    console.log(`║    Squeeze:   $${squeezeCostUSD.toFixed(4)}`);
    console.log(`║    Saved:     $${savedUSD.toFixed(4)} per session`);
    console.log(`║    At 100 users × 20 sessions/day:  $${(savedUSD * 2000).toFixed(2)}/day`);
    console.log("╚═══════════════════════════════════════════════════════════════════╝\n");

    // ── Assertions ─────────────────────────────────────────────

    // Cumulative savings should be significant
    expect(totalSavings).toBeGreaterThan(50);

    // By turn 40, baseline should be much larger than squeeze
    const lastTurn = perTurnData[perTurnData.length - 1];
    expect(lastTurn.savings).toBeGreaterThan(70);

    // Directives must be present at EVERY turn after they were injected
    // Turn 1 injects the first directive
    for (let i = 1; i < perTurnData.length; i++) {
      expect(perTurnData[i].directivesPresent).toBeGreaterThan(0);
    }

    // The second directive (turn 33) should appear from turn 33 onwards
    for (let i = 32; i < perTurnData.length; i++) {
      expect(perTurnData[i].directivesPresent).toBeGreaterThanOrEqual(2);
    }
  });

  it("savings should grow as conversation gets longer", async () => {
    const conversation = buildConversation();
    const allMessagesSoFar: string[] = [];

    const savingsAtMilestones: Array<{ turn: number; savings: number }> = [];

    for (let t = 0; t < conversation.length; t++) {
      const turn = conversation[t];

      await engine.ingest({ role: "user", content: turn.user });
      allMessagesSoFar.push(turn.user);

      if (turn.toolResults) {
        for (const tr of turn.toolResults) {
          await engine.ingest({ role: "tool", content: tr });
          allMessagesSoFar.push(tr);
        }
      }

      // Measure at milestones
      if ((t + 1) % 10 === 0) {
        const baselineTokens = allMessagesSoFar.reduce(
          (sum, msg) => sum + estimateTokens(msg),
          0
        );
        const assembled = await engine.assemble(budget(100_000));
        const savings = ((baselineTokens - assembled.tokenCount) / baselineTokens) * 100;
        savingsAtMilestones.push({ turn: t + 1, savings });
      }

      await engine.ingest({ role: "assistant", content: turn.assistant });
      allMessagesSoFar.push(turn.assistant);
    }

    console.log("\n╔═══════════════════════════════════════════╗");
    console.log("║  SAVINGS GROWTH CURVE                      ║");
    console.log("╠═══════════════════════════════════════════╣");
    for (const m of savingsAtMilestones) {
      const bar = "█".repeat(Math.max(0, Math.floor(m.savings / 2)));
      console.log(`║  Turn ${String(m.turn).padStart(2)}: ${m.savings.toFixed(1).padStart(5)}% ${bar}`);
    }
    console.log("╚═══════════════════════════════════════════╝\n");

    // Savings should increase over time (later > earlier)
    for (let i = 1; i < savingsAtMilestones.length; i++) {
      expect(savingsAtMilestones[i].savings).toBeGreaterThanOrEqual(
        savingsAtMilestones[i - 1].savings * 0.9 // allow small dips
      );
    }
  });
});
