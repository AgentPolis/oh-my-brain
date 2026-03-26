/**
 * L3 Directive store + L2 Preference store with conflict resolution.
 */

import type Database from "better-sqlite3";
import type { DirectiveRecord, PreferenceRecord } from "../types.js";

export class DirectiveStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── L3 Directives ──────────────────────────────────────────────

  addDirective(
    key: string,
    value: string,
    sourceMsgId: number,
    confirmedByUser = false
  ): number {
    // Supersede existing directive with same key
    this.supersedeDirective(key);

    const result = this.db
      .prepare(
        `INSERT INTO directives (key, value, source_msg_id, confirmed_by_user)
         VALUES (?, ?, ?, ?)`
      )
      .run(key, value, sourceMsgId, confirmedByUser ? 1 : 0);

    return Number(result.lastInsertRowid);
  }

  getActiveDirectives(): DirectiveRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM directives WHERE superseded_by IS NULL ORDER BY created_at`
      )
      .all() as RawDirectiveRow[];
    return rows.map(toDirectiveRecord);
  }

  getDirectiveHistory(key: string): DirectiveRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM directives WHERE key = ? ORDER BY created_at`)
      .all(key) as RawDirectiveRow[];
    return rows.map(toDirectiveRecord);
  }

  removeDirective(id: number): boolean {
    const result = this.db
      .prepare(`DELETE FROM directives WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  private supersedeDirective(key: string): void {
    this.db
      .prepare(
        `UPDATE directives
         SET superseded_by = -1, superseded_at = datetime('now')
         WHERE key = ? AND superseded_by IS NULL`
      )
      .run(key);
  }

  // ── L2 Preferences ────────────────────────────────────────────

  addPreference(
    key: string,
    value: string,
    confidence: number,
    sourceMsgId: number
  ): number {
    this.supersedePreference(key);

    const result = this.db
      .prepare(
        `INSERT INTO preferences (key, value, confidence, source_msg_id)
         VALUES (?, ?, ?, ?)`
      )
      .run(key, value, confidence, sourceMsgId);

    return Number(result.lastInsertRowid);
  }

  getActivePreferences(minConfidence = 0): PreferenceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM preferences
         WHERE superseded_by IS NULL AND confidence >= ?
         ORDER BY confidence DESC, created_at`
      )
      .all(minConfidence) as RawPreferenceRow[];
    return rows.map(toPreferenceRecord);
  }

  private supersedePreference(key: string): void {
    this.db
      .prepare(
        `UPDATE preferences
         SET superseded_by = -1, superseded_at = datetime('now')
         WHERE key = ? AND superseded_by IS NULL`
      )
      .run(key);
  }

  // ── Fixup superseded_by after insert (link old → new id) ──────

  fixupSuperseded(table: "directives" | "preferences", newId: number, key: string): void {
    this.db
      .prepare(
        `UPDATE ${table} SET superseded_by = ? WHERE superseded_by = -1 AND key = ?`
      )
      .run(newId, key);
  }
}

// ── internal ─────────────────────────────────────────────────────

interface RawDirectiveRow {
  id: number;
  key: string;
  value: string;
  source_msg_id: number;
  created_at: string;
  confirmed_by_user: number;
  superseded_by: number | null;
  superseded_at: string | null;
}

interface RawPreferenceRow {
  id: number;
  key: string;
  value: string;
  confidence: number;
  source_msg_id: number;
  created_at: string;
  superseded_by: number | null;
  superseded_at: string | null;
}

function toDirectiveRecord(row: RawDirectiveRow): DirectiveRecord {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    sourceMsgId: row.source_msg_id,
    createdAt: row.created_at,
    confirmedByUser: row.confirmed_by_user === 1,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
  };
}

function toPreferenceRecord(row: RawPreferenceRow): PreferenceRecord {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sourceMsgId: row.source_msg_id,
    createdAt: row.created_at,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
  };
}
