#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { spawnSync } from "child_process";

const DECISION_CATEGORIES = [
  "architecture",
  "security",
  "scope",
  "tradeoff",
  "operations",
  "communication",
];

function parseArgs(argv) {
  const args = {
    projectRoot: process.cwd(),
    tool: "codex",
    adapter: "oh-my-brain",
    fresh: false,
    scenarios: null,
    checkpoint: null,
    report: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--tool" && next) {
      args.tool = next;
      index += 1;
      continue;
    }
    if (arg === "--adapter" && next) {
      args.adapter = next;
      index += 1;
      continue;
    }
    if (arg === "--scenarios" && next) {
      args.scenarios = next;
      index += 1;
      continue;
    }
    if (arg === "--checkpoint" && next) {
      args.checkpoint = next;
      index += 1;
      continue;
    }
    if (arg === "--report" && next) {
      args.report = next;
      index += 1;
      continue;
    }
    if (arg === "--project-root" && next) {
      args.projectRoot = next;
      index += 1;
      continue;
    }
    if (arg === "--fresh") {
      args.fresh = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    process.stderr.write(`[batch] unknown argument: ${arg}\n`);
    printHelp();
    process.exit(1);
  }

  if (!args.scenarios) {
    process.stderr.write("[batch] --scenarios is required\n");
    printHelp();
    process.exit(1);
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Decision Replay batch runner

Usage:
  node scripts/run-decision-replay-batch.mjs --scenarios path/to/scenarios.json [options]

Options:
  --tool codex|claude         Model CLI to invoke (default: codex)
  --adapter oh-my-brain|raw   Memory adapter to use (default: oh-my-brain)
  --checkpoint path           JSONL checkpoint file (default: .squeeze/eval/decision-replay-<adapter>-<tool>.jsonl)
  --report path               JSON summary file (default: .squeeze/eval/decision-replay-<adapter>-<tool>-report.json)
  --project-root path         Repo root containing package.json (default: cwd)
  --fresh                     Truncate checkpoint before starting
`);
}

function resolvePath(projectRoot, filePath) {
  return isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
}

function defaultCheckpointPath(projectRoot, adapter, tool) {
  return join(projectRoot, ".squeeze", "eval", `decision-replay-${adapter}-${tool}.jsonl`);
}

function defaultReportPath(projectRoot, adapter, tool) {
  return join(
    projectRoot,
    ".squeeze",
    "eval",
    `decision-replay-${adapter}-${tool}-report.json`
  );
}

function loadScenarios(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("scenario file must contain an array");
  }
  return parsed;
}

function loadCheckpoint(checkpointPath) {
  if (!existsSync(checkpointPath)) return [];
  return readFileSync(checkpointPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function summarizeRun(scenarios, checkpointEntries, meta) {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const uniqueEntries = new Map();
  for (const entry of checkpointEntries) {
    if (scenarioById.has(entry.scenario_id)) {
      uniqueEntries.set(entry.scenario_id, entry);
    }
  }

  let matched = 0;
  const perCategory = new Map(
    DECISION_CATEGORIES.map((category) => [category, { category, matched: 0, completed: 0, total: 0 }])
  );

  for (const scenario of scenarios) {
    const bucket = perCategory.get(scenario.category);
    if (bucket) bucket.total += 1;
    const entry = uniqueEntries.get(scenario.id);
    if (!entry) continue;
    if (bucket) {
      bucket.completed += 1;
      if (entry.matched === true) bucket.matched += 1;
    }
    if (entry.matched === true) matched += 1;
  }

  const completed = uniqueEntries.size;
  const scorePercent = completed === 0 ? 0 : Math.round((matched / completed) * 100);

  return {
    benchmark: "decision-replay",
    generated_at: new Date().toISOString(),
    project_root: meta.projectRoot,
    tool: meta.tool,
    adapter: meta.adapter,
    scenario_file: meta.scenarioFile,
    checkpoint_file: meta.checkpointFile,
    total_scenarios: scenarios.length,
    completed_scenarios: completed,
    remaining_scenarios: Math.max(scenarios.length - completed, 0),
    matched_scenarios: matched,
    score_percent: scorePercent,
    completed_percent:
      scenarios.length === 0 ? 0 : Math.round((completed / scenarios.length) * 100),
    status: completed >= scenarios.length ? "complete" : "partial",
    per_category: DECISION_CATEGORIES.map((category) => {
      const bucket = perCategory.get(category);
      return {
        category,
        matched: bucket.matched,
        completed: bucket.completed,
        total: bucket.total,
        score_percent:
          bucket.completed === 0 ? 0 : Math.round((bucket.matched / bucket.completed) * 100),
      };
    }).filter((bucket) => bucket.total > 0),
  };
}

function writeReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const projectRoot = resolve(args.projectRoot);
  const scenarioFile = resolvePath(projectRoot, args.scenarios);
  const checkpointFile = args.checkpoint
    ? resolvePath(projectRoot, args.checkpoint)
    : defaultCheckpointPath(projectRoot, args.adapter, args.tool);
  const reportFile = args.report
    ? resolvePath(projectRoot, args.report)
    : defaultReportPath(projectRoot, args.adapter, args.tool);

  const evalArgs = [
    "dist/cli/brain.js",
    "eval",
    "--tool",
    args.tool,
    "--adapter",
    args.adapter,
    "--scenarios",
    scenarioFile,
    "--checkpoint",
    checkpointFile,
  ];
  if (args.fresh) {
    evalArgs.push("--fresh");
  }

  const result = spawnSync("node", evalArgs, {
    cwd: projectRoot,
    stdio: "inherit",
  });

  const scenarios = loadScenarios(scenarioFile);
  const checkpointEntries = loadCheckpoint(checkpointFile);
  const report = summarizeRun(scenarios, checkpointEntries, {
    projectRoot,
    tool: args.tool,
    adapter: args.adapter,
    scenarioFile,
    checkpointFile,
  });
  writeReport(reportFile, report);

  process.stdout.write(
    `[batch] report written to ${reportFile} (${report.completed_scenarios}/${report.total_scenarios} complete, ${report.score_percent}% match)\n`
  );

  if (typeof result.status === "number") {
    process.exit(result.status);
  }
  process.exit(1);
}

main();
