/**
 * oh-my-brain type definitions (formerly squeeze-claw).
 *
 * The ContextEngine interface mirrors what OpenClaw exposes via
 * `openclaw/plugin-sdk/core`. If the upstream shapes change we only need
 * to update this file.
 */

// ── Importance Levels ────────────────────────────────────────────

export enum Level {
  /** L0 – Discard: noise, acks, empty results */
  Discard = 0,
  /** L1 – Observation: single-mention facts, casual content */
  Observation = 1,
  /** L2 – Preference: user-confirmed preferences, repeated decisions */
  Preference = 2,
  /** L3 – Directive: explicit instructions, never/always rules */
  Directive = 3,
}

// ── Content Types ────────────────────────────────────────────────

export type ContentType =
  | "code"
  | "tool_result"
  | "reasoning"
  | "instruction"
  | "reference"
  | "conversation";

// ── Classification Result ────────────────────────────────────────

export interface Classification {
  level: Level;
  contentType: ContentType;
  confidence: number; // 0.0 – 1.0
}

// ── Stored Message ───────────────────────────────────────────────

export interface StoredMessage {
  id: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  level: Level;
  contentType: ContentType;
  confidence: number;
  turnIndex: number;
  createdAt: string; // ISO-8601
}

// ── L2 Preference Record ────────────────────────────────────────

export interface PreferenceRecord {
  id: number;
  key: string;
  value: string;
  confidence: number;
  sourceMsgId: number;
  createdAt: string;
  eventTime: string;
  supersededBy: number | null;
  supersededAt: string | null;
}

// ── L3 Directive Record ─────────────────────────────────────────

export interface DirectiveRecord {
  id: number;
  key: string;
  value: string;
  sourceMsgId: number | null;
  createdAt: string;
  eventTime: string;
  confirmedByUser: boolean;
  evidenceText: string | null;
  evidenceTurn: number | null;
  lastReferencedAt: string | null;
  supersededBy: number | null;
  supersededAt: string | null;
  /** Domain this directive belongs to (e.g., "work", "life"). Undefined for flat MEMORY.md. */
  domain?: string;
}

// ── DAG Summary Node ─────────────────────────────────────────────

export interface DagNode {
  id: number;
  parentId: number | null;
  abstract: string;   // LOD tier 0 – one-line (~10 tokens)
  overview: string;    // LOD tier 1 – key facts (~50-100 tokens)
  detail: string;      // LOD tier 2 – full originals
  sourceIds: number[]; // message IDs summarised by this node
  minTurn: number | null; // first turn in this summary batch (if known)
  maxTurn: number | null; // last turn in this summary batch (if known)
  level: Level;        // highest level among sources
  createdAt: string;
}

// ── Task Detection ───────────────────────────────────────────────

export type TaskType = "coding" | "research" | "planning" | "chat" | "debug";

export interface TaskWeights {
  history: number;
  toolResults: number;
  directives: number;
}

export const DEFAULT_TASK_WEIGHTS: Record<TaskType, TaskWeights> = {
  coding:    { history: 0.20, toolResults: 0.55, directives: 0.15 },
  research:  { history: 0.30, toolResults: 0.45, directives: 0.15 },
  planning:  { history: 0.45, toolResults: 0.15, directives: 0.30 },
  chat:      { history: 0.50, toolResults: 0.10, directives: 0.20 },
  debug:     { history: 0.15, toolResults: 0.60, directives: 0.15 },
};

// ── Token Counting ───────────────────────────────────────────────

/**
 * Token counting function.
 * When running inside OpenClaw, inject the runtime's model-aware tokenizer.
 * Falls back to heuristic estimator when not provided.
 */
export type TokenCounter = (text: string) => number;

// ── Configuration ────────────────────────────────────────────────

export interface SqueezeConfig {
  freshTailCount: number;
  contextThreshold: number;

  triageMode: "hybrid" | "regex" | "llm";
  triageConfidenceThreshold: number;
  triageBatchSize: number;
  triageCostAlertPercent: number;

  taskDetection: boolean;
  taskTransitionBlendTurns: number;
  taskTransitionNewWeight: number;

  prefetch: boolean;
  prefetchTopK: number;
  prefetchMinAccuracy: number;
  prefetchMaxTopK: number;

