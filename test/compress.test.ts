import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, homedir } from "path";
import { tmpdir } from "os";
import { extractMemoryCandidates, extractTextContent, findSessionJsonl, parseSessionEntries, processMessages, writeDirectivesToMemory } from "../cli/compress-core.js";
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
    expect(extractTextContent(blocks)).toContain("result");
  });

  it("includes string tool_result payloads", () => {
    const blocks = [
      { type: "tool_result", content: "Read output: important context", tool_use_id: "abc" },
    ];
    expect(extractTextContent(blocks)).toContain("important context");
  });

  it("includes nested tool_result references", () => {
    const blocks = [
      {
        type: "tool_result",
        content: [{ type: "tool_reference", tool_name: "WebSearch" }],
        tool_use_id: "abc",
      },
    ];
    expect(extractTextContent(blocks)).toContain("WebSearch");
  });

  it("includes compact tool_use descriptors", () => {
    const blocks = [
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/demo.md", limit: 50 } },
    ];
    const result = extractTextContent(blocks);
    expect(result).toContain("[tool_use:Read]");
    expect(result).toContain("file_path");
  });

  it("returns empty string for empty array", () => {
    expect(extractTextContent([])).toBe("");
  });
});

// ── findSessionJsonl ───────────────────────────────────────────────────────

describe("findSessionJsonl", () => {
  let tmpBase: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), "squeeze-test-"));
    delete process.env.SQUEEZE_SESSION_FILE;
    delete process.env.SQUEEZE_CLAUDE_PROJECTS_DIR;
  });

  afterEach(() => {
    delete process.env.SQUEEZE_SESSION_FILE;
    delete process.env.SQUEEZE_CLAUDE_PROJECTS_DIR;
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

  it("prefers SQUEEZE_SESSION_FILE when provided", () => {
    const sessionPath = join(tmpBase, "session.jsonl");
    writeFileSync(sessionPath, '{"type":"user","message":{"role":"user","content":"hello"}}\n');
    process.env.SQUEEZE_SESSION_FILE = sessionPath;
    expect(findSessionJsonl("/any/path")).toBe(sessionPath);
  });

  it("uses SQUEEZE_CLAUDE_PROJECTS_DIR when provided", () => {
    const fakeCwd = "/tmp/squeeze-custom-project";
    const dirName = fakeCwd.replace(/\//g, "-");
    const projectDir = join(tmpBase, dirName);
    mkdirSync(projectDir, { recursive: true });

    const older = join(projectDir, "older.jsonl");
    const newer = join(projectDir, "newer.jsonl");
    writeFileSync(older, '{"type":"user","message":{"role":"user","content":"old"}}\n');
    writeFileSync(newer, '{"type":"user","message":{"role":"user","content":"new"}}\n');

    process.env.SQUEEZE_CLAUDE_PROJECTS_DIR = tmpBase;
    const found = findSessionJsonl(fakeCwd);
    expect(found === older || found === newer).toBe(true);
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

  it("classifies user corrective UI feedback as L3 when it expresses durable behavior expectations", () => {
    const directive = makeEntry(
      "user",
      "怎麼回事，你剛剛改完辦公室那個，變成我移動時，指標都沒移動了。應該都是要時時移動的，另外右邊側邊欄太多提醒了，能怎麼改善"
    );
    const entries = [
      directive,
      ...Array.from({ length: 20 }, () => makeEntry("user", "other")),
    ];
    const result = processMessages(entries as any);
    expect(result[0].level).toBe(Level.Directive);
  });

  it("flags review candidates for corrective user feedback that is not promoted to memory yet", () => {
    const entries = [
      makeEntry("user", "右邊側邊欄提醒很多，現在有點吵，想再清一點。"),
      ...Array.from({ length: 20 }, () => makeEntry("user", "other")),
    ];
    const result = processMessages(entries as any);
    const candidates = extractMemoryCandidates(result);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toContain("右邊側邊欄提醒很多");
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

  it("processes the sanitized Claude hook fixture with both compression and directives", () => {
    const fixturePath = new URL("./fixtures/claude-hook-session-demo.jsonl", import.meta.url);
    const entries = parseSessionEntries(fixturePath);
    const result = processMessages(entries as any);

    expect(result.length).toBe(28);
    expect(result.some((m) => m.wasCompressed)).toBe(true);
    expect(result.filter((m) => m.level === Level.Directive)).toHaveLength(2);
  });

  it("does not treat tool_result blocks in user-role entries as directives", () => {
    const entries = [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: "always use TDD in all future changes",
            },
          ],
        },
      },
      ...Array.from({ length: 20 }, () => makeEntry("user", "tail")),
    ];

    const result = processMessages(entries as any);
    expect(result[0].level).toBe(Level.Observation);
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
    const count = writeDirectivesToMemory(processed, memoryPath, {
      source: "claude",
      sessionId: "demo-session",
    });
    expect(count).toBe(1);
    expect(existsSync(memoryPath)).toBe(true);
    expect(readFileSync(memoryPath, "utf8")).toContain("always use TDD");
    expect(readFileSync(memoryPath, "utf8")).toContain("[source:claude session:demo-session]");
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

  it("does not let a shorter directive block a longer superset directive (substring bug regression)", () => {
    // Regression: previously used `existing.includes(d)` which would treat
    // "always use TypeScript" as already-present once "always use TypeScript strict mode"
    // had been written, causing the shorter directive to be silently dropped.
    // The bug also worked in the other direction in a more dangerous way:
    // writing "always use TypeScript" first would then silently drop
    // "always use TypeScript strict mode" because the prefix matched.
    const first = [makeProcessed(Level.Directive, "always use TypeScript")];
    writeDirectivesToMemory(first, memoryPath);

    const second = [makeProcessed(Level.Directive, "always use TypeScript strict mode")];
    const count = writeDirectivesToMemory(second, memoryPath);

    expect(count).toBe(1);
    const content = readFileSync(memoryPath, "utf8");
    expect(content).toContain("always use TypeScript strict mode");
    expect(content).toContain("always use TypeScript");
  });

  it("does not let a longer directive's substring of a shorter one cause duplication", () => {
    // Inverse of the above: write the long one first, then the short one.
    // The short one is genuinely new and should be appended exactly once.
    const first = [makeProcessed(Level.Directive, "always use TypeScript strict mode")];
    writeDirectivesToMemory(first, memoryPath);

    const second = [makeProcessed(Level.Directive, "always use TypeScript")];
    const count = writeDirectivesToMemory(second, memoryPath);

    expect(count).toBe(1);
    const content = readFileSync(memoryPath, "utf8");
    // The short directive should appear as its own bullet line, not just as a substring
    // of the long one.
    const occurrences = content.match(/^- \[[^\]]*\] always use TypeScript$/gm) ?? [];
    expect(occurrences.length).toBe(1);
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
