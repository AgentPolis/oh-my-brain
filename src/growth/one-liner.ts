import type { SessionStats } from "../types.js";

/**
 * Build a one-line growth summary for session end.
 * Returns "" if nothing was learned.
 */
export function buildGrowthOneLiner(stats: SessionStats, isChinese: boolean): string {
  const fragments: string[] = [];

  if (stats.new_outcomes.length > 0) {
    const summary = stats.new_outcomes[0].failure_mode.slice(0, 30);
    fragments.push(
      isChinese
        ? `+${stats.new_outcomes.length} caution（${summary}）`
        : `+${stats.new_outcomes.length} caution (${summary})`
    );
  }

  if (stats.new_directives > 0) {
    fragments.push(
      isChinese
        ? `+${stats.new_directives} directive`
        : `+${stats.new_directives} directive`
    );
  }

  if (stats.new_preferences > 0) {
    fragments.push(
      isChinese
        ? `+${stats.new_preferences} preference`
        : `+${stats.new_preferences} preference`
    );
  }

  if (stats.new_procedures > 0) {
    fragments.push(
      isChinese
        ? `+${stats.new_procedures} procedure candidate`
        : `+${stats.new_procedures} procedure candidate`
    );
  }

  if (fragments.length === 0) return "";

  const joiner = isChinese ? "，" : ", ";
  const prefix = isChinese ? "🧠 本次學到：" : "🧠 Learned: ";
  return prefix + fragments.join(joiner);
}

/**
 * Detect whether a session is predominantly Chinese.
 * Returns true if >30% of characters in user messages are CJK.
 */
export function detectChinese(
  messages: Array<{ role: string; content: string }>
): boolean {
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("");

  if (userText.length === 0) return false;

  const cjkCount = (
    userText.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\uf900-\ufaff]/g) || []
  ).length;

  return cjkCount / userText.length > 0.3;
}
