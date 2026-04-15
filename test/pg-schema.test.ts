import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pgliteFactory, type BrainDB } from "../src/storage/db.js";
import { initPgSchema, checkPgIntegrity, PG_SCHEMA_VERSION } from "../src/storage/pg-schema.js";

let db: BrainDB;

afterEach(async () => {
  if (db) await db.close();
});

async function freshDb(): Promise<BrainDB> {
  const dir = mkdtempSync(join(tmpdir(), "pg-schema-"));
  db = await pgliteFactory.create(dir);
  return db;
}

describe("initPgSchema", () => {
  it("creates all core tables", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    const tables = await d.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = tables.map((t) => t.tablename);
    expect(names).toContain("messages");
    expect(names).toContain("dag_nodes");
    expect(names).toContain("directives");
    expect(names).toContain("preferences");
    expect(names).toContain("mention_counts");
    expect(names).toContain("schema_meta");
  });

  it("creates knowledge graph tables", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    const tables = await d.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = tables.map((t) => t.tablename);
    expect(names).toContain("graph_nodes");
    expect(names).toContain("graph_edges");
  });

  it("creates unified store tables", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    const tables = await d.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = tables.map((t) => t.tablename);
    expect(names).toContain("events");
    expect(names).toContain("archive");
    expect(names).toContain("relations");
    expect(names).toContain("habits");
    expect(names).toContain("schemas");
  });

  it("sets schema version", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    const rows = await d.query<{ value: string }>(
      `SELECT value FROM schema_meta WHERE key = 'version'`,
    );
    expect(rows[0].value).toBe(String(PG_SCHEMA_VERSION));
  });

  it("is idempotent — calling twice does not error", async () => {
    const d = await freshDb();
    await initPgSchema(d);
    await initPgSchema(d);

    const rows = await d.query<{ value: string }>(
      `SELECT value FROM schema_meta WHERE key = 'version'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("supports inserting a message row", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    await d.exec(
      `INSERT INTO messages (role, content, level, turn_index) VALUES ($1, $2, $3, $4)`,
      ["user", "hello", 1, 0],
    );

    const rows = await d.query<{ id: number; role: string; content: string }>(
      "SELECT id, role, content FROM messages",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("user");
    expect(rows[0].content).toBe("hello");
  });

  it("supports graph_nodes and graph_edges with JSONB", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    await d.exec(
      `INSERT INTO graph_nodes (id, type, label, metadata) VALUES ($1, $2, $3, $4)`,
      ["n1", "event", "Test event", JSON.stringify({ foo: "bar" })],
    );
    await d.exec(
      `INSERT INTO graph_nodes (id, type, label) VALUES ($1, $2, $3)`,
      ["n2", "person", "Alice"],
    );
    await d.exec(
      `INSERT INTO graph_edges (id, from_id, to_id, type) VALUES ($1, $2, $3, $4)`,
      ["e1", "n1", "n2", "involved_in"],
    );

    const edges = await d.query<{ from_id: string; to_id: string }>(
      "SELECT from_id, to_id FROM graph_edges",
    );
    expect(edges).toEqual([{ from_id: "n1", to_id: "n2" }]);
  });

  it("supports PostgreSQL array types in events table", async () => {
    const d = await freshDb();
    await initPgSchema(d);

    await d.exec(
      `INSERT INTO events (id, what, who) VALUES ($1, $2, $3)`,
      ["ev1", "meeting", ["Alice", "Bob"]],
    );

    const rows = await d.query<{ who: string[] }>(
      "SELECT who FROM events WHERE id = $1",
      ["ev1"],
    );
    expect(rows[0].who).toEqual(["Alice", "Bob"]);
  });
});

describe("checkPgIntegrity", () => {
  it("returns true for a healthy database", async () => {
    const d = await freshDb();
    expect(await checkPgIntegrity(d)).toBe(true);
  });
});
