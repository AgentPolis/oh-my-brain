import { describe, expect, it, vi } from "vitest";
import { reflect, detectLLMCli, maybeReflect } from "../cli/llm-reflect.js";
import { spawnSync } from "child_process";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

describe("detectLLMCli", () => {
  it("returns claude when claude --version succeeds", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "2.1.63",
      stderr: "",
      error: undefined,
    } as any);
    expect(detectLLMCli()).toBe("claude");
  });

  it("returns codex when claude fails but codex succeeds", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, error: new Error("not found") } as any)
      .mockReturnValueOnce({ status: 0, stdout: "1.0", stderr: "" } as any);
    expect(detectLLMCli()).toBe("codex");
  });

  it("returns null when both fail", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, error: new Error("not found") } as any)
      .mockReturnValueOnce({ status: 1, error: new Error("not found") } as any);
    expect(detectLLMCli()).toBeNull();
  });
});

describe("reflect", () => {
  it("parses valid JSON response with corrections and sentiments", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        corrections: ["Don't create issues for imaginary users"],
        sentiments: ["Frustrated — agent created unnecessary GitHub issues"],
        events: [{ what: "Published oh-my-brain v0.7.0 to npm", category: "work" }],
      }),
      stderr: "",
      error: undefined,
    } as any);

    const result = reflect(["不是，這些必要嗎", "無聊欸"], "claude");
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toContain("imaginary");
    expect(result.sentiments).toHaveLength(1);
    expect(result.events).toHaveLength(1);
  });

  it("handles JSON wrapped in markdown code fences", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '```json\n{"corrections":["Stop over-explaining"],"sentiments":[],"events":[]}\n```',
      stderr: "",
      error: undefined,
    } as any);

    const result = reflect(["你整個檢查一下啦"], "claude");
    expect(result.corrections).toHaveLength(1);
  });

  it("returns empty on invalid JSON", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "I cannot parse this as JSON sorry",
      stderr: "",
      error: undefined,
    } as any);

    const result = reflect(["test"], "claude");
    expect(result.corrections).toHaveLength(0);
    expect(result.sentiments).toHaveLength(0);
    expect(result.raw).toContain("cannot parse");
  });

  it("returns empty on CLI failure", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "error",
      error: new Error("failed"),
    } as any);

    const result = reflect(["test"], "claude");
    expect(result.corrections).toHaveLength(0);
  });

  it("returns empty for empty messages", () => {
    const result = reflect([], "claude");
    expect(result.corrections).toHaveLength(0);
    expect(result.sentiments).toHaveLength(0);
  });

  it("truncates long transcripts to 15K chars", () => {
    const longMessages = Array.from({ length: 100 }, (_, i) => "x".repeat(200) + ` message ${i}`);
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: '{"corrections":[],"sentiments":[],"events":[]}',
      stderr: "",
      error: undefined,
    } as any);

    reflect(longMessages, "claude");
    // Find the reflect call (the one with "-p" as first arg)
    const reflectCall = mockSpawnSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === "-p"
    );
    expect(reflectCall).toBeDefined();
    const calledPrompt = reflectCall![1]![1] as string;
    expect(calledPrompt.length).toBeLessThan(20000);
  });
});

describe("maybeReflect", () => {
  it("returns null when no CLI available", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, error: new Error("nope") } as any)
      .mockReturnValueOnce({ status: 1, error: new Error("nope") } as any);
    expect(maybeReflect(["test"])).toBeNull();
  });
});
