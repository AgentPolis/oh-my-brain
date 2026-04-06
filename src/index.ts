/**
 * oh-my-brain — importance-aware memory layer for AI agents.
 *
 * The second brain that follows you across every agent. Classifies every
 * message by importance (L0 discard, L1 observation, L2 preference, L3
 * directive), compresses noise, protects your rules from ever being
 * forgotten, and surfaces soft signals (corrections, preferences) into a
 * human-review queue. Formerly published as `squeeze-claw`.
 *
 * Current adapters: Claude Code sessions, Codex sessions, OpenClaw-style
 * runtimes, MCP-native server for Cursor/Windsurf/any MCP-compatible tool.
 *
 * Licensed under Apache-2.0.
 */

export {
  SqueezeContextEngine,
  BrainEngine,
  ohMyBrainFactory,
  squeezeClawFactory,
} from "./engine.js";
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
  TokenCounter,
} from "./types.js";
export { DEFAULT_CONFIG } from "./types.js";
export { classify, classifyBatch } from "./triage/classifier.js";
export { isL0Noise } from "./triage/patterns.js";
export { setTokenCounter, heuristicTokenCount } from "./assembly/budget.js";
