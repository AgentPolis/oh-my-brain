import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgliteFactory } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyRememberDirective } from "../cli/actions.js";
import {
  approveReflectionProposal,
  buildGrowthSnapshot,
  consolidateProject,
  dismissReflectionProposal,
  loadGrowthJournal,
  loadReflectionProposals,
  renderConsolidationReport,
  renderReflectionProposals,
  renderGrowthSnapshot,
  runConsolidateCli,
  runGrowthCli,
  runReflectCli,
} from "../cli/consolidate.js";
import { saveHabits } from "../cli/habit-detector.js";
import { EventStore } from "../src/storage/events.js";

describe("offline consolidation", () => {
  let tmpDir: string;
  let stdout = "";
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-consolidate-"));
    stdout = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs external scan, reflection loop, and sleep consolidation together", async () => {
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        type: "module",
        devDependencies: { vitest: "^3.2.0" },
      })
    );
    writeFileSync(join(tmpDir, ".cursorrules"), "I prefer tabs over spaces\n");

    await applyRememberDirective(
      { projectRoot: tmpDir, source: "codex", sessionId: "seed" },
      { text: "Always review code for error handling first" }
    );

    const db = await pgliteFactory.create(join(tmpDir, ".squeeze", "brain.pg"));
    await initPgSchema(db);
    await db.exec(
      `UPDATE directives
       SET last_referenced_at = '2026-01-01T00:00:00.000Z',
           created_at = '2026-01-01T00:00:00.000Z'
       WHERE value = $1`,
      ["Always review code for error handling first"]
    );
    await db.close();

    const squeezePath = join(tmpDir, ".squeeze");
    mkdirSync(squeezePath, { recursive: true });

    const events = new EventStore(squeezePath);
    events.append([
      {
        id: "e1",
        ts: "2026-04-01T10:00:00.000Z",
        ts_ingest: "2026-04-01T10:01:00.000Z",
        ts_precision: "exact",
        what: "flew United to Seattle",
        detail: "",
        category: "travel",
        who: [],
        where: "Seattle",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "I flew United to Seattle.",
        session_id: "sess-1",
        turn_index: 1,
      },
      {
        id: "e2",
        ts: "2026-04-05T10:00:00.000Z",
        ts_ingest: "2026-04-05T10:01:00.000Z",
        ts_precision: "exact",
        what: "flew United to Denver",
        detail: "",
        category: "travel",
        who: [],
        where: "Denver",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "I flew United to Denver.",
        session_id: "sess-2",
        turn_index: 2,
      },
      {
        id: "e3",
        ts: "2026-04-10T10:00:00.000Z",
        ts_ingest: "2026-04-10T10:01:00.000Z",
        ts_precision: "exact",
        what: "flew United to Austin",
        detail: "",
        category: "travel",
        who: [],
        where: "Austin",
        related_to: [],
        sentiment: "",
        viewpoint: "",
        insight: "",
        source_text: "I flew United to Austin.",
        session_id: "sess-3",
        turn_index: 3,
      },
    ]);

    saveHabits(tmpDir, [
      {
        id: "h1",
        pattern: "always review error handling first",
        confidence: 0.9,
        evidence: ["e1"],
        first_seen: "2026-04-01T10:00:00.000Z",
        occurrences: 3,
      },
      {
        id: "h2",
        pattern: "always review naming after tests",
        confidence: 0.85,
        evidence: ["e2"],
        first_seen: "2026-04-02T10:00:00.000Z",
        occurrences: 3,
      },
    ]);

    const report = await consolidateProject(tmpDir, { staleDays: 30 });
    expect(report.external.directivesLearned).toBeGreaterThanOrEqual(2);
    expect(report.external.candidatesQueued).toBeGreaterThanOrEqual(1);
    expect(report.reflection.proposalsCreated).toBeGreaterThanOrEqual(1);
    expect(report.consolidation.newHabits).toBeGreaterThanOrEqual(1);
    expect(report.consolidation.newSchemas).toBeGreaterThanOrEqual(1);

    const memory = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("This project uses ESM (import/export), not CommonJS (require)");
    expect(memory).toContain("This project uses Vitest for tests");

    const reflections = loadReflectionProposals(tmpDir);
    expect(reflections.some((proposal) => proposal.kind === "retire")).toBe(true);
    expect(reflections.some((proposal) => proposal.title.includes("Always review code for error handling first"))).toBe(true);

    const journal = loadGrowthJournal(tmpDir);
    expect(journal).toHaveLength(1);
    expect(journal[0].summary).toContain("Learned");
    expect(existsSync(join(tmpDir, ".squeeze", "timeline.json"))).toBe(true);
    expect(existsSync(join(tmpDir, ".squeeze", "schemas.json"))).toBe(true);

    const rendered = renderConsolidationReport(report);
    expect(rendered).toContain("oh-my-brain consolidate");
    expect(rendered).toContain("Reflection loop:");

    const exitCode = await runConsolidateCli(["node", "consolidate", "--stale-days", "30"], tmpDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("oh-my-brain consolidate");

    const growth = buildGrowthSnapshot(tmpDir);
    expect(growth.pendingProposals).toBeGreaterThanOrEqual(1);
    expect(growth.latestJournal).not.toBeNull();
    expect(renderGrowthSnapshot(growth)).toContain("oh-my-brain growth");

    const growthCode = await runGrowthCli(["node", "growth"], tmpDir);
    expect(growthCode).toBe(0);
    expect(stdout).toContain("oh-my-brain growth");

    const retireProposal = reflections.find((proposal) => proposal.kind === "retire");
    expect(retireProposal).toBeDefined();
    const approved = await approveReflectionProposal(tmpDir, retireProposal!.id);
    expect(approved).not.toBeNull();
    expect(approved!.proposal.status).toBe("resolved");

    const afterApprove = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(afterApprove).toContain("## oh-my-brain archive");

    const manualProposalPath = join(tmpDir, ".squeeze", "reflection-proposals.json");
    const proposalDoc = JSON.parse(readFileSync(manualProposalPath, "utf8")) as {
      version: number;
      proposals: Array<Record<string, unknown>>;
    };
    proposalDoc.proposals.push({
      id: "manual-proposal",
      kind: "review_external",
      title: "Review external signal",
      detail: "manually seeded for dismiss flow",
      evidence: ["Recent git history suggests the project is standardizing on tsup"],
      status: "pending",
      createdAt: "2026-04-14T00:00:00.000Z",
      updatedAt: "2026-04-14T00:00:00.000Z",
    });
    writeFileSync(manualProposalPath, JSON.stringify(proposalDoc, null, 2));

    const dismissed = dismissReflectionProposal(tmpDir, "manual-proposal");
    expect(dismissed?.status).toBe("dismissed");

    expect(renderReflectionProposals(loadReflectionProposals(tmpDir))).toContain("oh-my-brain reflect");

    const reflectCode = await runReflectCli(["node", "reflect", "list", "--all"], tmpDir);
    expect(reflectCode).toBe(0);
    expect(stdout).toContain("oh-my-brain reflect");
  });
});
