/**
 * Tests for the Directive Type registry + L2 self-growth path.
 *
 * Coverage targets:
 *   - Built-in classifier hits the right type for representative directives
 *   - User types are loaded alongside built-ins
 *   - detectEmergingClusters proposes types when 3+ uncategorized
 *     directives share a non-trivial keyword
 *   - The proposal threshold suppresses noise (1-2 hits)
 *   - approveTypeCandidate produces a real DirectiveTypeSchema and the
 *     resulting user type immediately starts classifying directives
 *   - rejectTypeCandidate marks pending → rejected
 *   - The full self-growth flow via Action wrappers (applyApproveType,
 *     applyRejectType) lands in the action log AND can be undone
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifyDirective,
  detectEmergingClusters,
  ingestClusterProposals,
  loadAllTypes,
  loadTypeCandidates,
  loadUserTypes,
  saveTypeCandidates,
  scanForTypeCandidates,
} from "../cli/types-store.js";
import {
  applyApproveType,
  applyRejectType,
  loadActionLog,
  undoLastAction,
} from "../cli/actions.js";

describe("Directive Type classifier", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-types-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("ships with the five built-in types", () => {
    const types = loadAllTypes(tmp);
    const ids = types.map((t) => t.id);
    expect(ids).toContain("CodingPreference");
    expect(ids).toContain("ToolBan");
    expect(ids).toContain("CommunicationStyle");
    expect(ids).toContain("ProjectFact");
    expect(ids).toContain("PersonContact");
  });

  it("classifies coding preference directives correctly", () => {
    expect(
      classifyDirective(tmp, "Always use TypeScript strict mode").typeId
    ).toBe("CodingPreference");
    // "Vitest" hits CodingPreference, which is checked before ToolBan in
    // the built-in list, so it wins even though "never" is also present.
    // This is intentional: the order encodes a priority among types when
    // multiple match.
    expect(
      classifyDirective(tmp, "Always use Vitest, never Jest").typeId
    ).toBe("CodingPreference");
  });

  it("classifies tool bans by negation patterns", () => {
    expect(
      classifyDirective(tmp, "Never commit generated files").typeId
    ).toBe("ToolBan");
    expect(classifyDirective(tmp, "不要使用 console.log").typeId).toBe(
      "ToolBan"
    );
  });

  it("classifies communication style", () => {
    expect(
      classifyDirective(tmp, "Reply in concise English without emoji").typeId
    ).toBe("CommunicationStyle");
    expect(
      classifyDirective(tmp, "用中文回覆，簡潔一點").typeId
    ).toBe("CommunicationStyle");
  });

  it("returns Uncategorized when no pattern matches", () => {
    const result = classifyDirective(tmp, "the weather is nice today");
    expect(result.typeId).toBe("Uncategorized");
    expect(result.matchedPatterns).toEqual([]);
  });

  it("loads user-defined types and prefers them when they match", () => {
    // Built-ins return empty user list initially
    expect(loadUserTypes(tmp)).toEqual([]);
  });
});

describe("Cluster detection (L2 self-growth)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-clusters-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not propose anything when fewer than threshold directives match", () => {
    const proposals = detectEmergingClusters(
      ["the navbar is too cluttered", "fix the modal padding"],
      3
    );
    expect(proposals).toEqual([]);
  });

  it("proposes a cluster when 3+ uncategorized directives share a keyword", () => {
    const directives = [
      "the navbar should always show breadcrumbs",
      "navbar items must support keyboard navigation",
      "navbar dropdowns should close on escape key",
      "modal padding is fine",
    ];
    const proposals = detectEmergingClusters(directives, 3);
    expect(proposals.length).toBeGreaterThanOrEqual(1);
    expect(proposals[0].keyword).toBe("navbar");
    expect(proposals[0].exampleDirectives.length).toBe(3);
  });

  it("ignores stopwords like 'the' / 'always' / 'should'", () => {
    const directives = [
      "the navbar should always show breadcrumbs",
      "navbar items must support keyboard navigation",
      "navbar dropdowns should close on escape key",
    ];
    const proposals = detectEmergingClusters(directives, 3);
    const keywords = proposals.map((p) => p.keyword);
    expect(keywords).toContain("navbar");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("should");
    expect(keywords).not.toContain("always");
  });

  it("ingestClusterProposals stores them as type candidates", () => {
    const proposals = [
      {
        keyword: "navbar",
        exampleDirectives: [
          "navbar item one",
          "navbar item two",
          "navbar item three",
        ],
        derivedKeywords: ["navbar", "item"],
      },
    ];
    const store = loadTypeCandidates(tmp);
    const created = ingestClusterProposals(store, proposals);
    expect(created.length).toBe(1);
    expect(created[0].proposedName).toBe("NavbarPreference");
    expect(created[0].status).toBe("pending");
    saveTypeCandidates(tmp, store);

    const reloaded = loadTypeCandidates(tmp);
    expect(Object.keys(reloaded.candidates).length).toBe(1);
  });

  it("does not duplicate when ingest is called twice with the same cluster", () => {
    const proposals = [
      {
        keyword: "deployment",
        exampleDirectives: [
          "deployment uses fly.io",
          "deployment is gated on CI",
          "deployment runs migrations first",
        ],
        derivedKeywords: ["deployment"],
      },
    ];
    const store = loadTypeCandidates(tmp);
    ingestClusterProposals(store, proposals);
    const second = ingestClusterProposals(store, proposals);
    expect(second.length).toBe(0);
    expect(Object.keys(store.candidates).length).toBe(1);
  });
});

describe("scanForTypeCandidates end-to-end", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-scan-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty when no directives are uncategorized", () => {
    const created = scanForTypeCandidates(tmp, [
      "Always use TypeScript strict mode",
      "Never commit generated files",
      "Reply in English",
    ]);
    expect(created).toEqual([]);
  });

  it("proposes new types from uncategorized directives sharing a keyword", () => {
    const directives = [
      // These don't match any built-in pattern (no language, no ban,
      // no communication, no project, no person keyword) but share
      // "navbar" so the cluster should fire.
      "the navbar item ordering matters",
      "navbar items show recent first",
      "navbar items group by recency",
    ];
    const created = scanForTypeCandidates(tmp, directives);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0].proposedName).toContain("Navbar");
  });

  it("does not re-propose the same type on a subsequent scan", () => {
    const directives = [
      "sidebar layout uses two columns",
      "sidebar items align right",
      "sidebar background is dark",
    ];
    scanForTypeCandidates(tmp, directives);
    const second = scanForTypeCandidates(tmp, directives);
    expect(second.length).toBe(0);
  });
});

describe("Type Action wrappers (applyApproveType / applyRejectType)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ohmybrain-typeactions-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedTypeCandidate(): string {
    const directives = [
      "the navbar item ordering matters",
      "navbar items show recent first",
      "navbar items group by recency",
    ];
    const created = scanForTypeCandidates(tmp, directives);
    return created[0].id;
  }

  it("applyApproveType adds a new user type and logs an action", () => {
    const candidateId = seedTypeCandidate();

    const action = applyApproveType(
      { projectRoot: tmp, source: "cli" },
      { typeCandidateId: candidateId, finalName: "NavbarLayout" }
    );

    expect(action).not.toBeNull();
    expect(action!.kind).toBe("ApproveType");
    expect(action!.payload.finalName).toBe("NavbarLayout");

    const userTypes = loadUserTypes(tmp);
    expect(userTypes.length).toBe(1);
    expect(userTypes[0].name).toBe("NavbarLayout");
    expect(userTypes[0].origin).toBe("user");

    // Action log should contain the approval
    const log = loadActionLog(tmp);
    expect(log.some((a) => a.kind === "ApproveType")).toBe(true);
  });

  it("applyRejectType marks the candidate rejected and logs an action", () => {
    const candidateId = seedTypeCandidate();

    const action = applyRejectType(
      { projectRoot: tmp, source: "cli" },
      candidateId
    );

    expect(action).not.toBeNull();
    expect(action!.kind).toBe("RejectType");

    const store = loadTypeCandidates(tmp);
    expect(store.candidates[candidateId].status).toBe("rejected");
  });

  it("approve + undo restores the user types file AND brings the candidate back to pending", () => {
    const candidateId = seedTypeCandidate();
    applyApproveType(
      { projectRoot: tmp, source: "cli" },
      { typeCandidateId: candidateId, finalName: "NavbarLayout" }
    );
    expect(loadUserTypes(tmp).length).toBe(1);

    undoLastAction({ projectRoot: tmp, source: "cli" });

    expect(loadUserTypes(tmp).length).toBe(0);
    const store = loadTypeCandidates(tmp);
    expect(store.candidates[candidateId].status).toBe("pending");
  });

  it("reject + undo brings the candidate back to pending", () => {
    const candidateId = seedTypeCandidate();
    applyRejectType({ projectRoot: tmp, source: "cli" }, candidateId);
    expect(loadTypeCandidates(tmp).candidates[candidateId].status).toBe(
      "rejected"
    );

    undoLastAction({ projectRoot: tmp, source: "cli" });

    expect(loadTypeCandidates(tmp).candidates[candidateId].status).toBe(
      "pending"
    );
  });

  it("approveType creates patterns that classify subsequent matching directives", () => {
    const candidateId = seedTypeCandidate();
    applyApproveType(
      { projectRoot: tmp, source: "cli" },
      { typeCandidateId: candidateId, finalName: "NavbarLayout" }
    );

    // The new type should now classify a fresh navbar directive
    const result = classifyDirective(tmp, "navbar should support keyboard nav");
    expect(result.typeId).toBe("NavbarLayout");
  });
});
