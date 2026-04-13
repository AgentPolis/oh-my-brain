import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDecisionPrompt,
  loadDecisionScenarios,
  loadDecisionSchema,
  loadDirectiveContextFromMemory,
  matchesExpectedDecision,
  validateScenarioCollection,
} from "../cli/eval.js";
import {
  OhMyBrainAdapter,
  RawContextAdapter,
} from "../eval/decision-replay/adapter.js";

describe("Decision Replay eval", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-eval-"));
    mkdirSync(join(tmpDir, "eval", "decision-replay", "scenarios", "custom"), {
      recursive: true,
    });
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      [
        "# Memory",
        "",
        "- [codex] Keep everything in one package until team > 3 people",
        "- [codex] Governance rules must be centralized, not per-agent",
      ].join("\n")
    );
    writeFileSync(
      join(tmpDir, "eval", "decision-replay", "scenarios", "builtin.yaml"),
      JSON.stringify([
        {
          id: "custom-built",
          category: "architecture",
          situation:
            "The codebase is small, boundaries are still moving weekly, and three engineers are sharing context across all modules.",
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
          situation:
            "A governance model is needed for several agents and the team wants one place to update rules without drift.",
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

  it("loads the benchmark schema with communication category", () => {
    const schema = loadDecisionSchema(process.cwd());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(
      (
        (schema.properties as { category: { enum: string[] } }).category.enum
      )
    ).toContain("communication");
  });

  it("ships 20+ built-in scenarios across all categories", () => {
    const scenarios = loadDecisionScenarios(process.cwd());
    const counts = new Map<string, number>();
    for (const scenario of scenarios) {
      counts.set(scenario.category, (counts.get(scenario.category) ?? 0) + 1);
    }

    expect(scenarios.length).toBeGreaterThanOrEqual(20);
    expect(counts.get("architecture")).toBeGreaterThanOrEqual(3);
    expect(counts.get("security")).toBeGreaterThanOrEqual(3);
    expect(counts.get("scope")).toBeGreaterThanOrEqual(3);
    expect(counts.get("tradeoff")).toBeGreaterThanOrEqual(3);
    expect(counts.get("operations")).toBeGreaterThanOrEqual(3);
    expect(counts.get("communication")).toBeGreaterThanOrEqual(3);
  });

  it("validates scenario collections against the local schema rules", () => {
    const valid = validateScenarioCollection([
      {
        id: "valid-scenario",
        category: "communication",
        situation:
          "A mixed-language team is deciding which shared documentation language will maximize long-term maintenance clarity.",
        options: ["Chinese", "English"],
        expected_decision: "English",
        rationale: "Shared docs should optimize for broad readability.",
        relevant_directives: [],
        difficulty: "medium",
      },
    ]);
    const invalid = validateScenarioCollection([
      {
        id: "",
        category: "invalid",
        situation: "too short",
        options: ["one"],
        expected_decision: "",
        rationale: "",
        relevant_directives: [3],
        difficulty: "extreme",
      },
    ]);

    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThan(0);
  });

  it("loads directive context through the built-in adapter", async () => {
    const adapter = new OhMyBrainAdapter(tmpDir);
    const context = await adapter.loadContext();
    expect(context).toContain("- Keep everything in one package until team > 3 people");
    expect(context).toContain("- Governance rules must be centralized, not per-agent");
  });

  it("raw context adapter returns the full memory file", async () => {
    const adapter = new RawContextAdapter(tmpDir);
    const context = await adapter.loadContext();
    expect(context).toContain("# Memory");
    expect(context).toContain("Governance rules must be centralized, not per-agent");
  });

  it("builds prompts with directives, situation, and options", () => {
    const prompt = buildDecisionPrompt(
      ["Keep everything in one package until team > 3 people"],
      {
        id: "monolith",
        category: "architecture",
        situation:
          "The codebase is growing, the team is still small, and package boundaries are likely to change over the next month.",
        options: ["Split packages", "Keep a monolith"],
        expected_decision: "Keep a monolith",
        rationale: "Smaller team.",
        relevant_directives: ["Keep everything in one package until team > 3 people"],
        difficulty: "medium",
      }
    );

    expect(prompt).toContain("You have these rules:");
    expect(prompt).toContain("The codebase is growing");
    expect(prompt).toContain("Keep a monolith");
  });

  it("matches expected decisions case-insensitively", () => {
    expect(matchesExpectedDecision("I would choose build in-house.", "Build in-house")).toBe(
      true
    );
    expect(matchesExpectedDecision("Use Mem0 instead.", "Build in-house")).toBe(false);
  });

  it("loads directive context from memory bullets only", () => {
    const context = loadDirectiveContextFromMemory(tmpDir);
    expect(context.split("\n")).toHaveLength(2);
    expect(context).not.toContain("# Memory");
  });
});
