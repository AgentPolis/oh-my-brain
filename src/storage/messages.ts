/**
 * Message CRUD with L-level tags.
 */

import type { BrainDB } from "./db.js";
import type { Classification, StoredMessage, Message } from "../types.js";
import { Level } from "../types.js";
import { truncateIfNeeded } from "../triage/truncate.js";

export class MessageStore {
  private db: BrainDB;

  constructor(db: BrainDB) {
    this.db = db;
  }

  async insert(msg: Message, turnIndex: number, cls: Classification): Promise<number> {
    // L0 = discard, don't store
    if (cls.level === Level.Discard) return -1;

    const content = truncateIfNeeded(msg.content, cls.contentType);

    const rows = await this.db.query<{ id: number }>(
      `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [msg.role, content, cls.level, cls.contentType, cls.confidence, turnIndex],
    );

    return rows[0].id;
  }

  async getById(id: number): Promise<StoredMessage | null> {
    const rows = await this.db.query<RawRow>(
      `SELECT * FROM messages WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? toStoredMessage(rows[0]) : null;
  }

  async getRecentByTurn(count: number): Promise<StoredMessage[]> {
    const rows = await this.db.query<RawRow>(
      `SELECT * FROM messages ORDER BY turn_index DESC, id DESC LIMIT $1`,
      [count],
    );
    return rows.reverse().map(toStoredMessage);
  }

  async getByLevel(level: Level, limit = 100): Promise<StoredMessage[]> {
    const rows = await this.db.query<RawRow>(
      `SELECT * FROM messages WHERE level = $1 ORDER BY id DESC LIMIT $2`,
      [level, limit],
    );
    return rows.map(toStoredMessage);
  }

  async getByTurnRange(fromTurn: number, toTurn: number): Promise<StoredMessage[]> {
    const rows = await this.db.query<RawRow>(
      `SELECT * FROM messages WHERE turn_index BETWEEN $1 AND $2 ORDER BY turn_index, id`,
      [fromTurn, toTurn],
    );
    return rows.map(toStoredMessage);
  }

  async countByLevel(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ level: number; cnt: number }>(
      `SELECT level, COUNT(*) as cnt FROM messages GROUP BY level`,
    );

    const result: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
    for (const row of rows) {
      const key = `L${row.level}`;
      result[key] = Number(row.cnt);
    }
    return result;
  }

  async getMaxTurn(): Promise<number> {
    const rows = await this.db.query<{ max_turn: number | null }>(
      `SELECT MAX(turn_index) as max_turn FROM messages`,
    );
    return rows[0]?.max_turn ?? 0;
  }

  /**
   * Return L1 messages that are old enough to compact.
   * "Old enough" = turn_index <= currentTurn - freshTailTurns
   * Excludes already-compacted messages (compacted_by IS NOT NULL).
   */
  async getCompactable(currentTurn: number, freshTailTurns: number): Promise<StoredMessage[]> {
    const cutoffTurn = currentTurn - freshTailTurns;
    if (cutoffTurn <= 0) return [];

    const rows = await this.db.query<RawRow>(
      `SELECT * FROM messages
       WHERE level = $1 AND turn_index <= $2 AND compacted_by IS NULL
       ORDER BY turn_index, id`,
      [Level.Observation, cutoffTurn],
    );
    return rows.map(toStoredMessage);
  }

  /**
   * Mark messages as compacted (associated with a dag_node).
   */
  async markCompacted(ids: number[], dagNodeId: number): Promise<void> {
    if (ids.length === 0) return;
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, idx) => `$${idx + 2}`).join(",");
      await this.db.exec(
        `UPDATE messages SET compacted_by = $1 WHERE id IN (${placeholders})`,
        [dagNodeId, ...chunk],
      );
    }
  }
}

// ── internal ─────────────────────────────────────────────────────

interface RawRow {
  id: number;
  role: string;
  content: string;
  level: number;
  content_type: string;
  confidence: number;
  turn_index: number;
  created_at: string | Date;
  compacted_by: number | null;
}

function toStoredMessage(row: RawRow): StoredMessage {
  return {
    id: row.id,
    role: row.role as StoredMessage["role"],
    content: row.content,
    level: row.level as Level,
    contentType: row.content_type as StoredMessage["contentType"],
    confidence: row.confidence,
    turnIndex: row.turn_index,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}
