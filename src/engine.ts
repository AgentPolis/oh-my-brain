/**
 * SqueezeContextEngine — main engine implementing the OpenClaw ContextEngine
 * interface. This is the core of oh-my-brain (formerly squeeze-claw). The
 * class name is preserved for backward compatibility; `BrainEngine` is
 * exported as a clearer alias.
 *
 * Registration: api.registerContextEngine('oh-my-brain', ohMyBrainFactory)
 * Docs: https://docs.openclaw.ai/concepts/context-engine
 */

import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineFactory,
  Message,
  TokenBudget,
  Turn,
  SubagentResult,
  AssembledContext,
  SqueezeConfig,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { BrainDB } from "./storage/db.js";
import { pgliteFactory } from "./storage/db.js";
import { initPgSchema, checkPgIntegrity } from "./storage/pg-schema.js";
import { MessageStore } from "./storage/messages.js";
import { DirectiveStore } from "./storage/directives.js";
import { classify } from "./triage/classifier.js";
import { TaskDetector } from "./assembly/task-detector.js";
import { allocateBudget, setTokenCounter, estimateTokens } from "./assembly/budget.js";
import { assemble, formatPersonalContext } from "./assembly/assembler.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { Level } from "./types.js";
import { Compactor } from "./compact/compactor.js";
import { DagStore } from "./storage/dag.js";
import { OutcomeStore } from "./storage/outcomes.js";
import { ProcedureStore } from "./storage/procedures.js";
import { dirname, join } from "path";
import { resolveSystemRoot } from "./scope.js";

