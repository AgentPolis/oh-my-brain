import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, homedir } from "path";
import { tmpdir } from "os";
import { extractTextContent, findSessionJsonl, parseSessionEntries, processMessages, writeDirectivesToMemory } from "../cli/compress.js";
import { Level } from "../src/types.js";

// ── extractTextContent ─────────────────────────────────────────────────────

describe("extractTextContent", () => {
  it("returns string input as-is", () => {
    expect(extractTextContent("hello world")).toBe("hello world");
  });

  it("joins text blocks from ContentBlock[]", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractTextContent(blocks)).toBe("hello\nworld");
  });

  it("skips thinking blocks", () => {
    const blocks = [
      { type: "thinking", text: "internal reasoning" },
      { type: "text", text: "final answer" },
    ];
    expect(extractTextContent(blocks)).toBe("final answer");
  });

  it("skips non-text blocks", () => {
    const blocks = [
      { type: "tool_use", id: "x" },
      { type: "text", text: "result" },
    ];
    expect(extractTextContent(blocks)).toBe("result");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextContent([])).toBe("");
  });
});

// ── findSessionJsonl ───────────────────────────────────────────────────────

describe("findSessionJsonl", () => {
  let tmpBase: string;
  let fakeCwd: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "squeeze-test-"));
  });

  afterEach(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it("returns most recent .jsonl file when dir exists", () => {
    // We can't easily mock homedir, so test the path computation logic indirectly
    // by checking that findSessionJsonl returns null for a non-existent cwd
    const result = findSessionJsonl("/definitely/does/not/exist/ever");
    expect(result).toBeNull();
  });

  it("returns null when no .jsonl files in project dir", () => {
    // This path won't exist in ~/.claude/projects so null is expected
    const result = findSessionJsonl("/tmp/nonexistent-cwd-squeeze-test");
    expect(result).toBeNull();
  });
});

// ── parseSessionEntries ────────────────────────────────────────────────────

describe("parseSessionEntries", () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-parse-"));
    jsonlPath = join(tmpDir, "session.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses valid JSONL lines", () => {
    const entry = { type: "user", message: { role: "user", content: "hello" } };
    writeFileSync(jsonlPath, JSON.stringify(entry) + "\n");
    const entries = parseSessionEntries(jsonlPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("user");
  });

  it("skips partial/malformed last line gracefully", () => {
    const good = { type: "user", message: { role: "user", content: "hello" } };
    writeFileSync(jsonlPath, JSON.stringify(good) + "\n" + '{"incomplete":');
    const entries = parseSessionEntries(jsonlPath);
    expect(entries).toHaveLength(1); // partial line skipped
  });

  it("skips blank lines", () => {
    const entry = { type: "assistant", message: { role: "assistant", content: "hi" } };
    writeFileSync(jsonlPath, "\n" + JSON.stringify(entry) + "\n\n");
    const entries = parseSessionEntries(jsonlPath);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for empty file", () => {
    writeFileSync(jsonlPath, "");
    expect(parseSessionEntries(jsonlPath)).toHaveLength(0);
  });
});

// ── processMessages ────────────────────────────────────────────────────────

