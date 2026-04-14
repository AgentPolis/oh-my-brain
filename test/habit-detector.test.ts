import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectHabits, loadHabits, saveHabits, type Habit } from "../cli/habit-detector.js";
import type { BrainEvent } from "../src/storage/events.js";

describe("habit-detector", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-habits-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeEvent(id: string, what: string, category: string, ts = "2026-04-01T00:00:00.000Z"): BrainEvent {
    return {
      id,
      ts,
      ts_ingest: ts,
      ts_precision: "exact",
      what,
      detail: "",
      category,
      who: [],
      where: "",
      related_to: [],
      sentiment: "",
      viewpoint: "",
      insight: "",
      source_text: what,
      session_id: "sess-1",
      turn_index: 1,
    };
  }

  it("detects a travel habit from 3 similar events", () => {
    const habits = detectHabits(
      [
        makeEvent("e1", "flew United to Vegas", "travel"),
        makeEvent("e2", "flew United to SF", "travel"),
        makeEvent("e3", "flew United to Seattle", "travel"),
      ],
      []
    );
    expect(habits).toHaveLength(1);
    expect(habits[0].pattern).toContain("United");
    expect(habits[0].occurrences).toBe(3);
    expect(habits[0].confidence).toBe(0.6);
  });

  it("detects charity event habits", () => {
    const habits = detectHabits(
      [
        makeEvent("e1", "attended charity run", "events"),
        makeEvent("e2", "participated in charity walk", "events"),
        makeEvent("e3", "attended charity golf", "events"),
        makeEvent("e4", "attended food charity", "events"),
      ],
      []
    );
    expect(habits[0].pattern).toBe("regularly participates in charity events");
  });

  it("scales confidence with occurrence count", () => {
    const habits = detectHabits(
      [
        makeEvent("e1", "flew United to Vegas", "travel"),
        makeEvent("e2", "flew United to SF", "travel"),
        makeEvent("e3", "flew United to Seattle", "travel"),
        makeEvent("e4", "flew United to LA", "travel"),
        makeEvent("e5", "flew United to Boston", "travel"),
      ],
      []
    );
    expect(habits[0].confidence).toBe(0.8);
  });

  it("caps confidence at 1.0", () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      makeEvent(`e${index}`, `flew United to City ${index}`, "travel")
    );
    const habits = detectHabits(events, []);
    expect(habits[0].confidence).toBe(1);
  });

  it("does not propose habits already known", () => {
    const existing: Habit[] = [
      {
        id: "h1",
        pattern: "frequently flies United Airlines",
        confidence: 0.8,
        evidence: ["e0"],
        first_seen: "2026-03-01T00:00:00.000Z",
        occurrences: 4,
      },
    ];
    const habits = detectHabits(
      [
        makeEvent("e1", "flew United to Vegas", "travel"),
        makeEvent("e2", "flew United to SF", "travel"),
        makeEvent("e3", "flew United to Seattle", "travel"),
      ],
      existing
    );
    expect(habits).toEqual([]);
  });

  it("filters trivial assistant-like habits", () => {
    const habits = detectHabits(
      [
        makeEvent("e1", "talked to assistant about tests", "work"),
        makeEvent("e2", "talked to assistant about deploy", "work"),
        makeEvent("e3", "talked to assistant about refactor", "work"),
      ],
      []
    );
    expect(habits).toEqual([]);
  });

  it("ignores category other", () => {
    const habits = detectHabits(
      [
        makeEvent("e1", "misc note alpha", "other"),
        makeEvent("e2", "misc note beta", "other"),
        makeEvent("e3", "misc note gamma", "other"),
      ],
      []
    );
    expect(habits).toEqual([]);
  });

  it("persists habits to habits.json", () => {
    const habits: Habit[] = [
      {
        id: "h1",
        pattern: "frequently flies United Airlines",
        confidence: 0.8,
        evidence: ["e1", "e2", "e3"],
        first_seen: "2026-03-01T00:00:00.000Z",
        occurrences: 4,
      },
    ];
    saveHabits(tmp, habits);
    expect(loadHabits(tmp)).toEqual(habits);
  });
});
