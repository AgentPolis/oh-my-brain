import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { OutcomeStore } from "../src/storage/outcomes.js";
import type { OutcomeRecord } from "../src/types.js";

describe("OutcomeStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-outcomes-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(): OutcomeStore {
    return new OutcomeStore(join(tmp, ".squeeze"));
  }

  function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
    return {
      id: overrides.id ?? "out-1",
      result: "failure",
      failure_mode: overrides.failure_mode ?? "exit code 1",
      context: overrides.context ?? "npm test failed in deploy step",
      lesson: overrides.lesson ?? "Run npm install before npm test",
      session_id: overrides.session_id ?? "sess-1",
      timestamp: overrides.timestamp ?? "2026-04-15T10:00:00.000Z",
    };
  }

  it("returns [] when outcomes.jsonl does not exist", () => {
    const store = makeStore();
    expect(store.getAll()).toEqual([]);
  });

  it("creates outcomes.jsonl on first append", () => {
    const store = makeStore();
    store.append([makeOutcome()]);
    expect(existsSync(join(tmp, ".squeeze", "outcomes.jsonl"))).toBe(true);
  });

  it("round-trips: append then getAll returns same records", () => {
    const store = makeStore();
    const record = makeOutcome({ id: "out-42" });
    store.append([record]);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("out-42");
    expect(all[0].failure_mode).toBe("exit code 1");
  });

  it("appends without overwriting existing entries", () => {
    const store = makeStore();
    store.append([makeOutcome({ id: "out-1" })]);
    store.append([makeOutcome({ id: "out-2" })]);
    expect(store.getAll()).toHaveLength(2);
  });

  it("findRelevant matches by keyword overlap", () => {
    const store = makeStore();
    store.append([
      makeOutcome({ id: "out-1", failure_mode: "deploy rollback", context: "blue-green deploy failed" }),
      makeOutcome({ id: "out-2", failure_mode: "test timeout", context: "jest hung on CI" }),
    ]);
    const matches = store.findRelevant("deploy to production", 3);
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].id).toBe("out-1");
  });

  it("findRelevant returns empty for no keyword match", () => {
    const store = makeStore();
    store.append([makeOutcome({ failure_mode: "deploy rollback" })]);
    expect(store.findRelevant("database migration", 3)).toHaveLength(0);
  });

  it("getRecent returns last N outcomes", () => {
    const store = makeStore();
    store.append([
      makeOutcome({ id: "out-1", timestamp: "2026-04-14T10:00:00.000Z" }),
      makeOutcome({ id: "out-2", timestamp: "2026-04-15T10:00:00.000Z" }),
      makeOutcome({ id: "out-3", timestamp: "2026-04-15T12:00:00.000Z" }),
    ]);
    const recent = store.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe("out-3");
  });

  it("isDuplicate returns true for same failure_mode within 24h", () => {
    const store = makeStore();
    store.append([makeOutcome({
      failure_mode: "exit code 1",
      timestamp: "2026-04-15T10:00:00.000Z",
    })]);
    expect(store.isDuplicate("exit code 1", "2026-04-15T20:00:00.000Z")).toBe(true);
  });

  it("isDuplicate returns false after 24h", () => {
    const store = makeStore();
    store.append([makeOutcome({
      failure_mode: "exit code 1",
      timestamp: "2026-04-14T10:00:00.000Z",
    })]);
    expect(store.isDuplicate("exit code 1", "2026-04-15T20:00:00.000Z")).toBe(false);
  });
});
