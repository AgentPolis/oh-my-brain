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
