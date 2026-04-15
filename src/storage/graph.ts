/**
 * GraphStore — unified knowledge graph backed by graph_nodes + graph_edges tables.
 * Every memory entity (event, directive, person, habit, schema) becomes a node.
 * Relationships between entities become edges.
 * Multi-hop traversal via PostgreSQL recursive CTE.
 */

import type { BrainDB } from "./db.js";

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  detail: string | null;
  ts: string | null;
  tsPrecision: string;
  category: string | null;
  sentiment: string | null;
  sourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface RawNodeRow {
  id: string;
  type: string;
  label: string;
  detail: string | null;
  ts: string | Date | null;
  ts_precision: string;
  category: string | null;
  sentiment: string | null;
  source_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
}

interface RawEdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  confidence: number;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
}

function tsStr(val: string | Date | null | undefined): string {
  if (val == null) return "";
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toGraphNode(row: RawNodeRow): GraphNode {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    detail: row.detail,
    ts: row.ts ? tsStr(row.ts) : null,
    tsPrecision: row.ts_precision ?? "exact",
    category: row.category,
    sentiment: row.sentiment,
    sourceId: row.source_id,
    metadata: row.metadata,
    createdAt: tsStr(row.created_at),
  };
}

function toGraphEdge(row: RawEdgeRow): GraphEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    type: row.type,
    confidence: row.confidence,
    metadata: row.metadata,
    createdAt: tsStr(row.created_at),
  };
}

export class GraphStore {
  constructor(private db: BrainDB) {}

