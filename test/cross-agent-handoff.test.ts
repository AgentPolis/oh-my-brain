/**
 * Cross-agent handoff integration test.
 *
 * This is the credibility artifact for the "cross-agent durable memory"
 * positioning. It proves end-to-end that:
 *
 *   1. Agent A (Claude Code) writes directives via its compress hook
 *   2. Agent B (Codex) reads and writes to the SAME MEMORY.md
 *   3. Both agents' directives coexist with correct provenance tags
 *   4. Duplicate directives from different sources are deduped correctly
 *   5. The MCP server can recall everything regardless of which agent wrote it
 *   6. Rejecting a Memory Candidate respects that decision across agents
 *
 * If this test breaks, the product's core promise ("your context, everywhere
 * you work") is broken and we must not ship.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { appendDirectivesToMemory } from "../cli/compress-core.js";
import {
  ingestCandidates,
  loadCandidateStore,
  rejectCandidate,
  saveCandidateStore,
} from "../cli/candidates.js";
import { handleRequest } from "../cli/mcp-server.js";

describe("Cross-agent handoff", () => {
  let projectRoot: string;
  let origProjectRoot: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "ohmybrain-handoff-"));
    origProjectRoot = process.env.OH_MY_BRAIN_PROJECT_ROOT;
    process.env.OH_MY_BRAIN_PROJECT_ROOT = projectRoot;
  });

  afterEach(() => {
    if (origProjectRoot === undefined) {
      delete process.env.OH_MY_BRAIN_PROJECT_ROOT;
    } else {
      process.env.OH_MY_BRAIN_PROJECT_ROOT = origProjectRoot;
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function memoryPath(): string {
    return join(projectRoot, "MEMORY.md");
  }

  function callMcp(name: string, args: Record<string, unknown> = {}) {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return (response.result as { content: { text: string }[] }).content[0].text;
  }

  it("Claude writes a directive, Codex sees the same MEMORY.md", () => {
    // Step 1: Claude Code stop hook writes via the compress hook path
    const claudeWritten = appendDirectivesToMemory(
      [
        "Always use TypeScript strict mode",
        "Never commit generated files",
        "Always write tests first",
      ],
      memoryPath(),
      { source: "claude", sessionId: "claude-session-abc" }
    );
    expect(claudeWritten).toBe(3);
    expect(existsSync(memoryPath())).toBe(true);

    // Step 2: Codex sync path writes 2 more directives to the SAME file
    const codexWritten = appendDirectivesToMemory(
      [
        "Always parameterize SQL queries",
        "Never expose internal errors to users",
      ],
      memoryPath(),
      { source: "codex", sessionId: "codex-session-xyz" }
    );
    expect(codexWritten).toBe(2);

    // Step 3: Verify both agents' directives are present with correct provenance
    const content = readFileSync(memoryPath(), "utf8");

    // All 5 directives should be present
    expect(content).toContain("Always use TypeScript strict mode");
    expect(content).toContain("Never commit generated files");
    expect(content).toContain("Always write tests first");
    expect(content).toContain("Always parameterize SQL queries");
    expect(content).toContain("Never expose internal errors to users");

    // Provenance tags: Claude's section vs Codex's section
    expect(content).toContain("[source:claude session:claude-session-abc]");
    expect(content).toContain("[source:codex session:codex-session-xyz]");

    // Each directive bullet should carry its source tag inline
    expect(content).toMatch(/- \[claude claude-session-abc\] Always use TypeScript strict mode/);
    expect(content).toMatch(/- \[codex codex-session-xyz\] Always parameterize SQL queries/);
  });

  it("identical directive from two different agents is deduped (last-source-loses)", () => {
    // Claude writes first
    appendDirectivesToMemory(["Always use HTTPS"], memoryPath(), {
      source: "claude",
      sessionId: "claude-1",
    });

    // Codex tries to write the exact same directive
    const secondWrite = appendDirectivesToMemory(["Always use HTTPS"], memoryPath(), {
      source: "codex",
      sessionId: "codex-1",
    });

    // Should be a no-op because the directive already exists
    expect(secondWrite).toBe(0);

    const content = readFileSync(memoryPath(), "utf8");
    const occurrences = content.match(/^- \[.*\] Always use HTTPS$/gm) ?? [];
    expect(occurrences.length).toBe(1);
    // First writer keeps provenance
    expect(content).toContain("[claude claude-1] Always use HTTPS");
    expect(content).not.toContain("[codex codex-1] Always use HTTPS");
  });

  it("MCP server recalls directives written by both agents via brain_recall", () => {
    // Agent A writes via compress path
    appendDirectivesToMemory(["Always review before merging"], memoryPath(), {
      source: "claude",
      sessionId: "a",
    });

    // Agent B writes via compress path (simulating codex-sync)
    appendDirectivesToMemory(["Never force-push to main"], memoryPath(), {
      source: "codex",
      sessionId: "b",
    });

    // Agent C uses the MCP server to recall everything
    const recalled = callMcp("brain_recall", { mode: "all" });

    expect(recalled).toContain("Always review before merging");
    expect(recalled).toContain("Never force-push to main");
    expect(recalled).toContain("Active directives (2)");
  });

  it("MCP brain_remember + brain_recall round-trip works from a third agent", () => {
    // Existing state: Claude wrote one directive, Codex wrote another
    appendDirectivesToMemory(["Always prefer composition over inheritance"], memoryPath(), {
      source: "claude",
      sessionId: "claude-1",
    });
    appendDirectivesToMemory(["Never swallow exceptions silently"], memoryPath(), {
      source: "codex",
      sessionId: "codex-1",
    });

    // Cursor (via MCP) adds a third directive
    const addResult = callMcp("brain_remember", {
      text: "Always keep functions under 30 lines",
      source: "cursor",
      session_id: "cursor-1",
    });
    expect(addResult).toMatch(/remembered/);

    // Cursor then recalls — should see all three
    const recalled = callMcp("brain_recall", { mode: "all" });
    expect(recalled).toContain("Always prefer composition over inheritance");
    expect(recalled).toContain("Never swallow exceptions silently");
    expect(recalled).toContain("Always keep functions under 30 lines");
    expect(recalled).toContain("Active directives (3)");
  });

  it("rejecting a Memory Candidate persists across agents (no resurrection)", () => {
    // Claude sees a soft signal and enqueues it as a candidate
    let store = loadCandidateStore(projectRoot);
    const [created] = ingestCandidates(
      store,
      ["should probably use Redis instead of Postgres for queues"],
      { source: "claude", sessionId: "claude-1" }
    );
    saveCandidateStore(projectRoot, store);

    // User rejects the candidate (via CLI, MCP, or direct store call)
    store = loadCandidateStore(projectRoot);
    rejectCandidate(store, created.id);
    saveCandidateStore(projectRoot, store);

    // Codex sees the SAME soft signal later and tries to re-queue it
    store = loadCandidateStore(projectRoot);
    const recreated = ingestCandidates(
      store,
      ["should probably use Redis instead of Postgres for queues"],
      { source: "codex", sessionId: "codex-1" }
    );
    saveCandidateStore(projectRoot, store);

    // The previously-rejected candidate must NOT be resurrected
    expect(recreated.length).toBe(0);
    const reloaded = loadCandidateStore(projectRoot);
    expect(reloaded.candidates[created.id].status).toBe("rejected");
  });

  it("concurrent-style writes from two sources both land (no silent clobber)", () => {
    // Simulate two hook runs interleaving on the same MEMORY.md. The lock
    // in appendDirectivesToMemory guarantees neither writer loses its data.
    const claudeDirectives = Array.from(
      { length: 5 },
      (_, i) => `Always check claude rule ${i + 1}`
    );
    const codexDirectives = Array.from(
      { length: 5 },
      (_, i) => `Always check codex rule ${i + 1}`
    );

    // Interleave the writes. In a real concurrent scenario the lockfile
    // would serialize these; in this single-threaded test we just verify
    // that intermixing preserves every directive.
    for (let i = 0; i < 5; i++) {
      appendDirectivesToMemory([claudeDirectives[i]], memoryPath(), {
        source: "claude",
        sessionId: "claude-concurrent",
      });
      appendDirectivesToMemory([codexDirectives[i]], memoryPath(), {
        source: "codex",
        sessionId: "codex-concurrent",
      });
    }

    const content = readFileSync(memoryPath(), "utf8");
    for (const d of [...claudeDirectives, ...codexDirectives]) {
      expect(content).toContain(d);
    }
  });
});
