import { describe, it, expect } from "vitest";
import { truncateIfNeeded, TOOL_OUTPUT_MAX_TOKENS } from "../src/triage/truncate.js";
import { estimateTokens } from "../src/assembly/budget.js";

describe("truncateIfNeeded", () => {
  it("passes short content through unchanged", () => {
    const short = "hello world";
    expect(truncateIfNeeded(short, "tool_result")).toBe(short);
  });

  it("passes non-tool content through unchanged even if long", () => {
    const long = "x".repeat(10000);
    expect(truncateIfNeeded(long, "conversation")).toBe(long);
  });

  it("truncates long tool output to token budget", () => {
    const long = "A".repeat(5000);
    const result = truncateIfNeeded(long, "tool_result");
    // Result chars should be proportional to token budget (with slack for marker line)
    expect(result.length).toBeLessThan(TOOL_OUTPUT_MAX_TOKENS * 4 * 1.2);
    expect(result).toContain("[truncated");
    // Core guarantee: output token count should not greatly exceed the budget
    // (small overshoot allowed for the marker line itself, ~15 tokens)
    expect(estimateTokens(result)).toBeLessThan(TOOL_OUTPUT_MAX_TOKENS + 20);
  });

  it("preserves head and tail of tool output", () => {
    const content = "HEAD " + "noise ".repeat(500) + " TAIL";
    const result = truncateIfNeeded(content, "tool_result");
    expect(result).toContain("HEAD");
    expect(result).toContain("TAIL");
  });

  it("does not truncate content just under the limit", () => {
    const underLimit = "x".repeat((TOOL_OUTPUT_MAX_TOKENS - 1) * 4);
    const result = truncateIfNeeded(underLimit, "tool_result");
    expect(result).not.toContain("[truncated");
  });

  it("does not truncate non-tool_result content types even when very long", () => {
    const long = "x".repeat(5000);
    for (const ct of ["conversation", "code", "reasoning", "instruction", "reference"] as const) {
      expect(truncateIfNeeded(long, ct)).toBe(long);
    }
  });
});
