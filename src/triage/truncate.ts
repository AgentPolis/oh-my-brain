import { estimateTokens } from "../assembly/budget.js";
import type { ContentType } from "../types.js";

/** Max tokens for a stored tool result. ~400 tokens ≈ a screenful of output. */
export const TOOL_OUTPUT_MAX_TOKENS = 400;

/**
 * Truncate tool output that would exceed TOOL_OUTPUT_MAX_TOKENS.
 * Keeps the head (70%) and tail (20%) of the token budget, inserts a marker in the middle.
 * Non-tool content is never truncated here.
 */
export function truncateIfNeeded(content: string, contentType: ContentType): string {
  if (contentType !== "tool_result") return content;
  if (estimateTokens(content) <= TOOL_OUTPUT_MAX_TOKENS) return content;

  const totalChars = content.length;
  const totalTokens = estimateTokens(content);
  // Scale char counts proportionally to the token budget
  const ratio = TOOL_OUTPUT_MAX_TOKENS / totalTokens;
  const headChars = Math.floor(totalChars * ratio * 0.70);
  const tailChars = Math.floor(totalChars * ratio * 0.20);
  const skipped = totalChars - headChars - tailChars;

  const head = content.slice(0, headChars);
  const tail = content.slice(totalChars - tailChars);
  const skippedTokens = estimateTokens(content.slice(headChars, totalChars - tailChars));

  return `${head}\n... [truncated ${skippedTokens} tokens, ${skipped} chars] ...\n${tail}`;
}
