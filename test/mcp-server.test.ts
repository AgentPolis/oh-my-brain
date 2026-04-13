import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRequest } from "../cli/mcp-server.js";
import { writeDirectivesToMemory } from "../cli/compress-core.js";
import { Level } from "../src/types.js";
import { saveLinks } from "../cli/links-store.js";

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

  it("lists all five brain_* tools", () => {
    const response = handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const result = response.result as { tools: { name: string }[] };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("brain_remember");
    expect(names).toContain("brain_recall");
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
    expect(recallTool!.description).toContain("brain_remember");
    expect(recallTool!.description).toContain("brain_candidates");
    expect(recallTool!.description).toContain("AGENT BEHAVIOR");
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
    expect(text).toContain("evidence (turn 3): Always use TypeScript");
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

    const status = callTool("brain_status");
    const text = (status.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("memory_exists: true");
    expect(text).toContain("candidates_pending: 1");
    expect(text).toContain("candidates_total: 1");
    expect(text).toContain("guard_blocked_total: 0");
    expect(text).toContain("merge_proposals_pending: 0");
    expect(text).toContain("last_ontology_scan:");
    expect(text).toContain("health: healthy");
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