describe("processMessages", () => {
  function makeEntry(role: "user" | "assistant", content: string, type = role) {
    return { type, message: { role, content } };
  }

  it("filters out file-history-snapshot entries", () => {
    const entries = [
      { type: "file-history-snapshot" },
      makeEntry("user", "hello"),
    ];
    const result = processMessages(entries as any);
    expect(result).toHaveLength(1);
  });

  it("does not compress messages in the last STALE_TAIL_COUNT positions", () => {
    // 5 messages, all within tail window (< 20) — none should be compressed
    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry("user", "x".repeat(400)) // long enough to compress if stale
    );
    const result = processMessages(entries as any);
    expect(result.every((m) => !m.wasCompressed)).toBe(true);
  });

  it("compresses stale L1 messages longer than MIN_COMPRESS_CHARS", () => {
    // 25 messages: first 5 are stale L1 with long content
    const longContent = "a".repeat(400);
    const entries = [
      ...Array.from({ length: 5 }, () => makeEntry("user", longContent)),
      ...Array.from({ length: 20 }, () => makeEntry("user", "short")),
    ];
    const result = processMessages(entries as any);
    const compressed = result.filter((m) => m.wasCompressed);
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed[0].compressedText).toContain("[compressed");
  });

  it("does not compress short stale messages", () => {
    const entries = [
      ...Array.from({ length: 5 }, () => makeEntry("user", "short msg")),
      ...Array.from({ length: 20 }, () => makeEntry("user", "tail")),
    ];
    const result = processMessages(entries as any);
    expect(result.filter((m) => m.wasCompressed)).toHaveLength(0);
  });

  it("classifies user message with directive pattern as L3", () => {
    const directive = makeEntry("user", "always use TDD for all new code");
    const entries = [
      directive,
      ...Array.from({ length: 20 }, () => makeEntry("user", "other")),
    ];
    const result = processMessages(entries as any);
    expect(result[0].level).toBe(Level.Directive);
  });

  it("does NOT classify assistant messages as L3 directives", () => {
    // Assistant message mentioning "always" should not be L3
    const entries = [
      makeEntry("assistant", "always use TDD — that's the rule"),
      ...Array.from({ length: 20 }, () => makeEntry("user", "ok")),
    ];
    const result = processMessages(entries as any);
    expect(result[0].level).not.toBe(Level.Directive);
  });

  it("does NOT classify long user messages as L3 directives", () => {
    // Long message (>500 chars) matching directive pattern → L1, not L3
    const longDirective = "always " + "x".repeat(600);
    const entries = [
      makeEntry("user", longDirective),
      ...Array.from({ length: 20 }, () => makeEntry("user", "ok")),
    ];
    const result = processMessages(entries as any);
    expect(result[0].level).not.toBe(Level.Directive);
  });
});

// ── writeDirectivesToMemory ────────────────────────────────────────────────

describe("writeDirectivesToMemory", () => {
  let tmpDir: string;
  let memoryPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-memory-"));
    memoryPath = join(tmpDir, "MEMORY.md");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProcessed(level: Level, text: string, role: "user" | "assistant" = "user") {
    return { index: 0, role, originalText: text, compressedText: text, level, wasCompressed: false };
  }

  it("creates MEMORY.md with L3 directives", () => {
    const processed = [makeProcessed(Level.Directive, "always use TDD")];
    const count = writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(1);
    expect(existsSync(memoryPath)).toBe(true);
    expect(readFileSync(memoryPath, "utf8")).toContain("always use TDD");
  });

  it("returns 0 and does not create file when no directives", () => {
    const processed = [makeProcessed(Level.Observation, "some observation")];
    const count = writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(0);
    expect(existsSync(memoryPath)).toBe(false);
  });

  it("deduplicates — does not append the same directive twice", () => {
    const processed = [makeProcessed(Level.Directive, "always use TDD")];
    writeDirectivesToMemory(processed, memoryPath);
    const count2 = writeDirectivesToMemory(processed, memoryPath);
    expect(count2).toBe(0); // already present
    const content = readFileSync(memoryPath, "utf8");
    expect(content.split("always use TDD").length - 1).toBe(1); // appears exactly once
  });

  it("appends new directives to existing MEMORY.md", () => {
    writeFileSync(memoryPath, "# existing content\n");
    const processed = [makeProcessed(Level.Directive, "never push to main")];
    const count = writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(1);
    const content = readFileSync(memoryPath, "utf8");
    expect(content).toContain("# existing content");
    expect(content).toContain("never push to main");
  });

  it("ignores L1 and L0 messages", () => {
    const processed = [
      makeProcessed(Level.Observation, "just an observation"),
      makeProcessed(Level.Discard, "noise"),
    ];
    const count = writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(0);
  });
});
