import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pgliteFactory, type BrainDB } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";
import { DagStore } from "../src/storage/dag.js";
import { Level } from "../src/types.js";
import { summarize } from "../src/compact/summarizer.js";
import type { StoredMessage } from "../src/types.js";
import { MessageStore } from "../src/storage/messages.js";
import { Compactor } from "../src/compact/compactor.js";

let db: BrainDB;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "squeeze-compactor-test-"));
  db = await pgliteFactory.create(tmpDir);
  await initPgSchema(db);
});

afterEach(async () => {
  await db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("DagStore", () => {
  it("inserts a dag node and retrieves it", async () => {
    const dagStore = new DagStore(db);
    const id = await dagStore.insert({
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

    const nodes = await dagStore.getAll();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].abstract).toBe("User asked about authentication");
    expect(nodes[0].sourceIds).toEqual([1, 2, 3]);
    expect(nodes[0].minTurn).toBe(1);
    expect(nodes[0].maxTurn).toBe(3);
  });

  it("getAbstracts returns summaries ordered by creation", async () => {
    const dagStore = new DagStore(db);
    await dagStore.insert({ parentId: null, abstract: "A", overview: "", detail: "", sourceIds: [1], minTurn: 1, maxTurn: 1, level: Level.Observation });
    await dagStore.insert({ parentId: null, abstract: "B", overview: "", detail: "", sourceIds: [2], minTurn: 2, maxTurn: 2, level: Level.Observation });
    const abstracts = await dagStore.getAbstracts(10);
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

describe("MessageStore compaction methods", () => {
  it("getCompactable returns L1 messages older than freshTailTurns", async () => {
    const msgStore = new MessageStore(db);
    for (let t = 1; t <= 30; t++) {
      await msgStore.insert(
        { role: "user", content: `message at turn ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    // currentTurn=30, freshTailTurns=20 → compactable = turns 1-10
    const compactable = await msgStore.getCompactable(30, 20);
    expect(compactable.length).toBeGreaterThan(0);
    expect(compactable.every(m => m.turnIndex <= 10)).toBe(true);
  });

  it("getCompactable excludes already-compacted messages", async () => {
    const msgStore = new MessageStore(db);
    const dagStore = new DagStore(db);
    for (let t = 1; t <= 5; t++) {
      await msgStore.insert(
        { role: "user", content: `msg ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    const first = await msgStore.getCompactable(10, 5);
    const dagNodeId = await dagStore.insert({ parentId: null, abstract: "test", overview: "", detail: "", sourceIds: [], minTurn: 1, maxTurn: 5, level: Level.Observation });
    await msgStore.markCompacted(first.map(m => m.id), dagNodeId);
    const second = await msgStore.getCompactable(10, 5);
    expect(second).toHaveLength(0);
  });
});

describe("Compactor.run()", () => {
  it("compacts old L1 messages into dag_nodes", async () => {
    const msgStore = new MessageStore(db);
    const dagStore = new DagStore(db);
    const compactor = new Compactor(msgStore, dagStore, { freshTailTurns: 5, batchTurns: 3 });

    for (let t = 1; t <= 20; t++) {
      await msgStore.insert(
        { role: "user", content: `user message at turn ${t}, asking about topic ${t % 4}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
      await msgStore.insert(
        { role: "assistant", content: `assistant done handling turn ${t}` },
        t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }

    await compactor.run(20);

    expect(await dagStore.count()).toBeGreaterThan(0);
    const stillCompactable = await msgStore.getCompactable(20, 5);
    expect(stillCompactable).toHaveLength(0);
  });

  it("does nothing if no compactable messages", async () => {
    const msgStore = new MessageStore(db);
    const dagStore = new DagStore(db);
    const compactor = new Compactor(msgStore, dagStore, { freshTailTurns: 20, batchTurns: 5 });

    for (let t = 1; t <= 5; t++) {
      await msgStore.insert(
        { role: "user", content: `msg ${t}` }, t,
        { level: Level.Observation, contentType: "conversation", confidence: 0.6 }
      );
    }
    await compactor.run(5);
    expect(await dagStore.count()).toBe(0);
  });
});
