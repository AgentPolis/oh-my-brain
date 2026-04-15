/**
 * One-time migration: JSONL/JSON files → PostgreSQL tables + knowledge graph.
 *
 * Usage:
 *   oh-my-brain migrate-to-pg [--project-root <path>]
 *
 * Reads:
 *   .squeeze/archive.jsonl → archive table
 *   .squeeze/events.jsonl  → events table
 *   .squeeze/relations.json → relations table
 *   .squeeze/habits.json   → habits table
 *   .squeeze/schemas.json  → schemas table
 *
 * Also creates graph nodes/edges from all imported data.
 * Idempotent — running twice does not duplicate data.
 */

import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { pgliteFactory, type BrainDB } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";
import { GraphStore } from "../src/storage/graph.js";

interface MigrationResult {
  archiveImported: number;
  eventsImported: number;
  relationsImported: number;
  habitsImported: number;
  schemasImported: number;
  graphNodesCreated: number;
  graphEdgesCreated: number;
  oldDbRenamed: boolean;
}

function readJsonl<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function migrateToPg(projectRoot: string): Promise<MigrationResult> {
  const squeezePath = join(projectRoot, ".squeeze");
  const pgDir = join(squeezePath, "brain.pg");

  const db = await pgliteFactory.create(pgDir);
  await initPgSchema(db);
  const graph = new GraphStore(db);

  const result: MigrationResult = {
    archiveImported: 0,
    eventsImported: 0,
    relationsImported: 0,
    habitsImported: 0,
    schemasImported: 0,
    graphNodesCreated: 0,
    graphEdgesCreated: 0,
    oldDbRenamed: false,
  };

  try {
    // ── Archive ──
    const archiveEntries = readJsonl<Record<string, unknown>>(join(squeezePath, "archive.jsonl"));
    for (const entry of archiveEntries) {
      const id = String(entry.id ?? randomUUID());
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM archive WHERE id = $1", [id],
      );
      if (existing.length > 0) continue;

      await db.exec(
        `INSERT INTO archive (id, ts, ts_ingest, role, content, summary, level, turn_index, session_id, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          entry.ts ?? null,
          entry.ingest_ts ?? entry.ts_ingest ?? null,
          entry.role ?? null,
          String(entry.content ?? ""),
          entry.summary ?? null,
          entry.level ?? null,
          entry.turn_index ?? null,
          entry.session_id ?? null,
          Array.isArray(entry.tags) ? entry.tags : null,
        ],
      );
      result.archiveImported++;
    }

    // ── Events ──
    const eventEntries = readJsonl<Record<string, unknown>>(join(squeezePath, "events.jsonl"));
    for (const entry of eventEntries) {
      const id = String(entry.id ?? randomUUID());
      const existing = await db.query<{ id: string }>(
        "SELECT id FROM events WHERE id = $1", [id],
      );
      if (existing.length > 0) continue;

      await db.exec(
        `INSERT INTO events (id, ts, ts_ingest, ts_precision, what, detail, category, who, "where", sentiment, viewpoint, insight, source_text, session_id, turn_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          id,
          entry.ts ?? null,
          entry.ts_ingest ?? null,
          entry.ts_precision ?? "exact",
          String(entry.what ?? ""),
          entry.detail ?? null,
          entry.category ?? null,
          Array.isArray(entry.who) ? entry.who : null,
          entry.where ?? null,
          entry.sentiment ?? null,
          entry.viewpoint ?? null,
          entry.insight ?? null,
          entry.source_text ?? null,
          entry.session_id ?? null,
          entry.turn_index ?? null,
        ],
      );
      result.eventsImported++;

      // Create graph node for event
      const nodeId = `evt-${id}`;
      await graph.addNode({
        id: nodeId,
        type: "event",
        label: String(entry.what ?? ""),
        detail: entry.detail ? String(entry.detail) : undefined,
        ts: entry.ts ? String(entry.ts) : undefined,
        category: entry.category ? String(entry.category) : undefined,
        sentiment: entry.sentiment ? String(entry.sentiment) : undefined,
        sourceId: id,
      });
      result.graphNodesCreated++;

      // Link people to event
      const who = Array.isArray(entry.who) ? entry.who : [];
      for (const person of who) {
        const personId = `per-${String(person).toLowerCase().replace(/\s+/g, "-")}`;
        await graph.addNode({ id: personId, type: "person", label: String(person) });
        result.graphNodesCreated++;
        await graph.addEdge({
          id: `edge-${id}-${personId}`,
          fromId: personId,
          toId: nodeId,
          type: "involved_in",
        });
        result.graphEdgesCreated++;
      }
    }

    // ── Relations ──
    const relationsData = readJson<Record<string, unknown>[]>(join(squeezePath, "relations.json"));
    if (Array.isArray(relationsData)) {
      for (const rel of relationsData) {
        const id = String(rel.id ?? randomUUID());
        const existing = await db.query<{ id: string }>(
          "SELECT id FROM relations WHERE id = $1", [id],
        );
        if (existing.length > 0) continue;

        const personId = `per-${String(rel.person ?? "").toLowerCase().replace(/\s+/g, "-")}`;
        await graph.addNode({ id: personId, type: "person", label: String(rel.person ?? "") });

        await db.exec(
          `INSERT INTO relations (id, person, relation_type, domain, level, evidence, notes, graph_node_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            id,
            String(rel.person ?? ""),
            String(rel.type ?? rel.relation_type ?? ""),
            String(rel.domain ?? ""),
            String(rel.level ?? "medium"),
            Array.isArray(rel.evidence) ? rel.evidence : null,
            rel.notes ?? null,
            personId,
          ],
        );
        result.relationsImported++;
        result.graphNodesCreated++;
      }
    }

    // ── Habits ──
    const habitsData = readJson<Record<string, unknown>[]>(join(squeezePath, "habits.json"));
    if (Array.isArray(habitsData)) {
      for (const habit of habitsData) {
        const id = String(habit.id ?? randomUUID());
        const existing = await db.query<{ id: string }>(
          "SELECT id FROM habits WHERE id = $1", [id],
        );
        if (existing.length > 0) continue;

        const nodeId = `hab-${id}`;
        await graph.addNode({
          id: nodeId,
          type: "habit",
          label: String(habit.pattern ?? ""),
          sourceId: id,
        });

        await db.exec(
          `INSERT INTO habits (id, pattern, confidence, evidence, occurrences, graph_node_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            String(habit.pattern ?? ""),
            habit.confidence ?? 0.5,
            Array.isArray(habit.evidence) ? habit.evidence : null,
            habit.occurrences ?? 0,
            nodeId,
          ],
        );
        result.habitsImported++;
        result.graphNodesCreated++;
      }
    }

    // ── Schemas ──
    const schemasData = readJson<Record<string, unknown>[]>(join(squeezePath, "schemas.json"));
    if (Array.isArray(schemasData)) {
      for (const schema of schemasData) {
        const id = String(schema.id ?? randomUUID());
        const existing = await db.query<{ id: string }>(
          "SELECT id FROM schemas WHERE id = $1", [id],
        );
        if (existing.length > 0) continue;

        const nodeId = `sch-${id}`;
        await graph.addNode({
          id: nodeId,
          type: "schema",
          label: String(schema.name ?? ""),
          sourceId: id,
        });

        await db.exec(
          `INSERT INTO schemas (id, name, description, steps, category, confidence, graph_node_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            String(schema.name ?? ""),
            schema.description ?? null,
            Array.isArray(schema.steps) ? schema.steps : null,
            schema.category ?? null,
            schema.confidence ?? 0.5,
            nodeId,
          ],
        );
        result.schemasImported++;
        result.graphNodesCreated++;
      }
    }

    // ── Rename old SQLite db ──
    const oldDbPath = join(squeezePath, "brain.db");
    if (existsSync(oldDbPath)) {
      renameSync(oldDbPath, `${oldDbPath}.bak`);
      result.oldDbRenamed = true;
    }
  } finally {
    await db.close();
  }

  return result;
}

export async function runMigrateCli(
  args: string[],
  projectRoot?: string,
): Promise<number> {
  const rootIdx = args.indexOf("--project-root");
  const root =
    projectRoot ??
    (rootIdx >= 0 ? args[rootIdx + 1] : process.cwd());

  process.stdout.write(`[oh-my-brain] migrating ${root} to PGLite...\n`);

  try {
    const result = await migrateToPg(root);
    process.stdout.write(
      `[oh-my-brain] migration complete:\n` +
      `  archive: ${result.archiveImported} entries\n` +
      `  events: ${result.eventsImported} entries\n` +
      `  relations: ${result.relationsImported} entries\n` +
      `  habits: ${result.habitsImported} entries\n` +
      `  schemas: ${result.schemasImported} entries\n` +
      `  graph nodes: ${result.graphNodesCreated}\n` +
      `  graph edges: ${result.graphEdgesCreated}\n` +
      `  old db renamed: ${result.oldDbRenamed}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`[oh-my-brain] migration failed: ${err}\n`);
    return 1;
  }
}
