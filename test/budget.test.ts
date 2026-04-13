import { describe, it, expect } from "vitest";
import { allocateBudget, heuristicTokenCount, estimateTokens } from "../src/assembly/budget.js";
import { DEFAULT_CONFIG, DEFAULT_TASK_WEIGHTS } from "../src/types.js";
import type { SqueezeConfig, TaskWeights } from "../src/types.js";

describe("allocateBudget", () => {
  const weights: TaskWeights = DEFAULT_TASK_WEIGHTS.coding;

  it("caps memory at memoryInjectionCapPercent (15% default)", () => {
    const budget = allocateBudget(10_000, 1_000, weights, DEFAULT_CONFIG);

    // remaining = 10_000 - 1_000 = 9_000
    // memoryCap = floor(9_000 * 0.15) = 1_350
    expect(budget.memory).toBe(Math.floor(9_000 * (DEFAULT_CONFIG.memoryInjectionCapPercent / 100)));
    expect(budget.memory).toBe(1_350);
  });

  it("returns custom memory cap when memoryInjectionCapPercent is changed", () => {
    const config: SqueezeConfig = { ...DEFAULT_CONFIG, memoryInjectionCapPercent: 25 };
    const budget = allocateBudget(10_000, 1_000, weights, config);

    // remaining = 9_000, cap = floor(9_000 * 0.25) = 2_250
    expect(budget.memory).toBe(2_250);
  });

  it("returns all-zero allocation (except systemPrompt) when 0 remaining", () => {
    // system prompt eats the entire budget
    const budget = allocateBudget(5_000, 5_000, weights, DEFAULT_CONFIG);

    expect(budget.memory).toBe(0);
    expect(budget.freshTail).toBe(0);
    expect(budget.toolResults).toBe(0);
    expect(budget.prefetch).toBe(0);
    expect(budget.historySummaries).toBe(0);
    expect(budget.systemPrompt).toBe(5_000);
    expect(budget.total).toBe(5_000);
  });

  it("returns all-zero allocation when system prompt exceeds total", () => {
    const budget = allocateBudget(3_000, 4_000, weights, DEFAULT_CONFIG);

    expect(budget.memory).toBe(0);
    expect(budget.freshTail).toBe(0);
    expect(budget.toolResults).toBe(0);
    expect(budget.systemPrompt).toBe(3_000);
    expect(budget.total).toBe(3_000);
  });

  it("task weights affect toolResults vs historySummaries distribution", () => {
    const codingBudget = allocateBudget(20_000, 2_000, DEFAULT_TASK_WEIGHTS.coding, DEFAULT_CONFIG);
    const chatBudget = allocateBudget(20_000, 2_000, DEFAULT_TASK_WEIGHTS.chat, DEFAULT_CONFIG);

    // coding: toolResults weight 0.55 > chat: toolResults weight 0.10
    expect(codingBudget.toolResults).toBeGreaterThan(chatBudget.toolResults);
    // chat: history weight 0.50 > coding: history weight 0.20
    expect(chatBudget.historySummaries).toBeGreaterThan(codingBudget.historySummaries);
  });

  it("debug task allocates the most to toolResults", () => {
    const debugBudget = allocateBudget(20_000, 2_000, DEFAULT_TASK_WEIGHTS.debug, DEFAULT_CONFIG);
    const planBudget = allocateBudget(20_000, 2_000, DEFAULT_TASK_WEIGHTS.planning, DEFAULT_CONFIG);

    expect(debugBudget.toolResults).toBeGreaterThan(planBudget.toolResults);
  });

  it("total field always equals the input totalBudget", () => {
    const budget = allocateBudget(12_000, 1_500, weights, DEFAULT_CONFIG);
    expect(budget.total).toBe(12_000);
  });
});

describe("heuristicTokenCount", () => {
  it("estimates English text at ~4 chars per token", () => {
    const text = "Hello, this is a test sentence for token counting purposes.";
    const tokens = heuristicTokenCount(text);
    // 59 chars / 4 = 14.75 → ceil = 15
    expect(tokens).toBe(Math.ceil(text.length / 4));
  });

  it("estimates CJK text at ~1.5 tokens per character", () => {
    const text = "これはテストです"; // 8 CJK characters
    const tokens = heuristicTokenCount(text);
    // 8 CJK chars * 1.5 = 12
    expect(tokens).toBe(Math.ceil(8 * 1.5));
  });

  it("handles mixed English and CJK text", () => {
    const text = "Hello世界Test"; // 9 non-CJK chars + 2 CJK chars
    const tokens = heuristicTokenCount(text);
    const nonCjk = text.length - 2; // 9
    const expected = Math.ceil(nonCjk / 4 + 2 * 1.5);
    expect(tokens).toBe(expected);
  });

  it("returns 0 for empty string", () => {
    expect(heuristicTokenCount("")).toBe(0);
  });
});

describe("estimateTokens", () => {
  it("uses heuristic counter by default", () => {
    const text = "A short sentence.";
    // Default counter is heuristicTokenCount
    expect(estimateTokens(text)).toBe(heuristicTokenCount(text));
  });
});
