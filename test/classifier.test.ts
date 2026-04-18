import { describe, it, expect } from "vitest";
import { classify } from "../src/triage/classifier.js";
import { isL0Noise } from "../src/triage/patterns.js";
import { Level } from "../src/types.js";

describe("L0 regex classifier", () => {
  const L0_SAMPLES = [
    "ok",
    "OK",
    "Ok.",
    "okay",
    "got it",
    "thanks",
    "thank you",
    "thx",
    "sure",
    "nice",
    "great",
    "perfect",
    "done",
    "noted",
    "yep",
    "nope",
    "cool",
    "alright",
    "👍",
    "✅",
    "",
    "   ",
    "no output",
    "no results",
    "empty",
    "none",
    "N/A",
    "(Bash completed with no output)",
    "File created successfully at /foo/bar.ts",
    "The file /foo/bar.ts has been updated successfully",
    "checking...",
    "loading...",
    "please wait",
  ];

  for (const sample of L0_SAMPLES) {
    it(`should classify "${sample}" as L0 noise`, () => {
      expect(isL0Noise(sample)).toBe(true);
    });
  }

  const NOT_L0_SAMPLES = [
    "Can you help me debug this function?",
    "The error is on line 42",
    "import { useState } from 'react'",
    "Always use TDD for testing",
    "BTC is at $59,800",
    "Here's the implementation plan:",
    "I prefer using TypeScript over JavaScript",
    "Error: Cannot find module 'foo'",
    "Let me explain the architecture",
  ];

  for (const sample of NOT_L0_SAMPLES) {
    it(`should NOT classify "${sample}" as L0 noise`, () => {
      expect(isL0Noise(sample)).toBe(false);
    });
  }
});

describe("classify()", () => {
  const opts = { confidenceThreshold: 0.7, mode: "hybrid" as const };

  it("classifies L0 noise", () => {
    const result = classify({ role: "user", content: "ok" }, opts);
    expect(result.level).toBe(Level.Discard);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("classifies directive patterns as L3", () => {
    const result = classify(
      { role: "user", content: "Always use TDD when writing tests" },
      opts
    );
    expect(result.level).toBe(Level.Directive);
  });

  it('classifies "never" as L3', () => {
    const result = classify(
      { role: "user", content: "Never push directly to main" },
      opts
    );
    expect(result.level).toBe(Level.Directive);
  });

  it('classifies "from now on" as L3', () => {
    const result = classify(
      { role: "user", content: "From now on, use snake_case for variables" },
      opts
    );
    expect(result.level).toBe(Level.Directive);
  });

  it('classifies "remember that" as L3', () => {
    const result = classify(
      { role: "user", content: "Remember that I prefer vim keybindings" },
      opts
    );
    expect(result.level).toBe(Level.Directive);
  });

  it("classifies identity statements as L3", () => {
    const result = classify(
      { role: "user", content: "I am a senior backend engineer" },
      opts
    );
    expect(result.level).toBe(Level.Directive);
  });

  it("classifies regular messages as L1", () => {
    const result = classify(
      { role: "user", content: "Can you help me debug this function?" },
      opts
    );
    expect(result.level).toBe(Level.Observation);
  });

  it("detects code content type", () => {
    const result = classify(
      {
        role: "assistant",
        content: '```typescript\nfunction foo() { return 42; }\n```',
      },
      opts
    );
    expect(result.contentType).toBe("code");
  });

  it("detects tool_result for tool messages", () => {
    const result = classify(
      { role: "tool", content: "Found 5 matching files" },
      opts
    );
    expect(result.contentType).toBe("tool_result");
  });
});

describe("context-aware L0 classification", () => {
  it('"yes" after a question is NOT noise', () => {
    expect(isL0Noise("yes", "Should we delete the database?")).toBe(false);
  });

  it('"ok" after a question is NOT noise', () => {
    expect(isL0Noise("ok", "Do you want me to proceed?")).toBe(false);
  });

  it('"sure" after a confirmation prompt is NOT noise', () => {
    expect(isL0Noise("sure", "Shall I deploy to production?")).toBe(false);
  });

  it('"no" after a question is NOT noise', () => {
    expect(isL0Noise("no", "Would you like to enable caching?")).toBe(false);
  });

  it('"yes" after a choice prompt is NOT noise', () => {
    expect(isL0Noise("yes", "Option A or option B? Which do you prefer?")).toBe(false);
  });

  it('"ok" after a non-question is still noise', () => {
    expect(isL0Noise("ok", "I've updated the file.")).toBe(true);
  });

  it('"thanks" after a non-question is still noise', () => {
    expect(isL0Noise("thanks", "Here is the implementation.")).toBe(true);
  });

  it('"ok" with no previous context is noise', () => {
    expect(isL0Noise("ok")).toBe(true);
  });

  it("empty result patterns are always noise regardless of context", () => {
    expect(isL0Noise("(Bash completed with no output)", "Should we proceed?")).toBe(true);
  });

  const opts = { confidenceThreshold: 0.7, mode: "hybrid" as const };

  it('classify() preserves "yes" when previous was a question', () => {
    const result = classify(
      { role: "user", content: "yes" },
      opts,
      "Should we use TDD for this project?"
    );
    expect(result.level).not.toBe(Level.Discard);
  });

  it('classify() discards "yes" when previous was not a question', () => {
    const result = classify(
      { role: "user", content: "yes" },
      opts,
      "I've finished the implementation."
    );
    expect(result.level).toBe(Level.Discard);
  });
});

describe("L2 preference detection", () => {
  const opts = { confidenceThreshold: 0.7, mode: "hybrid" as const };

  const PREFERENCE_SAMPLES = [
    "I prefer tabs over spaces",
    "I'd prefer to use TypeScript strict mode",
    "I like the single-file approach better",
    "I'd like the tests in a separate directory",
    "I find this pattern cleaner than the previous one",
    "that makes more sense to me",
    "the new layout is easier to read",
    "I prefer using TypeScript",
    "I prefer putting the tests in a separate directory",
    "I like this layout better",
    "This workflow feels more natural to me",
    "This approach is more intuitive",
  ];

  for (const sample of PREFERENCE_SAMPLES) {
    it(`classifies as L2 Preference: "${sample}"`, () => {
      const result = classify({ role: "user", content: sample }, opts);
      expect(result.level).toBe(Level.Preference);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });
  }

  it("L3 directive takes precedence over L2 preference when both patterns match", () => {
    // "always I prefer tabs" — both "always" (L3) and "I prefer" (L2) match.
    // L3 should win because it is checked first.
    const result = classify(
      { role: "user", content: "always I prefer tabs" },
      opts
    );
    expect(result.level).toBe(Level.Directive);
  });

  it("plain observations are still L1, not L2", () => {
    const result = classify(
      { role: "user", content: "the build finished with no errors" },
      opts
    );
    expect(result.level).toBe(Level.Observation);
  });
});