export class SqueezeContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "oh-my-brain",
    name: "oh-my-brain — Importance-Aware Agent Memory",
    ownsCompaction: true,
  };

  private brainDb!: BrainDB;
  private messages!: MessageStore;
  private directives!: DirectiveStore;
  private taskDetector!: TaskDetector;
  private circuitBreaker!: CircuitBreaker;
  private dag!: DagStore;
  private compactor!: Compactor;
  private config: SqueezeConfig;
  private turnIndex = 0;
  private memoryEnabled = true;
  private lastIngestedContent: string | undefined;
  private tokenCounter?: (text: string) => number;
  private ownsDb = true;
  private outcomeStore!: OutcomeStore;
  private procedureStore!: ProcedureStore;
  private _subagentTaskHint?: string;
  private squeezePath!: string;

  constructor(config: Partial<SqueezeConfig> = {}, tokenCounter?: (text: string) => number) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = tokenCounter;
  }

  // ── Lifecycle hooks ────────────────────────────────────────────

  async bootstrap(dbPath: string): Promise<void> {
    this.squeezePath = resolveSystemRoot(dirname(dbPath));
    this.brainDb = await pgliteFactory.create(dbPath);

    if (!(await checkPgIntegrity(this.brainDb))) {
      console.warn("[oh-my-brain] Database integrity check failed, reinitializing");
    }

    await initPgSchema(this.brainDb);
    await this._initStores();
  }

  /**
   * Bootstrap with an existing BrainDB instance (for testing).
   * The caller retains ownership of the DB lifecycle — close() will not close it.
   */
  async bootstrapWithDb(db: BrainDB): Promise<void> {
    this.brainDb = db;
    this.ownsDb = false;
    await this._initStores();
  }

  private async _initStores(): Promise<void> {
    // Inject token counter if provided (e.g., OpenClaw runtime tokenizer)
    if (this.tokenCounter) {
      setTokenCounter(this.tokenCounter);
    }

    this.messages = new MessageStore(this.brainDb);
    this.dag = new DagStore(this.brainDb);
    this.compactor = new Compactor(this.messages, this.dag, {
      freshTailTurns: this.config.freshTailCount,
      batchTurns: 5,
    });
    this.directives = new DirectiveStore(this.brainDb);
    this.taskDetector = new TaskDetector({
      blendTurns: this.config.taskTransitionBlendTurns,
      newWeight: this.config.taskTransitionNewWeight,
    });
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker);

    this.turnIndex = await this.messages.getMaxTurn();

    // JSONL-based stores (outcome loop + procedures)
    if (!this.squeezePath) this.squeezePath = resolveSystemRoot(process.cwd());
    this.outcomeStore = new OutcomeStore(this.squeezePath);
    this.procedureStore = new ProcedureStore(this.squeezePath);
  }

  async ingest(msg: Message, turnIndex?: number): Promise<void> {
    // Guard: null/undefined/empty content → treat as L0 discard
    if (!msg.content && msg.content !== "") return;
    if (typeof msg.content !== "string") return;

    const start = performance.now();
    const effectiveTurn = turnIndex ?? this.turnIndex;

    try {
      const cls = this.circuitBreaker.isDegraded
        ? { level: Level.Observation, contentType: "conversation" as const, confidence: 0.5 }
        : classify(msg, {
            confidenceThreshold: this.config.triageConfidenceThreshold,
            mode: this.config.triageMode,
          }, this.lastIngestedContent);

      // Track content for next message's context-aware L0 check
      this.lastIngestedContent = msg.content;

      if (cls.level === Level.Discard) return;

      const msgId = await this.messages.insert(msg, effectiveTurn, cls);
      if (msgId < 0) return;

      if (cls.level === Level.Directive) {
        const key = extractDirectiveKey(msg.content);
        await this.directives.addDirective(key, msg.content, msgId);
      } else if (cls.level === Level.Preference) {
        const key = extractDirectiveKey(msg.content);
        await this.directives.addPreference(key, msg.content, cls.confidence, msgId);
      }

      this.circuitBreaker.recordClassifierSuccess();
    } catch (err) {
      console.error("[oh-my-brain] ingest error:", err);
      this.circuitBreaker.recordClassifierFailure();

      await this.messages.insert(msg, effectiveTurn, {
        level: Level.Observation,
        contentType: "conversation",
        confidence: 0.5,
      });
    }

    const elapsed = performance.now() - start;
    this.circuitBreaker.recordTurnLatency(elapsed);
  }

  async assemble(budget: TokenBudget): Promise<AssembledContext> {
    const activeDirectives = this.memoryEnabled
      ? await this.directives.getActiveDirectives()
      : [];
    const activePreferences = this.memoryEnabled
      ? await this.directives.getActivePreferences(this.config.preferenceConfidenceThreshold)
      : [];

    const freshTail = await this.messages.getRecentByTurn(this.config.freshTailCount);

    if (this.config.taskDetection && !this.circuitBreaker.isDegraded) {
      const recent = await this.messages.getRecentByTurn(10);
      this.taskDetector.detect(recent);
    }

    const budgetAlloc = allocateBudget(
      budget.maxTokens,
      budget.usedTokens,
      this.taskDetector.weights,
      this.config
    );

    const dagNodes = await this.dag.getAbstracts(20);

    return assemble({
      systemPrompt: [],
      directives: activeDirectives,
      preferences: activePreferences,
      freshTail,
      taskType: this.taskDetector.currentTask,
      budget: budgetAlloc,
      config: this.config,
      degraded: this.circuitBreaker.isDegraded,
      degradedReason: this.circuitBreaker.degradedReason ?? undefined,
      dagNodes,
    });
  }

  async compact(): Promise<void> {
    await this.compactor.run(this.turnIndex);
  }

  async afterTurn(turn: Turn): Promise<void> {
    // Increment turnIndex once per turn, not per message
    this.turnIndex++;
    const currentTurn = this.turnIndex;

    // Ingest all messages from the turn with the same turnIndex
    await this.ingest(turn.userMessage, currentTurn);
    await this.ingest(turn.assistantMessage, currentTurn);
    if (turn.toolMessages) {
      for (const toolMsg of turn.toolMessages) {
        await this.ingest(toolMsg, currentTurn);
      }
    }

    // Circuit breaker tick
    if (this.circuitBreaker.tick()) {
      this.circuitBreaker.attemptRecovery();
    }
  }

  async prepareSubagentSpawn(parentContext: AssembledContext): Promise<AssembledContext> {
    const taskDescription = this._subagentTaskHint;
    this._subagentTaskHint = undefined; // consume once

    // 1. Gather personal context
    const directives = await this.directives.getActiveDirectives();

    const matchedProcedure = taskDescription
      ? this.procedureStore.findApprovedByTrigger(taskDescription)
      : null;

    const cautions = taskDescription
      ? this.outcomeStore.findRelevant(taskDescription, 3)
      : [];

    // 2. Format as plain text block
    const personalBlock = formatPersonalContext(
      directives,
      matchedProcedure,
      cautions,
      this.config.subagentPersonalContextMaxTokens
    );

    // 3. Assemble with half parent budget
    const halfMax = Math.floor(parentContext.tokenCount * 0.5);
    const halfBudget: TokenBudget = {
      maxTokens: halfMax,
      usedTokens: 0,
      available: halfMax,
    };
    const assembled = await this.assemble(halfBudget);

    // Prepend personal context as system message
    const personalTokens = estimateTokens(personalBlock);
    assembled.messages.unshift({ role: "system", content: personalBlock });
    assembled.tokenCount += personalTokens;

    return assembled;
  }

  async onSubagentEnded(result: SubagentResult): Promise<void> {
    for (const msg of result.messages) {
      await this.ingest(msg);
    }
  }

  // ── Public API (squeeze-claw specific) ─────────────────────────

  setMemoryEnabled(enabled: boolean): void {
    this.memoryEnabled = enabled;
  }

  setSubagentTaskHint(description: string): void {
    this._subagentTaskHint = description;
  }

  getOutcomeStore(): OutcomeStore {
    return this.outcomeStore;
  }

  getProcedureStore(): ProcedureStore {
    return this.procedureStore;
  }

  async getStatus(): Promise<object> {
    return {
      turnIndex: this.turnIndex,
      counts: await this.messages.countByLevel(),
      taskType: this.taskDetector.currentTask,
      weights: this.taskDetector.weights,
      memoryEnabled: this.memoryEnabled,
      degraded: this.circuitBreaker.isDegraded,
      degradedReason: this.circuitBreaker.degradedReason,
    };
  }

  getDirectiveStore(): DirectiveStore {
    return this.directives;
  }

  getMessageStore(): MessageStore {
    return this.messages;
  }

  async close(): Promise<void> {
    if (this.ownsDb) {
      await this.brainDb?.close();
    }
  }
}

// ── Factory for OpenClaw plugin registration ─────────────────────

export const ohMyBrainFactory: ContextEngineFactory = (config) => {
  const { tokenCounter, ...rest } = config as Partial<SqueezeConfig> & { tokenCounter?: (text: string) => number };
  return new SqueezeContextEngine(rest, tokenCounter);
};

/** @deprecated Use `ohMyBrainFactory` instead. Kept for backward compat. */
export const squeezeClawFactory = ohMyBrainFactory;

/** Clearer alias for the main engine class. */
export { SqueezeContextEngine as BrainEngine };

// ── Helpers ──────────────────────────────────────────────────────

function extractDirectiveKey(content: string): string {
  const match = content.match(
    /\b(?:always|never|remember that|from now on|don't ever)\s+(.{5,40})/i
  );
  if (match) {
    return match[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 50);
  }
  return content
    .slice(0, 50)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}
