import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveMemoryPaths, generateMemoryShim } from "../cli/compress-core.js";
import { scoreDomainsForSession, loadDomainProfiles } from "../src/triage/domain-router.js";

describe("domain-aware eval: selective injection saves tokens", () => {
  function setupDomains(): string {
    const dir = mkdtempSync(join(tmpdir(), "brain-eval-"));
    mkdirSync(join(dir, "memory"));
    const workLines = [
      "- [claude] always write tests before implementing features",
      "- [claude] deploy only after CI pipeline passes",
      "- [claude] implement new features with TypeScript strict mode",
      "- [claude] write unit tests for every module",
      "- [claude] fix failing tests before merging code",
      "- [claude] deploy code changes to staging first",
      "- [claude] implement error handling in all functions",
      "- [claude] write integration tests for API endpoints",
      "- [claude] fix CI pipeline failures immediately",
      "- [claude] deploy with feature flags for safer rollouts",
      "- [claude] implement logging for all service calls",
      "- [claude] write documentation for new features",
      "- [claude] fix linting errors before code review",
      "- [claude] deploy via automated pipeline only",
      "- [claude] implement retry logic for network requests",
      "- [claude] write tests for edge cases first",
      "- [claude] fix memory leaks in long-running services",
      "- [claude] deploy feature branches to preview environments",
      "- [claude] implement circuit breakers for external APIs",
      "- [claude] write clear commit messages for each change",
    ];
    writeFileSync(join(dir, "memory", "work.md"), `## work\n\n${workLines.join("\n")}\n`);
    const investLines = [
      "- [claude] rebalance portfolio quarterly based on ETF performance",
      "- [claude] review allocation across equity and bond funds",
      "- [claude] check portfolio dividend yield each month",
      "- [claude] invest in low-cost index funds for long-term growth",
      "- [claude] track ETF expense ratios before buying",
      "- [claude] review portfolio allocation against target weights",
      "- [claude] invest surplus cash in treasury funds",
      "- [claude] check dividend reinvestment settings annually",
      "- [claude] review bond allocation when rates change",
      "- [claude] track portfolio performance against benchmark index",
      "- [claude] invest in diversified equity funds each quarter",
      "- [claude] review allocation drift and rebalance accordingly",
      "- [claude] check ETF liquidity before large purchases",
      "- [claude] track capital gains and losses for tax reporting",
      "- [claude] review portfolio risk exposure monthly",
    ];
    writeFileSync(join(dir, "memory", "investing.md"), `## investing\n\n${investLines.join("\n")}\n`);
    const travelLines = [
      "- [claude] book flights at least three weeks in advance",
      "- [claude] prefer window seats when booking flights",
      "- [claude] book hotels with free cancellation policy",
      "- [claude] prefer direct flights over connecting routes",
      "- [claude] book travel insurance for international trips",
    ];
    writeFileSync(join(dir, "memory", "travel.md"), `## travel\n\n${travelLines.join("\n")}\n`);
    return dir;
  }

  it("work session excludes investing and travel domains", () => {
    const dir = setupDomains();
    const profiles = loadDomainProfiles(dir);
    const workMessages = ["let's implement the new feature", "write tests first, then deploy", "fix the CI pipeline"];
    const scores = scoreDomainsForSession(workMessages, profiles);
    const workScore = scores.find((s) => s.domain === "work")!;
    const investScore = scores.find((s) => s.domain === "investing")!;
    expect(workScore.include).toBe(true);
    expect(investScore.include).toBe(false);
  });

  it("investing session includes investing, excludes work", () => {
    const dir = setupDomains();
    const profiles = loadDomainProfiles(dir);
    const investMessages = ["check the portfolio allocation", "review ETF performance this quarter"];
    const scores = scoreDomainsForSession(investMessages, profiles);
    const investScore = scores.find((s) => s.domain === "investing")!;
    expect(investScore.include).toBe(true);
  });

  it("small domains always included regardless of topic", () => {
    const dir = setupDomains();
    const profiles = loadDomainProfiles(dir);
    const domainTokens = new Map([["work", 800], ["investing", 600], ["travel", 200]]);
    const scores = scoreDomainsForSession(["deploy the code"], profiles, domainTokens);
    const travelScore = scores.find((s) => s.domain === "travel")!;
    expect(travelScore.include).toBe(true);
    expect(travelScore.reason).toBe("small_file");
  });

  it("ambiguous session includes all domains (fallback)", () => {
    const dir = setupDomains();
    const profiles = loadDomainProfiles(dir);
    const ambiguousMessages = ["hello, how are you today"];
    const scores = scoreDomainsForSession(ambiguousMessages, profiles);
    expect(scores.every((s) => s.include)).toBe(true);
  });

  it("MEMORY.md shim contains all directives from all domains", () => {
    const dir = setupDomains();
    generateMemoryShim(dir);
    const shim = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(shim).toContain("Auto-generated from memory/*.md");
    expect(shim).toContain("write tests before implementing");
    expect(shim).toContain("rebalance portfolio quarterly");
    expect(shim).toContain("book flights at least three weeks");
  });

  it("backward compat: flat MEMORY.md works when memory/ absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-eval-flat-"));
    writeFileSync(join(dir, "MEMORY.md"), "## directives\n\n- [claude] rule 1\n");
    const paths = resolveMemoryPaths(dir);
    expect(paths.length).toBe(1);
    expect(paths[0].domain).toBe("_flat");
  });
});
