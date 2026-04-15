import { describe, expect, it } from "vitest";
import { extractProcedure } from "../src/procedure/extractor.js";

describe("extractProcedure", () => {
  it("extracts 5 tool calls as 5 ordered steps", () => {
    const messages = [
      { role: "user" as const, content: "Deploy the app" },
      { role: "assistant" as const, content: "Using bash: npm install" },
      { role: "tool" as const, content: "installed 200 packages" },
      { role: "assistant" as const, content: "Using bash: npm run build" },
      { role: "tool" as const, content: "build succeeded" },
      { role: "assistant" as const, content: "Using edit: updated config.ts" },
      { role: "tool" as const, content: "file saved" },
      { role: "assistant" as const, content: "Using bash: npm run deploy" },
      { role: "tool" as const, content: "deployed to staging" },
      { role: "assistant" as const, content: "Using bash: npm test" },
      { role: "tool" as const, content: "all tests passed" },
    ];

    const result = extractProcedure(messages, "Deploy", "deploy workflow", "sess-1");
    expect(result.steps).toHaveLength(5);
    expect(result.steps[0]).toEqual({ order: 1, action: "npm install", tool: "bash" });
    expect(result.steps[1]).toEqual({ order: 2, action: "npm run build", tool: "bash" });
    expect(result.steps[2]).toEqual({ order: 3, action: "updated config.ts", tool: "edit" });
    expect(result.steps[3]).toEqual({ order: 4, action: "npm run deploy", tool: "bash" });
    expect(result.steps[4]).toEqual({ order: 5, action: "npm test", tool: "bash" });
  });

  it("detects error followed by retry as pitfall", () => {
    const messages = [
      { role: "assistant" as const, content: "Using bash: npm test" },
      { role: "tool" as const, content: "error: lockfile is stale, exit code 1" },
      { role: "assistant" as const, content: "Using bash: npm install && npm test" },
      { role: "tool" as const, content: "all tests passed" },
    ];

    const result = extractProcedure(messages, "Test", "run tests", "sess-1");
    expect(result.pitfalls).toHaveLength(1);
    expect(result.pitfalls[0]).toContain("lockfile is stale");
  });

  it("extracts verification from final tool results with test keywords", () => {
    const messages = [
      { role: "assistant" as const, content: "Using bash: npm run build" },
      { role: "tool" as const, content: "build completed" },
      { role: "assistant" as const, content: "Using bash: npm test" },
      { role: "tool" as const, content: "all 42 tests passed" },
    ];

    const result = extractProcedure(messages, "Build", "build and test", "sess-1");
    expect(result.verification.length).toBeGreaterThanOrEqual(1);
    expect(result.verification.some((v) => v.includes("passed"))).toBe(true);
  });

  it("returns empty steps when no tool calls present", () => {
    const messages = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi there, how can I help?" },
    ];

    const result = extractProcedure(messages, "Chat", "greeting", "sess-1");
    expect(result.steps).toHaveLength(0);
  });

  it("always sets status to candidate", () => {
    const messages = [
      { role: "assistant" as const, content: "Using bash: echo hello" },
    ];

    const result = extractProcedure(messages, "Test", "test trigger", "sess-1");
    expect(result.status).toBe("candidate");
  });
});
