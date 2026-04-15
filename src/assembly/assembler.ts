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
  DagNode,
  OutcomeRecord,
  ProcedureRecord,
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
  dagNodes: DagNode[];
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

  // 4. History summaries from dag_nodes (oldest first) — BEFORE fresh tail
  //    Uses historySummaries budget slice to leave room for fresh tail.
  let summaryCount = 0;
  let summaryTokensUsed = 0;
  for (const node of input.dagNodes) {
    const turnRange =
      node.minTurn !== null && node.maxTurn !== null
        ? `${node.minTurn}-${node.maxTurn}`
        : "unknown";
    const summaryText = `[Summary turns ${turnRange}]: ${node.abstract}`;
    const summaryTokens = estimateTokens(summaryText);
    if (summaryTokensUsed + summaryTokens > input.budget.historySummaries) break;
    messages.push({ role: "system", content: summaryText });
    tokenCount += summaryTokens;
    summaryTokensUsed += summaryTokens;
    summaryCount++;
  }

  // 5. Fresh tail (was step 4)
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
      summaryCount,
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

// ── Sub-agent personal context ─────────────────────────────────

/**
 * Build a `<personal-context>` block for sub-agent spawning.
 * Contains directives (rules), an optional matched procedure, and cautions
 * from the outcome loop. Token-capped with a graceful degradation strategy.
 */
export function formatPersonalContext(
  directives: DirectiveRecord[],
  procedure: ProcedureRecord | null,
  cautions: OutcomeRecord[],
  maxTokens = 2000
): string {
  const sections: string[] = [];

  // ## Your Rules — always included (never truncated)
  if (directives.length > 0) {
    const lines = directives.map((d) => `- ${d.value}`);
    sections.push(`## Your Rules\n${lines.join("\n")}`);
  }

  // ## Procedure — full version first
  let procedureSection = formatProcedureSection(procedure, false);
  if (procedureSection) sections.push(procedureSection);

  // ## Cautions
  let cautionRecords = cautions;
  let cautionsSection = formatCautionsSection(cautionRecords);
  if (cautionsSection) sections.push(cautionsSection);

  let body = sections.join("\n\n");
  let result = `<personal-context>\n${body}\n</personal-context>`;

  // Token cap: first reduce cautions to 1
  if (estimateTokens(result) > maxTokens && cautionRecords.length > 1) {
    cautionRecords = cautionRecords.slice(0, 1);
    result = rebuildPersonalContext(directives, procedure, cautionRecords, false);
  }

  // Token cap: then reduce procedure to title+pitfalls only
  if (estimateTokens(result) > maxTokens && procedure) {
    result = rebuildPersonalContext(directives, procedure, cautionRecords, true);
  }

  return result;
}

function rebuildPersonalContext(
  directives: DirectiveRecord[],
  procedure: ProcedureRecord | null,
  cautions: OutcomeRecord[],
  procedureTitleOnly: boolean
): string {
  const sections: string[] = [];

  if (directives.length > 0) {
    const lines = directives.map((d) => `- ${d.value}`);
    sections.push(`## Your Rules\n${lines.join("\n")}`);
  }

  const procSection = formatProcedureSection(procedure, procedureTitleOnly);
  if (procSection) sections.push(procSection);

  const cautionSection = formatCautionsSection(cautions);
  if (cautionSection) sections.push(cautionSection);

  const body = sections.join("\n\n");
  return `<personal-context>\n${body}\n</personal-context>`;
}

function formatProcedureSection(
  procedure: ProcedureRecord | null,
  titleOnly: boolean
): string | null {
  if (!procedure) return null;
  const lines: string[] = [`## Procedure: ${procedure.title}`];
  if (!titleOnly) {
    for (const step of procedure.steps) {
      lines.push(`${step.order}. ${step.action}`);
    }
  }
  for (const pitfall of procedure.pitfalls) {
    lines.push(`⚠️ Pitfall: ${pitfall}`);
  }
  return lines.join("\n");
}

function formatCautionsSection(cautions: OutcomeRecord[]): string | null {
  if (cautions.length === 0) return null;
  const lines = cautions.map(
    (c) => `- ⚠️ ${c.lesson} (${c.timestamp.slice(0, 10)})`
  );
  return `## Cautions\n${lines.join("\n")}`;
}
