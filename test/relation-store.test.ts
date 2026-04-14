import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RelationStore,
  detectRelationSignals,
  inferRelationDomain,
  normalizePersonName,
  updateRelation,
  upsertInfluenceRelation,
} from "../cli/relation-store.js";

describe("RelationStore", () => {
  let tmpDir: string;
  let store: RelationStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-relations-"));
    store = new RelationStore(join(tmpDir, ".squeeze"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts relations by person and domain", () => {
    store.upsert({
      id: "r1",
      person: "Tom",
      relation_type: "trust",
      domain: "tech",
      level: "medium",
      evidence: ["Tom recommended Redis."],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "recommended Redis",
    });
    store.upsert({
      id: "r2",
      person: "my mechanic Tom",
      relation_type: "trust",
      domain: "tech",
      level: "high",
      evidence: ["Tom was right about Redis."],
      last_updated: "2026-04-14T01:00:00.000Z",
      notes: "was right",
    });

    const relations = store.getAll();
    expect(relations).toHaveLength(1);
    expect(relations[0].person).toBe("Tom");
    expect(relations[0].level).toBe("high");
  });

  it("queries by normalized person", () => {
    store.upsert({
      id: "r1",
      person: "Tom",
      relation_type: "trust",
      domain: "tech",
      level: "high",
      evidence: ["Tom helped"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "helped",
    });
    store.upsert({
      id: "r2",
      person: "Tom",
      relation_type: "trust",
      domain: "architecture",
      level: "low",
      evidence: ["Tom was wrong"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "wrong",
    });

    expect(store.getByPerson("my manager Tom")).toHaveLength(2);
  });

  it("returns only high-trust relations from getTrusted", () => {
    store.upsert({
      id: "r1",
      person: "Tom",
      relation_type: "trust",
      domain: "tech",
      level: "high",
      evidence: ["good"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "good",
    });
    store.upsert({
      id: "r2",
      person: "Alice",
      relation_type: "trust",
      domain: "architecture",
      level: "low",
      evidence: ["bad"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "bad",
    });

    expect(store.getTrusted().map((relation) => relation.person)).toEqual(["Tom"]);
    expect(store.getTrusted("tech")).toHaveLength(1);
    expect(store.getTrusted("architecture")).toHaveLength(0);
  });

  it("renders compact trust and verify sections", () => {
    store.upsert({
      id: "r1",
      person: "Tom",
      relation_type: "trust",
      domain: "tech",
      level: "high",
      evidence: ["good"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "recommended Redis, worked well",
    });
    store.upsert({
      id: "r2",
      person: "Alice",
      relation_type: "trust",
      domain: "architecture",
      level: "low",
      evidence: ["bad"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "past suggestion caused bug",
    });

    const text = store.toCompactString();
    expect(text).toContain("People you trust:");
    expect(text).toContain("Tom (tech: high)");
    expect(text).toContain("People to verify:");
    expect(text).toContain("Alice (architecture: low)");
  });

  it("returns summary stats", () => {
    store.upsert({
      id: "r1",
      person: "Tom",
      relation_type: "trust",
      domain: "tech",
      level: "high",
      evidence: ["good"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "good",
    });
    store.upsert({
      id: "r2",
      person: "Tom",
      relation_type: "influence",
      domain: "tech",
      level: "high",
      evidence: ["good"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "good",
    });

    expect(store.getSummary()).toEqual({ total: 2, people: 1, high_trust: 1 });
  });

  it("persists relations in relations.json", () => {
    store.upsert({
      id: "r1",
      person: "Tom",
      relation_type: "trust",
      domain: "tech",
      level: "high",
      evidence: ["good"],
      last_updated: "2026-04-14T00:00:00.000Z",
      notes: "good",
    });

    const reloaded = new RelationStore(join(tmpDir, ".squeeze"));
    expect(reloaded.getAll()).toHaveLength(1);
    expect(reloaded.getAll()[0].person).toBe("Tom");
  });
});

describe("relation signal detection", () => {
  it("detects positive trust signals", () => {
    const signals = detectRelationSignals("Tom's recommendation worked really well for our Redis setup.");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ person: "Tom", type: "positive", domain: "tech" });
  });

  it("detects negative trust signals", () => {
    const signals = detectRelationSignals("Alice's suggestion caused a bug in our architecture.");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ person: "Alice", type: "negative", domain: "architecture" });
  });

  it("detects influence signals from named people", () => {
    const signals = detectRelationSignals("Bob suggested I add tests before merging.");
    expect(signals).toEqual([
      expect.objectContaining({ person: "Bob", type: "influence", domain: "code-review" }),
    ]);
  });

  it("detects influence signals from role names", () => {
    const signals = detectRelationSignals("My mentor thinks we should compare tradeoffs before deciding.");
    expect(signals).toEqual([
      expect.objectContaining({ person: "mentor", type: "influence" }),
    ]);
  });

  it("normalizes role phrases to the same person", () => {
    expect(normalizePersonName("my mechanic Tom")).toBe("Tom");
    expect(normalizePersonName("Tom")).toBe("Tom");
  });

  it("infers code-review and architecture domains", () => {
    expect(inferRelationDomain("Bob always catches naming and test coverage in review.")).toBe("code-review");
    expect(inferRelationDomain("Alice was wrong about the microservice architecture.")).toBe("architecture");
  });
});

describe("updateRelation", () => {
  let tmpDir: string;
  let store: RelationStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "squeeze-relations-update-"));
    store = new RelationStore(join(tmpDir, ".squeeze"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates new positive trust at medium", () => {
    updateRelation(store, "Tom", "positive", "tech", "Tom recommended Redis and it worked.");
    expect(store.getByPerson("Tom")[0]).toMatchObject({ level: "medium", domain: "tech" });
  });

  it("creates new negative trust at low", () => {
    updateRelation(store, "Alice", "negative", "architecture", "Alice's suggestion caused a bug.");
    expect(store.getByPerson("Alice")[0]).toMatchObject({ level: "low", domain: "architecture" });
  });

  it("evolves trust level up and down", () => {
    updateRelation(store, "Tom", "positive", "tech", "Tom helped once.");
    updateRelation(store, "Tom", "positive", "tech", "Tom was right again.");
    updateRelation(store, "Tom", "negative", "tech", "Tom was wrong once.");
    expect(store.getByPerson("Tom")[0].level).toBe("medium");
  });

  it("does not double-count the same evidence", () => {
    updateRelation(store, "Tom", "positive", "tech", "Tom helped once.");
    updateRelation(store, "Tom", "positive", "tech", "Tom helped once.");
    const relation = store.getByPerson("Tom")[0];
    expect(relation.level).toBe("medium");
    expect(relation.evidence).toEqual(["Tom helped once."]);
  });

  it("stores influence relations separately", () => {
    upsertInfluenceRelation(store, "mentor", "general", "My mentor suggested that I slow down.");
    upsertInfluenceRelation(store, "mentor", "general", "My mentor suggested that I slow down.");
    const relations = store.getByPerson("mentor");
    expect(relations).toHaveLength(1);
    expect(relations[0].relation_type).toBe("influence");
    expect(relations[0].evidence).toHaveLength(1);
  });
});
