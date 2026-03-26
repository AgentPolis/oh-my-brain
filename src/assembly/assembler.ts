/**
 * Priority-ordered context assembler.
 * Builds the final context array within token budget.
 */

import type {
  Message,
  AssembledContext,
  StoredMessage,
  DirectiveRecord,
  PreferenceRecord,
  TaskType,
  SqueezeConfig,
} from "../types.js";
import type { BudgetAllocation } from "./budget.js";
import { estimateTokens } from "./budget.js";

export interface AssemblerInput {
  systemPrompt: Message[];
  directives: DirectiveRecord[];
  preferences: PreferenceRecord[];
  freshTail: StoredMessage[];
  taskType: TaskType;
  budget: BudgetAllocation;
  config: SqueezeConfig;
  degraded: boolean;
  degradedReason?: string;
}

/**
 * Assemble context in priority order:
 * 1. System prompt + tool schemas
 * 2. L3 Directives (injected as structured block)
 * 3. L2 Preferences (filtered by confidence threshold)
 * 4. Fresh tail (last N messages)
 * 5. (Future: tool results, prefetch, history summaries)
 */
export function assemble(input: AssemblerInput): AssembledContext {
  const messages: Message[] = [];
  let tokenCount = 0;

  // 1. System prompt (always included)
  for (const msg of input.systemPrompt) {
    messages.push(msg);
    tokenCount += estimateTokens(msg.content);
  }

  // 2. L3 Directives — injected as a structured system block
  if (input.directives.length > 0) {
    const directiveBlock = formatDirectives(input.directives);
    const directiveTokens = estimateTokens(directiveBlock);

    if (tokenCount + directiveTokens <= input.budget.systemPrompt + input.budget.memory) {
      messages.push({ role: "system", content: directiveBlock });
      tokenCount += directiveTokens;
    }
  }

  // 3. L2 Preferences — only above confidence threshold
  const eligiblePrefs = input.preferences.filter(
    (p) => p.confidence >= input.config.preferenceConfidenceThreshold
  );
  if (eligiblePrefs.length > 0) {
    const prefBlock = formatPreferences(eligiblePrefs);
    const prefTokens = estimateTokens(prefBlock);
    const memoryBudgetRemaining = input.budget.memory - (tokenCount - input.budget.systemPrompt);

    if (prefTokens <= memoryBudgetRemaining) {
      messages.push({ role: "system", content: prefBlock });
      tokenCount += prefTokens;
    }
  }

  // 4. Fresh tail
  const tailBudget = input.budget.total - tokenCount;
  for (const msg of input.freshTail) {
    const msgTokens = estimateTokens(msg.content);
    if (tokenCount + msgTokens > input.budget.total) break;
    messages.push({ role: msg.role, content: msg.content });
    tokenCount += msgTokens;
  }

  return {
    messages,
    tokenCount,
    metadata: {
      taskType: input.taskType,
      directiveCount: input.directives.length,
      preferenceCount: eligiblePrefs.length,
      freshTailCount: input.freshTail.length,
      summaryCount: 0,   // TODO: DAG summaries
      prefetchCount: 0,   // TODO: prefetch
      memoryPercent: input.budget.total > 0
        ? Math.round(((tokenCount - input.budget.systemPrompt) / input.budget.total) * 100)
        : 0,
      degraded: input.degraded,
      degradedReason: input.degradedReason,
    },
  };
}

// ── Formatting helpers ───────────────────────────────────────────

function formatDirectives(directives: DirectiveRecord[]): string {
  const lines = directives.map(
    (d) => `- [${d.key}]: ${d.value}`
  );
  return `<squeeze-directives>\n${lines.join("\n")}\n</squeeze-directives>`;
}

function formatPreferences(preferences: PreferenceRecord[]): string {
  const lines = preferences.map(
    (p) => `- [${p.key}] (confidence: ${p.confidence.toFixed(1)}): ${p.value}`
  );
  return `<squeeze-preferences>\n${lines.join("\n")}\n</squeeze-preferences>`;
}