  memoryInjectionCapPercent: number;
  preferenceConfidenceThreshold: number;
  dagSummaryLOD: boolean;
  subagentPersonalContextMaxTokens: number;

  circuitBreaker: {
    classifierFailThreshold: number;
    latencyFailThreshold: number;
    latencyHardLimitMs: number;
    recoveryCheckInterval: number;
  };
}

export const DEFAULT_CONFIG: SqueezeConfig = {
  freshTailCount: 20,
  contextThreshold: 0.75,

  triageMode: "hybrid",
  triageConfidenceThreshold: 0.7,
  triageBatchSize: 10,
  triageCostAlertPercent: 2,

  taskDetection: true,
  taskTransitionBlendTurns: 3,
  taskTransitionNewWeight: 0.6,

  prefetch: true,
  prefetchTopK: 5,
  prefetchMinAccuracy: 0.4,
  prefetchMaxTopK: 10,

  memoryInjectionCapPercent: 15,
  preferenceConfidenceThreshold: 0.5,
  dagSummaryLOD: true,
  subagentPersonalContextMaxTokens: 2000,

  circuitBreaker: {
    classifierFailThreshold: 3,
    latencyFailThreshold: 5,
    latencyHardLimitMs: 2000,
    recoveryCheckInterval: 10,
  },
};

// ── ContextEngine interface (mirrors OpenClaw plugin slot) ───────
// Reference: https://docs.openclaw.ai/concepts/context-engine

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
}

export interface TokenBudget {
  /** Max tokens available for the entire context */
  maxTokens: number;
  /** Tokens already consumed by system prompt + tool schemas */
  usedTokens: number;
  /** Remaining tokens available */
  available: number;
}

export interface AssembledContext {
  messages: Message[];
  /** Optional addition injected into system prompt area */
  systemPromptAddition?: string;
  tokenCount: number;
  metadata: {
    taskType: TaskType;
    directiveCount: number;
    preferenceCount: number;
    freshTailCount: number;
    summaryCount: number;
    prefetchCount: number;
    memoryPercent: number;
    degraded: boolean;
    degradedReason?: string;
  };
}

export interface Turn {
  userMessage: Message;
  assistantMessage: Message;
  toolMessages?: Message[];
  turnIndex: number;
}

export interface SubagentResult {
  messages: Message[];
  success: boolean;
}

export interface ContextEngineInfo {
  id: string;
  name: string;
  ownsCompaction: boolean;
}

/**
 * OpenClaw ContextEngine interface.
 * Only one ContextEngine can be active at a time (exclusive slot model).
 * Register via: api.registerContextEngine(id, factory)
 */
export interface ContextEngine {
  info: ContextEngineInfo;
  bootstrap(dbPath: string): Promise<void>;
  ingest(msg: Message): Promise<void>;
  assemble(budget: TokenBudget): Promise<AssembledContext>;
  compact(): Promise<void>;
  afterTurn(turn: Turn): Promise<void>;
  prepareSubagentSpawn(parentContext: AssembledContext): Promise<AssembledContext>;
  onSubagentEnded(result: SubagentResult): Promise<void>;
}

/**
 * Factory function type for plugin registration.
 * Usage: api.registerContextEngine('oh-my-brain', ohMyBrainFactory)
 */
export type ContextEngineFactory = (config: Record<string, unknown>) => ContextEngine;

// ── Outcome Loop ────────────────────────────────────────────────

export interface OutcomeRecord {
  id: string;
  result: "failure";
  failure_mode: string;
  context: string;
  lesson: string;
  session_id: string;
  timestamp: string;
}

// ── Procedure ───────────────────────────────────────────────────

export interface ProcedureStep {
  order: number;
  action: string;
  tool?: string;
}

export interface ProcedureRecord {
  id: string;
  title: string;
  trigger: string;
  steps: ProcedureStep[];
  pitfalls: string[];
  verification: string[];
  status: "candidate" | "approved" | "archived";
  source_session_id: string;
  created_at: string;
  updated_at: string;
}

// ── Growth One-liner ────────────────────────────────────────────

export interface SessionStats {
  new_directives: number;
  new_preferences: number;
  new_outcomes: OutcomeRecord[];
  new_procedures: number;
}
