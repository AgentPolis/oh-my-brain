import { randomUUID } from "crypto";
import type { OutcomeRecord } from "../types.js";

interface SimpleMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
}

// Only match in tool_result or user messages, NOT assistant
const TOOL_FAILURE_PATTERNS = [
  /exit code [1-9]\d*/i,
  /\bFAILED\b/,
  /\bERROR\b.*(?:refused|timeout|ENOENT|EACCES|EPERM)/i,
  /\bstderr\b.{0,50}\S/i,
];

const USER_CORRECTION_PATTERNS = [
  /\b(?:wrong|broke|broken|redo)\b/i,
  /不對|壞了|搞砸|錯了|重做/,
];

const ROLLBACK_PATTERNS = [
  /\b(?:rollback|revert|回滾)\b/i,
];

// Skip matches containing these (false positives)
const EXCLUSIONS = [
  /error\s+handling/i,
  /error\s+boundary/i,
  /TypeError\s+docs?/i,
  /revert\s+commit/i,
  /error\s+message/i,
  /error\s+code/i,
];

const WINDOW_SIZE = 6; // 6-message window for confidence gate

export function scanSessionForFailures(
  messages: SimpleMessage[],
  sessionId: string,
  maxMessages = 50
): OutcomeRecord[] {
  if (messages.length === 0) return [];

  const recent = messages.slice(-maxMessages);
  const outcomes: OutcomeRecord[] = [];

  // Scan with sliding window
  for (let i = 0; i < recent.length; i++) {
    const windowStart = Math.max(0, i - 3);
    const windowEnd = Math.min(recent.length, i + 4);
    const window = recent.slice(windowStart, windowEnd);

    // Count signals in window (only from tool/user messages)
    let signals = 0;
    let failureType: "rollback" | "error" | "correction" = "error";
    let failureDetail = "";

    for (const m of window) {
      if (m.role === "assistant" || m.role === "system") continue;

      const text = m.content;

      // Check exclusions first
      if (EXCLUSIONS.some((ex) => ex.test(text))) continue;

      for (const pattern of TOOL_FAILURE_PATTERNS) {
        if (m.role === "tool" && pattern.test(text)) {
          signals++;
          // Prefer keeping the first tool error as the primary detail
          if (!failureDetail) {
            failureType = "error";
            failureDetail = text.slice(0, 100);
          }
          break;
        }
      }

      for (const pattern of USER_CORRECTION_PATTERNS) {
        if (m.role === "user" && pattern.test(text)) {
          signals++;
          if (!failureDetail) {
            failureType = "correction";
            failureDetail = text.slice(0, 100);
          }
          break;
        }
      }

      for (const pattern of ROLLBACK_PATTERNS) {
        if (pattern.test(text)) {
          signals++;
          if (!failureDetail) {
            failureType = "rollback";
            failureDetail = text.slice(0, 100);
          }
          break;
        }
      }
    }

    // Confidence gate: require 2+ signals
    if (signals >= 2) {
      const contextText = window
        .map((m) => `[${m.role}] ${m.content.slice(0, 50)}`)
        .join(" | ")
        .slice(0, 200);

      outcomes.push({
        id: randomUUID().slice(0, 12),
        result: "failure",
        failure_mode: failureDetail,
        context: contextText,
        lesson: generateLesson(failureType, failureDetail, contextText),
        session_id: sessionId,
        timestamp: new Date().toISOString(),
      });

      // Skip ahead past this window to avoid duplicate detections
      // (loop will i++ so we land at windowEnd + 1)
      i = windowEnd;
    }
  }

  return outcomes;
}

export function generateLesson(
  type: "rollback" | "error" | "correction",
  detail: string,
  context: string
): string {
  const shortContext = context.slice(0, 80);
  switch (type) {
    case "rollback":
      return `Last time ${shortContext} required rollback. Do a dry-run first next time.`;
    case "error":
      return `Last time ${shortContext} hit ${detail.slice(0, 50)}. Watch out for this.`;
    case "correction":
      return `Last time ${shortContext} was corrected by user: ${detail.slice(0, 50)}.`;
  }
}
