import { describe, it, expect } from "vitest";
import { buildKeywordProfile, scoreDomains, routeToDomain, autoCreateDomains, loadDomainProfiles, countDirectivesPerDomain, scoreDomainsForSession } from "../src/triage/domain-router.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "brain-domain-router-"));
}

describe("buildKeywordProfile", () => {
  it("extracts keywords from domain filename", () => {
    const profile = buildKeywordProfile("investing", []);
    expect(profile.keywords).toContain("invest");
    expect(profile.keywords).toContain("investing");
  });

  it("extracts keywords from directive bodies", () => {
    const profile = buildKeywordProfile("work", [
      "always use Apache-2.0 + CLA",
      "commit messages: professional, neutral",
    ]);
    expect(profile.keywords).toContain("apache");
    expect(profile.keywords).toContain("commit");
  });

  it("stems filename to root form", () => {
    const profile = buildKeywordProfile("investing", []);
    expect(profile.keywords).toContain("invest");
  });

  it("combines filename and body keywords", () => {
    const profile = buildKeywordProfile("travel", ["book flights early"]);
    expect(profile.keywords).toContain("travel");
    expect(profile.keywords).toContain("flight");
    expect(profile.keywords).toContain("book");
  });

  it("filters stop words", () => {
    const profile = buildKeywordProfile("work", ["the quick brown fox"]);
    expect(profile.keywords).not.toContain("the");
  });
});

describe("scoreDomains", () => {
  it("scores directive against domain profiles", () => {
    const profiles = [
      buildKeywordProfile("work", ["commit messages", "Apache license"]),
      buildKeywordProfile("investing", ["portfolio", "ETF", "dividend"]),
    ];
    const scores = scoreDomains("rebalance portfolio quarterly", profiles);
    expect(scores[0].domain).toBe("investing");
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
  });

  it("returns all domains sorted by score descending", () => {
    const profiles = [
      buildKeywordProfile("a", ["alpha"]),
      buildKeywordProfile("b", ["beta"]),
      buildKeywordProfile("c", ["gamma"]),
    ];
    const scores = scoreDomains("alpha beta", profiles);
    expect(scores.length).toBe(3);
    expect(scores[0].score).toBeGreaterThanOrEqual(scores[1].score);
    expect(scores[1].score).toBeGreaterThanOrEqual(scores[2].score);
  });
});

describe("routeToDomain", () => {
  it("routes to highest scoring domain", () => {
    const profiles = [
      buildKeywordProfile("work", ["commit", "deploy", "test"]),
      buildKeywordProfile("life", ["family", "health"]),
    ];
    const result = routeToDomain("always run tests before deploy", profiles);
    expect(result).toBe("work");
  });

  it("tie-breaks by fewer directives", () => {
    const profiles = [
      buildKeywordProfile("a", ["shared"]),
      buildKeywordProfile("b", ["shared"]),
    ];
    const directiveCounts = new Map([["a", 5], ["b", 2]]);
    const result = routeToDomain("shared keyword", profiles, directiveCounts);
    expect(result).toBe("b");
  });

  it("tie-breaks alphabetically when directive counts equal", () => {
    const profiles = [
      buildKeywordProfile("beta", ["shared"]),
      buildKeywordProfile("alpha", ["shared"]),
    ];
    const directiveCounts = new Map([["alpha", 3], ["beta", 3]]);
    const result = routeToDomain("shared keyword", profiles, directiveCounts);
    expect(result).toBe("alpha");
  });

  it("returns null when no domain scores above threshold", () => {
    const profiles = [
      buildKeywordProfile("work", ["commit", "deploy"]),
    ];
    const result = routeToDomain("completely unrelated gibberish xyz", profiles);
    expect(result).toBeNull();
  });
});

