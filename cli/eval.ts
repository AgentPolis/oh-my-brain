import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { parseActiveDirectives } from "./import-memory.js";

export interface DecisionScenario {
  id: string;
  category: "architecture" | "scope" | "security" | "tradeoff" | "operations";
  situation: string;
  options: string[];
  expected_decision: string;
  rationale: string;
  relevant_directives: string[];
  difficulty: "easy" | "medium" | "hard";
}

const REQUIRED_FIELDS: Array<keyof DecisionScenario> = [
  "id",
  "category",
  "situation",
  "options",
  "expected_decision",
  "rationale",
  "relevant_directives",
  "difficulty",
];

function scenariosRoot(projectRoot: string): string {
  return join(projectRoot, "eval", "decision-replay", "scenarios");
}

function parseScenarioFile(filePath: string): DecisionScenario[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidScenario);
  } catch {
    process.stderr.write(`[brain] warning: failed to parse scenarios from ${filePath}\n`);
    return [];
  }
}

function isValidScenario(value: unknown): value is DecisionScenario {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return REQUIRED_FIELDS.every((field) => field in record);
}

export function loadDecisionScenarios(projectRoot: string): DecisionScenario[] {
  const root = scenariosRoot(projectRoot);
  const bundledCandidates = [
    join(root, "builtin.yaml"),
    new URL("../eval/decision-replay/scenarios/builtin.yaml", import.meta.url).pathname,
    new URL("../../eval/decision-replay/scenarios/builtin.yaml", import.meta.url).pathname,
  ];
  const builtinPath =
    bundledCandidates.find((candidate) => existsSync(candidate)) ?? bundledCandidates[0];
  const builtin = parseScenarioFile(builtinPath);
  const customRoot = join(root, "custom");
  const custom = existsSync(customRoot)
    ? readdirSync(customRoot)
        .filter((file) => file.endsWith(".yaml"))
        .flatMap((file) => parseScenarioFile(join(customRoot, file)))
    : [];
  return [...builtin, ...custom];
}

export function buildDecisionPrompt(
  directives: string[],
  scenario: DecisionScenario
): string {
  return [
    `You have these rules:\n${directives.map((directive) => `- ${directive}`).join("\n")}`,
    `Given this situation:\n${scenario.situation}`,
    `Choose one:\n${scenario.options.map((option) => `- ${option}`).join("\n")}`,
    "Explain your reasoning.",
  ].join("\n\n");
}

export function matchesExpectedDecision(output: string, expectedDecision: string): boolean {
  return output.toLowerCase().includes(expectedDecision.toLowerCase());
}

function runScenarioWithTool(
  tool: "claude" | "codex",
  prompt: string
): string | null {
  const command = tool === "claude" ? "claude" : "codex";
  const args = tool === "claude" ? ["-p", prompt] : ["exec", prompt];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function runDecisionReplayCli(argv: string[], projectRoot: string): number {
  const args = argv.slice(2);
  const toolArgIndex = args.indexOf("--tool");
  const tool =
    toolArgIndex >= 0 && args[toolArgIndex + 1] === "codex" ? "codex" : "claude";
  const dryRun = args.includes("--dry-run");
  const customScenarioIndex = args.indexOf("--scenarios");
  const scenarioPath =
    customScenarioIndex >= 0 ? join(projectRoot, args[customScenarioIndex + 1]) : null;

  const scenarios = scenarioPath
    ? parseScenarioFile(scenarioPath)
    : loadDecisionScenarios(projectRoot);
  const memoryPath = join(projectRoot, "MEMORY.md");
  const directives = existsSync(memoryPath) ? parseActiveDirectives(memoryPath) : [];

  if (dryRun) {
    for (const scenario of scenarios) {
      process.stdout.write(`${buildDecisionPrompt(directives, scenario)}\n\n`);
    }
    return 0;
  }

  let matched = 0;
  let attempted = 0;
  for (const scenario of scenarios) {
    const output = runScenarioWithTool(tool, buildDecisionPrompt(directives, scenario));
    if (!output) {
      process.stderr.write(
        `[brain] warning: ${tool} unavailable for ${scenario.id}; falling back to dry run output\n`
      );
      process.stdout.write(`${buildDecisionPrompt(directives, scenario)}\n\n`);
      continue;
    }
    attempted += 1;
    if (matchesExpectedDecision(output, scenario.expected_decision)) {
      matched += 1;
    }
  }

  const denominator = attempted === 0 ? scenarios.length : attempted;
  const percent = denominator === 0 ? 0 : Math.round((matched / denominator) * 100);
  process.stdout.write(`Decision Replay: ${percent}% match (${matched}/${denominator})\n`);
  return 0;
}

export function ensureDecisionScenarioDirs(projectRoot: string): void {
  mkdirSync(join(scenariosRoot(projectRoot), "custom"), { recursive: true });
}
