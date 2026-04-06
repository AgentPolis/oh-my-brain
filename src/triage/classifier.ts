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

  // ── L2 detection: explicit preference statements ──────────────
  // These are unambiguous user preferences ("I prefer tabs", "我比較喜歡 X")
  // that don't need repetition to be confident. Implicit preferences that
  // only emerge through repetition are handled separately by the mention-
  // counting observation loop (planned).
  if (hasPreferenceSignal(content)) {
    return {
      level: Level.Preference,
      contentType,
      confidence: 0.7,
    };
  }

  // ── Default: L1 Observation ────────────────────────────────────
  // L2 promotion via repetition happens in the observation loop.
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
  // L3 Chinese patterns are restricted to the strongest imperatives only.
  // Softer signals like "應該", "太多", "搞錯" are intentionally excluded here
  // because they trigger false positives on questions and observations
  // ("這應該怎麼做?" should not be L3). Those live in Memory Candidates.
  /(一律|永遠|都要|不要再|別再|從現在開始|絕對不能)/,
];

function hasDirectiveSignal(content: string): boolean {
  return DIRECTIVE_PATTERNS.some((p) => p.test(content));
}

// L2 preference patterns — explicit "I prefer / I like / I find X easier" and
// Chinese equivalents. Deliberately narrower than L3: these are soft
// preferences the user has stated but not elevated to a rule. If a sentence
// matches both L3 and L2 patterns, L3 wins because it is checked first.
const PREFERENCE_PATTERNS = [
  /\b(i prefer|i'd prefer|i would prefer|i like|i'd like|i would like)\b/i,
  /\b(makes more sense|easier to read|easier to use|more readable)\b/i,
  /\b(i find .{3,40} (easier|cleaner|nicer|better))/i,
  /(我比較喜歡|我偏好|我喜歡|比較順手|比較直覺|用起來比較)/,
];

function hasPreferenceSignal(content: string): boolean {
  return PREFERENCE_PATTERNS.some((p) => p.test(content));
}
