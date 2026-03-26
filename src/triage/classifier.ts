/**
 * Hybrid classifier: regex fast-path + LLM fallback.
 *
 * Phase 1: regex-only mode (no external LLM dependency).
 * Phase 2: add LLM classification for L1/L2/L3 distinction.
 */

import type { Classification, ContentType, Message } from "../types.js";
import { Level } from "../types.js";
import { isL0Noise, hintContentType } from "./patterns.js";

export interface ClassifierOptions {
  confidenceThreshold: number;
  mode: "hybrid" | "regex" | "llm";
}

/**
 * Classify a single message.
 *
 * Current implementation: regex-based heuristics.
 * L0 detection is high-confidence. L1/L2/L3 distinction uses heuristics
 * with moderate confidence — will be replaced by LLM in Phase 2.
 *
 * previousContent: the content of the preceding message, used to determine
 * if a short ack ("yes", "ok") is a meaningful response to a question.
 */
export function classify(msg: Message, opts: ClassifierOptions, previousContent?: string): Classification {
  const content = msg.content;

  // ── L0 fast path ───────────────────────────────────────────────
  if (isL0Noise(content, previousContent)) {
    return { level: Level.Discard, contentType: "conversation", confidence: 0.95 };
  }

  // ── Content type hint ──────────────────────────────────────────
  const typeHint = hintContentType(msg.role, content);
  const contentType: ContentType = (typeHint as ContentType) ?? "conversation";

  // ── L3 detection: explicit directive patterns ──────────────────
  if (hasDirectiveSignal(content)) {
    return {
      level: Level.Directive,
      contentType: typeHint === "instruction" ? "instruction" : contentType,
      confidence: 0.8,
    };
  }

  // ── Default: L1 Observation ────────────────────────────────────
  // L2 promotion happens in the observation loop, not at classification time.
  return {
    level: Level.Observation,
    contentType,
    confidence: 0.6,
  };
}

/**
 * Batch classify multiple messages.
 * In regex mode this is just a loop. In LLM mode this would batch the API call.
 */
export function classifyBatch(
  messages: Message[],
  opts: ClassifierOptions
): Classification[] {
  return messages.map((msg, i) =>
    classify(msg, opts, i > 0 ? messages[i - 1].content : undefined)
  );
}

// ── internal ─────────────────────────────────────────────────────

const DIRECTIVE_PATTERNS = [
  /\b(always|never|from now on|remember that|don't ever|do not ever)\b/i,
  /\b(my role is|i am a|i'm a)\b/i,
  /\b(rule|requirement|constraint|must|shall)\s*:/i,
];

function hasDirectiveSignal(content: string): boolean {
  return DIRECTIVE_PATTERNS.some((p) => p.test(content));
}
