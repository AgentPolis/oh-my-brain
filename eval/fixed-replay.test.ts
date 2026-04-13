import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseSessionEntries, processMessages, writeDirectivesToMemory } from "../cli/compress.js";
import { SqueezeContextEngine } from "../src/engine.js";
import type { Message, TokenBudget } from "../src/types.js";
import { estimateTokens } from "../src/assembly/budget.js";
import { noisySession } from "./simulate-session.js";

function budget(n: number): TokenBudget {
  return { maxTokens: n, usedTokens: 0, available: n };
}

function fixtureEntries(name: string) {
  const fixtureUrl = new URL(`../test/fixtures/${name}`, import.meta.url);
  return parseSessionEntries(fixtureUrl);
}

function messagesFromEntries(entries: ReturnType<typeof parseSessionEntries>): Message[] {
  return entries
    .filter((e): e is typeof e & { message: { role: Message["role"]; content: string } } =>
      Boolean(e.message) && typeof e.message?.content === "string"
    )
    .map((e) => ({
      role: e.message.role,
      content: e.message.content,
    }));
}

async function assembleSession(messages: Message[]) {
  const dbPath = join(tmpdir(), `squeeze-fixed-replay-${Date.now()}-${Math.random()}.db`);
  const engine = new SqueezeContextEngine();
  await engine.bootstrap(dbPath);

  for (const msg of messages) {
    await engine.ingest(msg);
  }

  const baselineTokens = messages.reduce((sum, msg) => sum + estimateTokens(msg.content), 0);
  const assembled = await engine.assemble(budget(baselineTokens));
  const directives = engine.getDirectiveStore().getActiveDirectives().map((d) => d.value);
  const counts = engine.getMessageStore().countByLevel();
  engine.close();

  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }

  return { baselineTokens, assembled, directives, counts };
}

describe("Fixed replay evaluation", () => {
  afterEach(() => {
    delete process.env.SQUEEZE_SESSION_FILE;
    delete process.env.SQUEEZE_CLAUDE_PROJECTS_DIR;
  });

  it("Scenario 1: Claude hook replay produces a real MEMORY artifact and compresses stale notes", () => {
    const entries = fixtureEntries("claude-hook-session-demo.jsonl");
    const processed = processMessages(entries);
    const tmpDir = mkdtempSync(join(tmpdir(), "squeeze-hook-replay-"));
    const memoryPath = join(tmpDir, "MEMORY.md");
    const directivesWritten = writeDirectivesToMemory(processed, memoryPath);

    const totalMsgs = processed.length;
    const compressedCount = processed.filter((m) => m.wasCompressed).length;
    const originalChars = processed.reduce((sum, m) => sum + m.originalText.length, 0);
    const compressedChars = processed.reduce((sum, m) => sum + m.compressedText.length, 0);
    const savedPercent = ((originalChars - compressedChars) / originalChars) * 100;
    const memory = readFileSync(memoryPath, "utf8");

    console.log("\nFixed Replay 1 — Claude hook replay");
    console.log(`  Method: local replay of sanitized Claude Code-style JSONL fixture`);
    console.log(`  Baseline: ${totalMsgs} messages, no MEMORY artifact, no compression`);
    console.log(`  With squeeze: ${totalMsgs - compressedCount}/${totalMsgs} messages left uncompressed in-window`);
    console.log(`  Compression: ${compressedCount} stale messages compressed, ${savedPercent.toFixed(1)}% chars saved`);
    console.log(`  Memory artifact: ${directivesWritten} directives written to MEMORY.md`);
    console.log(`  MEMORY.md contents:\n${memory}`);

    expect(compressedCount).toBeGreaterThan(0);
    expect(directivesWritten).toBe(2);
    expect(memory).toContain("Always preserve API backward compatibility.");
    expect(memory).toContain("Never remove audit logs from production systems.");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Scenario 2: noisy session replay reduces token load without losing directives", async () => {
    const session = noisySession();
    const result = await assembleSession(session.messages);
    const savings = ((result.baselineTokens - result.assembled.tokenCount) / result.baselineTokens) * 100;

    console.log("\nFixed Replay 2 — Noisy session replay");
    console.log(`  Method: simulated 80% noise session run through engine assembly`);
    console.log(`  Baseline tokens: ${result.baselineTokens}`);
    console.log(`  With squeeze tokens: ${result.assembled.tokenCount}`);
    console.log(`  Savings: ${savings.toFixed(1)}%`);
    console.log(`  Active directives kept: ${result.directives.length}`);
    console.log(`  Stored counts: ${JSON.stringify(result.counts)}`);

    expect(savings).toBeGreaterThan(60);
    expect(result.directives).toContain("Never delete files without asking me first.");
    expect(result.directives).toContain("Always validate input before processing.");
  });

  it("Scenario 3: memory precision replay writes user directives but not assistant phrasing", () => {
    const entries = fixtureEntries("memory-precision-demo.jsonl");
    const processed = processMessages(entries);
    const tmpDir = mkdtempSync(join(tmpdir(), "squeeze-memory-precision-"));
    const memoryPath = join(tmpDir, "MEMORY.md");
    writeDirectivesToMemory(processed, memoryPath);
    const memory = readFileSync(memoryPath, "utf8");

    console.log("\nFixed Replay 3 — Memory precision replay");
    console.log(`  Method: sanitized session with assistant directive-like phrasing and user durable directives`);
    console.log(`  Expected writes: 2`);
    console.log(`  Actual MEMORY.md:\n${memory}`);

    expect(memory).toContain("Remember that staging uses a separate Stripe account.");
    expect(memory).toContain("For this repo, always ask before changing billing-related environment variables.");
    expect(memory).not.toContain("Always use Redis here if we hit scaling limits.");
    expect(memory).not.toContain("Never deploy on Friday night unless we have rollback coverage.");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
