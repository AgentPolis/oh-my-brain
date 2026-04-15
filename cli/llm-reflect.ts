/**
 * Post-session LLM reflection.
 *
 * One cheap LLM call (Haiku / GPT-4o-mini) at the end of compress hook.
 * Extracts corrections, sentiment, and structured events that regex misses.
 *
 * Falls back to no-op when no LLM CLI is available (offline / CI).
 */

import { spawnSync } from "child_process";

export interface ReflectionResult {
  corrections: string[];   // → Memory Candidates
  sentiments: string[];    // → logged for awareness
  events: ReflectedEvent[];
  raw?: string;            // raw LLM output for debugging
}

export interface ReflectedEvent {
  what: string;
  when?: string;
  who?: string[];
  category?: string;
  sentiment?: string;
}

/**
 * Detect which LLM CLI is available.
 * claude -p is preferred (runs inside Claude Code context).
 * codex exec is fallback.
 */
export function detectLLMCli(): "claude" | "codex" | null {
  const claudeResult = spawnSync("claude", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (!claudeResult.error && claudeResult.status === 0) return "claude";

  const codexResult = spawnSync("codex", ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (!codexResult.error && codexResult.status === 0) return "codex";

  return null;
}

const REFLECTION_PROMPT = `You are analyzing an AI coding session transcript. Extract the following in JSON format:

{
  "corrections": ["list of things the user corrected or told the agent was wrong/unnecessary — paraphrase as short actionable rules"],
  "sentiments": ["list of emotional signals — frustration, surprise, impatience, satisfaction — with context"],
  "events": [{"what": "...", "when": "...", "who": ["..."], "category": "...", "sentiment": "..."}]
}

Rules:
- corrections: Only include things the user explicitly pushed back on. Rephrase as concise rules (e.g., "Don't create GitHub issues for hypothetical user needs"). Skip positive confirmations.
- sentiments: Include emotional tone with what triggered it (e.g., "Frustrated — agent created unnecessary issues"). Skip neutral exchanges.
- events: Only extract things that HAPPENED (decisions made, things shipped, things discovered). Skip discussion.
- If nothing found for a category, return empty array.
- Return ONLY valid JSON, no explanation.

Session transcript:
`;

/**
 * Run post-session LLM reflection on user messages.
 * Returns corrections and sentiments extracted from the conversation.
 */
export function reflect(
  userMessages: string[],
  cli: "claude" | "codex"
): ReflectionResult {
  const empty: ReflectionResult = { corrections: [], sentiments: [], events: [] };

  if (userMessages.length === 0) return empty;

  // Truncate to ~15K chars to stay within cheap model context
  const transcript = userMessages
    .map((msg, i) => `[user-${i}] ${msg}`)
    .join("\n---\n")
    .slice(0, 15000);

  const prompt = REFLECTION_PROMPT + transcript;

  const command = cli === "claude" ? "claude" : "codex";
  const args = cli === "claude" ? ["-p", prompt] : ["exec", prompt];

  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30000, // 30s timeout
  });

  if (result.error || result.status !== 0) {
    return empty;
  }

  const raw = result.stdout.trim();

  try {
    // Strip markdown code fences if present
    const cleaned = raw
      .replace(/^```json\n?/m, "")
      .replace(/^```\n?/m, "")
      .replace(/```$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    return {
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections.filter((c: unknown) => typeof c === "string") : [],
      sentiments: Array.isArray(parsed.sentiments) ? parsed.sentiments.filter((s: unknown) => typeof s === "string") : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      raw,
    };
  } catch {
    // LLM returned invalid JSON — no-op
    return { ...empty, raw };
  }
}

/**
 * Run reflection if an LLM CLI is available.
 * Returns null if no LLM is available (offline mode).
 */
export function maybeReflect(
  userMessages: string[]
): ReflectionResult | null {
  const cli = detectLLMCli();
  if (!cli) return null;
  return reflect(userMessages, cli);
}
