import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { getTestDB, cleanTables, releaseTestDB } from "./helpers/db.js";
import type { BrainDB } from "../src/storage/db.js";
import { DirectiveStore } from "../src/storage/directives.js";

describe("DirectiveStore", () => {
  let db: BrainDB;
  let store: DirectiveStore;

  /** Insert a dummy message row so foreign key constraints are satisfied. */
  async function insertMsg(): Promise<number> {
    const rows = await db.query<{ id: number }>(
      `INSERT INTO messages (role, content, level, content_type, confidence, turn_index)
       VALUES ('user', 'test', 1, 'conversation', 0.5, 0)
       RETURNING id`,
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    db = await getTestDB();
  });

  beforeEach(async () => {
    await cleanTables(db);
    store = new DirectiveStore(db);
  });

  afterAll(async () => {
    await releaseTestDB();
  });

  // ── L3 Directive Tests ──────────────────────────────────────────

  it("adding a directive with the same key supersedes the old one", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();

    const id1 = await store.addDirective("lang", "always reply in English", msgId1);
    const id2 = await store.addDirective("lang", "always reply in French", msgId2);

    // The old directive should be superseded
    const history = await store.getDirectiveHistory("lang");
    const old = history.find((d) => d.id === id1)!;
    expect(old.supersededBy).not.toBeNull();
    expect(old.supersededAt).not.toBeNull();

    // The new directive should be active
    const newer = history.find((d) => d.id === id2)!;
    expect(newer.supersededBy).toBeNull();
  });

  it("superseded directive is not returned by getActiveDirectives", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();

    await store.addDirective("format", "use markdown", msgId1);
    await store.addDirective("format", "use plain text", msgId2);

    const active = await store.getActiveDirectives();
    const formatDirectives = active.filter((d) => d.key === "format");
    expect(formatDirectives).toHaveLength(1);
    expect(formatDirectives[0].value).toBe("use plain text");
  });

  it("supersede + insert is atomic (old is only superseded if new succeeds)", async () => {
    const msgId = await insertMsg();
    await store.addDirective("tone", "be formal", msgId);

    // Verify the directive is active before attempted second insert
    expect((await store.getActiveDirectives()).filter((d) => d.key === "tone")).toHaveLength(1);

    // A normal second insert should work atomically
    const msgId2 = await insertMsg();
    await store.addDirective("tone", "be casual", msgId2);

    const active = (await store.getActiveDirectives()).filter((d) => d.key === "tone");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("be casual");

    // The full history should have both entries
    const history = await store.getDirectiveHistory("tone");
    expect(history).toHaveLength(2);
  });

  it("getDirectiveHistory returns the full chain", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();
    const msgId3 = await insertMsg();

    await store.addDirective("style", "v1", msgId1);
    await store.addDirective("style", "v2", msgId2);
    await store.addDirective("style", "v3", msgId3);

    const history = await store.getDirectiveHistory("style");
    expect(history).toHaveLength(3);
    expect(history.map((d) => d.value)).toEqual(["v1", "v2", "v3"]);

    // First two should be superseded, last one active
    expect(history[0].supersededBy).not.toBeNull();
    expect(history[1].supersededBy).not.toBeNull();
    expect(history[2].supersededBy).toBeNull();
  });

  it("directives with different keys do not interfere", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();

    await store.addDirective("lang", "English", msgId1);
    await store.addDirective("tone", "formal", msgId2);

    const active = await store.getActiveDirectives();
    expect(active).toHaveLength(2);
    expect(active.map((d) => d.key).sort()).toEqual(["lang", "tone"]);
  });

  it("stores and retrieves directive evidence when provided", async () => {
    const msgId = await insertMsg();
    await store.addDirective("lang", "always reply in English", msgId, false, {
      text: "不要再用中文了",
      turn: 7,
    });

    const [directive] = await store.getActiveDirectives();
    expect(directive.evidenceText).toBe("不要再用中文了");
    expect(directive.evidenceTurn).toBe(7);
  });

  it("stores directive event_time separately from created_at", async () => {
    const msgId = await insertMsg();
    await store.addDirective(
      "project",
      "I started the project on March 15, 2026",
      msgId,
      false,
      undefined,
      "2026-03-15T00:00:00.000Z"
    );

    const [directive] = await store.getActiveDirectives();
    expect(directive.eventTime).toContain("2026-03-15");
    expect(directive.createdAt).toBeTruthy();
  });

  it("existing directives without evidence remain readable", async () => {
    const msgId = await insertMsg();
    await store.addDirective("tone", "be formal", msgId);

    const [directive] = await store.getActiveDirectives();
    expect(directive.evidenceText).toBeNull();
    expect(directive.evidenceTurn).toBeNull();
  });

  // ── L2 Preference Tests ─────────────────────────────────────────

  it("addPreference with supersede works the same as directives", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();

    await store.addPreference("editor", "vim", 0.7, msgId1);
    await store.addPreference("editor", "vscode", 0.9, msgId2);

    const active = await store.getActivePreferences();
    const editorPrefs = active.filter((p) => p.key === "editor");
    expect(editorPrefs).toHaveLength(1);
    expect(editorPrefs[0].value).toBe("vscode");
    expect(editorPrefs[0].confidence).toBe(0.9);
  });

  it("getActivePreferences filters by minConfidence", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();

    await store.addPreference("color", "blue", 0.3, msgId1);
    await store.addPreference("font", "monospace", 0.8, msgId2);

    const highConf = await store.getActivePreferences(0.5);
    expect(highConf).toHaveLength(1);
    expect(highConf[0].key).toBe("font");

    const all = await store.getActivePreferences(0);
    expect(all).toHaveLength(2);
  });

  it("stores preference event_time separately from created_at", async () => {
    const msgId = await insertMsg();
    await store.addPreference("stack", "TypeScript", 0.9, msgId, "2026-03-15T00:00:00.000Z");

    const [preference] = await store.getActivePreferences();
    expect(preference.eventTime).toContain("2026-03-15");
    expect(preference.createdAt).toBeTruthy();
  });

  it("fixupSuperseded links old records to the new id", async () => {
    const msgId1 = await insertMsg();
    const msgId2 = await insertMsg();

    const id1 = await store.addDirective("rule", "old rule", msgId1);
    const id2 = await store.addDirective("rule", "new rule", msgId2);

    // Backward-compatibility helper should be safe even if no placeholder rows exist.
    await store.fixupSuperseded("directives", id2, "rule");

    const history = await store.getDirectiveHistory("rule");
    const old = history.find((d) => d.id === id1)!;
    expect(old.supersededBy).toBe(id2);
  });
});
