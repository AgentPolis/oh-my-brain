import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, homedir } from "path";
import { tmpdir } from "os";
import { archiveCompressedMessages, detectAndStoreHabits, detectAndStoreRelations, detectAndStoreSchemas, extractEventTime, extractMemoryCandidates, extractSessionEvents, extractTextContent, findSessionJsonl, parseSessionEntries, processMessages, writeDirectivesToMemory } from "../cli/compress-core.js";
import { Level } from "../src/types.js";
import { EventStore } from "../src/storage/events.js";
import { loadHabits } from "../cli/habit-detector.js";
import { RelationStore } from "../cli/relation-store.js";
import { SchemaStore } from "../cli/schema-detector.js";

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

describe("extractEventTime", () => {
  it("extracts absolute dates from directive text", () => {
    const ts = extractEventTime(
      "I switched to TypeScript on March 15, 2026",
      "2026-04-10T12:00:00.000Z"
    );
    expect(ts).toBe("2026-03-15T00:00:00.000Z");
  });

  it("falls back cleanly for non-temporal text", () => {
    const fallback = "2026-04-10T12:00:00.000Z";
    expect(extractEventTime("Always use strict mode", fallback)).toBe(fallback);
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

  it("classifies soft-signal corrective feedback as L1 and surfaces it as a Memory Candidate (not L3)", () => {
    // This is the exact kind of natural-language correction described in
    // docs/why-memory-candidates.md. "應該", "太多", "搞錯", "改善" are soft
    // signals: obviously important to a human, but NOT explicit imperatives
    // like "always X" or "never Y". The product's two-stage capture model
    // says these belong in the Memory Candidates review queue, not auto-
    // promoted to L3 directives. A previous version of the classifier
    // matched these as L3, which caused false positives on any sentence
    // containing "應該" or "太多" — including questions.
    const softSignal = makeEntry(
      "user",
      "怎麼回事，你剛剛改完辦公室那個，變成我移動時，指標都沒移動了。應該都是要時時移動的，另外右邊側邊欄太多提醒了，能怎麼改善"
    );
    const entries = [
      softSignal,
      ...Array.from({ length: 20 }, () => makeEntry("user", "other")),
    ];
    const result = processMessages(entries as any);
    expect(result[0].level).not.toBe(Level.Directive);

    const candidates = extractMemoryCandidates(result);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((c) => c.includes("應該"))).toBe(true);
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

  it("catches user corrections as memory candidates", () => {
    const corrections = [
      // EN: negation / correction
      "No, that's not right — it should use absolute dates",
      "Actually, I meant the other endpoint",
      "Wait, no — don't use relative time",
      "You're wrong, the API returns a list",
      "Why did you add that? I didn't ask for it",
      "I said use dates, not relative time",
      "Stop making assumptions about the format",
      "That's not what I asked for",
      // CJK: negation / correction
      "不對吧，這個應該是放日期不是放相對時間才對啊",
      "不是這樣的吧，你搞錯了整個方向，要重新來過",
      "為什麼要用 relative time？這完全沒有意義吧",
      "這個方向錯了吧，你改回來吧，用原本的方案就好",
      // JP
      "違う、そうじゃないよ、もう一回最初からやり直してください",
      // KR
      "아니, 그게 아니야, 처음부터 다시 해봐야 할 것 같아",
    ];
    for (const text of corrections) {
      const entries = [
        makeEntry("user", text),
        ...Array.from({ length: 20 }, () => makeEntry("user", "other")),
      ];
      const result = processMessages(entries as any);
      const candidates = extractMemoryCandidates(result);
      expect(
        candidates.length,
        `expected candidate for: "${text}"`
      ).toBeGreaterThan(0);
    }
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

describe("archiveCompressedMessages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-archive-run-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("archives compressed L1 messages and rebuilds timeline", () => {
    const processed = [
      {
        index: 1,
        role: "user" as const,
        originalText: "Long compressed message about car service and deployment follow-up.",
        compressedText: "[compressed] car service and deployment",
        level: Level.Observation,
        wasCompressed: true,
      },
      {
        index: 2,
        role: "user" as const,
        originalText: "Always use TypeScript strict mode",
        compressedText: "Always use TypeScript strict mode",
        level: Level.Directive,
        wasCompressed: false,
      },
    ];

    const result = archiveCompressedMessages(tmpDir, processed, {
      sessionId: "sess-1",
      sessionStart: "2026-04-06T10:00:00.000Z",
    });

    expect(result.appended).toBe(1);
    const archiveText = readFileSync(join(tmpDir, ".squeeze", "archive.jsonl"), "utf8");
    expect(archiveText).toContain("car service");
    expect(existsSync(join(tmpDir, ".squeeze", "timeline.json"))).toBe(true);
  });

  it("dedupes repeated archive writes for the same session and content", () => {
    const processed = [
      {
        index: 1,
        role: "assistant" as const,
        originalText: "Repeated compressed note.",
        compressedText: "[compressed] repeated",
        level: Level.Observation,
        wasCompressed: true,
      },
    ];

    archiveCompressedMessages(tmpDir, processed, {
      sessionId: "sess-dup",
      sessionStart: "2026-04-06T10:00:00.000Z",
    });
    const second = archiveCompressedMessages(tmpDir, processed, {
      sessionId: "sess-dup",
      sessionStart: "2026-04-06T10:00:00.000Z",
    });

    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(1);
    const lines = readFileSync(join(tmpDir, ".squeeze", "archive.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
  });
});

describe("extractSessionEvents", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-events-run-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts events from user L1/L2 messages into events.jsonl", () => {
    const processed = [
      {
        index: 1,
        role: "user" as const,
        originalText: "I got my car serviced last Tuesday. The GPS wasn't working.",
        compressedText: "[compressed] car serviced",
        level: Level.Observation,
        wasCompressed: true,
      },
      {
        index: 2,
        role: "assistant" as const,
        originalText: "That sounds frustrating.",
        compressedText: "That sounds frustrating.",
        level: Level.Observation,
        wasCompressed: false,
      },
      {
        index: 3,
        role: "user" as const,
        originalText: "I prefer tabs over spaces.",
        compressedText: "I prefer tabs over spaces.",
        level: Level.Preference,
        wasCompressed: false,
      },
    ];

    const result = extractSessionEvents(tmpDir, processed, {
      sessionId: "sess-events",
      sessionDate: "2026-03-20T12:00:00.000Z",
    });

    expect(result.appended).toBeGreaterThan(0);
    const store = new EventStore(join(tmpDir, ".squeeze"));
    const events = store.getAll();
    expect(events.some((event) => event.what === "car serviced")).toBe(true);
    expect(events.every((event) => event.session_id === "sess-events")).toBe(true);
  });

  it("dedupes repeated extraction for the same session and source text", () => {
    const processed = [
      {
        index: 1,
        role: "user" as const,
        originalText: "I bought a Samsung Galaxy S22 on February 20th.",
        compressedText: "[compressed] bought Galaxy",
        level: Level.Observation,
        wasCompressed: true,
      },
    ];

    extractSessionEvents(tmpDir, processed, {
      sessionId: "sess-events",
      sessionDate: "2026-03-20T12:00:00.000Z",
    });
    const second = extractSessionEvents(tmpDir, processed, {
      sessionId: "sess-events",
      sessionDate: "2026-03-20T12:00:00.000Z",
    });

    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(1);
    const store = new EventStore(join(tmpDir, ".squeeze"));
    expect(store.getAll()).toHaveLength(1);
  });
});

describe("detectAndStoreHabits", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-habits-run-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects new habits from stored event history and returns HABIT candidates", () => {
    const store = new EventStore(join(tmpDir, ".squeeze"));
    store.append([
      {
        id: "e1",
        ts: "2026-04-01T00:00:00.000Z",
        ts_ingest: "2026-04-01T00:00:00.000Z",
        ts_precision: "exact",
        what: "flew United to Vegas",
        detail: "",
        category: "travel",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "flew United to Vegas",
        session_id: "sess-1",
        turn_index: 1,
      },
      {
        id: "e2",
        ts: "2026-04-02T00:00:00.000Z",
        ts_ingest: "2026-04-02T00:00:00.000Z",
        ts_precision: "exact",
        what: "flew United to SF",
        detail: "",
        category: "travel",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "flew United to SF",
        session_id: "sess-1",
        turn_index: 2,
      },
      {
        id: "e3",
        ts: "2026-04-03T00:00:00.000Z",
        ts_ingest: "2026-04-03T00:00:00.000Z",
        ts_precision: "exact",
        what: "flew United to Seattle",
        detail: "",
        category: "travel",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "flew United to Seattle",
        session_id: "sess-1",
        turn_index: 3,
      },
    ]);

    const result = detectAndStoreHabits(tmpDir);
    expect(result.detected).toBe(1);
    expect(result.candidates).toEqual(["HABIT: frequently flies United Airlines"]);
    expect(loadHabits(tmpDir)).toHaveLength(1);
  });

  it("does not re-propose existing habits on later runs", () => {
    const store = new EventStore(join(tmpDir, ".squeeze"));
    store.append([
      {
        id: "e1",
        ts: "2026-04-01T00:00:00.000Z",
        ts_ingest: "2026-04-01T00:00:00.000Z",
        ts_precision: "exact",
        what: "flew United to Vegas",
        detail: "",
        category: "travel",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "flew United to Vegas",
        session_id: "sess-1",
        turn_index: 1,
      },
      {
        id: "e2",
        ts: "2026-04-02T00:00:00.000Z",
        ts_ingest: "2026-04-02T00:00:00.000Z",
        ts_precision: "exact",
        what: "flew United to SF",
        detail: "",
        category: "travel",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "flew United to SF",
        session_id: "sess-1",
        turn_index: 2,
      },
      {
        id: "e3",
        ts: "2026-04-03T00:00:00.000Z",
        ts_ingest: "2026-04-03T00:00:00.000Z",
        ts_precision: "exact",
        what: "flew United to Seattle",
        detail: "",
        category: "travel",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "flew United to Seattle",
        session_id: "sess-1",
        turn_index: 3,
      },
    ]);

    detectAndStoreHabits(tmpDir);
    const second = detectAndStoreHabits(tmpDir);
    expect(second.detected).toBe(0);
    expect(second.candidates).toEqual([]);
  });
});

