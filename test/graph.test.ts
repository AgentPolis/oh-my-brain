import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pgliteFactory, type BrainDB } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";
import { GraphStore } from "../src/storage/graph.js";

let db: BrainDB;
let tmpDir: string;

afterEach(async () => {
  if (db) await db.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

async function freshGraph(): Promise<GraphStore> {
  tmpDir = mkdtempSync(join(tmpdir(), "graph-test-"));
  db = await pgliteFactory.create(tmpDir);
  await initPgSchema(db);
  return new GraphStore(db);
}

describe("GraphStore", () => {
  it("adds and retrieves a node", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "evt-1", type: "event", label: "car service" });
    const node = await g.getNode("evt-1");
    expect(node).not.toBeNull();
    expect(node!.type).toBe("event");
    expect(node!.label).toBe("car service");
  });

  it("upserts nodes — second add updates label", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "per-alice", type: "person", label: "Alice" });
    await g.addNode({ id: "per-alice", type: "person", label: "Alice Chen" });
    const node = await g.getNode("per-alice");
    expect(node!.label).toBe("Alice Chen");
  });

  it("adds edges between nodes", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "per-tom", type: "person", label: "Tom" });
    await g.addNode({ id: "evt-1", type: "event", label: "car service" });
    await g.addEdge({ id: "e1", fromId: "per-tom", toId: "evt-1", type: "involved_in" });

    const neighbors = await g.getNeighbors("per-tom");
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe("evt-1");
  });

  it("getNeighbors filters by edge type", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "per-tom", type: "person", label: "Tom" });
    await g.addNode({ id: "evt-1", type: "event", label: "car service" });
    await g.addNode({ id: "dir-1", type: "directive", label: "check reliability" });
    await g.addEdge({ id: "e1", fromId: "per-tom", toId: "evt-1", type: "involved_in" });
    await g.addEdge({ id: "e2", fromId: "per-tom", toId: "dir-1", type: "triggered" });

    const involved = await g.getNeighbors("per-tom", "involved_in");
    expect(involved).toHaveLength(1);
    expect(involved[0].id).toBe("evt-1");

    const all = await g.getNeighbors("per-tom");
    expect(all).toHaveLength(2);
  });

  it("multi-hop traversal via findPath", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "a", type: "person", label: "Alice" });
    await g.addNode({ id: "b", type: "event", label: "meeting" });
    await g.addNode({ id: "c", type: "directive", label: "always take notes" });
    await g.addEdge({ id: "e1", fromId: "a", toId: "b", type: "involved_in" });
    await g.addEdge({ id: "e2", fromId: "b", toId: "c", type: "triggered" });

    const path = await g.findPath("a", "c", 3);
    expect(path.length).toBeGreaterThan(0);
    expect(path.some((n) => n.id === "c")).toBe(true);
  });

  it("searchNodes by type", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "per-1", type: "person", label: "Alice" });
    await g.addNode({ id: "per-2", type: "person", label: "Bob" });
    await g.addNode({ id: "evt-1", type: "event", label: "lunch" });

    const people = await g.searchNodes({ type: "person" });
    expect(people).toHaveLength(2);
    expect(people.every((n) => n.type === "person")).toBe(true);
  });

  it("searchNodes by keyword (case-insensitive)", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "evt-1", type: "event", label: "Car service at Lexus dealer" });
    await g.addNode({ id: "evt-2", type: "event", label: "Lunch meeting" });

    const results = await g.searchNodes({ keyword: "lexus" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("evt-1");
  });

  it("searchNodes by category", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "evt-1", type: "event", label: "trip", category: "travel" });
    await g.addNode({ id: "evt-2", type: "event", label: "lunch", category: "food" });

    const travel = await g.searchNodes({ category: "travel" });
    expect(travel).toHaveLength(1);
    expect(travel[0].label).toBe("trip");
  });

  it("searchNodes respects limit", async () => {
    const g = await freshGraph();
    for (let i = 0; i < 10; i++) {
      await g.addNode({ id: `n-${i}`, type: "event", label: `event ${i}` });
    }
    const results = await g.searchNodes({ type: "event", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("getSummary returns correct counts", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "per-1", type: "person", label: "Alice" });
    await g.addNode({ id: "evt-1", type: "event", label: "meeting" });
    await g.addEdge({ id: "e1", fromId: "per-1", toId: "evt-1", type: "involved_in" });

    const summary = await g.getSummary();
    expect(summary.totalNodes).toBe(2);
    expect(summary.totalEdges).toBe(1);
    expect(summary.nodesByType.person).toBe(1);
    expect(summary.nodesByType.event).toBe(1);
    expect(summary.edgesByType.involved_in).toBe(1);
  });

  it("toTimelineString formats nodes with timestamps", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "evt-1", type: "event", label: "flight to Seattle", ts: "2026-04-01T10:00:00.000Z" });
    await g.addNode({ id: "evt-2", type: "event", label: "meeting with Tom", ts: "2026-04-02T14:00:00.000Z" });

    const timeline = await g.toTimelineString();
    expect(timeline).toContain("flight to Seattle");
    expect(timeline).toContain("meeting with Tom");
  });

  it("stores JSONB metadata on nodes", async () => {
    const g = await freshGraph();
    await g.addNode({
      id: "evt-1",
      type: "event",
      label: "deployment",
      metadata: { env: "production", version: "2.0" },
    });

    const node = await g.getNode("evt-1");
    expect(node!.metadata).toEqual({ env: "production", version: "2.0" });
  });

  it("edge confidence defaults to 0.5", async () => {
    const g = await freshGraph();
    await g.addNode({ id: "a", type: "person", label: "A" });
    await g.addNode({ id: "b", type: "event", label: "B" });
    await g.addEdge({ id: "e1", fromId: "a", toId: "b", type: "involved_in" });

    const rows = await db.query<{ confidence: number }>(
      "SELECT confidence FROM graph_edges WHERE id = $1",
      ["e1"],
    );
    expect(rows[0].confidence).toBe(0.5);
  });
});
