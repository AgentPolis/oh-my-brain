import { describe, it, expect } from "vitest";
import { assemble } from "../src/assembly/assembler.js";
import { allocateBudget, heuristicTokenCount } from "../src/assembly/budget.js";
import { DEFAULT_CONFIG, DEFAULT_TASK_WEIGHTS } from "../src/types.js";
import type {
  DirectiveRecord,
  PreferenceRecord,
  StoredMessage,
  Message,
  DagNode,
  SqueezeConfig,
} from "../src/types.js";
import type { AssemblerInput } from "../src/assembly/assembler.js";
import type { BudgetAllocation } from "../src/assembly/budget.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeDirective(id: number, key: string, value: string): DirectiveRecord {
  return {
    id,
    key,
    value,
    sourceMsgId: id,
    createdAt: new Date().toISOString(),
    eventTime: new Date().toISOString(),
    confirmedByUser: true,
    evidenceText: null,
    evidenceTurn: null,
    lastReferencedAt: null,
    supersededBy: null,
    supersededAt: null,
  };
}

function makePreference(
  id: number,
  key: string,
  value: string,
  confidence: number
): PreferenceRecord {
  return {
    id,
    key,
    value,
    confidence,
    sourceMsgId: id,
    createdAt: new Date().toISOString(),
    eventTime: new Date().toISOString(),
    supersededBy: null,
    supersededAt: null,
  };
}

function makeStoredMessage(
  id: number,
  content: string,
  turnIndex: number,
  role: "user" | "assistant" = "user"
): StoredMessage {
  return {
    id,
    role,
    content,
    level: 1,
    contentType: "conversation",
    confidence: 0.5,
    turnIndex,
    createdAt: new Date(Date.now() + turnIndex * 1000).toISOString(),
  };
}

function makeDagNode(id: number, abstract: string, minTurn: number, maxTurn: number): DagNode {
  return {
    id,
    parentId: null,
    abstract,
    overview: `Overview of turns ${minTurn}-${maxTurn}`,
    detail: `Full detail of turns ${minTurn}-${maxTurn}`,
    sourceIds: [id],
    minTurn,
    maxTurn,
    level: 1,
    createdAt: new Date().toISOString(),
  };
}

function largeBudget(): BudgetAllocation {
  return allocateBudget(100_000, 500, DEFAULT_TASK_WEIGHTS.chat, DEFAULT_CONFIG);
}