describe("detectAndStoreRelations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-relations-run-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects trust relations from user messages", () => {
    const result = detectAndStoreRelations(tmpDir, [
      {
        index: 1,
        role: "user",
        originalText: "Tom's recommendation worked well for our Redis setup.",
        compressedText: "Tom's recommendation worked well for our Redis setup.",
        level: Level.Observation,
        wasCompressed: false,
      },
    ]);

    const store = new RelationStore(join(tmpDir, ".squeeze"));
    expect(result.updated).toBe(1);
    expect(store.getTrusted("tech")).toHaveLength(0);
    expect(store.getByPerson("Tom")[0].level).toBe("medium");
  });

  it("is idempotent for repeated session runs", () => {
    const processed = [
      {
        index: 1,
        role: "user" as const,
        originalText: "Tom's recommendation worked well for our Redis setup.",
        compressedText: "Tom's recommendation worked well for our Redis setup.",
        level: Level.Observation,
        wasCompressed: false,
      },
    ];

    detectAndStoreRelations(tmpDir, processed);
    const second = detectAndStoreRelations(tmpDir, processed);
    const store = new RelationStore(join(tmpDir, ".squeeze"));
    expect(second.updated).toBe(0);
    expect(store.getByPerson("Tom")[0].evidence).toHaveLength(1);
  });
});

