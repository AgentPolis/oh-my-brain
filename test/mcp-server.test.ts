import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRequest } from "../cli/mcp-server.js";
import { writeDirectivesToMemory } from "../cli/compress-core.js";
import { Level } from "../src/types.js";
import { saveLinks } from "../cli/links-store.js";
import { ArchiveStore } from "../src/storage/archive.js";
import { EventStore } from "../src/storage/events.js";
import { TimelineIndex } from "../src/storage/timeline.js";

describe("MCP server", () => {
  let tmp: string;
  let origCwd: string;
  let origProjectRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-mcp-"));
    origCwd = process.cwd();
    origProjectRoot = process.env.OH_MY_BRAIN_PROJECT_ROOT;
    process.env.OH_MY_BRAIN_PROJECT_ROOT = tmp;
  });

  afterEach(() => {
    if (origProjectRoot === undefined) {
      delete process.env.OH_MY_BRAIN_PROJECT_ROOT;
    } else {
      process.env.OH_MY_BRAIN_PROJECT_ROOT = origProjectRoot;
    }
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  function callTool(name: string, args: Record<string, unknown> = {}) {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    return response;
  }

  it("responds to initialize with protocol + server info", () => {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
    });
    expect(response.error).toBeUndefined();
    const result = response.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    };
    expect(result.protocolVersion).toBeDefined();
    expect(result.serverInfo.name).toBe("oh-my-brain");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("lists the core brain_* tools including brain_search", () => {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const result = response.result as { tools: { name: string }[] };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("brain_remember");
    expect(names).toContain("brain_recall");
    expect(names).toContain("brain_search");
    expect(names).toContain("brain_candidates");
    expect(names).toContain("brain_retire");
    expect(names).toContain("brain_status");
  });

  it("brain_remember writes a directive to MEMORY.md", () => {
    const response = callTool("brain_remember", {
      text: "Always use TypeScript strict mode",
      source: "claude",
      session_id: "test-session",
    });
    expect(response.error).toBeUndefined();
    const content = (response.result as { content: { text: string }[] }).content[0].text;
    expect(content).toMatch(/remembered|already/);

    const memoryContent = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(memoryContent).toContain("Always use TypeScript strict mode");
  });

  it("brain_remember is idempotent", () => {
    callTool("brain_remember", { text: "Never commit to main" });
    const second = callTool("brain_remember", { text: "Never commit to main" });
    const text = (second.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("already remembered");

    const memoryContent = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    const occurrences = memoryContent.match(/Never commit to main/g) ?? [];
    expect(occurrences.length).toBe(1);
  });

  it("brain_recall returns a summary by default", () => {
    callTool("brain_remember", { text: "Always validate input" });
    callTool("brain_remember", { text: "Never expose internal errors" });

    const response = callTool("brain_recall");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("You have 2 active directives across");
    expect(text).toContain("Use brain_recall with mode=all to load everything.");
    // Agent instruction moved to tool description — not in response body
  });

  it("brain_recall summary includes archive preview when timeline exists", () => {
    callTool("brain_remember", { text: "Always validate input" });
    const events = new EventStore(join(tmp, ".squeeze"));
    events.append([
      {
        id: "e1",
        ts: "2026-04-06T10:00:00.000Z",
        ts_ingest: "2026-04-06T10:01:00.000Z",
        ts_precision: "exact",
        what: "bought training pads for Luna",
        detail: "",
        category: "pets",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "I bought training pads for Luna.",
        session_id: "sess-1",
        turn_index: 1,
      },
    ]);
    const archive = new ArchiveStore(join(tmp, ".squeeze"));
    archive.append([
      {
        id: "s1",
        ts: "2026-04-13T10:00:00.000Z",
        ingest_ts: "2026-04-13T10:01:00.000Z",
        role: "user",
        content: "Code review planning for memory architecture.",
        summary: "code review",
        level: 1,
        turn_index: 1,
        tags: ["review", "memory", "architecture"],
      },
      {
        id: "s2",
        ts: "2026-04-12T10:00:00.000Z",
        ingest_ts: "2026-04-12T10:01:00.000Z",
        role: "assistant",
        content: "Deployment follow-up and testing.",
        summary: "deployment",
        level: 1,
        turn_index: 2,
        tags: ["deployment", "testing"],
      },
    ]);
    const timeline = new TimelineIndex(join(tmp, ".squeeze"));
    timeline.rebuild();

    const response = callTool("brain_recall");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Events (1 total, 2026-04-06 ~ 2026-04-06):");
    expect(text).toContain("Recent: Apr06 🐕 bought training pads for Luna");
    expect(text).toContain("Archived history: 2 conversations (2026-04-12 ~ 2026-04-13)");
    expect(text).toContain("Recent: Apr13 (1 msgs:");
    expect(text).toContain("Use brain_search --when/--query/--who/--category for details.");
    expect(text).toContain("Use brain_search to look up specific dates or topics.");
  });

  it("brain_recall returns empty state when no directives exist", () => {
    const response = callTool("brain_recall");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toMatch(/no directives|MEMORY\.md does not exist/);
  });

  it("brain_recall tool description contains agent behavior instructions", () => {
    // Instruction is now in the tool description, not the response
    const listResponse = handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listResponse.result as { tools: { name: string; description: string }[] }).tools;
    const recallTool = tools.find((t) => t.name === "brain_recall");
    const searchTool = tools.find((t) => t.name === "brain_search");
    expect(recallTool!.description).toContain("brain_remember");
    expect(recallTool!.description).toContain("brain_search");
    expect(recallTool!.description).toContain("brain_candidates");
    expect(recallTool!.description).toContain("AGENT BEHAVIOR");
    expect(searchTool!.description).toContain("who/category");
  });

  it("brain_recall mode=all returns the full directive list", () => {
    callTool("brain_remember", { text: "Always validate input" });
    callTool("brain_remember", { text: "Never expose internal errors" });

    const response = callTool("brain_recall", { mode: "all" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Always validate input");
    expect(text).toContain("Never expose internal errors");
    expect(text).toContain("Active directives (2)");
  });

  it("brain_recall mode=type filters by directive type", () => {
    callTool("brain_remember", { text: "Always use TypeScript strict mode" });
    callTool("brain_remember", { text: "Reply in concise English" });

    const response = callTool("brain_recall", {
      mode: "type",
      type: "CodingPreference",
    });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Always use TypeScript strict mode");
    expect(text).not.toContain("Reply in concise English");
  });

  it("brain_recall with_evidence includes stored provenance", () => {
    writeDirectivesToMemory(
      [
        {
          index: 3,
          role: "user",
          originalText: "Always use TypeScript",
          compressedText: "Always use TypeScript",
          level: Level.Directive,
          wasCompressed: false,
        },
      ],
      join(tmp, "MEMORY.md"),
      { source: "claude", sessionId: "sess-evidence" }
    );

    const response = callTool("brain_recall", { mode: "all", with_evidence: true });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("event_time:");
    expect(text).toContain("evidence (turn 3): Always use TypeScript");
  });

  it("brain_search returns empty-state guidance when archive is empty", () => {
    const response = callTool("brain_search", { when: "last week" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("No archived conversations yet");
  });

  it("brain_search returns structured events before archive hits by exact day", () => {
    const squeezePath = join(tmp, ".squeeze");
    const events = new EventStore(squeezePath);
    events.append([
      {
        id: "e1",
        ts: "2026-04-06T14:32:00.000Z",
        ts_ingest: "2026-04-06T14:33:00.000Z",
        ts_precision: "exact",
        what: "car serviced",
        detail: "GPS malfunction found",
        category: "vehicle",
        who: ["Tom"],
        where: "",
        related_to: [],
        sentiment: "frustrated",
        viewpoint: "",
        insight: "",
        source_text: "I just got my car serviced and the GPS still fails.",
        session_id: "sess-1",
        turn_index: 1,
      },
    ]);
    const archive = new ArchiveStore(squeezePath);
    archive.append([
      {
        id: "a1",
        ts: "2026-04-06T14:32:00.000Z",
        ingest_ts: "2026-04-06T14:33:00.000Z",
        role: "user",
        content: "I just got my car serviced and the GPS still fails.",
        summary: "car service",
        level: 1,
        turn_index: 1,
        tags: ["service", "gps"],
      },
    ]);

    const response = callTool("brain_search", { when: "2026-04-06" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Found 1 event + 1 archived message (2026-04-06):");
    expect(text).toContain("EVENTS:");
    expect(text).toContain("🚗 car serviced");
    expect(text).toContain("ARCHIVED (additional context):");
  });

  it("brain_search searches events before archive by keyword", () => {
    const squeezePath = join(tmp, ".squeeze");
    const events = new EventStore(squeezePath);
    events.append([
      {
        id: "e2",
        ts: "2026-04-07T09:00:00.000Z",
        ts_ingest: "2026-04-07T09:01:00.000Z",
        ts_precision: "exact",
        what: "car serviced",
        detail: "GPS module issue",
        category: "vehicle",
        who: [],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "The car service issue may be related to the GPS module.",
        session_id: "sess-2",
        turn_index: 2,
      },
    ]);
    const archive = new ArchiveStore(squeezePath);
    archive.append([
      {
        id: "a2",
        ts: "2026-04-07T09:00:00.000Z",
        ingest_ts: "2026-04-07T09:01:00.000Z",
        role: "assistant",
        content: "The car service issue may be related to the GPS module.",
        summary: "service issue",
        level: 1,
        turn_index: 2,
        tags: ["service", "gps"],
      },
    ]);

    const response = callTool("brain_search", { query: "car service" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Found 1 event + 1 archived message (query: car service):");
    expect(text).toContain("EVENTS:");
    expect(text).toContain("GPS module");
  });

  it("brain_search supports who lookups from event data", () => {
    const events = new EventStore(join(tmp, ".squeeze"));
    events.append([
      {
        id: "e3",
        ts: "2026-04-06T14:32:00.000Z",
        ts_ingest: "2026-04-06T14:33:00.000Z",
        ts_precision: "exact",
        what: "car serviced",
        detail: "GPS malfunction found",
        category: "vehicle",
        who: ["mechanic Tom"],
        where: "",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "my mechanic Tom said the GPS was dead",
        session_id: "sess-1",
        turn_index: 1,
      },
    ]);

    const response = callTool("brain_search", { who: "Tom" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Found 1 event + 0 archived messages (who: Tom):");
    expect(text).toContain("car serviced");
  });

  it("brain_search supports category lookups from event data", () => {
    const events = new EventStore(join(tmp, ".squeeze"));
    events.append([
      {
        id: "e4",
        ts: "2026-04-07T09:00:00.000Z",
        ts_ingest: "2026-04-07T09:01:00.000Z",
        ts_precision: "exact",
        what: "flew to Las Vegas",
        detail: "conference trip",
        category: "travel",
        who: [],
        where: "Las Vegas",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "I flew to Las Vegas for a conference.",
        session_id: "sess-2",
        turn_index: 2,
      },
    ]);

    const response = callTool("brain_search", { category: "travel" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Found 1 event + 0 archived messages (category: travel):");
    expect(text).toContain("✈️ flew to Las Vegas");
  });

  it("brain_search parses relative dates and respects limits", () => {
    const archive = new ArchiveStore(join(tmp, ".squeeze"));
    const now = new Date();
    const withinWeek = new Date(now);
    withinWeek.setDate(withinWeek.getDate() - 2);
    const alsoWithinWeek = new Date(now);
    alsoWithinWeek.setDate(alsoWithinWeek.getDate() - 1);
    archive.append([
      {
        id: "a3",
        ts: withinWeek.toISOString(),
        ingest_ts: withinWeek.toISOString(),
        role: "user",
        content: "Recent deployment note one.",
        summary: "deployment",
        level: 1,
        turn_index: 3,
        tags: ["deployment"],
      },
      {
        id: "a4",
        ts: alsoWithinWeek.toISOString(),
        ingest_ts: alsoWithinWeek.toISOString(),
        role: "assistant",
        content: "Recent deployment note two.",
        summary: "deployment",
        level: 1,
        turn_index: 4,
        tags: ["deployment"],
      },
    ]);

    const response = callTool("brain_search", { when: "last week", limit: 1 });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Found 0 events + 2 archived messages (last week):");
    const noteMatches = text.match(/Recent deployment note/g) ?? [];
    expect(noteMatches).toHaveLength(1);
  });

  it("brain_search without args returns timeline summary", () => {
    const archive = new ArchiveStore(join(tmp, ".squeeze"));
    archive.append([
      {
        id: "a5",
        ts: "2026-04-11T10:00:00.000Z",
        ingest_ts: "2026-04-11T10:00:01.000Z",
        role: "user",
        content: "Timeline preview for testing.",
        summary: "timeline preview",
        level: 1,
        turn_index: 5,
        tags: ["testing", "preview"],
      },
    ]);
    const timeline = new TimelineIndex(join(tmp, ".squeeze"));
    timeline.rebuild();

    const response = callTool("brain_search");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Apr11: 1 msgs");
  });

  it("brain_candidates supports full add → list → approve flow", () => {
    // Add
    const add = callTool("brain_candidates", {
      action: "add",
      text: "prefer tabs over spaces",
    });
    const addText = (add.result as { content: { text: string }[] }).content[0].text;
    expect(addText).toContain("added candidate");

    // List
    const list = callTool("brain_candidates", { action: "list" });
    const listText = (list.result as { content: { text: string }[] }).content[0].text;
    expect(listText).toContain("prefer tabs over spaces");

    // Extract id from list output (first 8 chars of shown id)
    const idMatch = listText.match(/([a-f0-9]{8})/);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1];

    // Approve
    const approve = callTool("brain_candidates", {
      action: "approve",
      id,
    });
    const approveText = (approve.result as { content: { text: string }[] }).content[0].text;
    expect(approveText).toMatch(/approved/);

    const memoryContent = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(memoryContent).toContain("prefer tabs over spaces");
  });

  it("brain_candidates approve with final_text uses edited version", () => {
    callTool("brain_candidates", { action: "add", text: "use TS" });
    const list = callTool("brain_candidates", { action: "list" });
    const id = ((list.result as { content: { text: string }[] }).content[0].text.match(
      /([a-f0-9]{8})/
    )! )[1];

    callTool("brain_candidates", {
      action: "approve",
      id,
      final_text: "Always use TypeScript",
    });

    const memoryContent = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(memoryContent).toContain("Always use TypeScript");
    expect(memoryContent).not.toContain("- [unknown] use TS");
  });

  it("brain_candidates reject never promotes the candidate", () => {
    callTool("brain_candidates", { action: "add", text: "noisy correction" });
    const list = callTool("brain_candidates", { action: "list" });
    const id = ((list.result as { content: { text: string }[] }).content[0].text.match(
      /([a-f0-9]{8})/
    )!)[1];

    callTool("brain_candidates", { action: "reject", id });

    expect(existsSync(join(tmp, "MEMORY.md"))).toBe(false);
  });

  it("brain_retire moves a directive to the archive", () => {
    callTool("brain_remember", { text: "Always use Python 3.11" });
    const retire = callTool("brain_retire", { match: "Python 3.11" });
    const text = (retire.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("retired 1");

    const memoryContent = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(memoryContent).toContain("## oh-my-brain archive");
    const archiveIdx = memoryContent.indexOf("## oh-my-brain archive");
    expect(memoryContent.slice(0, archiveIdx)).not.toContain("Always use Python 3.11");
  });

  it("brain_status returns counts and health fields", () => {
    callTool("brain_remember", { text: "test directive" });
    callTool("brain_candidates", { action: "add", text: "pending candidate" });
    const events = new EventStore(join(tmp, ".squeeze"));
    events.append([
      {
        id: "e1",
        ts: "2026-04-06T10:00:00.000Z",
        ts_ingest: "2026-04-06T10:01:00.000Z",
        ts_precision: "exact",
        what: "viewpoint",
        detail: "microservices are overengineered",
        category: "viewpoint",
        who: [],
        where: "",
        related_to: [],
        sentiment: "negative",
        viewpoint: "",
        insight: "",
        source_text: "I think microservices are overengineered",
        session_id: "sess-1",
        turn_index: 1,
      },
      {
        id: "e2",
        ts: "2026-04-07T10:00:00.000Z",
        ts_ingest: "2026-04-07T10:01:00.000Z",
        ts_precision: "exact",
        what: "flew to Las Vegas",
        detail: "",
        category: "travel",
        who: [],
        where: "Las Vegas",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "I flew to Las Vegas",
        session_id: "sess-2",
        turn_index: 2,
      },
    ]);
    writeFileSync(
      join(tmp, ".squeeze", "habits.json"),
      JSON.stringify({
        version: 1,
        habits: [
          {
            id: "h1",
            pattern: "frequently flies United Airlines",
            confidence: 0.8,
            evidence: ["e2"],
            first_seen: "2026-04-07T10:00:00.000Z",
            occurrences: 4,
          },
        ],
      })
    );
    const archive = new ArchiveStore(join(tmp, ".squeeze"));
    archive.append([
      {
        id: "st1",
        ts: "2026-04-12T10:00:00.000Z",
        ingest_ts: "2026-04-12T10:01:00.000Z",
        role: "user",
        content: "Status archive entry",
        summary: "status archive",
        level: 1,
        turn_index: 1,
        tags: ["status"],
      },
    ]);

    const status = callTool("brain_status");
    const text = (status.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("memory_exists: true");
    expect(text).toContain("candidates_pending: 1");
    expect(text).toContain("candidates_total: 1");
    expect(text).toContain("guard_blocked_total: 0");
    expect(text).toContain("merge_proposals_pending: 0");
    expect(text).toContain("last_ontology_scan:");
    expect(text).toContain("health: healthy");
    expect(text).toContain("archive_entries: 1");
    expect(text).toContain("archive_date_range: 2026-04-12 ~ 2026-04-12");
    expect(text).toContain("archive_size_kb:");
    expect(text).toContain("events_total: 2");
    expect(text).toContain("events_categories: travel(1) viewpoint(1)");
    expect(text).toContain("habits_detected: 1");
    expect(text).toContain("viewpoints_captured: 1");
    expect(text).toContain("token_budget.total_directives: 1");
  });

  it("brain_status reports needs_review when pending candidates exceed threshold", () => {
    for (let i = 0; i < 6; i += 1) {
      callTool("brain_candidates", { action: "add", text: `pending candidate ${i}` });
    }

    const status = callTool("brain_status");
    const text = (status.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("health: needs_review");
  });

  it("brain_status reports bloated when active directives exceed 30", () => {
    for (let i = 0; i < 31; i += 1) {
      callTool("brain_remember", { text: `Always keep rule ${i}` });
    }

    const status = callTool("brain_status");
    const text = (status.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("health: bloated");
  });

  it("brain_recall shows conflict warnings from approved contradicts links", () => {
    callTool("brain_remember", { text: "Always use tabs" });
    callTool("brain_remember", { text: "Follow project conventions" });
    saveLinks(tmp, [
      {
        id: "link-1",
        fromDirective: "Always use tabs",
        toDirective: "Follow project conventions",
        kind: "contradicts",
        addedAt: new Date().toISOString(),
        origin: "user",
      },
    ]);

    const response = callTool("brain_recall", { mode: "all" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain('⚠ CONFLICT: "Always use tabs" may contradict "Follow project conventions"');
  });

  it("brain_quiz returns an error until enough directives exist", () => {
    callTool("brain_remember", { text: "Always use TypeScript" });
    callTool("brain_remember", { text: "Never force-push to main" });

    const response = callTool("brain_quiz", { category: "random" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain(
      "Not enough directives to generate meaningful scenarios. Use oh-my-brain for a few sessions first."
    );
  });

  it("brain_quiz returns a scenario payload when enough directives exist", () => {
    callTool("brain_remember", { text: "Always use TypeScript strict mode" });
    callTool("brain_remember", { text: "Never force-push to main" });
    callTool("brain_remember", { text: "Always review before merging" });

    const response = callTool("brain_quiz", { category: "random" });
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text) as {
      scenario: string;
      options: string[];
      hint: string;
      expected: string;
      relevant_directives: string[];
      instructions: string;
    };
    expect(payload.scenario).toBeTruthy();
    expect(payload.options.length).toBeGreaterThan(0);
    expect(payload.expected).toBeTruthy();
    expect(payload.relevant_directives.length).toBeGreaterThan(0);
  });

  it("unknown method returns JSON-RPC error", () => {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: 99,
      method: "does/not/exist",
    });
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
  });

  it("unknown tool name returns error text", () => {
    const response = callTool("brain_fake_tool");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("unknown tool");
  });

  it("notifications/initialized returns empty result", () => {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: null,
      method: "notifications/initialized",
    });
    expect(response.error).toBeUndefined();
  });
});
