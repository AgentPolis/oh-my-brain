import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EventStore, detectEventCategory, type BrainEvent } from "../src/storage/events.js";

describe("EventStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-events-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(): EventStore {
    return new EventStore(join(tmp, ".squeeze"));
  }

  function makeEvent(overrides: Partial<BrainEvent>): BrainEvent {
    return {
      id: overrides.id ?? "evt-1",
      ts: overrides.ts ?? "2026-03-14T10:00:00.000Z",
      ts_ingest: overrides.ts_ingest ?? "2026-03-14T10:05:00.000Z",
      ts_precision: overrides.ts_precision ?? "exact",
      what: overrides.what ?? "car serviced",
      detail: overrides.detail ?? "GPS malfunction found",
      category: overrides.category ?? "vehicle",
      who: overrides.who ?? ["Tom"],
      where: overrides.where ?? "Taipei",
      related_to: overrides.related_to ?? [],
      sentiment: overrides.sentiment ?? "frustrated",
      viewpoint: overrides.viewpoint ?? "",
      insight: overrides.insight ?? "",
      source_text: overrides.source_text ?? "I got my car serviced last Tuesday. The GPS wasn't working.",
      session_id: overrides.session_id ?? "sess-1",
      turn_index: overrides.turn_index ?? 3,
    };
  }

  it("creates events.jsonl on first append", () => {
    const store = makeStore();
    store.append([makeEvent({ id: "evt-1" })]);
    expect(existsSync(join(tmp, ".squeeze", "events.jsonl"))).toBe(true);
  });

  it("appends entries without overwriting existing ones", () => {
    const store = makeStore();
    store.append([makeEvent({ id: "evt-1" })]);
    store.append([makeEvent({ id: "evt-2", what: "flew to Las Vegas", category: "travel" })]);
    expect(store.getAll().map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
  });

  it("searches exact day boundaries by date-only input", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", ts: "2026-03-14T10:00:00.000Z" }),
      makeEvent({ id: "evt-2", ts: "2026-03-15T10:00:00.000Z" }),
    ]);
    expect(store.searchByTime("2026-03-14", "2026-03-14").map((event) => event.id)).toEqual(["evt-1"]);
  });

  it("matches month-precision events within the searched month", () => {
    const store = makeStore();
    store.append([makeEvent({ id: "evt-1", ts: "2026-03-01T00:00:00.000Z", ts_precision: "month" })]);
    expect(store.searchByTime("2026-03-14", "2026-03-14").map((event) => event.id)).toEqual(["evt-1"]);
  });

  it("matches week-precision events across the covered week", () => {
    const store = makeStore();
    store.append([makeEvent({ id: "evt-1", ts: "2026-03-10T00:00:00.000Z", ts_precision: "week" })]);
    expect(store.searchByTime("2026-03-14", "2026-03-14").map((event) => event.id)).toEqual(["evt-1"]);
  });

  it("treats relative precision as a resolved day for search", () => {
    const store = makeStore();
    store.append([makeEvent({ id: "evt-1", ts: "2026-03-01T00:00:00.000Z", ts_precision: "relative" })]);
    expect(store.searchByTime("2026-03-01", "2026-03-01").map((event) => event.id)).toEqual(["evt-1"]);
  });

  it("searches by keyword across what detail and source text", () => {
    const store = makeStore();
    store.append([makeEvent({ id: "evt-1" })]);
    expect(store.searchByKeyword("gps").map((event) => event.id)).toEqual(["evt-1"]);
  });

  it("respects keyword search limits", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", what: "bought Galaxy S22", category: "shopping" }),
      makeEvent({ id: "evt-2", what: "bought training pads", category: "pets" }),
    ]);
    expect(store.searchByKeyword("bought", 1)).toHaveLength(1);
  });

  it("searches by exact category", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", category: "vehicle" }),
      makeEvent({ id: "evt-2", category: "travel", what: "flew to Vegas" }),
    ]);
    expect(store.searchByCategory("travel").map((event) => event.id)).toEqual(["evt-2"]);
  });

  it("searches by person with case-insensitive partial matching", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", who: ["mechanic Tom"] }),
      makeEvent({ id: "evt-2", who: ["Dr. Chen"] }),
    ]);
    expect(store.searchByPerson("tom").map((event) => event.id)).toEqual(["evt-1"]);
  });

  it("returns count date bounds and category breakdown in summary", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", ts: "2026-03-14T10:00:00.000Z", category: "vehicle" }),
      makeEvent({ id: "evt-2", ts: "2026-03-20T10:00:00.000Z", category: "travel", what: "flew to Vegas" }),
      makeEvent({ id: "evt-3", ts: "2026-04-06T10:00:00.000Z", category: "travel", what: "flew home" }),
    ]);
    expect(store.getSummary()).toEqual({
      count: 3,
      earliest: "2026-03-14T10:00:00.000Z",
      latest: "2026-04-06T10:00:00.000Z",
      categories: {
        travel: 2,
        vehicle: 1,
      },
    });
  });

  it("renders a compact timeline string with one line per event", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", ts: "2026-02-15T10:00:00.000Z", what: "got Samsung Galaxy S22", category: "shopping" }),
      makeEvent({ id: "evt-2", ts: "2026-03-14T10:00:00.000Z", what: "car serviced", category: "vehicle" }),
      makeEvent({ id: "evt-3", ts: "2026-04-06T10:00:00.000Z", what: "bought training pads for Luna", category: "pets" }),
    ]);
    const timeline = store.toTimelineString();
    expect(timeline).toContain("Events (3 total, 2026-02-15 ~ 2026-04-06):");
    expect(timeline).toContain("Feb15: got Samsung Galaxy S22");
    expect(timeline).toContain("Mar14: car serviced");
    expect(timeline).toContain("Apr06: bought training pads for Luna");
  });

  it("counts events before a given date with category filtering", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", ts: "2026-03-01T10:00:00.000Z", category: "events", what: "joined charity walk" }),
      makeEvent({ id: "evt-2", ts: "2026-05-01T10:00:00.000Z", category: "events", what: "ran in fundraiser" }),
      makeEvent({ id: "evt-3", ts: "2026-06-02T10:00:00.000Z", category: "events", what: "attended Run for the Cure" }),
    ]);
    expect(store.countBefore({ before: "2026-06-01", category: "events" })).toBe(2);
  });

  it("counts events in a range with keyword filtering", () => {
    const store = makeStore();
    store.append([
      makeEvent({ id: "evt-1", ts: "2026-03-05T10:00:00.000Z", category: "events", what: "charity walk kickoff" }),
      makeEvent({ id: "evt-2", ts: "2026-03-20T10:00:00.000Z", category: "events", what: "charity gala" }),
      makeEvent({ id: "evt-3", ts: "2026-04-10T10:00:00.000Z", category: "events", what: "team meetup" }),
    ]);
    expect(
      store.countInRange({
        from: "2026-03-01",
        to: "2026-04-01",
        whatContains: "charity",
      })
    ).toBe(2);
  });
});

describe("detectEventCategory", () => {
  it("maps common text to heuristic categories", () => {
    expect(detectEventCategory("I got my car serviced and the mechanic checked the GPS")).toBe("vehicle");
    expect(detectEventCategory("I flew to Las Vegas for a conference")).toBe("travel");
    expect(detectEventCategory("I bought a Samsung Galaxy S22")).toBe("shopping");
  });
});
