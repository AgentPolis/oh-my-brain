import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  detectMergeCandidates,
  enqueueMergeCandidates,
} from "../cli/compress-core.js";
import { loadCandidateStore, listCandidates } from "../cli/candidates.js";

describe("detectMergeCandidates", () => {
  it("proposes a merge when one directive subsumes another", () => {
    const merges = detectMergeCandidates([
      "Always use TypeScript",
      "Always use TypeScript strict mode",
    ]);

    expect(merges).toHaveLength(1);
    expect(merges[0].merged).toBe("Always use TypeScript strict mode");
  });

  it("does not merge negated directives", () => {
    const merges = detectMergeCandidates([
      "Always use tabs",
      "Never use spaces",
    ]);

    expect(merges).toHaveLength(0);
  });

  it("does not merge unrelated directives", () => {
    const merges = detectMergeCandidates([
      "Use React",
      "Deploy to Vercel",
    ]);

    expect(merges).toHaveLength(0);
  });

  it("requires subset token overlap rather than loose similarity", () => {
    const merges = detectMergeCandidates([
      "Always write unit tests before implementation",
      "Always write integration tests before deployment",
    ]);

    expect(merges).toHaveLength(0);
  });
});

describe("enqueueMergeCandidates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-merge-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not run below the directive threshold", () => {
    const created = enqueueMergeCandidates(
      tmpDir,
      Array.from({ length: 15 }, (_, index) => `Rule ${index}`)
    );

    expect(created).toHaveLength(0);
    expect(listCandidates(loadCandidateStore(tmpDir))).toHaveLength(0);
  });

  it("creates MERGE candidates when threshold is exceeded and pairs are mergeable", () => {
    const directives = [
      "Always use TypeScript",
      "Always use TypeScript strict mode",
      ...Array.from({ length: 14 }, (_, index) => `Independent rule ${index}`),
    ];

    const created = enqueueMergeCandidates(tmpDir, directives, "sess-merge");
    expect(created).toHaveLength(1);

    const pending = listCandidates(loadCandidateStore(tmpDir), { status: "pending" });
    expect(pending[0].text).toContain('MERGE: "Always use TypeScript"');
    expect(pending[0].text).toContain("retire the shorter one");
  });
});
