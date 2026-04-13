import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ArchiveStore } from "../src/storage/archive.js";
import { TimelineIndex } from "../src/storage/timeline.js";

describe("TimelineIndex", () => {
  let tmp: string;
  let squeezePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-timeline-"));
    squeezePath = join(tmp, ".squeeze");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedArchive() {
    const archive = new ArchiveStore(squeezePath);
    archive.append([
      {
        id: "a1",
        ts: "2026-04-01T10:00:00.000Z",
        ingest_ts: "2026-04-01T10:00:01.000Z",
        role: "user",
        content: "Car service follow-up and GPS debugging.",
        summary: "car service",
        level: 1,
        turn_index: 1,
        tags: ["service", "gps", "debugging"],
      },
      {
        id: "a2",
        ts: "2026-04-01T12:00:00.000Z",
        ingest_ts: "2026-04-01T12:00:01.000Z",
        role: "assistant",
        content: "Deployment checklist review after the car service note.",
        summary: "deployment checklist",
        level: 1,
        turn_index: 2,
        tags: ["deployment", "service", "checklist"],
      },
      {
        id: "a3",
        ts: "2026-04-03T09:00:00.000Z",
        ingest_ts: "2026-04-03T09:00:01.000Z",
        role: "user",
        content: "Memory architecture planning and TypeScript setup.",
        summary: "memory architecture",
        level: 1,
        turn_index: 3,
        tags: ["memory", "architecture", "typescript"],
      },
    ]);
  }

  it("rebuilds day-level summaries from archive", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    const entries = timeline.readAll();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      ts: "2026-04-01",
      count: 2,
    });
  });

  it("keeps top topics per day", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    const [first] = timeline.readAll();
    expect(first.topics).toContain("service");
    expect(first.topics.length).toBeLessThanOrEqual(3);
  });

  it("builds one-line day summaries capped at 50 chars", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    for (const entry of timeline.readAll()) {
      expect(entry.summary.length).toBeLessThanOrEqual(50);
    }
  });

  it("returns date ranges inclusively", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    const range = timeline.range("2026-04-01", "2026-04-02");
    expect(range).toHaveLength(1);
    expect(range[0].ts).toBe("2026-04-01");
  });

  it("returns bounds for available timeline entries", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    expect(timeline.bounds()).toEqual({
      earliest: "2026-04-01",
      latest: "2026-04-03",
    });
  });

  it("is idempotent across repeated rebuilds", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();
    const first = JSON.stringify(timeline.readAll());
    timeline.rebuild();
    const second = JSON.stringify(timeline.readAll());
    expect(second).toBe(first);
  });

  it("renders a compact string for recent days", () => {
    seedArchive();
    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    const compact = timeline.toCompactString();
    expect(compact).toContain("Apr01: 2 msgs");
    expect(compact).toContain("Apr03: 1 msgs");
  });

  it("collapses older history beyond 30 days in compact output", () => {
    const archive = new ArchiveStore(squeezePath);
    for (let index = 0; index < 35; index += 1) {
      const date = new Date(Date.UTC(2026, 2, index + 1, 10, 0, 0));
      const iso = date.toISOString();
      archive.append([
        {
          id: `a-${index}`,
          ts: iso,
          ingest_ts: iso,
          role: "user",
          content: `Conversation ${index}`,
          summary: `Summary ${index}`,
          level: 1,
          turn_index: index,
          tags: ["topic"],
        },
      ]);
    }

    const timeline = new TimelineIndex(squeezePath);
    timeline.rebuild();

    const compact = timeline.toCompactString();
    expect(compact).toContain("and 5 earlier days");
  });
});
