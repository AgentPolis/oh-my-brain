import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn((command: string) => {
    if (command === "pbcopy") {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "Choose A", stderr: "" };
  }),
}));

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  appendQuizHistory,
  formatQuizHistorySummary,
  formatShareText,
  loadQuizHistory,
  runQuizCli,
  sampleQuizScenarios,
  summarizeQuizHistory,
} from "../cli/quiz.js";

describe("quiz CLI", () => {
  let tmpDir: string;
  let stdout = "";
  let stderr = "";
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalStdoutIsTTY: PropertyDescriptor | undefined;
  let originalStdinIsTTY: PropertyDescriptor | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-quiz-"));
    mkdirSync(join(tmpDir, "eval", "decision-replay", "scenarios"), {
      recursive: true,
    });
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      ["# Memory", "", "- [codex] Build core differentiators in-house, buy commodity"].join(
        "\n"
      )
    );
    writeFileSync(
      join(tmpDir, "eval", "decision-replay", "scenarios", "builtin.yaml"),
      JSON.stringify(
        Array.from({ length: 6 }, (_, index) => ({
          id: `scenario-${index + 1}`,
          category: index % 2 === 0 ? "architecture" : "communication",
          situation:
            "This is a long enough scenario description that clearly exceeds fifty characters and still maps to a single expected answer for the quiz harness.",
          options: ["Choose A", "Choose B"],
          expected_decision: "Choose A",
          rationale: "The quiz mock always answers Choose A.",
          relevant_directives: [],
          difficulty: "easy",
        }))
      )
    );

    stdout = "";
    stderr = "";
    spawnSyncMock.mockClear();
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      stdout += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;

    originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalStdoutIsTTY) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
    }
    if (originalStdinIsTTY) {
      Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("samples five unique scenarios without repeats", () => {
    const sampled = sampleQuizScenarios(tmpDir, 5, "random");
    expect(sampled).toHaveLength(5);
    expect(new Set(sampled.map((scenario) => scenario.id)).size).toBe(5);
  });

  it("tracks quiz history and formats summary text", () => {
    appendQuizHistory(tmpDir, {
      ts: "2026-04-14T10:00:00.000Z",
      total: 5,
      correct: 3,
      score: 60,
      scenarios: ["one", "two", "three", "four", "five"],
    });
    appendQuizHistory(tmpDir, {
      ts: "2026-04-14T11:00:00.000Z",
      total: 5,
      correct: 4,
      score: 80,
      scenarios: ["six", "seven", "eight", "nine", "ten"],
    });

    const history = loadQuizHistory(tmpDir);
    const summary = summarizeQuizHistory(tmpDir);
    expect(history).toHaveLength(2);
    expect(summary).toEqual({
      runs: 2,
      averageScore: 70,
      trend: "↑",
    });
    expect(formatQuizHistorySummary(summary)).toBe("quiz_history: 2 runs, avg 70%, trend ↑");
  });

  it("runs non-interactively, records history, and prints share text", async () => {
    const code = await runQuizCli(["node", "quiz", "--share"], tmpDir);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("🧠 Brain Quiz");
    expect(stdout).toContain("Result: 5/5 (100%) Decision Match 🧠");
    expect(stdout).toContain("My AI scored 100% on Decision Match 🧠");
    expect(stdout).toContain("Copied to clipboard!");
    expect(existsSync(join(tmpDir, ".squeeze", "quiz-history.jsonl"))).toBe(true);

    const lines = readFileSync(join(tmpDir, ".squeeze", "quiz-history.jsonl"), "utf8")
      .trim()
      .split("\n");
    const saved = JSON.parse(lines[0]) as { total: number; correct: number; scenarios: string[] };
    expect(saved.total).toBe(5);
    expect(saved.correct).toBe(5);
    expect(new Set(saved.scenarios).size).toBe(5);
  });

  it("formats the share block from a quiz result", () => {
    const text = formatShareText({
      total: 5,
      correct: 4,
      score: 80,
      results: [],
    });
    expect(text).toContain("My AI scored 80% on Decision Match 🧠");
    expect(text).toContain("4/5 decisions matched my judgment.");
  });
});
