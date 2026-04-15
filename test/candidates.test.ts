import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  approveCandidate,
  candidateId,
  ingestCandidates,
  listCandidates,
  loadCandidateStore,
  pendingCount,
  rejectCandidate,
  resolveCandidateId,
  saveCandidateStore,
} from "../cli/candidates.js";
import { runCandidatesCli } from "../cli/candidates-cli.js";

describe("candidateId", () => {
  it("is stable across leading/trailing whitespace", () => {
    expect(candidateId("這個本來就要一直移動")).toBe(
      candidateId("  這個本來就要一直移動  ")
    );
  });

  it("collapses runs of whitespace in ASCII text", () => {
    expect(candidateId("should reduce noise")).toBe(
      candidateId("should  reduce   noise")
    );
  });

  it("returns different ids for different text", () => {
    expect(candidateId("too many reminders")).not.toBe(
      candidateId("too few reminders")
    );
  });

  it("is case-insensitive", () => {
    expect(candidateId("Always X")).toBe(candidateId("always x"));
  });
});

describe("candidate store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-candidates-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads an empty store when no file exists", () => {
    const store = loadCandidateStore(tmpDir);
    expect(store.version).toBe(1);
    expect(Object.keys(store.candidates)).toEqual([]);
  });

  it("ingests new candidates and persists them", () => {
    const store = loadCandidateStore(tmpDir);
    const created = ingestCandidates(
      store,
      ["這個本來就要一直移動", "too many reminders in the sidebar"],
      { source: "claude", sessionId: "sess-1" }
    );
    expect(created.length).toBe(2);
    saveCandidateStore(tmpDir, store);

    const reloaded = loadCandidateStore(tmpDir);
    expect(Object.keys(reloaded.candidates).length).toBe(2);
    const values = Object.values(reloaded.candidates);
    expect(values.every((c) => c.status === "pending")).toBe(true);
    expect(values.every((c) => c.source === "claude")).toBe(true);
  });

  it("does not duplicate candidates across runs; bumps mentionCount instead", () => {
    const store = loadCandidateStore(tmpDir);
    ingestCandidates(store, ["should reduce noise"], {
      source: "claude",
      sessionId: "sess-1",
    });
    const secondRun = ingestCandidates(store, ["should reduce noise"], {
      source: "claude",
      sessionId: "sess-2",
    });
    expect(secondRun.length).toBe(0);
    const records = Object.values(store.candidates);
    expect(records.length).toBe(1);
    expect(records[0].mentionCount).toBe(2);
    expect(records[0].sessionId).toBe("sess-2"); // latest wins
  });

  it("does not resurrect a rejected candidate", () => {
    const store = loadCandidateStore(tmpDir);
    const [created] = ingestCandidates(store, ["太多提醒了"], {
      source: "claude",
    });
    rejectCandidate(store, created.id);
    const second = ingestCandidates(store, ["太多提醒了"], { source: "codex" });
    expect(second.length).toBe(0);
    expect(store.candidates[created.id].status).toBe("rejected");
  });

  it("approves a candidate with the original text", () => {
    const store = loadCandidateStore(tmpDir);
    const [created] = ingestCandidates(store, ["always lowercase file names"], {
      source: "claude",
    });
    const result = approveCandidate(store, created.id);
    expect(result).not.toBeNull();
    expect(result!.finalText).toBe("always lowercase file names");
    expect(store.candidates[created.id].status).toBe("approved");
  });

  it("approves a candidate with edited text", () => {
    const store = loadCandidateStore(tmpDir);
    const [created] = ingestCandidates(store, ["不要在 main branch push"], {
      source: "claude",
    });
    const result = approveCandidate(
      store,
      created.id,
      "never push directly to main branch"
    );
    expect(result!.finalText).toBe("never push directly to main branch");
    expect(store.candidates[created.id].finalText).toBe(
      "never push directly to main branch"
    );
  });

  it("approve returns null for non-pending candidates", () => {
    const store = loadCandidateStore(tmpDir);
    const [created] = ingestCandidates(store, ["example candidate"], {
      source: "claude",
    });
    approveCandidate(store, created.id);
    const second = approveCandidate(store, created.id);
    expect(second).toBeNull();
  });

  it("resolves a short id prefix to the full id", () => {
    const store = loadCandidateStore(tmpDir);
    const [created] = ingestCandidates(store, ["some candidate text"], {
      source: "claude",
    });
    const resolved = resolveCandidateId(store, created.id.slice(0, 6));
    expect(resolved).toBe(created.id);
  });

  it("returns null on ambiguous prefix", () => {
    // Force a collision by crafting IDs — use real candidateId for both.
    const store = loadCandidateStore(tmpDir);
    ingestCandidates(store, ["one", "two", "three"], { source: "claude" });
    // A single char is likely ambiguous across multiple ids.
    const firstId = Object.keys(store.candidates)[0];
    const resolved = resolveCandidateId(store, firstId);
    expect(resolved).toBe(firstId);
  });

  it("lists pending candidates by default, all when requested", () => {
    const store = loadCandidateStore(tmpDir);
    const [a] = ingestCandidates(store, ["keep this one"], { source: "claude" });
    const [b] = ingestCandidates(store, ["reject this one"], { source: "claude" });
    rejectCandidate(store, b.id);

    const pending = listCandidates(store, { status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(a.id);

    const all = listCandidates(store);
    expect(all.length).toBe(2);
  });

  it("pendingCount excludes approved and rejected", () => {
    const store = loadCandidateStore(tmpDir);
    const [a] = ingestCandidates(store, ["approve me"], { source: "claude" });
    const [b] = ingestCandidates(store, ["reject me"], { source: "claude" });
    const [c] = ingestCandidates(store, ["leave me pending"], { source: "claude" });
    approveCandidate(store, a.id);
    rejectCandidate(store, b.id);
    expect(pendingCount(store)).toBe(1);
    expect(c.id).toBeTruthy();
  });

  it("tolerates a corrupted store file without throwing", () => {
    const dir = tmpDir;
    require("fs").mkdirSync(join(dir, ".squeeze"), { recursive: true });
    require("fs").writeFileSync(join(dir, ".squeeze", "candidates.json"), "{ not json");
    const store = loadCandidateStore(dir);
    expect(store.version).toBe(1);
    expect(Object.keys(store.candidates)).toEqual([]);
  });
});

