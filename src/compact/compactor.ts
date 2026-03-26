/**
 * Compactor — runs compact() logic on old L1 messages.
 * Called from SqueezeContextEngine.compact() and during heartbeat.
 */

import type { MessageStore } from "../storage/messages.js";
import type { DagStore } from "../storage/dag.js";
import { summarize } from "./summarizer.js";
import { Level } from "../types.js";
import type { StoredMessage } from "../types.js";

export interface CompactorConfig {
  freshTailTurns: number;
  batchTurns: number;
}

const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  freshTailTurns: 20,
  batchTurns: 5,
};

export class Compactor {
  private messages: MessageStore;
  private dag: DagStore;
  private config: CompactorConfig;

  constructor(messages: MessageStore, dag: DagStore, config: Partial<CompactorConfig> = {}) {
    this.messages = messages;
    this.dag = dag;
    this.config = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
  }

  /**
   * Compact old L1 messages up to currentTurn - freshTailTurns.
   * Groups by batchTurns, writes one dag_node per batch.
   * Idempotent — already-compacted messages are skipped.
   */
  run(currentTurn: number): void {
    const compactable = this.messages.getCompactable(currentTurn, this.config.freshTailTurns);
    if (compactable.length === 0) return;

    const batches = groupByTurns(compactable, this.config.batchTurns);

    for (const batch of batches) {
      const summary = summarize(batch);
      const maxLevel = Math.max(...batch.map(m => m.level)) as Level;
      const sourceIds = batch.map(m => m.id);

      const nodeId = this.dag.insert({
        parentId: null,
        abstract: summary.abstract,
        overview: summary.overview,
        detail: summary.detail,
        sourceIds,
        minTurn: batch[0].turnIndex,
        maxTurn: batch.at(-1)!.turnIndex,
        level: maxLevel,
      });

      this.messages.markCompacted(sourceIds, nodeId);
    }
  }
}

function groupByTurns<T extends { turnIndex: number }>(
  messages: T[],
  batchTurns: number
): T[][] {
  if (messages.length === 0) return [];

  const minTurn = messages[0].turnIndex;
  const batches: Map<number, T[]> = new Map();

  for (const msg of messages) {
    const bucketKey = Math.floor((msg.turnIndex - minTurn) / batchTurns);
    if (!batches.has(bucketKey)) batches.set(bucketKey, []);
    batches.get(bucketKey)!.push(msg);
  }

  return Array.from(batches.values());
}
