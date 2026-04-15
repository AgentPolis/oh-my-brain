/**
 * L3 Directive store + L2 Preference store with conflict resolution.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import type { DirectiveRecord, PreferenceRecord } from "../types.js";
import type { BrainDB } from "./db.js";
import { pgliteFactory } from "./db.js";
import { initPgSchema } from "./pg-schema.js";

export class DirectiveStore {
  private db: BrainDB;

  constructor(db: BrainDB) {
    this.db = db;
  }

  // ── L3 Directives ──────────────────────────────────────────────

  async addDirective(
    key: string,
    value: string,
    sourceMsgId: number | null,
    confirmedByUser = false,
    evidence?: { text?: string; turn?: number },
    eventTime?: string
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: number }>(
        `INSERT INTO directives (
           key, value, source_msg_id, confirmed_by_user, evidence_text, evidence_turn, event_time
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          key,
          value,
          sourceMsgId,
          confirmedByUser,
          evidence?.text ?? null,
          evidence?.turn ?? null,
          eventTime ?? new Date().toISOString(),
        ],
      );

      const newId = rows[0].id;
      await tx.exec(
        `UPDATE directives
         SET superseded_by = $1, superseded_at = NOW()
         WHERE key = $2 AND superseded_by IS NULL AND id != $3`,
        [newId, key, newId],
      );

      return newId;
    });
  }

  async getActiveDirectives(): Promise<DirectiveRecord[]> {
    const rows = await this.db.query<RawDirectiveRow>(
      `SELECT * FROM directives WHERE superseded_by IS NULL ORDER BY created_at`,
    );
    return rows.map(toDirectiveRecord);
  }

  async getDirectiveHistory(key: string): Promise<DirectiveRecord[]> {
    const rows = await this.db.query<RawDirectiveRow>(
      `SELECT * FROM directives WHERE key = $1 ORDER BY created_at`,
      [key],
    );
    return rows.map(toDirectiveRecord);
  }

  async removeDirective(id: number): Promise<boolean> {
    const rows = await this.db.query<{ id: number }>(
      `DELETE FROM directives WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  // ── L2 Preferences ────────────────────────────────────────────

  async addPreference(
    key: string,
    value: string,
    confidence: number,
    sourceMsgId: number,
    eventTime?: string
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: number }>(
        `INSERT INTO preferences (key, value, confidence, source_msg_id, event_time)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [key, value, confidence, sourceMsgId, eventTime ?? new Date().toISOString()],
      );

      const newId = rows[0].id;
      await tx.exec(
        `UPDATE preferences
         SET superseded_by = $1, superseded_at = NOW()
         WHERE key = $2 AND superseded_by IS NULL AND id != $3`,
        [newId, key, newId],
      );

      return newId;
    });
  }

  async getActivePreferences(minConfidence = 0): Promise<PreferenceRecord[]> {
    const rows = await this.db.query<RawPreferenceRow>(
      `SELECT * FROM preferences
       WHERE superseded_by IS NULL AND confidence >= $1
       ORDER BY confidence DESC, created_at`,
      [minConfidence],
    );
    return rows.map(toPreferenceRecord);
  }

  // ── Backward-compatibility helper ───────────────────────────────

  async fixupSuperseded(table: "directives" | "preferences", newId: number, key: string): Promise<void> {
    await this.db.exec(
      `UPDATE ${table} SET superseded_by = $1 WHERE superseded_by = -1 AND key = $2`,
      [newId, key],
    );
  }
}

// ── internal ─────────────────────────────────────────────────────

interface RawDirectiveRow {
  id: number;
  key: string;
  value: string;
  source_msg_id: number | null;
  created_at: string | Date;
  event_time: string | Date | null;
  confirmed_by_user: boolean;
  evidence_text: string | null;
  evidence_turn: number | null;
  last_referenced_at: string | Date | null;
  superseded_by: number | null;
  superseded_at: string | Date | null;
}

interface RawPreferenceRow {
  id: number;
  key: string;
  value: string;
  confidence: number;
  source_msg_id: number;
  created_at: string | Date;
  event_time: string | Date | null;
  superseded_by: number | null;
  superseded_at: string | Date | null;
}

/** Convert a PGLite TIMESTAMPTZ value (Date object or string) to ISO string. */
function tsToString(val: string | Date | null | undefined): string | null {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toDirectiveRecord(row: RawDirectiveRow): DirectiveRecord {
  const createdAt = tsToString(row.created_at) ?? "";
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    sourceMsgId: row.source_msg_id,
    createdAt,
    eventTime: tsToString(row.event_time) ?? createdAt,
    confirmedByUser: Boolean(row.confirmed_by_user),
    evidenceText: row.evidence_text,
    evidenceTurn: row.evidence_turn,
    lastReferencedAt: tsToString(row.last_referenced_at),
    supersededBy: row.superseded_by,
    supersededAt: tsToString(row.superseded_at),
  };
}

function projectPgPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", "brain.pg");
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

export async function persistDirectives(
  projectRoot: string,
  records: Array<{
    directiveText: string;
    evidenceText?: string;
    evidenceTurn?: number;
    eventTime?: string;
  }>
): Promise<void> {
  if (records.length === 0) return;

  mkdirSync(join(projectRoot, ".squeeze"), { recursive: true });
  const db = await pgliteFactory.create(projectPgPath(projectRoot));
  try {
    await initPgSchema(db);
    const store = new DirectiveStore(db);

    for (const record of records) {
      const existing = await db.query<{ n: number }>(
        `SELECT 1 as n FROM directives WHERE superseded_by IS NULL AND value = $1`,
        [record.directiveText],
      );
      if (existing.length > 0) continue;

      let messageId: number | null = null;
      if (typeof record.evidenceText === "string") {
        const msgRows = await db.query<{ id: number }>(
          `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
           VALUES ('user', $1, 3, 'conversation', 1.0, $2)
           RETURNING id`,
          [record.evidenceText, record.evidenceTurn ?? 0],
        );
        messageId = msgRows[0].id;
      }
      await store.addDirective(
        extractDirectiveKey(record.directiveText),
        record.directiveText,
        messageId,
        false,
        {
          text: record.evidenceText,
          turn: record.evidenceTurn,
        },
        record.eventTime
      );
    }
  } finally {
    await db.close();
  }
}

export async function loadDirectiveEvidence(
  projectRoot: string
): Promise<Map<string, { evidenceText: string | null; evidenceTurn: number | null }>> {
  const dataDir = projectPgPath(projectRoot);

  try {
    const db = await pgliteFactory.create(dataDir);
    try {
      await initPgSchema(db);
      const rows = await db.query<{
        value: string;
        evidence_text: string | null;
        evidence_turn: number | null;
      }>(
        `SELECT value, evidence_text, evidence_turn
         FROM directives
         WHERE superseded_by IS NULL`,
      );
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
      await db.close();
    }
  } catch {
    return new Map();
  }
}

export async function loadDirectiveMetadata(projectRoot: string): Promise<DirectiveRecord[]> {
  const dataDir = projectPgPath(projectRoot);

  try {
    const db = await pgliteFactory.create(dataDir);
    try {
      await initPgSchema(db);
      return await new DirectiveStore(db).getActiveDirectives();
    } finally {
      await db.close();
    }
  } catch {
    return [];
  }
}

export async function markDirectivesReferenced(
  projectRoot: string,
  directiveTexts: string[]
): Promise<void> {
  if (directiveTexts.length === 0) return;
  const dataDir = projectPgPath(projectRoot);

  try {
    const db = await pgliteFactory.create(dataDir);
    try {
      await initPgSchema(db);
      for (const directiveText of directiveTexts) {
        await db.exec(
          `UPDATE directives
           SET last_referenced_at = NOW()
           WHERE superseded_by IS NULL AND value = $1`,
          [directiveText],
        );
      }
    } finally {
      await db.close();
    }
  } catch {
    // Best-effort metadata update only.
  }
}

function toPreferenceRecord(row: RawPreferenceRow): PreferenceRecord {
  const createdAt = tsToString(row.created_at) ?? "";
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    sourceMsgId: row.source_msg_id,
    createdAt,
    eventTime: tsToString(row.event_time) ?? createdAt,
    supersededBy: row.superseded_by,
    supersededAt: tsToString(row.superseded_at),
  };
}
