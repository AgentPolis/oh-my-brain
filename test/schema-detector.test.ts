import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Habit } from "../cli/habit-detector.js";
import {
  SchemaStore,
  detectSchemas,
  inferCategory,
  type CognitiveSchema,
} from "../cli/schema-detector.js";

describe("SchemaStore", () => {
  let tmpDir: string;
  let store: SchemaStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-schemas-"));
    store = new SchemaStore(join(tmpDir, ".squeeze"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts schemas by category", () => {
    const schema: CognitiveSchema = {
      id: "s1",
      name: "Code Review Framework",
      description: "How you review code",
      steps: ["always check error handling", "always verify test coverage"],
      evidence: {
        habits: ["h1", "h2"],
        directives: ["well-tested code is non-negotiable"],
        events: ["e1", "e2"],
      },
      confidence: 0.75,
      category: "code-review",
      first_detected: "2026-04-14T00:00:00.000Z",
      last_updated: "2026-04-14T00:00:00.000Z",
    };
    store.upsert(schema);
    store.upsert({ ...schema, id: "s2", confidence: 0.9, steps: [...schema.steps, "always review naming"] });

    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].confidence).toBe(0.9);
    expect(all[0].steps).toContain("always review naming");
  });

  it("queries by category and renders compact string", () => {
    store.upsert({
      id: "s1",
      name: "Code Review Framework",
      description: "How you review code",
      steps: ["always check error handling", "always verify test coverage"],
      evidence: {
        habits: ["h1", "h2"],
        directives: ["well-tested code is non-negotiable"],
        events: ["e1", "e2"],
      },
      confidence: 0.85,
      category: "code-review",
      first_detected: "2026-04-14T00:00:00.000Z",
      last_updated: "2026-04-14T00:00:00.000Z",
    });

    expect(store.getByCategory("code-review")).toHaveLength(1);
    const compact = store.toCompactString();
    expect(compact).toContain("Your decision frameworks:");
    expect(compact).toContain("Code Review: always check error handling → always verify test coverage");
  });

  it("returns summary stats", () => {
    store.upsert({
      id: "s1",
      name: "Code Review Framework",
      description: "How you review code",
      steps: ["always check error handling", "always verify test coverage"],
      evidence: {
        habits: ["h1", "h2"],
        directives: ["well-tested code is non-negotiable"],
        events: ["e1", "e2"],
      },
      confidence: 0.85,
      category: "code-review",
      first_detected: "2026-04-14T00:00:00.000Z",
      last_updated: "2026-04-14T00:00:00.000Z",
    });
    expect(store.getSummary()).toEqual({ total: 1, categories: ["code-review"] });
  });

  it("persists schemas to schemas.json", () => {
    store.upsert({
      id: "s1",
      name: "Code Review Framework",
      description: "How you review code",
      steps: ["always check error handling", "always verify test coverage"],
      evidence: {
        habits: ["h1", "h2"],
        directives: ["well-tested code is non-negotiable"],
        events: ["e1", "e2"],
      },
      confidence: 0.85,
      category: "code-review",
      first_detected: "2026-04-14T00:00:00.000Z",
      last_updated: "2026-04-14T00:00:00.000Z",
    });

    const reloaded = new SchemaStore(join(tmpDir, ".squeeze"));
    expect(reloaded.getAll()).toHaveLength(1);
  });
});

describe("detectSchemas", () => {
  function makeHabit(
    id: string,
    pattern: string,
    confidence: number,
    evidence: string[] = [`${id}-e1`, `${id}-e2`]
  ): Habit {
    return {
      id,
      pattern,
      confidence,
      evidence,
      first_seen: "2026-04-01T00:00:00.000Z",
      occurrences: 4,
    };
  }

  it("detects a schema from 2+ habits in the same category plus a directive", () => {
    const schemas = detectSchemas(
      [
        makeHabit("h1", "always check error handling in reviews", 0.9),
        makeHabit("h2", "always verify test coverage in reviews", 0.8),
        makeHabit("h3", "always review naming during code review", 0.7),
      ],
      ["Well-tested code is non-negotiable during review."],
      []
    );

    expect(schemas).toHaveLength(1);
    expect(schemas[0].category).toBe("code-review");
    expect(schemas[0].evidence.directives).toHaveLength(1);
  });

  it("orders schema steps by habit confidence", () => {
    const [schema] = detectSchemas(
      [
        makeHabit("h1", "always verify test coverage in reviews", 0.7),
        makeHabit("h2", "always check error handling in reviews", 0.95),
      ],
      ["Review quality is non-negotiable."],
      []
    );

    expect(schema.steps).toEqual([
      "always check error handling in reviews",
      "always verify test coverage in reviews",
    ]);
  });

  it("requires a matching directive", () => {
    const schemas = detectSchemas(
      [
        makeHabit("h1", "always check error handling in reviews", 0.9),
        makeHabit("h2", "always verify test coverage in reviews", 0.8),
      ],
      ["Prefer aisle seats when flying."],
      []
    );

    expect(schemas).toEqual([]);
  });

  it("filters out non-framework categories and preference-like habits", () => {
    const schemas = detectSchemas(
      [
        makeHabit("h1", "frequently flies United Airlines", 0.9),
        makeHabit("h2", "prefers aisle seats on flights", 0.8),
      ],
      ["Travel comfortably whenever possible."],
      []
    );

    expect(schemas).toEqual([]);
  });

  it("does not re-propose existing schema categories", () => {
    const schemas = detectSchemas(
      [
        makeHabit("h1", "always check team size before architecture decisions", 0.9),
        makeHabit("h2", "always compare monolith and split options", 0.8),
      ],
      ["Keep everything in one package until team > 3."],
      [
        {
          id: "s1",
          name: "Architecture Framework",
          description: "How you approach architecture decisions",
          steps: ["always check team size before architecture decisions"],
          evidence: { habits: ["h0"], directives: ["existing"], events: ["e0"] },
          confidence: 0.8,
          category: "architecture",
          first_detected: "2026-04-01T00:00:00.000Z",
          last_updated: "2026-04-01T00:00:00.000Z",
        },
      ]
    );

    expect(schemas).toEqual([]);
  });

  it("scales confidence with evidence count", () => {
    const [schema] = detectSchemas(
      [
        makeHabit("h1", "always check team size before architecture decisions", 0.9),
        makeHabit("h2", "always compare monolith and split options", 0.8),
        makeHabit("h3", "always ensure architecture fits current team size", 0.7),
      ],
      ["Keep everything in one package until team > 3."],
      []
    );

    expect(schema.confidence).toBeGreaterThan(0.7);
  });

  it("includes aggregated event evidence", () => {
    const [schema] = detectSchemas(
      [
        makeHabit("h1", "always check team size before architecture decisions", 0.9, ["e1", "e2"]),
        makeHabit("h2", "always compare monolith and split options", 0.8, ["e3", "e2"]),
      ],
      ["Keep everything in one package until team > 3."],
      []
    );

    expect(schema.evidence.events).toEqual(["e1", "e2", "e3"]);
  });

  it("infers categories conservatively", () => {
    expect(inferCategory("always review naming during code review")).toBe("code-review");
    expect(inferCategory("always check team size before architecture decisions")).toBe("architecture");
  });
});
