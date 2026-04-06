import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleRequest } from "../cli/mcp-server.js";

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

  it("brain_recall returns all active directives", () => {
    callTool("brain_remember", { text: "Always validate input" });
    callTool("brain_remember", { text: "Never expose internal errors" });

    const response = callTool("brain_recall");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("Always validate input");
    expect(text).toContain("Never expose internal errors");
    expect(text).toContain("Active directives (2)");
  });

  it("brain_recall returns empty state when no directives exist", () => {
    const response = callTool("brain_recall");
    const text = (response.result as { content: { text: string }[] }).content[0].text;
    expect(text).toMatch(/no directives|MEMORY\.md does not exist/);
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

  it("brain_status returns counts", () => {
    callTool("brain_remember", { text: "test directive" });
    callTool("brain_candidates", { action: "add", text: "pending candidate" });

    const status = callTool("brain_status");
    const text = (status.result as { content: { text: string }[] }).content[0].text;
    expect(text).toContain("memory_exists: true");
    expect(text).toContain("candidates_pending: 1");
    expect(text).toContain("candidates_total: 1");
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