  /** Add a node to the graph. Upserts — existing nodes are updated. */
  async addNode(node: {
    id: string;
    type: string;
    label: string;
    detail?: string;
    ts?: string;
    tsPrecision?: string;
    category?: string;
    sentiment?: string;
    sourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.exec(
      `INSERT INTO graph_nodes (id, type, label, detail, ts, ts_precision, category, sentiment, source_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         detail = COALESCE(EXCLUDED.detail, graph_nodes.detail),
         ts = COALESCE(EXCLUDED.ts, graph_nodes.ts),
         category = COALESCE(EXCLUDED.category, graph_nodes.category),
         sentiment = COALESCE(EXCLUDED.sentiment, graph_nodes.sentiment),
         metadata = COALESCE(EXCLUDED.metadata, graph_nodes.metadata)`,
      [
        node.id,
        node.type,
        node.label,
        node.detail ?? null,
        node.ts ?? null,
        node.tsPrecision ?? "exact",
        node.category ?? null,
        node.sentiment ?? null,
        node.sourceId ?? null,
        node.metadata ? JSON.stringify(node.metadata) : null,
      ],
    );
  }

  /** Add an edge between two nodes. Upserts on id. */
  async addEdge(edge: {
    id: string;
    fromId: string;
    toId: string;
    type: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.exec(
      `INSERT INTO graph_edges (id, from_id, to_id, type, confidence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         confidence = EXCLUDED.confidence,
         metadata = COALESCE(EXCLUDED.metadata, graph_edges.metadata)`,
      [
        edge.id,
        edge.fromId,
        edge.toId,
        edge.type,
        edge.confidence ?? 0.5,
        edge.metadata ? JSON.stringify(edge.metadata) : null,
      ],
    );
  }

  /** Get a node by its id. */
  async getNode(id: string): Promise<GraphNode | null> {
    const rows = await this.db.query<RawNodeRow>(
      `SELECT * FROM graph_nodes WHERE id = $1`,
      [id],
    );
    return rows.length > 0 ? toGraphNode(rows[0]) : null;
  }

  /** Find nodes connected to a given node (1-hop). */
  async getNeighbors(nodeId: string, edgeType?: string): Promise<GraphNode[]> {
    const sql = edgeType
      ? `SELECT n.* FROM graph_nodes n
         JOIN graph_edges e ON (e.to_id = n.id OR e.from_id = n.id)
         WHERE (e.from_id = $1 OR e.to_id = $1) AND n.id != $1 AND e.type = $2`
      : `SELECT n.* FROM graph_nodes n
         JOIN graph_edges e ON (e.to_id = n.id OR e.from_id = n.id)
         WHERE (e.from_id = $1 OR e.to_id = $1) AND n.id != $1`;
    const params = edgeType ? [nodeId, edgeType] : [nodeId];
    const rows = await this.db.query<RawNodeRow>(sql, params);
    return rows.map(toGraphNode);
  }

  /** Find path between two nodes (multi-hop, up to maxDepth). */
  async findPath(fromId: string, toId: string, maxDepth = 5): Promise<GraphNode[]> {
    const rows = await this.db.query<RawNodeRow>(
      `WITH RECURSIVE connected AS (
         SELECT to_id AS node_id, 1 AS depth
         FROM graph_edges
         WHERE from_id = $1

         UNION ALL

         SELECT e.to_id, c.depth + 1
         FROM graph_edges e
         JOIN connected c ON e.from_id = c.node_id
         WHERE c.depth < $3
       )
       SELECT DISTINCT n.*
       FROM connected c
       JOIN graph_nodes n ON n.id = c.node_id
       WHERE c.node_id = $2 OR EXISTS (
         SELECT 1 FROM connected WHERE node_id = $2
       )`,
      [fromId, toId, maxDepth],
    );
    return rows.map(toGraphNode);
  }

  /** Search nodes by type + keyword. */
  async searchNodes(opts: {
    type?: string;
    keyword?: string;
    category?: string;
    limit?: number;
  }): Promise<GraphNode[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts.type) {
      conditions.push(`type = $${paramIdx++}`);
      params.push(opts.type);
    }
    if (opts.keyword) {
      conditions.push(`(label ILIKE $${paramIdx} OR detail ILIKE $${paramIdx})`);
      paramIdx++;
      params.push(`%${opts.keyword}%`);
    }
    if (opts.category) {
      conditions.push(`category = $${paramIdx++}`);
      params.push(opts.category);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    params.push(limit);

    const rows = await this.db.query<RawNodeRow>(
      `SELECT * FROM graph_nodes ${where} ORDER BY created_at DESC LIMIT $${paramIdx}`,
      params,
    );
    return rows.map(toGraphNode);
  }

  /** Get graph summary for brain_recall. */
  async getSummary(): Promise<{
    totalNodes: number;
    totalEdges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
  }> {
    const nodeCount = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) as n FROM graph_nodes`,
    );
    const edgeCount = await this.db.query<{ n: number }>(
      `SELECT COUNT(*) as n FROM graph_edges`,
    );
    const nodeTypes = await this.db.query<{ type: string; cnt: number }>(
      `SELECT type, COUNT(*) as cnt FROM graph_nodes GROUP BY type`,
    );
    const edgeTypes = await this.db.query<{ type: string; cnt: number }>(
      `SELECT type, COUNT(*) as cnt FROM graph_edges GROUP BY type`,
    );

    const nodesByType: Record<string, number> = {};
    for (const row of nodeTypes) nodesByType[row.type] = Number(row.cnt);

    const edgesByType: Record<string, number> = {};
    for (const row of edgeTypes) edgesByType[row.type] = Number(row.cnt);

    return {
      totalNodes: Number(nodeCount[0].n),
      totalEdges: Number(edgeCount[0].n),
      nodesByType,
      edgesByType,
    };
  }

  /** Compact timeline string from graph nodes. */
  async toTimelineString(limit = 20): Promise<string> {
    const rows = await this.db.query<RawNodeRow>(
      `SELECT * FROM graph_nodes WHERE ts IS NOT NULL ORDER BY ts DESC LIMIT $1`,
      [limit],
    );
    if (rows.length === 0) return "(no timeline entries)";
    return rows
      .map(toGraphNode)
      .map((n) => `[${n.ts}] ${n.type}: ${n.label}`)
      .reverse()
      .join("\n");
  }
}
