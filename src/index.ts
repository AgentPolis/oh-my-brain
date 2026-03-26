/**
 * squeeze-claw — Stop Paying for Context Tokens That Don't Matter
 *
 * Semantic-aware context compression for OpenClaw.
 * AGPL-3.0 + Non-Commercial restriction.
 */

export { SqueezeContextEngine, squeezeClawFactory } from "./engine.js";
export { Level } from "./types.js";
export type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineFactory,
  Message,
  TokenBudget,
  Turn,
  SubagentResult,
  AssembledContext,
  SqueezeConfig,
  Classification,
  ContentType,
  TaskType,
  StoredMessage,
  DirectiveRecord,
  PreferenceRecord,
  DagNode,
} from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
export { classify, classifyBatch } from "./triage/classifier.js";
export { isL0Noise } from "./triage/patterns.js";