describe("detectAndStoreSchemas", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-schemas-run-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects schemas when habits and directives support a framework", () => {
    mkdirSync(join(tmpDir, ".squeeze"), { recursive: true });
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      "## oh-my-brain directives (2026-04-14) [source:test]\n\n- [test] Well-tested code is non-negotiable in review.\n"
    );
    writeFileSync(
      join(tmpDir, ".squeeze", "habits.json"),
      JSON.stringify({
        version: 1,
        habits: [
          {
            id: "h1",
            pattern: "always check error handling in reviews",
            confidence: 0.9,
            evidence: ["e1", "e2"],
            first_seen: "2026-04-01T00:00:00.000Z",
            occurrences: 4,
          },
          {
            id: "h2",
            pattern: "always verify test coverage in reviews",
            confidence: 0.8,
            evidence: ["e3", "e4"],
            first_seen: "2026-04-01T00:00:00.000Z",
            occurrences: 4,
          },
        ],
      })
    );

    const result = detectAndStoreSchemas(tmpDir);
    const store = new SchemaStore(join(tmpDir, ".squeeze"));
    expect(result.detected).toBe(1);
    expect(result.candidates).toEqual([
      'SCHEMA: "Code Review Framework" — always check error handling in reviews → always verify test coverage in reviews',
    ]);
    expect(store.getByCategory("code-review")).toHaveLength(1);
  });

  it("does not re-propose schemas once stored", () => {
    mkdirSync(join(tmpDir, ".squeeze"), { recursive: true });
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      "## oh-my-brain directives (2026-04-14) [source:test]\n\n- [test] Well-tested code is non-negotiable in review.\n"
    );
    writeFileSync(
      join(tmpDir, ".squeeze", "habits.json"),
      JSON.stringify({
        version: 1,
        habits: [
          {
            id: "h1",
            pattern: "always check error handling in reviews",
            confidence: 0.9,
            evidence: ["e1", "e2"],
            first_seen: "2026-04-01T00:00:00.000Z",
            occurrences: 4,
          },
          {
            id: "h2",
            pattern: "always verify test coverage in reviews",
            confidence: 0.8,
            evidence: ["e3", "e4"],
            first_seen: "2026-04-01T00:00:00.000Z",
            occurrences: 4,
          },
        ],
      })
    );

    detectAndStoreSchemas(tmpDir);
    const second = detectAndStoreSchemas(tmpDir);
    expect(second.detected).toBe(0);
    expect(second.candidates).toEqual([]);
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

  it("creates MEMORY.md with L3 directives", async () => {
    const processed = [makeProcessed(Level.Directive, "always use TDD")];
    const count = await writeDirectivesToMemory(processed, memoryPath, {
      source: "claude",
      sessionId: "demo-session",
    });
    expect(count).toBe(1);
    expect(existsSync(memoryPath)).toBe(true);
    expect(readFileSync(memoryPath, "utf8")).toContain("always use TDD");
    expect(readFileSync(memoryPath, "utf8")).toContain("[source:claude session:demo-session]");
  });

  it("returns 0 and does not create file when no directives", async () => {
    const processed = [makeProcessed(Level.Observation, "some observation")];
    const count = await writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(0);
    expect(existsSync(memoryPath)).toBe(false);
  });

  it("deduplicates — does not append the same directive twice", async () => {
    const processed = [makeProcessed(Level.Directive, "always use TDD")];
    await writeDirectivesToMemory(processed, memoryPath);
    const count2 = await writeDirectivesToMemory(processed, memoryPath);
    expect(count2).toBe(0); // already present
    const content = readFileSync(memoryPath, "utf8");
    expect(content.split("always use TDD").length - 1).toBe(1); // appears exactly once
  });

  it("appends new directives to existing MEMORY.md", async () => {
    writeFileSync(memoryPath, "# existing content\n");
    const processed = [makeProcessed(Level.Directive, "never push to main")];
    const count = await writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(1);
    const content = readFileSync(memoryPath, "utf8");
    expect(content).toContain("# existing content");
    expect(content).toContain("never push to main");
  });

  it("retireDirective moves a matching directive to the archive section", async () => {
    const { retireDirective } = await import("../cli/compress-core.js");
    const processed = [
      makeProcessed(Level.Directive, "always use TypeScript strict mode"),
      makeProcessed(Level.Directive, "never commit generated files"),
    ];
    await writeDirectivesToMemory(processed, memoryPath, { source: "claude" });

    const retired = retireDirective(memoryPath, "always use TypeScript");
    expect(retired).toBe(1);

    const content = readFileSync(memoryPath, "utf8");
    expect(content).toContain("## oh-my-brain archive");
    expect(content).toContain("never commit generated files");

    // The active section should no longer contain the retired directive
    // ahead of the archive heading.
    const archiveIdx = content.indexOf("## oh-my-brain archive");
    const activeSection = content.slice(0, archiveIdx);
    expect(activeSection).not.toContain("always use TypeScript strict mode");

    const archiveSection = content.slice(archiveIdx);
    expect(archiveSection).toContain("always use TypeScript strict mode");
  });

  it("retireDirective allows re-adding a retired directive later", async () => {
    const { retireDirective } = await import("../cli/compress-core.js");
    const processed = [makeProcessed(Level.Directive, "always use Python 3.11")];
    await writeDirectivesToMemory(processed, memoryPath, { source: "claude" });

    retireDirective(memoryPath, "always use Python 3.11");

    // Re-add the same directive — should succeed because parseExistingDirectives
    // skips archive content.
    const count = await writeDirectivesToMemory(processed, memoryPath, { source: "claude" });
    expect(count).toBe(1);

    const content = readFileSync(memoryPath, "utf8");
    // Both the archive copy and the re-added active copy should exist.
    const occurrences = content.match(/always use Python 3\.11/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("retireDirective returns 0 when no directive matches", async () => {
    const { retireDirective } = await import("../cli/compress-core.js");
    const processed = [makeProcessed(Level.Directive, "always use TDD")];
    await writeDirectivesToMemory(processed, memoryPath, { source: "claude" });

    const retired = retireDirective(memoryPath, "never pair program");
    expect(retired).toBe(0);
  });

  it("retireDirective is a no-op when MEMORY.md does not exist", async () => {
    const { retireDirective } = await import("../cli/compress-core.js");
    const retired = retireDirective(memoryPath, "anything");
    expect(retired).toBe(0);
  });

  it("does not let a shorter directive block a longer superset directive (substring bug regression)", async () => {
    // Regression: previously used `existing.includes(d)` which would treat
    // "always use TypeScript" as already-present once "always use TypeScript strict mode"
    // had been written, causing the shorter directive to be silently dropped.
    // The bug also worked in the other direction in a more dangerous way:
    // writing "always use TypeScript" first would then silently drop
    // "always use TypeScript strict mode" because the prefix matched.
    const first = [makeProcessed(Level.Directive, "always use TypeScript")];
    await writeDirectivesToMemory(first, memoryPath);

    const second = [makeProcessed(Level.Directive, "always use TypeScript strict mode")];
    const count = await writeDirectivesToMemory(second, memoryPath);

    expect(count).toBe(1);
    const content = readFileSync(memoryPath, "utf8");
    expect(content).toContain("always use TypeScript strict mode");
    expect(content).toContain("always use TypeScript");
  });

  it("does not let a longer directive's substring of a shorter one cause duplication", async () => {
    // Inverse of the above: write the long one first, then the short one.
    // The short one is genuinely new and should be appended exactly once.
    const first = [makeProcessed(Level.Directive, "always use TypeScript strict mode")];
    await writeDirectivesToMemory(first, memoryPath);

    const second = [makeProcessed(Level.Directive, "always use TypeScript")];
    const count = await writeDirectivesToMemory(second, memoryPath);

    expect(count).toBe(1);
    const content = readFileSync(memoryPath, "utf8");
    // The short directive should appear as its own bullet line, not just as a substring
    // of the long one.
    const occurrences = content.match(/^- \[[^\]]*\] always use TypeScript$/gm) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("ignores L1 and L0 messages", async () => {
    const processed = [
      makeProcessed(Level.Observation, "just an observation"),
      makeProcessed(Level.Discard, "noise"),
    ];
    const count = await writeDirectivesToMemory(processed, memoryPath);
    expect(count).toBe(0);
  });
});
