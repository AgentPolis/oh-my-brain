import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { parseActiveDirectives } from "./import-memory.js";
import {
  OhMyBrainAdapter,
  RawContextAdapter,
  type MemoryAdapter,
} from "../eval/decision-replay/adapter.js";

export const DECISION_CATEGORIES = [
  "architecture",
  "security",
  "scope",
  "tradeoff",
  "operations",
  "communication",
] as const;

export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];
export type Difficulty = "easy" | "medium" | "hard";

export interface DecisionScenario {
  id: string;
  category: DecisionCategory;
  situation: string;
  options: string[];
  expected_decision: string;
  rationale: string;
  relevant_directives: string[];
  difficulty: Difficulty;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

interface ScenarioRunResult {
  scenario: DecisionScenario;
  output: string | null;
  matched: boolean;
}

interface CategoryBreakdown {
  category: DecisionCategory;
  matched: number;
  total: number;
}

function scenariosRoot(projectRoot: string): string {
  return join(projectRoot, "eval", "decision-replay", "scenarios");
}

function schemaPath(projectRoot: string): string {
  return join(projectRoot, "eval", "decision-replay", "schema.json");
}

function bundledSchemaPath(): string {
  return new URL("../eval/decision-replay/schema.json", import.meta.url).pathname;
}

function builtinScenarioCandidates(projectRoot: string): string[] {
  return [
    join(scenariosRoot(projectRoot), "builtin.yaml"),
    new URL("../eval/decision-replay/scenarios/builtin.yaml", import.meta.url).pathname,
    new URL("../../eval/decision-replay/scenarios/builtin.yaml", import.meta.url).pathname,
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateDecisionScenario(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { valid: false, errors: ["scenario must be an object"] };
  }

  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    errors.push("id must be a non-empty string");
  }

  if (
    typeof value.category !== "string" ||
    !DECISION_CATEGORIES.includes(value.category as DecisionCategory)
  ) {
    errors.push(`category must be one of: ${DECISION_CATEGORIES.join(", ")}`);
  }

  if (typeof value.situation !== "string" || value.situation.trim().length < 50) {
    errors.push("situation must be a string with minLength 50");
  }

  if (
    !Array.isArray(value.options) ||
    value.options.length < 2 ||
    value.options.some((option) => typeof option !== "string" || option.trim().length === 0)
  ) {
    errors.push("options must be an array of at least 2 non-empty strings");
  }

  if (
    typeof value.expected_decision !== "string" ||
    value.expected_decision.trim().length === 0
  ) {
    errors.push("expected_decision must be a non-empty string");
  }

  if (typeof value.rationale !== "string" || value.rationale.trim().length === 0) {
    errors.push("rationale must be a non-empty string");
  }

  if (
    !Array.isArray(value.relevant_directives) ||
    value.relevant_directives.some(
      (directive) => typeof directive !== "string" || directive.trim().length === 0
    )
  ) {
    errors.push("relevant_directives must be an array of strings");
  }

  if (
    value.difficulty !== "easy" &&
    value.difficulty !== "medium" &&
    value.difficulty !== "hard"
  ) {
    errors.push("difficulty must be easy, medium, or hard");
  }

  return { valid: errors.length === 0, errors };
}

export function validateScenarioCollection(scenarios: unknown): ValidationResult {
  if (!Array.isArray(scenarios)) {
    return { valid: false, errors: ["scenario file must contain an array"] };
  }

  const errors = scenarios.flatMap((scenario, index) =>
    validateDecisionScenario(scenario).errors.map((error) => `[${index}] ${error}`)
  );
  return { valid: errors.length === 0, errors };
}

export function loadDecisionSchema(projectRoot: string): Record<string, unknown> {
  const candidate = existsSync(schemaPath(projectRoot))
    ? schemaPath(projectRoot)
    : bundledSchemaPath();
  return JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
}

function parseScenarioFile(filePath: string): DecisionScenario[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    process.stderr.write(`[brain] warning: failed to parse scenarios from ${filePath}\n`);
    return [];
  }

  const validation = validateScenarioCollection(parsed);
  if (!validation.valid) {
    process.stderr.write(
      `[brain] warning: invalid scenarios in ${filePath}\n${validation.errors
        .map((error) => `  - ${error}`)
        .join("\n")}\n`
    );
    return [];
  }

  return parsed as DecisionScenario[];
}

export function loadDecisionScenarios(projectRoot: string): DecisionScenario[] {
  const builtinPath =
    builtinScenarioCandidates(projectRoot).find((candidate) => existsSync(candidate)) ??
    builtinScenarioCandidates(projectRoot)[0];
  const builtin = parseScenarioFile(builtinPath);
  const customRoot = join(scenariosRoot(projectRoot), "custom");
  const custom = existsSync(customRoot)
    ? readdirSync(customRoot)
        .filter((file) => file.endsWith(".yaml"))
        .flatMap((file) => parseScenarioFile(join(customRoot, file)))
    : [];
  return [...builtin, ...custom];
}

export function buildDecisionPrompt(directives: string[], scenario: DecisionScenario): string {
  const ruleBlock =
    directives.length > 0
      ? directives.map((directive) => `- ${directive}`).join("\n")
      : "- No directives loaded.";
  return [
    `You have these rules:\n${ruleBlock}`,
    `Given this situation:\n${scenario.situation}`,
    `Choose one:\n${scenario.options.map((option) => `- ${option}`).join("\n")}`,
    "Explain your reasoning.",
  ].join("\n\n");
}

