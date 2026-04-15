/**
 * Tests for the typed Actions / undo / why surface.
 *
 * Coverage targets:
 *   - applyRememberDirective writes to MEMORY.md and logs an Action
 *   - applyPromoteCandidate moves a candidate to approved AND logs an Action
 *   - applyRejectCandidate moves a candidate to rejected AND logs an Action
 *   - applyRetireDirective archives matching directives AND logs an Action
 *   - undoLastAction reverses the most recent action and skips already-undone ones
 *   - whyDirective returns the action chain that produced a directive
 *   - The action log is append-only and tolerates corrupted lines
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyPromoteCandidate,
  applyRejectCandidate,
  applyRememberDirective,
  applyRetireDirective,
  loadActionLog,
  undoLastAction,
  whyDirective,
} from "../cli/actions.js";
import {
  ingestCandidates,
  loadCandidateStore,
  saveCandidateStore,
} from "../cli/candidates.js";

describe("Memory Actions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-actions-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function memoryPath(): string {
    return join(tmp, "MEMORY.md");
  }

  function actionsLogPath(): string {
    return join(tmp, ".squeeze", "actions.jsonl");
  }

  describe("applyRememberDirective", () => {
    it("writes the directive to MEMORY.md and appends an action to the log", async () => {
      const action = await applyRememberDirective(
        { projectRoot: tmp, source: "claude", sessionId: "s1" },
        { text: "Always use TypeScript strict mode" }
      );

      expect(action.kind).toBe("RememberDirective");
      expect(action.payload.written).toBe(true);
      expect(action.payload.finalText).toBe("Always use TypeScript strict mode");
      expect(action.payload.memoryPathSnapshot).toBeNull(); // file didn't exist before
      expect(action.id).toMatch(/^act_/);

      const memory = readFileSync(memoryPath(), "utf8");
      expect(memory).toContain("Always use TypeScript strict mode");

      const log = loadActionLog(tmp);
      expect(log).toHaveLength(1);
      expect(log[0].id).toBe(action.id);
    });

    it("captures the prior MEMORY.md state in the snapshot when the file already exists", async () => {
      writeFileSync(memoryPath(), "# pre-existing content\n");

      const action = await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Never commit generated files" }
      );

      expect(action.payload.memoryPathSnapshot).toBe("# pre-existing content\n");
    });

    it("logs the action even when the directive was already present (dedup hit)", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Vitest" }
      );
      const second = await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Vitest" }
      );

      expect(second.payload.written).toBe(false);
      expect(loadActionLog(tmp)).toHaveLength(2);
    });
  });

  describe("applyPromoteCandidate", () => {
    function seedCandidate(text: string): string {
      const store = loadCandidateStore(tmp);
      const [created] = ingestCandidates(store, [text], {
        source: "claude",
        sessionId: "test-session",
      });
      saveCandidateStore(tmp, store);
      return created.id;
    }

    it("approves the candidate, writes to MEMORY.md, and logs an action", async () => {
      const candidateId = seedCandidate("這個本來就要一直移動");

      const action = await applyPromoteCandidate(
        { projectRoot: tmp, source: "cli" },
        {
          candidateId,
          finalText: "the cursor should always keep moving",
        }
      );

      expect(action).not.toBeNull();
      expect(action!.kind).toBe("PromoteCandidate");
      expect(action!.payload.candidateId).toBe(candidateId);
      expect(action!.payload.originalText).toBe("這個本來就要一直移動");
      expect(action!.payload.finalText).toBe("the cursor should always keep moving");
      expect(action!.payload.written).toBe(true);

      const memory = readFileSync(memoryPath(), "utf8");
      expect(memory).toContain("the cursor should always keep moving");
      expect(memory).not.toContain("這個本來就要一直移動"); // edited text won

      const store = loadCandidateStore(tmp);
      expect(store.candidates[candidateId].status).toBe("approved");
    });

    it("returns null when the candidate is not pending", async () => {
      const candidateId = seedCandidate("test candidate");

      // First approve succeeds
      await applyPromoteCandidate({ projectRoot: tmp, source: "cli" }, { candidateId });

      // Second attempt returns null
      const second = await applyPromoteCandidate(
        { projectRoot: tmp, source: "cli" },
        { candidateId }
      );
      expect(second).toBeNull();
    });

    it("returns null when the candidate id does not exist", async () => {
      const action = await applyPromoteCandidate(
        { projectRoot: tmp, source: "cli" },
        { candidateId: "nonexistent" }
      );
      expect(action).toBeNull();
    });
  });

  describe("applyRejectCandidate", () => {
    it("rejects a pending candidate and logs the action", () => {
      const store = loadCandidateStore(tmp);
      const [created] = ingestCandidates(store, ["should fix the navbar"], {
        source: "claude",
      });
      saveCandidateStore(tmp, store);

      const action = applyRejectCandidate(
        { projectRoot: tmp, source: "cli" },
        created.id
      );

      expect(action).not.toBeNull();
      expect(action!.kind).toBe("RejectCandidate");
      expect(action!.payload.text).toBe("should fix the navbar");

      const reloaded = loadCandidateStore(tmp);
      expect(reloaded.candidates[created.id].status).toBe("rejected");
    });
  });

  describe("applyRetireDirective", () => {
    it("retires matching directives and logs the action with snapshot", async () => {
      // Set up two directives
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Python 3.11" }
      );
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Vitest" }
      );

      const memorySnapshotBefore = readFileSync(memoryPath(), "utf8");

      const action = applyRetireDirective(
        { projectRoot: tmp, source: "cli" },
        "Python 3.11"
      );

      expect(action.kind).toBe("RetireDirective");
      expect(action.payload.retiredCount).toBe(1);
      expect(action.payload.matchText).toBe("Python 3.11");
      expect(action.payload.memoryPathSnapshot).toBe(memorySnapshotBefore);

      const memoryAfter = readFileSync(memoryPath(), "utf8");
      expect(memoryAfter).toContain("## oh-my-brain archive");
    });

    it("returns retiredCount=0 when nothing matches", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Vitest" }
      );

      const action = applyRetireDirective(
        { projectRoot: tmp, source: "cli" },
        "Mocha"
      );

      expect(action.payload.retiredCount).toBe(0);
    });
  });

  describe("undoLastAction", () => {
    it("returns null when the action log is empty", () => {
      const result = undoLastAction({ projectRoot: tmp, source: "cli" });
      expect(result).toBeNull();
    });

    it("undoes a RememberDirective by removing it from MEMORY.md", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use HTTPS" }
      );
      expect(readFileSync(memoryPath(), "utf8")).toContain("Always use HTTPS");

      const result = undoLastAction({ projectRoot: tmp, source: "cli" });
      expect(result).not.toBeNull();
      expect(result!.undone.kind).toBe("RememberDirective");

      // After undo, MEMORY.md should be back to its prior state (file removed
      // because it didn't exist before the original action).
      expect(existsSync(memoryPath())).toBe(false);

      // The undo itself should be in the log, marked as UndoAction.
      const log = loadActionLog(tmp);
      expect(log).toHaveLength(2);
      expect(log[1].kind).toBe("UndoAction");
    });

    it("undoes a PromoteCandidate by reverting both MEMORY.md AND candidate state", async () => {
      const store = loadCandidateStore(tmp);
      const [created] = ingestCandidates(store, ["always lowercase filenames"], {
        source: "claude",
      });
      saveCandidateStore(tmp, store);

      await applyPromoteCandidate(
        { projectRoot: tmp, source: "cli" },
        { candidateId: created.id }
      );
      expect(loadCandidateStore(tmp).candidates[created.id].status).toBe(
        "approved"
      );

      undoLastAction({ projectRoot: tmp, source: "cli" });

      // Candidate should be back to pending
      expect(loadCandidateStore(tmp).candidates[created.id].status).toBe(
        "pending"
      );
      // MEMORY.md should be gone (didn't exist before promotion)
      expect(existsSync(memoryPath())).toBe(false);
    });

    it("undoes a RejectCandidate by restoring it to pending", () => {
      const store = loadCandidateStore(tmp);
      const [created] = ingestCandidates(store, ["太多提醒了"], {
        source: "claude",
      });
      saveCandidateStore(tmp, store);

      applyRejectCandidate({ projectRoot: tmp, source: "cli" }, created.id);
      expect(loadCandidateStore(tmp).candidates[created.id].status).toBe(
        "rejected"
      );

      undoLastAction({ projectRoot: tmp, source: "cli" });
      expect(loadCandidateStore(tmp).candidates[created.id].status).toBe(
        "pending"
      );
    });

    it("undoes a RetireDirective by restoring archived directives", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Python 3.11" }
      );
      const memoryBefore = readFileSync(memoryPath(), "utf8");

      applyRetireDirective(
        { projectRoot: tmp, source: "cli" },
        "Python 3.11"
      );
      // The retire moved the directive into archive
      expect(readFileSync(memoryPath(), "utf8")).toContain(
        "## oh-my-brain archive"
      );

      undoLastAction({ projectRoot: tmp, source: "cli" });

      const restored = readFileSync(memoryPath(), "utf8");
      expect(restored).toBe(memoryBefore);
    });

    it("skips already-undone actions on subsequent undo calls", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Vitest" }
      );
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use Prettier" }
      );

      // Undo Prettier
      const first = undoLastAction({ projectRoot: tmp, source: "cli" });
      expect(first!.undone.payload).toMatchObject({ finalText: "Always use Prettier" });

      // Next undo should target Vitest, not re-undo Prettier
      const second = undoLastAction({ projectRoot: tmp, source: "cli" });
      expect(second!.undone.payload).toMatchObject({ finalText: "Always use Vitest" });

      // Third undo: nothing left
      const third = undoLastAction({ projectRoot: tmp, source: "cli" });
      expect(third).toBeNull();
    });
  });

  describe("whyDirective", () => {
    it("returns matching actions in chronological order", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "claude" },
        { text: "Always use TypeScript" }
      );
      const store = loadCandidateStore(tmp);
      const [created] = ingestCandidates(
        store,
        ["should also use strict mode"],
        { source: "codex" }
      );
      saveCandidateStore(tmp, store);
      await applyPromoteCandidate(
        { projectRoot: tmp, source: "cli" },
        {
          candidateId: created.id,
          finalText: "Always use TypeScript strict mode",
        }
      );

      const result = whyDirective(tmp, "TypeScript");
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      expect(result.matches[0].kind).toBe("RememberDirective");
      expect(result.matches[1].kind).toBe("PromoteCandidate");
      expect(result.summary).toContain("2 action");
    });

    it("returns an empty match list with a clear summary on no hits", () => {
      const result = whyDirective(tmp, "nonexistent directive");
      expect(result.matches).toHaveLength(0);
      expect(result.summary).toContain("No actions found");
    });

    it("matches case-insensitively", async () => {
      await applyRememberDirective(
        { projectRoot: tmp, source: "cli" },
        { text: "Always use HTTPS" }
      );
      const result = whyDirective(tmp, "https");
      expect(result.matches).toHaveLength(1);
    });
  });

  describe("loadActionLog tolerance", () => {
    it("ignores corrupted lines without throwing", () => {
      // Plant a partly-bad log file
      mkdirSync(join(tmp, ".squeeze"), { recursive: true });
      writeFileSync(
        actionsLogPath(),
        '{"id":"act_1","kind":"RememberDirective","timestamp":"2026-04-08T00:00:00Z","source":"cli","payload":{"text":"x","finalText":"x","written":true,"memoryPathSnapshot":null}}\n' +
          "this is not json\n" +
          '{"id":"act_2","kind":"RejectCandidate","timestamp":"2026-04-08T00:01:00Z","source":"cli","payload":{"candidateId":"abc","text":"y","candidatePrevStatus":"pending"}}\n'
      );
      const log = loadActionLog(tmp);
      expect(log).toHaveLength(2);
      expect(log[0].id).toBe("act_1");
      expect(log[1].id).toBe("act_2");
    });

    it("returns empty array when the log file does not exist", () => {
      expect(loadActionLog(tmp)).toEqual([]);
    });
  });
});
