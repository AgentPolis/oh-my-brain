/**
 * L3 Directive store + L2 Preference store with conflict resolution.
 */

import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join } from "path";
import type { DirectiveRecord, PreferenceRecord } from "../types.js";
import { initSchema } from "./schema.js";

export class DirectiveStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── L3 Directives ──────────────────────────────────────────────

  addDirective(
    key: string,
    value: string,
    sourceMsgId: number | null,
    confirmedByUser = false,
    evidence?: { text?: string; turn?: number }
  ): number {
    // Atomic insert-then-supersede in one transaction.
    const txn = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO directives (
             key, value, source_msg_id, confirmed_by_user, evidence_text, evidence_turn
           )
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          key,
          value,
          sourceMsgId,
          confirmedByUser ? 1 : 0,
          evidence?.text ?? null,
          evidence?.turn ?? null
        );

      const newId = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `UPDATE directives
           SET superseded_by = ?, superseded_at = datetime('now')
           WHERE key = ? AND superseded_by IS NULL AND id != ?`
        )
        .run(newId, key, newId);

      return newId;
    });

    return txn();
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

  // ── L2 Preferences ────────────────────────────────────────────

  addPreference(
    key: string,
    value: string,
    confidence: number,
    sourceMsgId: number
  ): number {
    const txn = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO preferences (key, value, confidence, source_msg_id)
           VALUES (?, ?, ?, ?)`
        )
        .run(key, value, confidence, sourceMsgId);

      const newId = Number(result.lastInsertRowid);
      this.db
        .prepare(
          `UPDATE preferences
           SET superseded_by = ?, superseded_at = datetime('now')
           WHERE key = ? AND superseded_by IS NULL AND id != ?`
        )
        .run(newId, key, newId);

      return newId;
    });

    return txn();
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

  // ── Backward-compatibility helper ───────────────────────────────

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
  source_msg_id: number | null;
  created_at: string;
  confirmed_by_user: number;
  evidence_text: string | null;
  evidence_turn: number | null;
  last_referenced_at: string | null;
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
    evidenceText: row.evidence_text,
    evidenceTurn: row.evidence_turn,
    lastReferencedAt: row.last_referenced_at,
    supersededBy: row.superseded_by,
    supersededAt: row.superseded_at,
  };
}

function projectDbPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", "brain.db");
}

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

export function persistDirectives(
  projectRoot: string,
  records: Array<{
    directiveText: string;
    evidenceText?: string;
    evidenceTurn?: number;
  }>
): void {
  if (records.length === 0) return;

  mkdirSync(join(projectRoot, ".squeeze"), { recursive: true });
  const db = new BetterSqlite3(projectDbPath(projectRoot));
  try {
    initSchema(db);
    const store = new DirectiveStore(db);
    const insertMessage = db.prepare(
      `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
       VALUES ('user', ?, 3, 'conversation', 1.0, ?)`
    );
    const existingStmt = db.prepare(
      `SELECT 1 FROM directives WHERE superseded_by IS NULL AND value = ?`
    );

    for (const record of records) {
      const exists = existingStmt.get(record.directiveText) as { 1: number } | undefined;
      if (exists) continue;

      const messageId =
        typeof record.evidenceText === "string"
          ? Number(insertMessage.run(record.evidenceText, record.evidenceTurn ?? 0).lastInsertRowid)
          : null;
      store.addDirective(
        extractDirectiveKey(record.directiveText),
        record.directiveText,
        messageId,
        false,
        {
          text: record.evidenceText,
          turn: record.evidenceTurn,
        }
      );
    }
  } finally {
    db.close();
  }
}

export function loadDirectiveEvidence(
  projectRoot: string
): Map<string, { evidenceText: string | null; evidenceTurn: number | null }> {
  const dbFile = projectDbPath(projectRoot);
  if (!dbFile) {
    return new Map();
  }

  try {
    const db = new BetterSqlite3(dbFile, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT value, evidence_text, evidence_turn
           FROM directives
           WHERE superseded_by IS NULL`
        )
        .all() as Array<{
        value: string;
        evidence_text: string | null;
        evidence_turn: number | null;
      }>;
      return new Map(
        rows.map((row) => [
          row.value,
          {
            evidenceText: row.evidence_text,
            evidenceTurn: row.evidence_turn,
          },
        ])
      );
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

export function loadDirectiveMetadata(projectRoot: string): DirectiveRecord[] {
  const dbFile = projectDbPath(projectRoot);
  if (!dbFile) return [];

  try {
    const db = new BetterSqlite3(dbFile, { readonly: true });
    try {
      return new DirectiveStore(db).getActiveDirectives();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function markDirectivesReferenced(
  projectRoot: string,
  directiveTexts: string[]
): void {
  if (directiveTexts.length === 0) return;
  const dbFile = projectDbPath(projectRoot);

  try {
    const db = new BetterSqlite3(dbFile);
    try {
      initSchema(db);
      const stmt = db.prepare(
        `UPDATE directives
         SET last_referenced_at = datetime('now')
         WHERE superseded_by IS NULL AND value = ?`
      );
      for (const directiveText of directiveTexts) {
        stmt.run(directiveText);
      }
    } finally {
      db.close();
    }
  } catch {
    // Best-effort metadata update only.
  }
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
