import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildDiffReport,
  parseSinceInput,
  renderDiffReport,
  runDiffCli,
} from "../cli/diff.js";

describe("memory diff", () => {
  let tmpDir: string;
  let stdout = "";
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-diff-"));
    mkdirSync(join(tmpDir, ".squeeze"), { recursive: true });
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      [
        "# Memory",
        "",
        "- [codex] Prefer the simplest architecture that preserves correctness",
        "- [codex] Communicate bad news early, even before every detail is final",
      ].join("\n")
    );
    writeFileSync(
      join(tmpDir, ".squeeze", "actions.jsonl"),
      [
        JSON.stringify({
          id: "a1",
          kind: "RememberDirective",
          timestamp: "2026-04-12T10:00:00.000Z",
          source: "compress-hook",
          payload: {},
        }),
        JSON.stringify({
          id: "a2",
          kind: "PromoteCandidate",
          timestamp: "2026-04-13T10:00:00.000Z",
          source: "mcp",
          payload: {},
        }),
        JSON.stringify({
          id: "a3",
          kind: "RetireDirective",
          timestamp: "2026-04-13T12:00:00.000Z",
          source: "mcp",
          payload: {},
        }),
        JSON.stringify({
          id: "a4",
          kind: "RejectCandidate",
          timestamp: "2026-04-13T13:00:00.000Z",
          source: "mcp",
          payload: {},
        }),
      ].join("\n") + "\n"
    );
    writeFileSync(
      join(tmpDir, ".squeeze", "candidates.json"),
      JSON.stringify({
        version: 1,
        candidates: {
          c1: {
            id: "c1",
            text: "MERGE: unify auth directives",
            status: "pending",
            source: "claude",
            createdAt: "2026-04-13T10:00:00.000Z",
            lastSeenAt: "2026-04-13T10:00:00.000Z",
            mentionCount: 1,
          },
          c2: {
            id: "c2",
            text: "review deployment wording",
            status: "pending",
            source: "claude",
            createdAt: "2026-04-13T11:00:00.000Z",
            lastSeenAt: "2026-04-13T11:00:00.000Z",
            mentionCount: 1,
          },
        },
      })
    );
    writeFileSync(
      join(tmpDir, ".squeeze", "links.json"),
      JSON.stringify({
        version: 1,
        links: [
          {
            id: "l1",
            fromDirective: "Prefer simplicity",
            toDirective: "Always split services",
            kind: "contradicts",
            addedAt: "2026-04-13T11:00:00.000Z",
            origin: "user",
          },
        ],
      })
    );
    writeFileSync(
      join(tmpDir, ".squeeze", "archive.jsonl"),
      [
        JSON.stringify({
          id: "ar1",
          ts: "2026-04-12T09:00:00.000Z",
          ingest_ts: "2026-04-12T09:01:00.000Z",
          role: "user",
          content: "archived entry one",
          summary: "one",
          level: 1,
          turn_index: 1,
          tags: ["archive"],
        }),
        JSON.stringify({
          id: "ar2",
          ts: "2026-04-13T09:00:00.000Z",
          ingest_ts: "2026-04-13T09:01:00.000Z",
          role: "assistant",
          content: "archived entry two",
          summary: "two",
          level: 1,
          turn_index: 2,
          tags: ["archive"],
        }),
      ].join("\n") + "\n"
    );

    stdout = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      stdout += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses relative day input", () => {
    const parsed = parseSinceInput("3 days", new Date("2026-04-14T10:00:00.000Z"));
    expect(parsed.label).toBe("3 days");
    expect(Date.parse(parsed.to)).toBeGreaterThan(Date.parse(parsed.from));
    expect(Math.round((Date.parse(parsed.to) - Date.parse(parsed.from)) / (1000 * 60 * 60 * 24))).toBeGreaterThanOrEqual(3);
  });

  it("parses absolute date input", () => {
    const parsed = parseSinceInput("2026-04-01", new Date("2026-04-14T10:00:00.000Z"));
    expect(parsed.label).toBe("2026-04-01");
    expect(Date.parse(parsed.to)).toBeGreaterThan(Date.parse(parsed.from));
  });

  it("builds a report from actions.jsonl and current pending state", () => {
    const report = buildDiffReport(tmpDir, "7 days", new Date("2026-04-14T10:00:00.000Z"));
    expect(report.added.directives).toBe(2);
    expect(report.added.auto_saved).toBe(1);
    expect(report.added.candidates_approved).toBe(1);
    expect(report.removed.retired).toBe(1);
    expect(report.removed.rejected).toBe(1);
    expect(report.pending.candidates).toBe(2);
    expect(report.pending.merge_proposals).toBe(1);
    expect(report.pending.conflicts).toBe(1);
    expect(report.growth.total_directives).toBe(2);
    expect(report.archive).toEqual({ new_entries: 2, total_entries: 2 });
  });

  it("marks trend as insufficient data when fewer than 3 days are observed", () => {
    const report = buildDiffReport(tmpDir, "2026-04-13", new Date("2026-04-14T10:00:00.000Z"));
    expect(report.growth.trend).toBe("insufficient data");
  });

  it("computes growing and shrinking trend thresholds", () => {
    const growing = buildDiffReport(tmpDir, "last month", new Date("2026-04-14T10:00:00.000Z"));
    expect(growing.growth.trend).toBe("stable");

    appendFileSync(
      join(tmpDir, ".squeeze", "actions.jsonl"),
      Array.from({ length: 20 }, (_, index) =>
        JSON.stringify({
          id: `extra-${index}`,
          kind: "RememberDirective",
          timestamp: "2026-04-12T15:00:00.000Z",
          source: "compress-hook",
          payload: {},
        })
      ).join("\n") + "\n"
    );
    const updated = buildDiffReport(tmpDir, "7 days", new Date("2026-04-14T10:00:00.000Z"));
    expect(updated.growth.trend).toBe("growing");
  });

  it("renders the human-readable diff output", () => {
    const report = buildDiffReport(tmpDir, "7 days", new Date("2026-04-14T10:00:00.000Z"));
    const text = renderDiffReport(report);
    expect(text).toContain("oh-my-brain diff (last 7 days)");
    expect(text).toContain("+ 2 new directives learned");
    expect(text).toContain("Archive: +2 conversations archived");
  });

  it("runs the CLI with the default 7 day window", async () => {
    const code = await runDiffCli(["node", "diff"], tmpDir);
    expect(code).toBe(0);
    expect(stdout).toContain("oh-my-brain diff (last 7 days)");
  });
});
