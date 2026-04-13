import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDecisionPrompt,
  loadDecisionScenarios,
  matchesExpectedDecision,
} from "../cli/eval.js";

describe("Decision Replay eval", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-eval-"));
    mkdirSync(join(tmpDir, "eval", "decision-replay", "scenarios", "custom"), {
      recursive: true,
    });
    writeFileSync(
      join(tmpDir, "eval", "decision-replay", "scenarios", "builtin.yaml"),
      JSON.stringify([
        {
          id: "custom-built",
          category: "architecture",
          situation: "Choose the architecture.",
          options: ["Monolith", "Split packages"],
          expected_decision: "Monolith",
          rationale: "Keep it simple.",
          relevant_directives: ["Keep everything in one package until team > 3 people"],
          difficulty: "easy",
        },
      ])
    );
    writeFileSync(
      join(tmpDir, "eval", "decision-replay", "scenarios", "custom", "extra.yaml"),
      JSON.stringify([
        {
          id: "ops-check",
          category: "operations",
          situation: "Choose the ops path.",
          options: ["Centralized", "Distributed"],
          expected_decision: "Centralized",
          rationale: "Stay consistent.",
          relevant_directives: ["Governance rules must be centralized, not per-agent"],
          difficulty: "medium",
        },
      ])
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads built-in and custom scenarios", () => {
    const scenarios = loadDecisionScenarios(tmpDir);
    expect(scenarios).toHaveLength(2);
    expect(scenarios.map((scenario) => scenario.category)).toEqual(
      expect.arrayContaining(["architecture", "operations"])
    );
  });

  it("builds prompts with directives, situation, and options", () => {
    const prompt = buildDecisionPrompt(
      ["Keep everything in one package until team > 3 people"],
      {
        id: "monolith",
        category: "architecture",
        situation: "The codebase is growing.",
        options: ["Split packages", "Keep a monolith"],
        expected_decision: "Keep a monolith",
        rationale: "Smaller team.",
        relevant_directives: ["Keep everything in one package until team > 3 people"],
        difficulty: "medium",
      }
    );

    expect(prompt).toContain("You have these rules:");
    expect(prompt).toContain("The codebase is growing.");
    expect(prompt).toContain("Keep a monolith");
  });

  it("matches expected decisions case-insensitively", () => {
    expect(matchesExpectedDecision("I would choose build in-house.", "Build in-house")).toBe(
      true
    );
    expect(matchesExpectedDecision("Use Mem0 instead.", "Build in-house")).toBe(false);
  });
});
