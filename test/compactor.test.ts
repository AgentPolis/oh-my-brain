import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/schema.js";
import { DagStore } from "../src/storage/dag.js";
import { Level } from "../src/types.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => db.close());

describe("DagStore", () => {
  it("inserts a dag node and retrieves it", () => {
    const dagStore = new DagStore(db);
    const id = dagStore.insert({
      parentId: null,
      abstract: "User asked about authentication",
      overview: "Decided to use JWT. Rejected sessions due to scale.",
      detail: "Full conversation...",
      sourceIds: [1, 2, 3],
      minTurn: 1,
      maxTurn: 3,
      level: Level.Observation,
    });
    expect(id).toBeGreaterThan(0);

    const nodes = dagStore.getAll();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].abstract).toBe("User asked about authentication");
    // sourceIds is now JSON with {ids, minTurn, maxTurn}
    const parsed = JSON.parse(nodes[0].sourceIds as unknown as string);
    expect(parsed.ids).toEqual([1, 2, 3]);
    expect(parsed.minTurn).toBe(1);
    expect(parsed.maxTurn).toBe(3);
  });

  it("getAbstracts returns summaries ordered by creation", () => {
    const dagStore = new DagStore(db);
    dagStore.insert({ parentId: null, abstract: "A", overview: "", detail: "", sourceIds: [1], minTurn: 1, maxTurn: 1, level: Level.Observation });
    dagStore.insert({ parentId: null, abstract: "B", overview: "", detail: "", sourceIds: [2], minTurn: 2, maxTurn: 2, level: Level.Observation });
    const abstracts = dagStore.getAbstracts(10);
    expect(abstracts.map(n => n.abstract)).toEqual(["A", "B"]);
  });
});
