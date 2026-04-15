import { describe, expect, it } from "vitest";
import { buildGrowthOneLiner, detectChinese } from "../src/growth/one-liner.js";
import type { OutcomeRecord, SessionStats } from "../src/types.js";

function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    id: overrides.id ?? "out-1",
    result: "failure",
    failure_mode: overrides.failure_mode ?? "deploy rollback",
    context: overrides.context ?? "blue-green deploy failed",
    lesson: overrides.lesson ?? "Watch out for deploy failures",
    session_id: "sess-1",
    timestamp: "2026-04-15T10:00:00.000Z",
  };
}

describe("buildGrowthOneLiner", () => {
  it("produces string with both caution and procedure fragments", () => {
    const stats: SessionStats = {
      new_directives: 0,
      new_preferences: 0,
      new_outcomes: [makeOutcome()],
      new_procedures: 1,
    };
    const result = buildGrowthOneLiner(stats, false);
    expect(result).toContain("+1 caution");
    expect(result).toContain("+1 procedure candidate");
    expect(result).toContain("Learned:");
  });

  it("returns empty string when nothing learned", () => {
    const stats: SessionStats = {
      new_directives: 0,
      new_preferences: 0,
      new_outcomes: [],
      new_procedures: 0,
    };
    expect(buildGrowthOneLiner(stats, false)).toBe("");
  });

  it("shows count and summary for multiple outcomes", () => {
    const stats: SessionStats = {
      new_directives: 0,
      new_preferences: 0,
      new_outcomes: [
        makeOutcome({ id: "out-1", failure_mode: "deploy risk" }),
        makeOutcome({ id: "out-2", failure_mode: "test timeout" }),
        makeOutcome({ id: "out-3", failure_mode: "lock error" }),
      ],
      new_procedures: 0,
    };
    const result = buildGrowthOneLiner(stats, false);
    expect(result).toContain("+3 caution");
    expect(result).toContain("deploy risk");
  });

  it("produces Chinese output for Chinese sessions", () => {
    const stats: SessionStats = {
      new_directives: 1,
      new_preferences: 0,
      new_outcomes: [makeOutcome({ failure_mode: "部署失敗" })],
      new_procedures: 0,
    };
    const result = buildGrowthOneLiner(stats, true);
    expect(result).toContain("🧠 本次學到：");
    expect(result).toContain("caution（");
    expect(result).toContain("，");
  });

  it("produces English output for English sessions", () => {
    const stats: SessionStats = {
      new_directives: 1,
      new_preferences: 0,
      new_outcomes: [makeOutcome()],
      new_procedures: 0,
    };
    const result = buildGrowthOneLiner(stats, false);
    expect(result).toContain("🧠 Learned: ");
    expect(result).toContain(", ");
  });
});

describe("detectChinese", () => {
  it("returns true when >30% CJK characters", () => {
    const messages = [
      { role: "user", content: "請幫我部署到生產環境" },
      { role: "assistant", content: "Sure, deploying now" },
    ];
    expect(detectChinese(messages)).toBe(true);
  });

  it("returns false for English-only messages", () => {
    const messages = [
      { role: "user", content: "Please deploy to production" },
      { role: "assistant", content: "Deploying now" },
    ];
    expect(detectChinese(messages)).toBe(false);
  });

  it("returns false for empty messages", () => {
    expect(detectChinese([])).toBe(false);
  });
});
