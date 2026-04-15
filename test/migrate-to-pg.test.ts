import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { migrateToPg } from "../cli/migrate-to-pg.js";
import { pgliteFactory } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrateToPg", () => {
  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "migrate-pg-"));
    mkdirSync(join(tmpDir, ".squeeze"), { recursive: true });
    return tmpDir;
  }

  it("imports archive.jsonl into archive table", async () => {
    const root = setup();
    writeFileSync(
      join(root, ".squeeze", "archive.jsonl"),
      [
        JSON.stringify({ id: "a1", ts: "2026-04-01T10:00:00Z", role: "user", content: "hello", summary: "greeting", level: 1, turn_index: 1, tags: ["test"] }),
        JSON.stringify({ id: "a2", ts: "2026-04-02T10:00:00Z", role: "assistant", content: "world", summary: "reply", level: 1, turn_index: 2, tags: [] }),
      ].join("\n"),
    );

    const result = await migrateToPg(root);
    expect(result.archiveImported).toBe(2);

    const db = await pgliteFactory.create(join(root, ".squeeze", "brain.pg"));
    await initPgSchema(db);
    const rows = await db.query<{ id: string }>("SELECT id FROM archive ORDER BY id");
    expect(rows).toHaveLength(2);
    await db.close();
  });

  it("imports events.jsonl with graph nodes and edges", async () => {
    const root = setup();
    writeFileSync(
      join(root, ".squeeze", "events.jsonl"),
      JSON.stringify({
        id: "e1",
        ts: "2026-04-01T10:00:00Z",
        what: "car service",
        category: "automotive",
        who: ["Tom", "Alice"],
      }),
    );

    const result = await migrateToPg(root);
    expect(result.eventsImported).toBe(1);
    expect(result.graphNodesCreated).toBeGreaterThanOrEqual(3); // event + 2 people
    expect(result.graphEdgesCreated).toBe(2); // 2 involved_in edges

    const db = await pgliteFactory.create(join(root, ".squeeze", "brain.pg"));
    await initPgSchema(db);
    const nodes = await db.query<{ id: string }>("SELECT id FROM graph_nodes");
    expect(nodes.length).toBeGreaterThanOrEqual(3);
    await db.close();
  });

  it("imports relations.json", async () => {
    const root = setup();
    writeFileSync(
      join(root, ".squeeze", "relations.json"),
      JSON.stringify([
        { id: "r1", person: "Tom", type: "trust", domain: "tech", level: "high" },
      ]),
    );

    const result = await migrateToPg(root);
    expect(result.relationsImported).toBe(1);
  });

  it("imports habits.json", async () => {
    const root = setup();
    writeFileSync(
      join(root, ".squeeze", "habits.json"),
      JSON.stringify([
        { id: "h1", pattern: "always review first", confidence: 0.9, occurrences: 3 },
      ]),
    );

    const result = await migrateToPg(root);
    expect(result.habitsImported).toBe(1);
  });

  it("imports schemas.json", async () => {
    const root = setup();
    writeFileSync(
      join(root, ".squeeze", "schemas.json"),
      JSON.stringify([
        { id: "s1", name: "code-review", description: "standard review flow", steps: ["read", "comment", "approve"] },
      ]),
    );

    const result = await migrateToPg(root);
    expect(result.schemasImported).toBe(1);
  });

  it("is idempotent — running twice does not duplicate data", async () => {
    const root = setup();
    writeFileSync(
      join(root, ".squeeze", "events.jsonl"),
      JSON.stringify({ id: "e1", what: "test event", who: [] }),
    );

    const r1 = await migrateToPg(root);
    const r2 = await migrateToPg(root);
    expect(r1.eventsImported).toBe(1);
    expect(r2.eventsImported).toBe(0);
  });

  it("renames old brain.db to brain.db.bak", async () => {
    const root = setup();
    writeFileSync(join(root, ".squeeze", "brain.db"), "fake sqlite");

    await migrateToPg(root);
    expect(existsSync(join(root, ".squeeze", "brain.db"))).toBe(false);
    expect(existsSync(join(root, ".squeeze", "brain.db.bak"))).toBe(true);
  });

  it("handles missing files gracefully", async () => {
    const root = setup();
    const result = await migrateToPg(root);
    expect(result.archiveImported).toBe(0);
    expect(result.eventsImported).toBe(0);
    expect(result.relationsImported).toBe(0);
    expect(result.habitsImported).toBe(0);
    expect(result.schemasImported).toBe(0);
  });
});
