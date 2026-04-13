import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import {
  buildDecisionPrompt,
  loadDecisionScenarios,
  matchesExpectedDecision,
  type DecisionCategory,
  type DecisionScenario,
} from "./eval.js";
import { OhMyBrainAdapter } from "../eval/decision-replay/adapter.js";

export interface QuizHistoryEntry {
  ts: string;
  total: number;
  correct: number;
  score: number;
  scenarios: string[];
}

export interface QuizQuestionResult {
  scenario: DecisionScenario;
  answer: string;
  correct: boolean;
}

export interface QuizRunResult {
  total: number;
  correct: number;
  score: number;
  results: QuizQuestionResult[];
}

export interface QuizHistorySummary {
  runs: number;
  averageScore: number;
  trend: "↑" | "↓" | "→";
}

function historyPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", "quiz-history.jsonl");
}

export function loadQuizHistory(projectRoot: string): QuizHistoryEntry[] {
  const path = historyPath(projectRoot);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as QuizHistoryEntry];
      } catch {
        return [];
      }
    });
}

export function appendQuizHistory(
  projectRoot: string,
  entry: QuizHistoryEntry
): void {
  mkdirSync(join(projectRoot, ".squeeze"), { recursive: true });
  appendFileSync(historyPath(projectRoot), JSON.stringify(entry) + "\n");
}

export function summarizeQuizHistory(projectRoot: string): QuizHistorySummary | null {
  const history = loadQuizHistory(projectRoot);
  if (history.length === 0) return null;
  const averageScore = Math.round(
    history.reduce((sum, entry) => sum + entry.score, 0) / history.length
  );
  const last = history[history.length - 1];
  const previous = history.length > 1 ? history[history.length - 2] : null;
  const trend =
    previous === null ? "→" : last.score > previous.score ? "↑" : last.score < previous.score ? "↓" : "→";

  return {
    runs: history.length,
    averageScore,
    trend,
  };
}

export function formatQuizHistorySummary(summary: QuizHistorySummary | null): string {
  if (!summary) return "quiz_history: 0 runs";
  return `quiz_history: ${summary.runs} runs, avg ${summary.averageScore}%, trend ${summary.trend}`;
}

export function sampleQuizScenarios(
  projectRoot: string,
  total: number,
  category?: DecisionCategory | "random"
): DecisionScenario[] {
  const all = loadDecisionScenarios(projectRoot);
  const pool =
    category && category !== "random"
      ? all.filter((scenario) => scenario.category === category)
      : all;
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(total, shuffled.length));
}

export function formatShareText(result: QuizRunResult): string {
  return [
    `My AI scored ${result.score}% on Decision Match 🧠`,
    `${result.correct}/${result.total} decisions matched my judgment.`,
    "Tested with oh-my-brain: https://github.com/AgentPolis/oh-my-brain",
    "#DecisionMatch #AIMemory",
  ].join("\n");
}

function maybeCopyToClipboard(text: string): string {
  const result = spawnSync("pbcopy", { input: text, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return "Pipe the share block to pbcopy if you want it on the clipboard.";
  }
  return "Copied to clipboard!";
}

export async function runQuizCli(argv: string[], projectRoot: string): Promise<number> {
  const args = argv.slice(2);
  const toolArgIndex = args.indexOf("--tool");
  const tool =
    toolArgIndex >= 0 && args[toolArgIndex + 1] === "codex" ? "codex" : "claude";
  const categoryArgIndex = args.indexOf("--category");
  const category =
    categoryArgIndex >= 0 && typeof args[categoryArgIndex + 1] === "string"
      ? (args[categoryArgIndex + 1] as DecisionCategory | "random")
      : "random";
  const share = args.includes("--share");
  const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY;

  const selected = sampleQuizScenarios(projectRoot, 5, category);
  if (selected.length === 0) {
    process.stderr.write("[brain] warning: no quiz scenarios available\n");
    return 1;
  }

  const adapter = new OhMyBrainAdapter(projectRoot, tool);
  const directives = (await adapter.loadContext())
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());

  process.stdout.write("🧠 Brain Quiz — Does your AI think like you?\n\n");

  const results: QuizQuestionResult[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    const scenario = selected[index];
    const answer = await adapter.ask(buildDecisionPrompt(directives, scenario));
    const correct = matchesExpectedDecision(answer, scenario.expected_decision);
    results.push({ scenario, answer, correct });

    if (interactive) {
      process.stdout.write(`Scenario ${index + 1}/${selected.length}: ${scenario.id}\n`);
      process.stdout.write(`${scenario.situation}\n\n`);
      process.stdout.write(
        `Your directives say: ${
          scenario.relevant_directives.length > 0
            ? scenario.relevant_directives.join(" | ")
            : "(none)"
        }\n`
      );
      process.stdout.write(`Expected: ${scenario.expected_decision}\n`);
      process.stdout.write(`Your AI answered: ${answer || "(no answer)"} ${correct ? "✅" : "❌"}\n\n`);
    }
  }

  if (!interactive) {
    for (const [index, result] of results.entries()) {
      process.stdout.write(
        `Scenario ${index + 1}/${results.length}: ${result.scenario.id} → ${
          result.correct ? "match" : "mismatch"
        }\n`
      );
    }
    process.stdout.write("\n");
  }

  const correct = results.filter((result) => result.correct).length;
  const total = results.length;
  const score = total === 0 ? 0 : Math.round((correct / total) * 100);
  const quizResult: QuizRunResult = { total, correct, score, results };
  const historyEntry: QuizHistoryEntry = {
    ts: new Date().toISOString(),
    total,
    correct,
    score,
    scenarios: results.map((result) => result.scenario.id),
  };
  appendQuizHistory(projectRoot, historyEntry);

  process.stdout.write(`Result: ${correct}/${total} (${score}%) Decision Match 🧠\n`);

  if (share) {
    const shareText = formatShareText(quizResult);
    process.stdout.write("\nShare this:\n");
    process.stdout.write("─────────────────────────────────\n");
    process.stdout.write(`${shareText}\n`);
    process.stdout.write("─────────────────────────────────\n");
    process.stdout.write(`${maybeCopyToClipboard(shareText)}\n`);
  }

  return 0;
}
