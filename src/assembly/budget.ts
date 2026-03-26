/**
 * Token budget allocation with memory injection cap.
 */

import type { TaskWeights, SqueezeConfig } from "../types.js";

export interface BudgetAllocation {
  /** Tokens for system prompt + tool schemas (fixed) */
  systemPrompt: number;
  /** Tokens for L3 directives + L2 preferences (capped) */
  memory: number;
  /** Tokens for fresh tail messages */
  freshTail: number;
  /** Tokens for task-relevant tool results */
  toolResults: number;
  /** Tokens for prefetched summaries */
  prefetch: number;
  /** Tokens for remaining history summaries */
  historySummaries: number;
  /** Total budget */
  total: number;
}

/**
 * Allocate token budget across context sections.
 *
 * Priority order:
 * 1. System prompt (fixed cost, estimated)
 * 2. L3/L2 memory (capped at memoryInjectionCapPercent)
 * 3. Fresh tail
 * 4. Task-weighted allocation for remaining budget
 */
export function allocateBudget(
  totalBudget: number,
  systemPromptTokens: number,
  weights: TaskWeights,
  config: SqueezeConfig
): BudgetAllocation {
  const remaining = totalBudget - systemPromptTokens;
  if (remaining <= 0) {
    return {
      systemPrompt: totalBudget,
      memory: 0,
      freshTail: 0,
      toolResults: 0,
      prefetch: 0,
      historySummaries: 0,
      total: totalBudget,
    };
  }

  // Memory cap: directives + preferences
  const memoryCap = Math.floor(remaining * (config.memoryInjectionCapPercent / 100));

  // Fresh tail: estimate ~100 tokens per message
  const freshTailEstimate = Math.min(
    config.freshTailCount * 100,
    Math.floor(remaining * 0.3)
  );

  // Remaining after memory + fresh tail
  const afterFixed = remaining - memoryCap - freshTailEstimate;
  const distributable = Math.max(0, afterFixed);

  // Distribute by task weights
  const toolResults = Math.floor(distributable * weights.toolResults);
  const historySummaries = Math.floor(distributable * weights.history);
  const prefetch = distributable - toolResults - historySummaries;

  return {
    systemPrompt: systemPromptTokens,
    memory: memoryCap,
    freshTail: freshTailEstimate,
    toolResults,
    prefetch: Math.max(0, prefetch),
    historySummaries,
    total: totalBudget,
  };
}

/**
 * Rough token count estimate.
 * ~4 chars per token for English, ~1.5 tokens per CJK character.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const nonCjkLength = text.length - cjkCount;

  return Math.ceil(nonCjkLength / 4 + cjkCount * 1.5);
}
