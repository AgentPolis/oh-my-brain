import { beforeEach, describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ProcedureStore } from "../src/storage/procedures.js";
import type { ProcedureRecord } from "../src/types.js";

describe("ProcedureStore", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-proc-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeStore(): ProcedureStore {
    return new ProcedureStore(join(tmp, ".squeeze"));
  }

  function makeRecord(overrides: Partial<ProcedureRecord> = {}): ProcedureRecord {
    return {
      id: overrides.id ?? "proc-001",
      title: overrides.title ?? "Deploy SOP",
      trigger: overrides.trigger ?? "production deploy workflow",
      steps: overrides.steps ?? [{ order: 1, action: "Run tests", tool: "bash" }],
      pitfalls: overrides.pitfalls ?? [],
      verification: overrides.verification ?? [],
      status: overrides.status ?? "candidate",
      source_session_id: overrides.source_session_id ?? "sess-1",
      created_at: overrides.created_at ?? "2026-04-15T10:00:00.000Z",
      updated_at: overrides.updated_at ?? "2026-04-15T10:00:00.000Z",
    };
  }

  it("returns empty array when file does not exist", () => {
    const store = makeStore();
    expect(store.getAll()).toEqual([]);
  });

  it("round-trips a record through append and getAll", () => {
    const store = makeStore();
    const record = makeRecord();
    store.append(record);
    const all = store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("proc-001");
    expect(all[0].title).toBe("Deploy SOP");
    expect(all[0].status).toBe("candidate");
  });

  it("getApproved filters correctly", () => {
    const store = makeStore();
    store.append(makeRecord({ id: "p1", status: "candidate" }));
    store.append(makeRecord({ id: "p2", status: "approved" }));
    store.append(makeRecord({ id: "p3", status: "archived" }));
    const approved = store.getApproved();
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe("p2");
  });

  it("findApprovedByTrigger matches on keyword overlap", () => {
    const store = makeStore();
    store.append(makeRecord({ id: "p1", status: "approved", trigger: "production deploy workflow" }));
    store.append(makeRecord({ id: "p2", status: "approved", trigger: "database migration steps" }));
    const match = store.findApprovedByTrigger("deploy to production");
    expect(match).not.toBeNull();
    expect(match!.id).toBe("p1");
  });

  it("findApprovedByTrigger returns null when no match exceeds threshold", () => {
    const store = makeStore();
    store.append(makeRecord({ id: "p1", status: "approved", trigger: "production deploy workflow" }));
    const match = store.findApprovedByTrigger("cooking recipe pasta");
    expect(match).toBeNull();
  });

  it("findApprovedByTrigger ignores non-approved records", () => {
    const store = makeStore();
    store.append(makeRecord({ id: "p1", status: "candidate", trigger: "production deploy workflow" }));
    const match = store.findApprovedByTrigger("production deploy workflow");
    expect(match).toBeNull();
  });

  it("updateStatus changes status and updated_at", () => {
    const store = makeStore();
    store.append(makeRecord({ id: "p1", status: "candidate" }));
    const result = store.updateStatus("p1", "approved");
    expect(result).toBe(true);
    const all = store.getAll();
    expect(all[0].status).toBe("approved");
    expect(all[0].updated_at).not.toBe("2026-04-15T10:00:00.000Z");
  });

  it("updateStatus returns false for unknown id", () => {
    const store = makeStore();
    store.append(makeRecord({ id: "p1" }));
    const result = store.updateStatus("nonexistent", "approved");
    expect(result).toBe(false);
  });
});
