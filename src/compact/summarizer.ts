/**
 * Heuristic summarizer for L1 message batches.
 * No LLM required — extracts user goals and assistant conclusions
 * using signal words. Zero API cost, safe for background/heartbeat use.
 */

import type { StoredMessage } from "../types.js";

export interface Summary {
  abstract: string;   // one-liner (<150 chars)
  overview: string;   // key facts, decisions (~300 chars)
  detail: string;     // full concatenated content (reference)
}

const CONCLUSION_SIGNALS = /\b(done|completed|created|implemented|decided|chose|will use|using|fixed|set up)\b/i;
const GOAL_SIGNALS = /\b(can you|help me|how do|please|need to|want to|should|could you)\b/i;

export function summarize(messages: StoredMessage[]): Summary {
  if (messages.length === 0) {
    return { abstract: "[empty batch]", overview: "", detail: "" };
  }

  const userMsgs = messages.filter(m => m.role === "user");
  const assistantMsgs = messages.filter(m => m.role === "assistant");

  // Abstract: first user message, trimmed to 120 chars
  const firstUser = userMsgs[0]?.content ?? messages[0].content;
  const abstract = firstUser.replace(/\s+/g, " ").trim().slice(0, 120) +
    (firstUser.length > 120 ? "…" : "");

  // Overview: goal sentences + conclusion sentences
  const goalSentences = userMsgs
    .flatMap(m => splitSentences(m.content))
    .filter(s => GOAL_SIGNALS.test(s))
    .slice(0, 3);

  const conclusionSentences = assistantMsgs
    .flatMap(m => splitSentences(m.content))
    .filter(s => CONCLUSION_SIGNALS.test(s))
    .slice(0, 3);

  const overviewParts = [...goalSentences, ...conclusionSentences];
  const overview = overviewParts.length > 0
    ? overviewParts.join(" ").slice(0, 600)
    : messages.slice(0, 3).map(m => `${m.role}: ${m.content.slice(0, 80)}`).join("\n");

  // Detail: full content for reference
  const detail = messages
    .map(m => `[${m.role} turn=${m.turnIndex}] ${m.content}`)
    .join("\n\n");

  return { abstract, overview, detail };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10 && s.length < 300);
}
