import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pgliteFactory, type BrainDB } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";
import { ArchiveStore, estimateArchiveTimestamp, extractTags } from "../src/storage/archive.js";
import { DagStore } from "../src/storage/dag.js";
import { MessageStore } from "../src/storage/messages.js";
import { Compactor } from "../src/compact/compactor.js";
import { Level } from "../src/types.js";

describe("ArchiveStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-archive-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(maxMb = 100): ArchiveStore {
    return new ArchiveStore(join(tmp, ".squeeze"), maxMb);
  }

  function seedArchive(store: ArchiveStore) {
    store.append([
      {
        id: "a1",
        ts: "2026-04-06T14:32:00.000Z",
        ingest_ts: "2026-04-06T14:35:00.000Z",
        role: "user",
        content: "I just got my car serviced today and the GPS still fails.",
        summary: "car service and GPS issue",
        level: 1,
        turn_index: 12,
        session_id: "sess-1",
        tags: ["service", "gps"],
      },
      {
        id: "a2",
        ts: "2026-04-07T10:00:00.000Z",
        ingest_ts: "2026-04-07T10:02:00.000Z",
        role: "assistant",
        content: "We decided to keep the TypeScript setup and review deployment later.",
        summary: "TypeScript setup and deployment review",
        level: 1,
        turn_index: 13,
        session_id: "sess-2",
        tags: ["typescript", "deployment"],
      },
    ]);
  }

  it("creates archive.jsonl on first append", () => {
    const store = makeStore();
    seedArchive(store);
    expect(existsSync(store.getArchivePath())).toBe(true);
  });

  it("appends entries without overwriting existing lines", () => {
    const store = makeStore();
    seedArchive(store);
    store.append([
      {
        id: "a3",
        ts: "2026-04-08T09:00:00.000Z",
        ingest_ts: "2026-04-08T09:01:00.000Z",
        role: "user",
        content: "Follow up on the car service and deployment checklist.",
        summary: "follow-up tasks",
        level: 1,
        turn_index: 14,
        tags: ["service", "deployment"],
      },
    ]);
    expect(store.readAll()).toHaveLength(3);
  });

  it("searches by exact day range", () => {
    const store = makeStore();
    seedArchive(store);
    const results = store.searchByTime("2026-04-06", "2026-04-06");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a1");
  });

  it("searches by full timestamp range", () => {
    const store = makeStore();
    seedArchive(store);
    const results = store.searchByTime("2026-04-06T00:00:00.000Z", "2026-04-07T00:00:00.000Z");
    expect(results.map((entry) => entry.id)).toEqual(["a1"]);
  });

  it("searches by keyword case-insensitively", () => {
    const store = makeStore();
    seedArchive(store);
    const results = store.searchByKeyword("CAR SERVICED");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a1");
  });

  it("respects keyword search limits", () => {
    const store = makeStore();
    seedArchive(store);
    store.append([
      {
        id: "a3",
        ts: "2026-04-06T20:00:00.000Z",
        ingest_ts: "2026-04-06T20:01:00.000Z",
        role: "assistant",
        content: "Car service notes captured for tomorrow.",
        summary: "service notes",
        level: 1,
        turn_index: 14,
        tags: ["service"],
      },
    ]);
    expect(store.searchByKeyword("service", 1)).toHaveLength(1);
  });

  it("returns entries by session id", () => {
    const store = makeStore();
    seedArchive(store);
    const results = store.getBySession("sess-2");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("a2");
  });

  it("returns count and date bounds in summary", () => {
    const store = makeStore();
    seedArchive(store);
    expect(store.getSummary()).toEqual({
      count: 2,
      earliest: "2026-04-06T14:32:00.000Z",
      latest: "2026-04-07T10:00:00.000Z",
    });
  });

  it("extractTags keeps useful English and Chinese tokens", () => {
    const tags = extractTags("I need a deployment checklist for TypeScript 專案，而且測試要穩定。");
    expect(tags).toContain("deployment");
    expect(tags).toContain("typescript");
    expect(tags.some((tag) => tag.includes("專案"))).toBe(true);
  });

  it("estimateArchiveTimestamp offsets from session start by turn index", () => {
    const ts = estimateArchiveTimestamp("", "2026-04-06T12:00:00.000Z", 3);
    expect(ts).toBe("2026-04-06T12:03:00.000Z");
  });

  it("soft limit drops oldest archive entries when exceeded", () => {
    const store = makeStore(0.0001);
    store.append([
      {
        id: "old",
        ts: "2026-04-01T10:00:00.000Z",
        ingest_ts: "2026-04-01T10:00:01.000Z",
        role: "user",
        content: "x".repeat(80),
        summary: "old",
        level: 1,
        turn_index: 1,
        tags: ["old"],
      },
      {
        id: "new",
        ts: "2026-04-02T10:00:00.000Z",
        ingest_ts: "2026-04-02T10:00:01.000Z",
        role: "assistant",
        content: "y".repeat(80),
        summary: "new",
        level: 1,
        turn_index: 2,
        tags: ["new"],
      },
    ]);
    const ids = store.readAll().map((entry) => entry.id);
    expect(ids).toContain("new");
    expect(ids).not.toContain("old");
  });
});

describe("Compactor archive integration", () => {
  let db: BrainDB;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-compactor-"));
    db = await pgliteFactory.create(join(tmp, "pg"));
    await initPgSchema(db);
  });

  afterEach(async () => {
    await db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("archives L1 messages before marking them compacted", async () => {
    const messages = new MessageStore(db);
    const dag = new DagStore(db);
    const archive = new ArchiveStore(join(tmp, ".squeeze"));
    const compactor = new Compactor(messages, dag, {
      freshTailTurns: 1,
      batchTurns: 2,
      archiveStore: archive,
      sessionId: "sess-test",
      sessionStart: "2026-04-06T09:00:00.000Z",
    });

    for (let turn = 1; turn <= 4; turn += 1) {
      await messages.insert(
        { role: "user", content: `Turn ${turn} discussed car service and deployment details in depth.` },
        turn,
        { level: Level.Observation, contentType: "conversation", confidence: 0.8 }
      );
    }

    await compactor.run(4);

    const archived = archive.readAll();
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((entry) => entry.content.includes("Turn"))).toBe(true);
    expect(readFileSync(archive.getArchivePath(), "utf8")).toContain("car service");
  });
});