describe("autoCreateDomains", () => {
  it("creates memory/ dir and domain files from existing MEMORY.md", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "MEMORY.md"), [
      "## oh-my-brain directives (2026-04-17) [source:claude]",
      "",
      "- [claude] always use Apache-2.0 + CLA",
      "- [claude] commit messages: professional, neutral",
      "- [claude] rebalance portfolio quarterly",
      "- [claude] book flights two weeks early",
    ].join("\n"));

    const result = autoCreateDomains(dir);
    expect(result.created.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "memory"))).toBe(true);
    const allFiles = result.created;
    let totalDirectives = 0;
    for (const f of allFiles) {
      const content = readFileSync(join(dir, "memory", `${f}.md`), "utf8");
      const bullets = content.split("\n").filter((l) => l.startsWith("- "));
      totalDirectives += bullets.length;
    }
    expect(totalDirectives).toBe(4);
  });

  it("creates general.md when MEMORY.md is empty", () => {
    const dir = makeTmpDir();
    const result = autoCreateDomains(dir);
    expect(existsSync(join(dir, "memory", "general.md"))).toBe(true);
    expect(result.created).toContain("general");
  });

  it("does nothing when memory/ already exists", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n");
    const result = autoCreateDomains(dir);
    expect(result.created.length).toBe(0);
    expect(result.skipped).toBe(true);
  });
});

describe("loadDomainProfiles", () => {
  it("loads keyword profiles from memory/*.md files", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude] always use TDD\n- [claude] commit messages neutral\n");
    writeFileSync(join(dir, "memory", "investing.md"), "## investing\n\n- [claude] rebalance portfolio\n");
    const profiles = loadDomainProfiles(dir);
    expect(profiles.length).toBe(2);
    expect(profiles.find((p) => p.domain === "work")!.keywords.has("tdd")).toBe(true);
    expect(profiles.find((p) => p.domain === "investing")!.keywords.has("portfolio")).toBe(true);
  });

  it("returns empty array when memory/ does not exist", () => {
    const dir = makeTmpDir();
    const profiles = loadDomainProfiles(dir);
    expect(profiles).toEqual([]);
  });

  it("ignores non-.md files", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude] use TDD\n");
    writeFileSync(join(dir, "memory", "notes.txt"), "not a domain\n");
    const profiles = loadDomainProfiles(dir);
    expect(profiles.length).toBe(1);
  });
});

describe("scoreDomainsForSession", () => {
  it("scores domains against recent messages", () => {
    const profiles = [
      buildKeywordProfile("work", ["commit", "deploy", "test", "TDD"]),
      buildKeywordProfile("investing", ["portfolio", "ETF", "dividend"]),
    ];
    const messages = ["let's add TDD to this module", "run the deploy pipeline", "fix the failing test"];
    const scores = scoreDomainsForSession(messages, profiles);
    expect(scores[0].domain).toBe("work");
  });

  it("returns all domains when none score above threshold", () => {
    const profiles = [
      buildKeywordProfile("work", ["commit"]),
      buildKeywordProfile("life", ["health"]),
    ];
    const messages = ["hello world"];
    const scores = scoreDomainsForSession(messages, profiles);
    expect(scores.every((s) => s.include)).toBe(true);
  });

  it("includes small domains regardless of score", () => {
    const profiles = [
      buildKeywordProfile("work", ["commit", "deploy"]),
      buildKeywordProfile("tiny", ["rare"]),
    ];
    const messages = ["deploy the code"];
    const domainTokens = new Map([["work", 1000], ["tiny", 200]]);
    const scores = scoreDomainsForSession(messages, profiles, domainTokens);
    const tinyScore = scores.find((s) => s.domain === "tiny")!;
    expect(tinyScore.include).toBe(true);
    expect(tinyScore.reason).toBe("small_file");
  });
});

describe("countDirectivesPerDomain", () => {
  it("counts bullet lines per domain file", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- rule 1\n- rule 2\n- rule 3\n");
    writeFileSync(join(dir, "memory", "life.md"), "## life\n\n- rule 1\n");
    const counts = countDirectivesPerDomain(dir);
    expect(counts.get("work")).toBe(3);
    expect(counts.get("life")).toBe(1);
  });

  it("returns empty map when memory/ does not exist", () => {
    const dir = makeTmpDir();
    const counts = countDirectivesPerDomain(dir);
    expect(counts.size).toBe(0);
  });
});
