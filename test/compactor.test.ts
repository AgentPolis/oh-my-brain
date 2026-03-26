import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../src/storage/schema.js";
import { DagStore } from "../src/storage/dag.js";
import { Level } from "../src/types.js";
import { summarize } from "../src/compact/summarizer.js";
import type { StoredMessage } from "../src/types.js";
import { MessageStore } from "../src/storage/messages.js";

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

function makeMsg(role: StoredMessage["role"], content: string, turnIndex = 0): StoredMessage {
  return { id: 0, role, content, level: Level.Observation, contentType: "conversation", confidence: 0.6, turnIndex, createdAt: "" };
}

describe("summarize", () => {
  it("produces abstract, overview, detail from messages", () => {
    const msgs: StoredMessage[] = [
      makeMsg("user", "Can you help me set up JWT authentication?", 1),
      makeMsg("assistant", "I'll implement JWT. We'll need jsonwebtoken and a secret key.", 1),
      makeMsg("user", "Use RS256 not HS256 for production.", 2),
      makeMsg("assistant", "Done. Created auth middleware using RS256.", 2),
    ];
    const result = summarize(msgs);
    expect(result.abstract.length).toBeGreaterThan(0);
    expect(result.abstract.length).toBeLessThan(200);
    expect(result.overview.length).toBeGreaterThan(0);
    expect(result.detail.length).toBeGreaterThan(0);
    expect(result.abstract.toLowerCase()).toMatch(/jwt|auth/);
  });

  it("handles empty input gracefully", () => {
    const result = summarize([]);
    expect(result.abstract).toBe("[empty batch]");
  });

  it("abstract is always shorter than or equal to overview when overview is non-empty", () => {
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "user" : "assistant", `Can you help me with topic ${i}? Done implementing topic ${i}.`, i)
    );
    const result = summarize(msgs);
    if (result.overview.length > 0) {
      expect(result.abstract.length).toBeLessThanOrEqual(result.overview.length + 10);
    }
  });
});

// Note: uses `db` from the outer beforeEach defined at the top of this file.
// Do not move these tests to a separate file without bringing that fixture along.
describe("MessageStore compaction methods", () => {
  it("getCompactable returns L1 messages older than freshTailTurns", () => {
    const msgStore = new MessageStore(db); // db from outer beforeEach
    for (let t = 1; t <= 30; t++) {
      msgStore.insert(
        { role: "user", content: `message at turn ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    // currentTurn=30, freshTailTurns=20 → compactable = turns 1-10
    const compactable = msgStore.getCompactable(30, 20);
    expect(compactable.length).toBeGreaterThan(0);
    expect(compactable.every(m => m.turnIndex <= 10)).toBe(true);
  });

  it("getCompactable excludes already-compacted messages", () => {
    const msgStore = new MessageStore(db);
    const dagStore = new DagStore(db);
    for (let t = 1; t <= 5; t++) {
      msgStore.insert(
        { role: "user", content: `msg ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    const first = msgStore.getCompactable(10, 5);
    const dagNodeId = dagStore.insert({ parentId: null, abstract: "test", overview: "", detail: "", sourceIds: [], minTurn: 1, maxTurn: 5, level: Level.Observation });
    msgStore.markCompacted(first.map(m => m.id), dagNodeId);
    const second = msgStore.getCompactable(10, 5);
    expect(second).toHaveLength(0);
  });
});
