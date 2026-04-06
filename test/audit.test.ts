import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadProjectRuns, parseMemoryEntries, renderMarkdown } from "../cli/audit.js";

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
