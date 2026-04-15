import crypto from "crypto";
import type { ProcedureRecord, ProcedureStep } from "../types.js";

interface SessionMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

const TOOL_USE_PATTERN = /Using\s+(\w+):\s+(.+)/;
const VERIFICATION_KEYWORDS = /\b(?:test|verify|assert|check|confirm|passed|HTTP\s*2\d{2})\b/i;

export function extractProcedure(
  messages: SessionMessage[],
  title: string,
  trigger: string,
  sessionId: string,
): ProcedureRecord {
  const steps: ProcedureStep[] = [];
  const pitfalls: string[] = [];
  const verification: string[] = [];

  // Extract tool calls from assistant messages
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const match = msg.content.match(TOOL_USE_PATTERN);
    if (match) {
      steps.push({
        order: steps.length + 1,
        action: match[2].trim(),
        tool: match[1],
      });
    }
  }

  // Detect error→retry sequences as pitfalls
  for (let i = 0; i < messages.length - 1; i++) {
    const current = messages[i];
    const next = messages[i + 1];

    const isError =
      (current.role === "tool" || current.role === "assistant") &&
      /\b(?:error|failed|failure|exception|ENOENT|exit code [1-9])\b/i.test(current.content);

    const isRetry =
      next.role === "assistant" &&
      TOOL_USE_PATTERN.test(next.content);

    if (isError && isRetry) {
      const errorSnippet = current.content.slice(0, 120).replace(/\n/g, " ").trim();
      pitfalls.push(`Error encountered: ${errorSnippet} — retry followed`);
    }
  }

  // Extract verification from last 3 tool results with verification keywords
  const toolResults = messages
    .map((msg, idx) => ({ msg, idx }))
    .filter(({ msg }) => msg.role === "tool" || msg.role === "assistant");

  const last3 = toolResults.slice(-3);
  for (const { msg } of last3) {
    if (VERIFICATION_KEYWORDS.test(msg.content)) {
      const snippet = msg.content.slice(0, 120).replace(/\n/g, " ").trim();
      verification.push(snippet);
    }
  }

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID().slice(0, 12),
    title,
    trigger,
    steps,
    pitfalls,
    verification,
    status: "candidate",
    source_session_id: sessionId,
    created_at: now,
    updated_at: now,
  };
}
