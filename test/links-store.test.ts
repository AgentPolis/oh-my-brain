/**
 * Tests for the Directive Link store + L3 self-growth path.
 *
 * Coverage targets:
 *   - detectLinkProposals fires the right kind for each pattern:
 *     supersedes, contradicts, refines, scopedTo
 *   - Similarity threshold suppresses unrelated directive pairs
 *   - ingestLinkProposals stores them as candidates without duplication
 *   - approveLinkCandidate produces a real DirectiveLink with the
 *     final kind, edits supported
 *   - rejectLinkCandidate marks pending → rejected
 *   - applyApproveLink + applyRejectLink land in the action log AND
 *     can be undone
 *   - End-to-end scanForLinkCandidates works against MEMORY.md content
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectLinkProposals,
  ingestLinkProposals,
  loadLinkCandidates,
  loadLinks,
  saveLinkCandidates,
  scanForLinkCandidates,
} from "../cli/links-store.js";
import {
  applyApproveLink,
  applyRejectLink,
  loadActionLog,
  undoLastAction,
} from "../cli/actions.js";

describe("Link detection heuristics", () => {
  it("does not propose links for unrelated directive pairs", () => {
    const proposals = detectLinkProposals([
      "Always use TypeScript strict mode",
      "Reply in concise English",
    ]);
    expect(proposals).toEqual([]);
  });

  it("detects supersedes when newer directive has a negation marker and shares tokens", () => {
    const proposals = detectLinkProposals([
      "Always use Jest for testing",
      "Stop using Jest, switch to Vitest for testing instead",
    ]);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    const supersede = proposals.find((p) => p.kind === "supersedes");
    expect(supersede).toBeDefined();
    expect(supersede!.fromDirective).toContain("Vitest");
    expect(supersede!.toDirective).toContain("Jest");
  });

  it("detects contradicts when both directives have negation markers", () => {
    const proposals = detectLinkProposals([
      "never use any in TypeScript projects when defining types",
      "stop avoiding any when defining external types in TypeScript",
    ]);
    const contradiction = proposals.find((p) => p.kind === "contradicts");
    expect(contradiction).toBeDefined();
  });

  it("detects refines when one directive is more specific than the other", () => {
    const proposals = detectLinkProposals([
      "Always use TypeScript",
      "Always use TypeScript strict mode with noImplicitAny enabled",
    ]);
    const refine = proposals.find((p) => p.kind === "refines");
    expect(refine).toBeDefined();
    expect(refine!.fromDirective).toContain("strict mode");
  });

  it("detects scopedTo when a directive contains a scope marker", () => {
    const proposals = detectLinkProposals([
      "Always use Vitest for testing",
      "in typescript projects always use Vitest for unit testing only",
    ]);
    const scope = proposals.find((p) => p.kind === "scopedTo");
    expect(scope).toBeDefined();
  });

  it("dedupes proposals across runs over the same input", () => {
    const directives = [
      "Always use Jest for testing",
      "Stop using Jest, switch to Vitest for testing instead",
    ];
    const first = detectLinkProposals(directives);
    const second = detectLinkProposals(directives);
    expect(first.length).toBe(second.length);
  });
});

describe("Link Candidate store", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-links-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ingests fresh proposals as pending candidates", () => {
    const proposals = detectLinkProposals([
      "Always use Jest for testing",
      "Stop using Jest, switch to Vitest for testing instead",
    ]);
    const store = loadLinkCandidates(tmp);
    const created = ingestLinkProposals(store, proposals);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0].status).toBe("pending");
    saveLinkCandidates(tmp, store);

    const reloaded = loadLinkCandidates(tmp);
    expect(Object.keys(reloaded.candidates).length).toBeGreaterThanOrEqual(1);
  });

  it("does not re-create existing candidates on second ingest", () => {
    const proposals = detectLinkProposals([
      "Always use Jest for testing",
      "Stop using Jest, switch to Vitest for testing instead",
    ]);
    const store = loadLinkCandidates(tmp);
    ingestLinkProposals(store, proposals);
    const second = ingestLinkProposals(store, proposals);
    expect(second.length).toBe(0);
  });
});

describe("scanForLinkCandidates end-to-end", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-linkscan-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when fewer than 2 directives", () => {
    expect(scanForLinkCandidates(tmp, [])).toEqual([]);
    expect(scanForLinkCandidates(tmp, ["only one"])).toEqual([]);
  });

  it("creates candidates and persists them on the first scan", () => {
    const directives = [
      "Always use Jest for unit testing",
      "Stop using Jest, switch to Vitest for unit testing instead",
    ];
    const created = scanForLinkCandidates(tmp, directives);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(loadLinkCandidates(tmp).candidates).not.toEqual({});
  });

  it("does not re-create candidates on a subsequent scan with the same input", () => {
    const directives = [
      "Always use Jest for unit testing",
      "Stop using Jest, switch to Vitest for unit testing instead",
    ];
    scanForLinkCandidates(tmp, directives);
    const second = scanForLinkCandidates(tmp, directives);
    expect(second.length).toBe(0);
  });
});

describe("Link Action wrappers (applyApproveLink / applyRejectLink)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-linkactions-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedLinkCandidate(): string {
    const directives = [
      "Always use Jest for unit testing",
      "Stop using Jest, switch to Vitest for unit testing instead",
    ];
    const created = scanForLinkCandidates(tmp, directives);
    return created[0].id;
  }

  it("applyApproveLink adds a typed link and logs an action", () => {
    const candidateId = seedLinkCandidate();

    const action = applyApproveLink(
      { projectRoot: tmp, source: "cli" },
      { linkCandidateId: candidateId }
    );

    expect(action).not.toBeNull();
    expect(action!.kind).toBe("ApproveLink");

    const links = loadLinks(tmp);
    expect(links.length).toBe(1);
    expect(["supersedes", "refines", "contradicts", "scopedTo"]).toContain(
      links[0].kind
    );

    const log = loadActionLog(tmp);
    expect(log.some((a) => a.kind === "ApproveLink")).toBe(true);
  });

  it("applyApproveLink with finalKind override uses the supplied kind", () => {
    const candidateId = seedLinkCandidate();
    const action = applyApproveLink(
      { projectRoot: tmp, source: "cli" },
      { linkCandidateId: candidateId, finalKind: "refines" }
    );
    expect(action!.payload.finalKind).toBe("refines");
    expect(loadLinks(tmp)[0].kind).toBe("refines");
  });

  it("applyRejectLink marks the candidate rejected and logs", () => {
    const candidateId = seedLinkCandidate();
    const action = applyRejectLink({ projectRoot: tmp, source: "cli" }, candidateId);
    expect(action).not.toBeNull();
    expect(action!.kind).toBe("RejectLink");

    const store = loadLinkCandidates(tmp);
    expect(store.candidates[candidateId].status).toBe("rejected");
  });

  it("approve + undo restores the links file AND brings the candidate back to pending", () => {
    const candidateId = seedLinkCandidate();
    applyApproveLink(
      { projectRoot: tmp, source: "cli" },
      { linkCandidateId: candidateId }
    );
    expect(loadLinks(tmp).length).toBe(1);

    undoLastAction({ projectRoot: tmp, source: "cli" });

    expect(loadLinks(tmp).length).toBe(0);
    expect(loadLinkCandidates(tmp).candidates[candidateId].status).toBe(
      "pending"
    );
  });

  it("reject + undo brings the candidate back to pending", () => {
    const candidateId = seedLinkCandidate();
    applyRejectLink({ projectRoot: tmp, source: "cli" }, candidateId);
    expect(loadLinkCandidates(tmp).candidates[candidateId].status).toBe(
      "rejected"
    );

    undoLastAction({ projectRoot: tmp, source: "cli" });

    expect(loadLinkCandidates(tmp).candidates[candidateId].status).toBe(
      "pending"
    );
  });
});
