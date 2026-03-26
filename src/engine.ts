/**
 * SqueezeContextEngine — main engine implementing the OpenClaw ContextEngine interface.
 *
 * Registration: api.registerContextEngine('squeeze-claw', squeezeClawFactory)
 * Docs: https://docs.openclaw.ai/concepts/context-engine
 */

import Database from "better-sqlite3";
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
import { initSchema, checkIntegrity, migrateFromLosslessClaw } from "./storage/schema.js";
import { MessageStore } from "./storage/messages.js";
import { DirectiveStore } from "./storage/directives.js";
import { classify } from "./triage/classifier.js";
import { TaskDetector } from "./assembly/task-detector.js";
import { allocateBudget } from "./assembly/budget.js";
import { assemble } from "./assembly/assembler.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { Level } from "./types.js";

export class SqueezeContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "squeeze-claw",
    name: "Squeeze Claw — Semantic Context Compression",
    ownsCompaction: true,
  };

  private db!: Database.Database;
  private messages!: MessageStore;
  private directives!: DirectiveStore;
  private taskDetector!: TaskDetector;
  private circuitBreaker!: CircuitBreaker;
  private config: SqueezeConfig;
  private turnIndex = 0;
  private memoryEnabled = true;
  private lastIngestedContent: string | undefined;

  constructor(config: Partial<SqueezeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle hooks ────────────────────────────────────────────

  async bootstrap(dbPath: string): Promise<void> {
    this.db = new Database(dbPath);

    if (!checkIntegrity(this.db)) {
      console.warn("[squeeze-claw] Database integrity check failed, reinitializing");
    }

    initSchema(this.db);

    this.messages = new MessageStore(this.db);
    this.directives = new DirectiveStore(this.db);
    this.taskDetector = new TaskDetector({
      blendTurns: this.config.taskTransitionBlendTurns,
      newWeight: this.config.taskTransitionNewWeight,
    });
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker);

    this.turnIndex = this.messages.getMaxTurn();
  }

  async ingest(msg: Message, turnIndex?: number): Promise<void> {
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

      const msgId = this.messages.insert(msg, effectiveTurn, cls);
      if (msgId < 0) return;

      if (cls.level === Level.Directive) {
        const key = extractDirectiveKey(msg.content);
        const newId = this.directives.addDirective(key, msg.content, msgId);
        this.directives.fixupSuperseded("directives", newId, key);
      }

      this.circuitBreaker.recordClassifierSuccess();
    } catch (err) {
      console.error("[squeeze-claw] ingest error:", err);
      this.circuitBreaker.recordClassifierFailure();

      this.messages.insert(msg, effectiveTurn, {
        level: Level.Observation,
        contentType: "conversation",
        confidence: 0.5,
      });
    }

    const elapsed = performance.now() - start;
    this.circuitBreaker.recordTurnLatency(elapsed);
  }

  async assemble(budget: TokenBudget): Promise<AssembledContext> {
    const availableTokens = budget.available;

    const activeDirectives = this.memoryEnabled
      ? this.directives.getActiveDirectives()
      : [];
    const activePreferences = this.memoryEnabled
      ? this.directives.getActivePreferences(this.config.preferenceConfidenceThreshold)
      : [];

    const freshTail = this.messages.getRecentByTurn(this.config.freshTailCount);

    if (this.config.taskDetection && !this.circuitBreaker.isDegraded) {
      const recent = this.messages.getRecentByTurn(10);
      this.taskDetector.detect(recent);
    }

    const budgetAlloc = allocateBudget(
      availableTokens,
      budget.usedTokens,
      this.taskDetector.weights,
      this.config
    );

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
    });
  }

  async compact(): Promise<void> {
    // TODO: Level-aware DAG compression
    // - L2+ content preserved with higher fidelity
    // - L3 never touched
    // - L0 already discarded at ingest
    // - L1 standard DAG summarization
  }

  async afterTurn(turn: Turn): Promise<void> {
    // Increment turnIndex once per turn, not per message
    this.turnIndex++;
    const currentTurn = this.turnIndex;

    // Ingest all messages from the turn with the same turnIndex
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

    // TODO: L1→L2 promotion (mention counting)
    // TODO: Prefetch accuracy tracking
    // TODO: Task type validation
  }

  async prepareSubagentSpawn(parentContext: AssembledContext): Promise<AssembledContext> {
    // Subagents get L3 directives + task-relevant subset, half budget
    const halfBudget: TokenBudget = {
      maxTokens: Math.floor(parentContext.tokenCount * 0.5),
      usedTokens: 0,
      available: Math.floor(parentContext.tokenCount * 0.5),
    };
    return this.assemble(halfBudget);
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

  getStatus(): object {
    return {
      turnIndex: this.turnIndex,
      counts: this.messages.countByLevel(),
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

  async migrate(existingDbPath: string): Promise<void> {
    const existingDb = new Database(existingDbPath);
    migrateFromLosslessClaw(existingDb);
    existingDb.close();
  }

  close(): void {
    this.db?.close();
  }
}

// ── Factory for OpenClaw plugin registration ─────────────────────

/**
 * Factory function for registering with OpenClaw.
 *
 * Usage:
 *   import { squeezeClawFactory } from 'squeeze-claw'
 *   api.registerContextEngine('squeeze-claw', squeezeClawFactory)
 */
export const squeezeClawFactory: ContextEngineFactory = (config) => {
  return new SqueezeContextEngine(config as Partial<SqueezeConfig>);
};

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
