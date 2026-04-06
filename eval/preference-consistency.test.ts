/**
 * L2 Preference Consistency Benchmark
 *
 * Measures the metric Codex's outside-voice review flagged as "measured
 * fiction" in the v0.1 README: how many explicit user preferences still
 * survive after a long session of mixed content?
 *
 * Now that ingest() actually calls addPreference() for messages the
 * classifier tags as L2, this test is no longer measuring nothing. It
 * exists as a regression fence: if a future change breaks the L2 path
 * again, this test will catch it before release.
 *
 * Target: 100% of explicit L2 preferences recalled after 50 turns of
 * mixed noise and observations.
 *
 * Run: npx vitest run eval/preference-consistency.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SqueezeContextEngine } from "../src/engine.js";
import type { TokenBudget } from "../src/types.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DB_PATH = join(tmpdir(), `ohmybrain-prefs-${Date.now()}.db`);

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function cleanup(path: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    } catch {
      /* ignore */
    }
  }
}

// Explicit preference statements — English and Traditional Chinese.
// These must all be caught by the regex PREFERENCE_PATTERNS in
// src/triage/classifier.ts.
const PREFERENCES = [
  "I prefer tabs over spaces",
  "I'd prefer to keep the tests in a separate folder",
  "I like the current layout better than the grid version",
  "I find the single-file approach easier to maintain",
  "我比較喜歡用 TypeScript",
  "我偏好把測試放在另一個資料夾",
];

describe("L2 Preference Consistency", () => {
  let engine: SqueezeContextEngine;

  beforeEach(async () => {
    engine = new SqueezeContextEngine();
    await engine.bootstrap(DB_PATH);
  });

  afterEach(() => {
    engine.close();
    cleanup(DB_PATH);
  });

  it("retains 100% of explicit L2 preferences after 50 turns of mixed content", async () => {
    // Phase 1: inject 6 explicit preferences early in the session
    for (const pref of PREFERENCES) {
      await engine.ingest({ role: "user", content: pref });
      await engine.ingest({
        role: "assistant",
        content: "Got it, I'll keep that in mind.",
      });
    }

    // Phase 2: 50 turns of mixed noise + tool output + code
    for (let turn = 7; turn <= 56; turn++) {
      const kind = turn % 5;
      if (kind === 0) {
        await engine.ingest({ role: "user", content: "ok" });
      } else if (kind === 1) {
        await engine.ingest({
          role: "tool",
          content: `Tool call #${turn} processed ${turn * 3} items`,
        });
      } else if (kind === 2) {
        await engine.ingest({
          role: "assistant",
          content: `\`\`\`ts\nconst handler${turn} = (req) => req.json();\n\`\`\``,
        });
      } else if (kind === 3) {
        await engine.ingest({
          role: "user",
          content: `What about the edge case at line ${turn}?`,
        });
        await engine.ingest({
          role: "assistant",
          content:
            "Good catch — you probably want to validate the input first.",
        });
      } else {
        await engine.ingest({ role: "user", content: "thanks" });
      }
    }

    // Phase 3: verify all preferences are still in the L2 store
    const activePrefs = engine
      .getDirectiveStore()
      .getActivePreferences(0);

    const retained = PREFERENCES.filter((pref) =>
      activePrefs.some((p) => p.value === pref)
    );

    const retentionRate = (retained.length / PREFERENCES.length) * 100;

    console.log("\n╔══════════════════════════════════════════════╗");
    console.log("║  L2 PREFERENCE CONSISTENCY after 50 turns      ║");
    console.log("╠══════════════════════════════════════════════╣");
    console.log(`║  Preferences injected:  ${PREFERENCES.length}`);
    console.log(`║  Preferences retained:  ${retained.length}`);
    console.log(`║  Retention rate:        ${retentionRate.toFixed(0)}%`);
    console.log(`║  Active store size:     ${activePrefs.length}`);
    console.log("║──────────────────────────────────────────────║");
    for (const pref of PREFERENCES) {
      const kept = retained.includes(pref);
      console.log(`║  ${kept ? "✅" : "❌"} ${pref}`);
    }
    console.log("╚══════════════════════════════════════════════╝\n");

    expect(retentionRate).toBe(100);
    expect(activePrefs.length).toBeGreaterThanOrEqual(PREFERENCES.length);
  });

  it("assembled context surfaces active preferences", async () => {
    for (const pref of PREFERENCES.slice(0, 3)) {
      await engine.ingest({ role: "user", content: pref });
    }

    const assembled = await engine.assemble(budget(10000));
    const text = assembled.messages.map((m) => m.content).join("\n");

    for (const pref of PREFERENCES.slice(0, 3)) {
      expect(text).toContain(pref);
    }
    expect(assembled.metadata.preferenceCount).toBeGreaterThanOrEqual(3);
  });
});
