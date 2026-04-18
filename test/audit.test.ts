import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadProjectRuns, parseMemoryEntries, renderMarkdown, reportDomainStats } from "../cli/audit.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "brain-audit-domain-"));
}

describe("brain-audit", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a human-readable markdown audit from project logs and MEMORY.md", () => {
    tempDir = mkdtempSync(join(tmpdir(), "squeeze-audit-"));
    const squeezeDir = join(tempDir, ".squeeze");
    mkdirSync(squeezeDir, { recursive: true });

    writeFileSync(
      join(squeezeDir, "runs.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-04-06T01:00:00.000Z",
          source: "codex",
          sessionId: "codex-1",
          directivesWritten: 1,
          compressedCount: 12,
          totalMessages: 80,
          savedTokens: 3200,
        }),
        JSON.stringify({
          timestamp: "2026-04-06T01:10:00.000Z",
          source: "claude",
          sessionId: "claude-1",
          directivesWritten: 0,
          compressedCount: 8,
          totalMessages: 40,
          savedTokens: 900,
          memoryCandidates: [
            "右邊側邊欄太多提醒了，這裡要再簡化一點。",
          ],
        }),
      ].join("\n")
    );

    writeFileSync(
      join(tempDir, "MEMORY.md"),
      [
        "## squeeze-claw directives (2026-04-06) [source:codex session:codex-1]",
        "",
        "- [codex codex-1] Never remove audit logs from production systems.",
        "",
        "## squeeze-claw directives (2026-04-06) [source:claude session:claude-1]",
        "",
        "- [claude claude-1] Always preserve backward compatibility.",
        "",
      ].join("\n")
    );

    const markdown = renderMarkdown(
      tempDir,
      loadProjectRuns(tempDir),
      parseMemoryEntries(join(tempDir, "MEMORY.md"))
    );

    expect(markdown).toContain("# oh-my-brain audit:");
    expect(markdown).toContain("`codex`: session `codex-1`");
    expect(markdown).toContain("`claude`: session `claude-1`");
    expect(markdown).toContain("Never remove audit logs from production systems.");
    expect(markdown).toContain("Always preserve backward compatibility.");
    expect(markdown).toContain("Memory Candidates");
    expect(markdown).toContain("右邊側邊欄太多提醒了");
    expect(markdown).toContain("Suggested Human Checks");
  });
});

describe("audit with domains", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports domain sizes and distribution", () => {
    tempDir = makeTmpDir();
    mkdirSync(join(tempDir, "memory"));
    writeFileSync(join(tempDir, "memory", "work.md"), "## work\n\n- rule 1\n- rule 2\n- rule 3\n");
    writeFileSync(join(tempDir, "memory", "life.md"), "## life\n\n- rule 1\n");
    const report = reportDomainStats(tempDir);
    expect(report).toContain("work");
    expect(report).toContain("3 directives");
    expect(report).toContain("life");
    expect(report).toContain("1 directive");
  });

  it("suggests splitting when domain exceeds 30 directives", () => {
    tempDir = makeTmpDir();
    mkdirSync(join(tempDir, "memory"));
    const bigDomain = Array.from({ length: 35 }, (_, i) => `- rule ${i}`).join("\n");
    writeFileSync(join(tempDir, "memory", "work.md"), `## work\n\n${bigDomain}\n`);
    const report = reportDomainStats(tempDir);
    expect(report).toContain("consider splitting");
    expect(report).toContain("work");
  });

  it("suggests merging when two domains have high keyword overlap", () => {
    tempDir = makeTmpDir();
    mkdirSync(join(tempDir, "memory"));
    // Use very similar content so keyword overlap exceeds 50%
    writeFileSync(join(tempDir, "memory", "coding.md"), "## coding\n\n- always use TDD testing\n- commit code often with tests\n- deploy code with tests passing\n- review code tests carefully\n");
    writeFileSync(join(tempDir, "memory", "development.md"), "## development\n\n- always write TDD tests\n- commit code with tests\n- deploy code after tests pass\n- code review requires tests\n");
    const report = reportDomainStats(tempDir);
    expect(report).toContain("consider merging");
  });

  it("returns empty string when memory/ does not exist", () => {
    tempDir = makeTmpDir();
    const report = reportDomainStats(tempDir);
    expect(report).toBe("");
  });
});
