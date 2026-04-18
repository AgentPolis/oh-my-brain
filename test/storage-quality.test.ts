import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isSemanticDuplicate,
  isOneOffTask,
  isRant,
  appendDirectivesToMemory,
} from "../cli/compress-core.js";

// ── isSemanticDuplicate ────────────────────────────────────────────────────────

describe("isSemanticDuplicate", () => {
  it("detects semantically similar directives", () => {
    const existing = new Set(["commit messages: professional, neutral"]);
    expect(isSemanticDuplicate("commit messages should be professional and neutral", existing)).toBe(true);
  });

  it("allows genuinely different directives", () => {
    const existing = new Set(["always use TDD"]);
    expect(isSemanticDuplicate("rebalance portfolio quarterly", existing)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isSemanticDuplicate("", new Set(["something"]))).toBe(false);
  });
});

// ── isOneOffTask ───────────────────────────────────────────────────────────────

describe("isOneOffTask", () => {
  it("detects 'remove X' as one-off", () => {
    expect(isOneOffTask("remove all squeeze-claw references")).toBe(true);
  });

  it("detects 'clean up X' as one-off", () => {
    expect(isOneOffTask("clean up legacy config files")).toBe(true);
  });

  it("detects 'fix X' as one-off", () => {
    expect(isOneOffTask("fix the broken CI pipeline")).toBe(true);
  });

  it("does NOT flag durable rules", () => {
    expect(isOneOffTask("always use Apache-2.0 + CLA")).toBe(false);
    expect(isOneOffTask("commit messages: professional, neutral")).toBe(false);
    expect(isOneOffTask("never attack competitors in docs")).toBe(false);
  });

  it("detects 'replace X with Y' as one-off", () => {
    expect(isOneOffTask("replace lodash with native methods")).toBe(true);
  });

  it("detects 'rename X' as one-off", () => {
    expect(isOneOffTask("rename squeeze-claw to oh-my-brain everywhere")).toBe(true);
  });
});

// ── isRant ─────────────────────────────────────────────────────────────────────

describe("isRant", () => {
  it("detects emotional Chinese rant", () => {
    expect(isRant("怎麼還在這，該不會有些更新都更新錯檔案了吧？")).toBe(true);
  });

  it("detects multiple punctuation rant", () => {
    expect(isRant("why is this still broken?? seriously??")).toBe(true);
  });

  it("does NOT flag normal directives", () => {
    expect(isRant("always use Apache-2.0 + CLA")).toBe(false);
    expect(isRant("commit messages: professional, neutral")).toBe(false);
  });

  it("does NOT flag single question mark", () => {
    expect(isRant("should we use TypeScript?")).toBe(false);
  });

  it("requires at least 2 signals to trigger", () => {
    // Only one signal — not enough
    expect(isRant("怎麼還在 but otherwise calm")).toBe(false);
  });
});

// ── section merging ────────────────────────────────────────────────────────────

describe("section merging", () => {
  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "brain-merge-"));
  }

  it("merges bullets into existing same-date section instead of creating new heading", () => {
    const dir = makeTmpDir();
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, "MEMORY.md"), [
      `## oh-my-brain directives (${today}) [source:claude session:abc]`,
      "",
      "- [claude abc] first rule",
      "",
    ].join("\n"));

    appendDirectivesToMemory(
      ["second rule"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "def" }
    );

    const content = readFileSync(join(dir, "MEMORY.md"), "utf8");
    // Should have only ONE section heading for today
    const headingCount = (content.match(/## oh-my-brain directives/g) || []).length;
    expect(headingCount).toBe(1);
    expect(content).toContain("first rule");
    expect(content).toContain("second rule");
  });

  it("creates new heading when date differs", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "MEMORY.md"), [
      "## oh-my-brain directives (2026-01-01) [source:claude session:old]",
      "",
      "- [claude old] old rule",
      "",
    ].join("\n"));

    appendDirectivesToMemory(
      ["new rule"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "new" }
    );

    const content = readFileSync(join(dir, "MEMORY.md"), "utf8");
    const headingCount = (content.match(/## oh-my-brain directives/g) || []).length;
    expect(headingCount).toBe(2);
  });
});

// ── rant filtering in appendDirectivesToMemory ─────────────────────────────────

describe("rant filtering in appendDirectivesToMemory", () => {
  function makeTmpDir(): string {
    return mkdtempSync(join(tmpdir(), "brain-rant-"));
  }

  it("filters out rants before storing", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "MEMORY.md"), "");

    appendDirectivesToMemory(
      ["怎麼還在這，該不會有些更新都更新錯檔案了吧？", "always use TDD"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "test" }
    );

    const content = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(content).toContain("always use TDD");
    expect(content).not.toContain("怎麼還在");
  });
});