describe("runCandidatesCli", () => {
  let tmpDir: string;
  let stdout: string;
  let stderr: string;
  let originalWriteOut: typeof process.stdout.write;
  let originalWriteErr: typeof process.stderr.write;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-cli-"));
    stdout = "";
    stderr = "";
    originalWriteOut = process.stdout.write.bind(process.stdout);
    originalWriteErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => {
      stdout += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalWriteOut;
    process.stderr.write = originalWriteErr;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(texts: string[]) {
    const store = loadCandidateStore(tmpDir);
    ingestCandidates(store, texts, { source: "claude", sessionId: "sess-test" });
    saveCandidateStore(tmpDir, store);
  }

  it("list shows 'nothing to review' when empty", async () => {
    const code = await runCandidatesCli(["node", "cli"], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain("No pending memory candidates");
  });

  it("list shows pending candidates", async () => {
    seed(["這個本來就要一直移動", "太多提醒了"]);
    const code = await runCandidatesCli(["node", "cli", "list"], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain("pending candidate");
    expect(stdout).toContain("這個本來就要一直移動");
  });

  it("approve writes the candidate to MEMORY.md and marks it approved", async () => {
    seed(["always lowercase file names"]);
    const store = loadCandidateStore(tmpDir);
    const [record] = Object.values(store.candidates);

    const code = await runCandidatesCli(
      ["node", "cli", "approve", record.id.slice(0, 6)],
      tmpDir
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Approved");

    const memoryContent = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(memoryContent).toContain("always lowercase file names");

    const after = loadCandidateStore(tmpDir);
    expect(after.candidates[record.id].status).toBe("approved");
  });

  it("approve --as writes the edited text instead", async () => {
    seed(["不要在 main branch push"]);
    const store = loadCandidateStore(tmpDir);
    const [record] = Object.values(store.candidates);

    const code = await runCandidatesCli(
      [
        "node",
        "cli",
        "approve",
        record.id.slice(0, 6),
        "--as",
        "never push directly to main branch",
      ],
      tmpDir
    );
    expect(code).toBe(0);

    const memoryContent = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(memoryContent).toContain("never push directly to main branch");
    expect(memoryContent).not.toContain("不要在 main branch push");
  });

  it("reject marks the candidate and does not write to MEMORY.md", async () => {
    seed(["太多提醒了"]);
    const store = loadCandidateStore(tmpDir);
    const [record] = Object.values(store.candidates);

    const code = await runCandidatesCli(
      ["node", "cli", "reject", record.id.slice(0, 6)],
      tmpDir
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Rejected");

    expect(existsSync(join(tmpDir, "MEMORY.md"))).toBe(false);

    const after = loadCandidateStore(tmpDir);
    expect(after.candidates[record.id].status).toBe("rejected");
  });

  it("approve with unknown id returns error", async () => {
    const code = await runCandidatesCli(
      ["node", "cli", "approve", "nosuchid"],
      tmpDir
    );
    expect(code).toBe(1);
    expect(stderr).toContain("No pending candidate matches");
  });

  it("retire moves a matching directive to the archive section", async () => {
    // Seed MEMORY.md via the approval path first, then retire the entry.
    seed(["always use TypeScript strict mode"]);
    const store = loadCandidateStore(tmpDir);
    const [record] = Object.values(store.candidates);
    await runCandidatesCli(
      ["node", "cli", "approve", record.id.slice(0, 6)],
      tmpDir
    );

    // Reset captured stdout for the retire command.
    stdout = "";
    const code = await runCandidatesCli(
      ["node", "cli", "retire", "always use TypeScript"],
      tmpDir
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Retired 1 directive");

    const content = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(content).toContain("## oh-my-brain archive");
    const archiveIdx = content.indexOf("## oh-my-brain archive");
    expect(content.slice(0, archiveIdx)).not.toContain(
      "always use TypeScript strict mode"
    );
  });

  it("retire with no match returns error", async () => {
    const code = await runCandidatesCli(
      ["node", "cli", "retire", "nonexistent directive"],
      tmpDir
    );
    expect(code).toBe(1);
    expect(stderr).toContain("No active directive matched");
  });

  it("retire without text argument returns usage error", async () => {
    const code = await runCandidatesCli(["node", "cli", "retire"], tmpDir);
    expect(code).toBe(1);
    expect(stderr).toContain("Usage: brain-candidates retire");
  });

  it("status prints counts", async () => {
    seed(["a", "b", "c"]);
    const store = loadCandidateStore(tmpDir);
    const records = Object.values(store.candidates);
    approveCandidate(store, records[0].id);
    rejectCandidate(store, records[1].id);
    saveCandidateStore(tmpDir, store);

    const code = await runCandidatesCli(["node", "cli", "status"], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain("pending:");
    expect(stdout).toContain("approved: 1");
    expect(stdout).toContain("rejected: 1");
  });

  it("--help returns help text", async () => {
    const code = await runCandidatesCli(["node", "cli", "--help"], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain("brain-candidates");
    expect(stdout).toContain("approve");
    expect(stdout).toContain("reject");
  });

  it("unknown command returns error + help", async () => {
    const code = await runCandidatesCli(["node", "cli", "nonsense"], tmpDir);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