export function matchesExpectedDecision(output: string, expectedDecision: string): boolean {
  return output.toLowerCase().includes(expectedDecision.toLowerCase());
}

export function runScenarioWithTool(tool: "claude" | "codex", prompt: string): string | null {
  const command = tool === "claude" ? "claude" : "codex";
  const args = tool === "claude" ? ["-p", prompt] : ["exec", prompt];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export async function runDecisionReplay(
  scenarios: DecisionScenario[],
  adapter: MemoryAdapter,
  dryRun: boolean
): Promise<ScenarioRunResult[]> {
  const loadedContext = await adapter.loadContext();
  const directives = loadedContext
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());

  if (dryRun) {
    return scenarios.map((scenario) => ({
      scenario,
      output: buildDecisionPrompt(directives, scenario),
      matched: false,
    }));
  }

  const results: ScenarioRunResult[] = [];
  for (const scenario of scenarios) {
    const output = await adapter.ask(buildDecisionPrompt(directives, scenario));
    results.push({
      scenario,
      output,
      matched: output !== "" && matchesExpectedDecision(output, scenario.expected_decision),
    });
  }
  return results;
}

function categoryBreakdown(results: ScenarioRunResult[]): CategoryBreakdown[] {
  const byCategory = new Map<DecisionCategory, CategoryBreakdown>();
  for (const result of results) {
    const existing = byCategory.get(result.scenario.category) ?? {
      category: result.scenario.category,
      matched: 0,
      total: 0,
    };
    existing.total += 1;
    if (result.matched) existing.matched += 1;
    byCategory.set(result.scenario.category, existing);
  }

  return DECISION_CATEGORIES.filter((category) => byCategory.has(category)).map(
    (category) => byCategory.get(category)!
  );
}

function formatDryRunOutput(results: ScenarioRunResult[]): string {
  return results
    .map((result, index) => {
      const { scenario, output } = result;
      return [
        `Scenario ${index + 1}/${results.length}: ${scenario.id} [${scenario.category}]`,
        output ?? "",
      ].join("\n");
    })
    .join("\n\n");
}

function formatCategoryLine(breakdown: CategoryBreakdown): string {
  const percent =
    breakdown.total === 0 ? 0 : Math.round((breakdown.matched / breakdown.total) * 100);
  return `  - ${breakdown.category}: ${percent}% (${breakdown.matched}/${breakdown.total})`;
}

export function ensureDecisionScenarioDirs(projectRoot: string): void {
  mkdirSync(join(scenariosRoot(projectRoot), "custom"), { recursive: true });
}

export async function runDecisionReplayCli(
  argv: string[],
  projectRoot: string
): Promise<number> {
  const args = argv.slice(2);
  const toolArgIndex = args.indexOf("--tool");
  const tool =
    toolArgIndex >= 0 && args[toolArgIndex + 1] === "codex" ? "codex" : "claude";
  const adapterArgIndex = args.indexOf("--adapter");
  const adapterName =
    adapterArgIndex >= 0 && typeof args[adapterArgIndex + 1] === "string"
      ? args[adapterArgIndex + 1]
      : "oh-my-brain";
  const dryRun = args.includes("--dry-run");
  const customScenarioIndex = args.indexOf("--scenarios");
  const scenarioPath =
    customScenarioIndex >= 0 ? join(projectRoot, args[customScenarioIndex + 1]) : null;

  const scenarios = scenarioPath
    ? parseScenarioFile(scenarioPath)
    : loadDecisionScenarios(projectRoot);
  const adapter =
    adapterName === "raw"
      ? new RawContextAdapter(projectRoot, tool)
      : new OhMyBrainAdapter(projectRoot, tool);

  if (scenarios.length === 0) {
    process.stderr.write("[brain] warning: no decision replay scenarios available\n");
    return 1;
  }

  const results = await runDecisionReplay(scenarios, adapter, dryRun);
  if (dryRun) {
    process.stdout.write(`${formatDryRunOutput(results)}\n`);
    return 0;
  }

  const attempted = results.filter((result) => result.output !== null).length;
  if (attempted !== results.length) {
    const failed = results.filter((result) => result.output === null);
    for (const result of failed) {
      process.stderr.write(
        `[brain] warning: ${adapter.name} unavailable for ${result.scenario.id}; skipping\n`
      );
    }
  }

  const denominator = attempted === 0 ? results.length : attempted;
  const matched = results.filter((result) => result.matched).length;
  const percent = denominator === 0 ? 0 : Math.round((matched / denominator) * 100);
  const breakdown = categoryBreakdown(results);

  process.stdout.write(`Decision Replay: ${percent}% match (${matched}/${denominator})\n`);
  process.stdout.write(`Adapter: ${adapter.name}\n`);
  process.stdout.write("Per-category breakdown:\n");
  for (const entry of breakdown) {
    process.stdout.write(`${formatCategoryLine(entry)}\n`);
  }
  return 0;
}

export function loadDirectiveContextFromMemory(projectRoot: string): string {
  const memoryPath = join(projectRoot, "MEMORY.md");
  if (!existsSync(memoryPath)) return "";
  return parseActiveDirectives(memoryPath).map((directive) => `- ${directive}`).join("\n");
}