function makeInput(overrides: Partial<AssemblerInput> = {}): AssemblerInput {
  return {
    systemPrompt: [{ role: "system", content: "You are a helpful assistant." }],
    directives: [],
    preferences: [],
    freshTail: [],
    taskType: "chat",
    budget: largeBudget(),
    config: DEFAULT_CONFIG,
    degraded: false,
    dagNodes: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("assemble", () => {
  it("directives appear before fresh tail in assembled messages", () => {
    const directives = [
      makeDirective(1, "lang", "always reply in English"),
    ];
    const freshTail = [
      makeStoredMessage(10, "What is the weather?", 5),
      makeStoredMessage(11, "It is sunny today.", 5, "assistant"),
    ];

    const result = assemble(makeInput({ directives, freshTail }));

    // Find indices: system prompt at 0, directive block next, then fresh tail
    const directiveIdx = result.messages.findIndex((m) =>
      m.content.includes("squeeze-directives")
    );
    const firstTailIdx = result.messages.findIndex((m) =>
      m.content === "What is the weather?"
    );

    expect(directiveIdx).toBeGreaterThan(0); // after system prompt
    expect(firstTailIdx).toBeGreaterThan(directiveIdx); // after directives
  });

  it("preferences with confidence below threshold are excluded", () => {
    const config: SqueezeConfig = { ...DEFAULT_CONFIG, preferenceConfidenceThreshold: 0.6 };
    const preferences = [
      makePreference(1, "color", "blue", 0.3), // below threshold
      makePreference(2, "font", "monospace", 0.8), // above threshold
    ];

    const result = assemble(makeInput({ preferences, config }));

    const prefBlock = result.messages.find((m) =>
      m.content.includes("squeeze-preferences")
    );

    expect(prefBlock).toBeDefined();
    expect(prefBlock!.content).toContain("font");
    expect(prefBlock!.content).not.toContain("color");
    // metadata reports only eligible count
    expect(result.metadata.preferenceCount).toBe(1);
  });

  it("all preferences below threshold means no preference block", () => {
    const config: SqueezeConfig = { ...DEFAULT_CONFIG, preferenceConfidenceThreshold: 0.9 };
    const preferences = [
      makePreference(1, "color", "blue", 0.3),
      makePreference(2, "font", "monospace", 0.5),
    ];

    const result = assemble(makeInput({ preferences, config }));

    const prefBlock = result.messages.find((m) =>
      m.content.includes("squeeze-preferences")
    );
    expect(prefBlock).toBeUndefined();
    expect(result.metadata.preferenceCount).toBe(0);
  });

  it("fresh tail messages are in chronological order", () => {
    const freshTail = [
      makeStoredMessage(1, "First message", 1),
      makeStoredMessage(2, "Second message", 2),
      makeStoredMessage(3, "Third message", 3),
    ];

    const result = assemble(makeInput({ freshTail }));

    const tailContents = result.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content);

    expect(tailContents).toEqual([
      "First message",
      "Second message",
      "Third message",
    ]);
  });

  it("assembly does not exceed budget total", () => {
    // Create a very tight budget
    const tinyBudget: BudgetAllocation = {
      systemPrompt: 50,
      memory: 20,
      freshTail: 30,
      toolResults: 0,
      prefetch: 0,
      historySummaries: 0,
      total: 100,
    };

    const freshTail = Array.from({ length: 50 }, (_, i) =>
      makeStoredMessage(i, `Message number ${i} with some extra content to use tokens`, i)
    );

    const result = assemble(
      makeInput({
        budget: tinyBudget,
        freshTail,
        systemPrompt: [{ role: "system", content: "Hi" }],
      })
    );

    expect(result.tokenCount).toBeLessThanOrEqual(tinyBudget.total);
    // Not all 50 messages should have fit
    expect(result.messages.length).toBeLessThan(51);
  });

  it("DAG summaries are injected between preferences and fresh tail", () => {
    const directives = [makeDirective(1, "rule", "be concise")];
    const preferences = [makePreference(2, "style", "formal", 0.8)];
    const dagNodes = [makeDagNode(1, "User discussed project setup", 1, 5)];
    const freshTail = [
      makeStoredMessage(20, "Latest question", 10),
    ];

    const budget = allocateBudget(100_000, 500, DEFAULT_TASK_WEIGHTS.chat, DEFAULT_CONFIG);

    const result = assemble(
      makeInput({ directives, preferences, dagNodes, freshTail, budget })
    );

    // Find positions of each section
    const directiveIdx = result.messages.findIndex((m) =>
      m.content.includes("squeeze-directives")
    );
    const prefIdx = result.messages.findIndex((m) =>
      m.content.includes("squeeze-preferences")
    );
    const summaryIdx = result.messages.findIndex((m) =>
      m.content.includes("[Summary turns")
    );
    const tailIdx = result.messages.findIndex((m) =>
      m.content === "Latest question"
    );

    expect(directiveIdx).toBeGreaterThan(0);
    expect(prefIdx).toBeGreaterThan(directiveIdx);
    expect(summaryIdx).toBeGreaterThan(prefIdx);
    expect(tailIdx).toBeGreaterThan(summaryIdx);
    expect(result.metadata.summaryCount).toBe(1);
  });

  it("metadata reports correct counts", () => {
    const directives = [
      makeDirective(1, "a", "directive a"),
      makeDirective(2, "b", "directive b"),
    ];
    const freshTail = [
      makeStoredMessage(10, "msg1", 1),
      makeStoredMessage(11, "msg2", 2),
      makeStoredMessage(12, "msg3", 3),
    ];

    const result = assemble(makeInput({ directives, freshTail }));

    expect(result.metadata.directiveCount).toBe(2);
    expect(result.metadata.freshTailCount).toBe(3);
    expect(result.metadata.degraded).toBe(false);
  });

  it("degraded flag is passed through in metadata", () => {
    const result = assemble(
      makeInput({ degraded: true, degradedReason: "classifier timeout" })
    );

    expect(result.metadata.degraded).toBe(true);
    expect(result.metadata.degradedReason).toBe("classifier timeout");
  });
});
