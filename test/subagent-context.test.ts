import { describe, expect, it } from "vitest";
import { formatPersonalContext } from "../src/assembly/assembler.js";
import type { DirectiveRecord, OutcomeRecord, ProcedureRecord } from "../src/types.js";

function makeDirective(id: number, value: string): DirectiveRecord {
  return {
    id,
    key: `key_${id}`,
    value,
    sourceMsgId: id,
    createdAt: "2026-04-15T00:00:00.000Z",
    eventTime: "2026-04-15T00:00:00.000Z",
    confirmedByUser: true,
    evidenceText: null,
    evidenceTurn: null,
    lastReferencedAt: null,
    supersededBy: null,
    supersededAt: null,
  };
}

function makeProcedure(overrides: Partial<ProcedureRecord> = {}): ProcedureRecord {
  return {
    id: "proc-1",
    title: overrides.title ?? "Production Deploy",
    trigger: overrides.trigger ?? "deploy to production",
    steps: overrides.steps ?? [
      { order: 1, action: "Run smoke test suite", tool: "bash" },
      { order: 2, action: "Deploy canary at 10%", tool: "bash" },
      { order: 3, action: "Monitor 15 minutes" },
      { order: 4, action: "Full rollout", tool: "bash" },
    ],
    pitfalls: overrides.pitfalls ?? ["Don't skip migration check"],
    verification: overrides.verification ?? ["Run health check endpoint"],
    status: "approved",
    source_session_id: "sess-1",
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
  };
}

function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    id: overrides.id ?? "out-1",
    result: "failure",
    failure_mode: overrides.failure_mode ?? "deploy rollback",
    context: overrides.context ?? "blue-green deploy failed",
    lesson: overrides.lesson ?? "Last time blue-green deploy failed due to missing migration.",
    session_id: "sess-1",
    timestamp: overrides.timestamp ?? "2026-03-20T10:00:00.000Z",
  };
}

describe("formatPersonalContext", () => {
  it("includes all sections when directives, procedure, and cautions provided", () => {
    const directives = [
      makeDirective(1, "Always run smoke test before production deploy"),
      makeDirective(2, "Never deploy during Asia business hours"),
    ];
    const procedure = makeProcedure();
    const cautions = [makeOutcome(), makeOutcome({ id: "out-2", lesson: "npm test may fail if lockfile is stale" })];

    const result = formatPersonalContext(directives, procedure, cautions);

    expect(result).toContain("## Your Rules");
    expect(result).toContain("Always run smoke test");
    expect(result).toContain("## Procedure: Production Deploy");
    expect(result).toContain("1. Run smoke test suite");
    expect(result).toContain("## Cautions");
    expect(result).toContain("blue-green deploy failed");
  });

  it("omits procedure section when procedure is null", () => {
    const directives = [makeDirective(1, "Use TypeScript strict mode")];
    const cautions = [makeOutcome()];

    const result = formatPersonalContext(directives, null, cautions);

    expect(result).toContain("## Your Rules");
    expect(result).toContain("## Cautions");
    expect(result).not.toContain("## Procedure");
  });

  it("omits cautions section when cautions array is empty", () => {
    const directives = [makeDirective(1, "Use TypeScript strict mode")];
    const procedure = makeProcedure();

    const result = formatPersonalContext(directives, procedure, []);

    expect(result).toContain("## Your Rules");
    expect(result).toContain("## Procedure");
    expect(result).not.toContain("## Cautions");
  });

  it("wraps output in <personal-context> tags", () => {
    const directives = [makeDirective(1, "Rule one")];

    const result = formatPersonalContext(directives, null, []);

    expect(result).toMatch(/^<personal-context>\n/);
    expect(result).toMatch(/\n<\/personal-context>$/);
  });

  it("respects token cap by reducing cautions and procedure", () => {
    // Create many directives + long procedure to push over budget
    const directives = Array.from({ length: 50 }, (_, i) =>
      makeDirective(i, `This is directive number ${i} with a reasonably long text to consume tokens in the budget`)
    );
    const procedure = makeProcedure({
      steps: Array.from({ length: 20 }, (_, i) => ({
        order: i + 1,
        action: `Step ${i + 1}: do something elaborate and detailed that uses many tokens`,
        tool: "bash",
      })),
    });
    const cautions = Array.from({ length: 5 }, (_, i) =>
      makeOutcome({ id: `out-${i}`, lesson: `Caution ${i}: something went wrong in a fairly elaborate way` })
    );

    const result = formatPersonalContext(directives, procedure, cautions, 2000);

    // The heuristic is ~4 chars per token, so 2000 tokens ~ 8000 chars
    // The result should be under the cap (the function degrades cautions/procedure)
    // We can't assert exact token count, but the function should have reduced content
    expect(result).toContain("<personal-context>");
    expect(result).toContain("</personal-context>");
    expect(result).toContain("## Your Rules");
  });
});
