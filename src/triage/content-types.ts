/**
 * Content type definitions and detection helpers.
 */

import type { ContentType } from "../types.js";

export const CONTENT_TYPE_DESCRIPTIONS: Record<ContentType, string> = {
  code: "Source code, diffs, file contents, AST references",
  tool_result: "Output from tool invocations",
  reasoning: "Chain-of-thought, analysis, explanations",
  instruction: "User directives, preferences, constraints",
  reference: "External links, documentation, API specs",
  conversation: "General dialogue, questions, acknowledgments",
};

export const ALL_CONTENT_TYPES: ContentType[] = [
  "code",
  "tool_result",
  "reasoning",
  "instruction",
  "reference",
  "conversation",
];
