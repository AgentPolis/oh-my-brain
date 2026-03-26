/**
 * Message CRUD with L-level tags.
 */

import type Database from "better-sqlite3";
import type { Classification, StoredMessage, Message } from "../types.js";
import { Level } from "../types.js";
import { truncateIfNeeded } from "../triage/truncate.js";

export class MessageStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insert(msg: Message, turnIndex: number, cls: Classification): number {
    // L0 = discard, don't store
    if (cls.level === Level.Discard) return -1;

    const content = truncateIfNeeded(msg.content, cls.contentType);

    const result = this.db
      .prepare(
        `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(msg.role, content, cls.level, cls.contentType, cls.confidence, turnIndex);

    return Number(result.lastInsertRowid);
  }

  getById(id: number): StoredMessage | null {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(id) as RawRow | undefined;
    return row ? toStoredMessage(row) : null;
  }

  getRecentByTurn(count: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages ORDER BY turn_index DESC, id DESC LIMIT ?`
      )
      .all(count) as RawRow[];
    return rows.reverse().map(toStoredMessage);
  }

  getByLevel(level: Level, limit = 100): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE level = ? ORDER BY id DESC LIMIT ?`)
      .all(level, limit) as RawRow[];
    return rows.map(toStoredMessage);
  }

  getByTurnRange(fromTurn: number, toTurn: number): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE turn_index BETWEEN ? AND ? ORDER BY turn_index, id`
      )
      .all(fromTurn, toTurn) as RawRow[];
    return rows.map(toStoredMessage);
  }

  countByLevel(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT level, COUNT(*) as cnt FROM messages GROUP BY level`)
      .all() as Array<{ level: number; cnt: number }>;

    const result: Record<string, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
    for (const row of rows) {
      const key = `L${row.level}`;
      result[key] = row.cnt;
    }
    return result;
  }

  getMaxTurn(): number {
    const row = this.db
      .prepare(`SELECT MAX(turn_index) as max_turn FROM messages`)
      .get() as { max_turn: number | null };
    return row.max_turn ?? 0;
  }

  /**
   * Return L1 messages that are old enough to compact.
   * "Old enough" = turn_index <= currentTurn - freshTailTurns
   * Excludes already-compacted messages (compacted_by IS NOT NULL).
   */
  getCompactable(currentTurn: number, freshTailTurns: number): StoredMessage[] {
    const cutoffTurn = currentTurn - freshTailTurns;
    if (cutoffTurn <= 0) return [];

    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE level = ? AND turn_index <= ? AND compacted_by IS NULL
         ORDER BY turn_index, id`
      )
      .all(Level.Observation, cutoffTurn) as RawRow[];
    return rows.map(toStoredMessage);
  }

  /**
   * Mark messages as compacted (associated with a dag_node).
   * Batches updates safely (SQLite limit: 999 bound params).
   */
  markCompacted(ids: number[], dagNodeId: number): void {
    if (ids.length === 0) return;
    // Process in chunks of 100 to stay well under SQLite's 999 param limit
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      this.db
        .prepare(`UPDATE messages SET compacted_by = ? WHERE id IN (${placeholders})`)
        .run(dagNodeId, ...chunk);
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
  created_at: string;
  compacted_by: number | null;  // needed so better-sqlite3 doesn't error on column
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
    createdAt: row.created_at,
  };
}
