import { describe, expect, it } from "vitest";
import { scanSessionForFailures, generateLesson } from "../src/outcome/detector.js";

describe("scanSessionForFailures", () => {
  function msg(role: "user" | "assistant" | "tool", content: string) {
    return { role, content };
  }

  it("detects failure when tool_result has exit code 1 and user says broke", () => {
    const messages = [
      msg("user", "deploy to production"),
      msg("assistant", "Running deploy script..."),
      msg("tool", "Error: exit code 1\nCommand failed"),
      msg("user", "it broke, rollback"),
      msg("assistant", "Rolling back..."),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].result).toBe("failure");
    expect(outcomes[0].failure_mode).toContain("exit code");
  });

  it("detects Chinese failure signals", () => {
    const messages = [
      msg("user", "部署到 production"),
      msg("tool", "ERROR: connection refused"),
      msg("user", "壞了，趕快回滾"),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(1);
  });

  it("ignores single error mention in assistant message", () => {
    const messages = [
      msg("user", "how do I handle errors?"),
      msg("assistant", "You should use try/catch for error handling"),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(0);
  });

  it("ignores 'error handling' in code discussion (exclusion list)", () => {
    const messages = [
      msg("user", "add error handling to the API"),
      msg("tool", "Updated error boundary component"),
      msg("user", "looks good"),
    ];
    const outcomes = scanSessionForFailures(messages, "sess-1");
    expect(outcomes).toHaveLength(0);
  });

  it("returns [] for clean session", () => {
    const messages = [
      msg("user", "write a function"),
      msg("assistant", "Here is the function"),
      msg("tool", "Tests passed"),
    ];
    expect(scanSessionForFailures(messages, "sess-1")).toHaveLength(0);
  });

  it("returns [] for empty messages array", () => {
    expect(scanSessionForFailures([], "sess-1")).toHaveLength(0);
  });
});

describe("generateLesson", () => {
  it("generates rollback lesson", () => {
    const lesson = generateLesson("rollback", "deploy failed", "blue-green deploy");
    expect(lesson).toContain("rollback");
    expect(lesson).toContain("dry-run");
  });

  it("generates error lesson", () => {
    const lesson = generateLesson("error", "ENOENT", "file operation");
    expect(lesson).toContain("ENOENT");
  });

  it("generates user correction lesson", () => {
    const lesson = generateLesson("correction", "wrong approach", "use canary instead");
    expect(lesson).toContain("corrected");
  });
});
