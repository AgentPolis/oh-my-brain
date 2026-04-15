/**
 * DagStore — CRUD for dag_nodes (L1 summary tree).
 */

import type { BrainDB } from "./db.js";
import type { DagNode, Level } from "../types.js";

export interface InsertInput {
  parentId: number | null;
  abstract: string;
  overview: string;
  detail: string;
  sourceIds: number[];   // message row IDs (not turn numbers)
  minTurn: number;       // first turn_index in this batch (for human-readable labels)
  maxTurn: number;       // last turn_index in this batch
  level: Level | number;
}

export class DagStore {
  private db: BrainDB;

  constructor(db: BrainDB) {
    this.db = db;
  }

  async insert(node: InsertInput): Promise<number> {
    // Store turn range alongside source IDs for human-readable labels in assembler
    const sourceMeta = JSON.stringify({ ids: node.sourceIds, minTurn: node.minTurn, maxTurn: node.maxTurn });
    const rows = await this.db.query<{ id: number }>(
      `INSERT INTO dag_nodes (parent_id, abstract, overview, detail, source_ids, level)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        node.parentId,
        node.abstract,
        node.overview,
        node.detail,
        sourceMeta,
        node.level,
      ],
    );
    return rows[0].id;
  }

  async getAll(): Promise<DagNode[]> {
    const rows = await this.db.query<RawRow>(
      `SELECT * FROM dag_nodes ORDER BY id`,
    );
    return rows.map(toNode);
  }

  /** Get the N most recent abstract summaries (for assembler injection). */
  async getAbstracts(limit: number): Promise<DagNode[]> {
    const rows = await this.db.query<RawRow>(
      `SELECT * FROM dag_nodes ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.reverse().map(toNode);
  }

  async count(): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) as n FROM dag_nodes`,
    );
    return Number(rows[0].n);
  }
}

interface RawRow {
  id: number;
  parent_id: number | null;
  abstract: string;
  overview: string;
  detail: string;
  source_ids: string;
  level: number;
  created_at: string | Date;
}

interface SourceMeta {
  ids: number[];
  minTurn: number | null;
  maxTurn: number | null;
}

function toNode(row: RawRow): DagNode {
  const sourceMeta = parseSourceMeta(row.source_ids);
  return {
    id: row.id,
    parentId: row.parent_id,
    abstract: row.abstract,
    overview: row.overview,
    detail: row.detail,
    sourceIds: sourceMeta.ids,
    minTurn: sourceMeta.minTurn,
    maxTurn: sourceMeta.maxTurn,
    level: row.level as Level,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

function parseSourceMeta(raw: string): SourceMeta {
  try {
    const parsed = JSON.parse(raw) as unknown;

    // Backward compatibility: older rows may store source_ids as plain number[].
    if (Array.isArray(parsed)) {
      return {
        ids: parsed.filter((v): v is number => typeof v === "number"),
        minTurn: null,
        maxTurn: null,
      };
    }

    if (parsed && typeof parsed === "object") {
      const asObj = parsed as Record<string, unknown>;
      const ids = Array.isArray(asObj.ids)
        ? asObj.ids.filter((v): v is number => typeof v === "number")
        : [];
      const minTurn = typeof asObj.minTurn === "number" ? asObj.minTurn : null;
      const maxTurn = typeof asObj.maxTurn === "number" ? asObj.maxTurn : null;
      return { ids, minTurn, maxTurn };
    }
  } catch {
    // no-op: fall through to safe defaults
  }

  return { ids: [], minTurn: null, maxTurn: null };
}
