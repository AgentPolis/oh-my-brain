#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { spawnSync } from "child_process";
import { SqueezeContextEngine } from "../dist/index.js";
import {
  analyzeQuestion,
  buildDeterministicAnswer,
  buildInsufficientAnswer,
  buildReasoningPolicy,
} from "./longmemeval-lib.mjs";

function parseArgs(argv) {
  const args = {
    data: null,
    out: ".squeeze/benchmarks/longmemeval-oracle-hypotheses.jsonl",
    report: ".squeeze/benchmarks/longmemeval-oracle-report.json",
    workdir: ".squeeze/benchmarks/longmemeval-work",
    tool: "codex",
    subset: null,
    limit: null,
    fresh: false,
    offset: 0,
    budget: 12000,
    concurrency: 1,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--data" && next) {
      args.data = next;
      index += 1;
      continue;
    }
    if (arg === "--out" && next) {
      args.out = next;
      index += 1;
      continue;
    }
    if (arg === "--report" && next) {
      args.report = next;
      index += 1;
      continue;
    }
    if (arg === "--workdir" && next) {
      args.workdir = next;
      index += 1;
      continue;
    }
    if (arg === "--tool" && next) {
      args.tool = next;
      index += 1;
      continue;
    }
    if (arg === "--subset" && next) {
      args.subset = next;
      index += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      args.limit = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--offset" && next) {
      args.offset = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--budget" && next) {
      args.budget = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--concurrency" && next) {
      args.concurrency = Number(next);
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
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!args.data) {
    throw new Error("--data is required");
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive number");
  }

  return args;
}

function printHelp() {
  process.stdout.write(`LongMemEval oracle runner for oh-my-brain

Usage:
  node scripts/run-longmemeval-oracle.mjs --data data/longmemeval_oracle.json [options]

Options:
  --subset temporal-reasoning     Filter by question_type
  --limit 50                      Max questions to run after filtering
  --offset 0                      Skip the first N filtered questions
  --tool codex|claude             Reader CLI to invoke
  --out path                      Hypothesis JSONL path
  --report path                   Progress report JSON path
  --workdir path                  Scratch dir for per-question DB files
  --budget 12000                  Context budget passed to oh-my-brain assemble()
  --concurrency 4                 Number of questions to run in parallel
  --fresh                         Truncate existing outputs before starting
`);
}

function resolvePath(pathLike) {
  return isAbsolute(pathLike) ? pathLike : resolve(process.cwd(), pathLike);
}

function loadDataset(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("dataset must be a JSON array");
  }
  return parsed;
}

function filterDataset(dataset, subset, offset, limit) {
  let filtered = subset
    ? dataset.filter((item) => item.question_type === subset)
    : dataset.slice();
  if (offset > 0) {
    filtered = filtered.slice(offset);
  }
  if (typeof limit === "number" && Number.isFinite(limit)) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
}

function loadCompleted(outPath) {
  if (!existsSync(outPath)) return new Set();
  const ids = new Set();
  const lines = readFileSync(outPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.question_id === "string") {
        ids.add(parsed.question_id);
      }
    } catch {}
  }
  return ids;
}

function pairSessionTurns(session) {
  const turns = [];
  let pendingUser = null;

  for (const msg of session) {
    if (!msg || typeof msg.content !== "string") continue;
    if (msg.role === "user") {
      if (pendingUser) {
        turns.push({
          userMessage: pendingUser,
          assistantMessage: { role: "assistant", content: "" },
        });
      }
      pendingUser = { role: "user", content: msg.content };
      continue;
    }

    if (msg.role === "assistant") {
      if (pendingUser) {
        turns.push({
          userMessage: pendingUser,
          assistantMessage: { role: "assistant", content: msg.content },
        });
        pendingUser = null;
      } else {
        turns.push({
          userMessage: { role: "user", content: "" },
          assistantMessage: { role: "assistant", content: msg.content },
        });
      }
    }
  }

  if (pendingUser) {
    turns.push({
      userMessage: pendingUser,
      assistantMessage: { role: "assistant", content: "" },
    });
  }

  return turns;
}

function formatAssembledMessages(messages) {
  return messages
    .map((msg) => {
      const role = msg.role.toUpperCase();
      return `[${role}]\n${msg.content}`;
    })
    .join("\n\n");
}

function formatRelevantSnippets(snippets) {
  if (!snippets || snippets.length === 0) return "None";
  return snippets
    .map((entry, index) => {
      const date = entry.date || "unknown date";
      const role = String(entry.role || "unknown").toUpperCase();
      return `${index + 1}. (${date}) [${role}] ${entry.content}`;
    })
    .join("\n");
}

function formatStructuredEvidence(analysis) {
  const lines = [];

  if (analysis.entityEvidence?.length > 0) {
    lines.push("Entity evidence:");
    for (const item of analysis.entityEvidence) {
      const anchors = item.anchors?.length > 0 ? ` [anchors: ${item.anchors.join(", ")}]` : "";
      if (!item.snippets || item.snippets.length === 0) {
        lines.push(`- ${item.entity}${anchors}: no direct supporting snippet found`);
        continue;
      }
      for (const snippet of item.snippets) {
        lines.push(`- ${item.entity}${anchors}: (${snippet.date || "unknown date"}) [${String(snippet.role || "unknown").toUpperCase()}] ${snippet.content}`);
      }
    }
  }

  if (analysis.optionEvidence?.length > 0) {
    lines.push("Comparison evidence:");
    for (const item of analysis.optionEvidence) {
      if (!item.snippets || item.snippets.length === 0) {
        lines.push(`- ${item.option}: no direct supporting snippet found`);
        continue;
      }
      for (const snippet of item.snippets) {
        lines.push(`- ${item.option}: (${snippet.date || "unknown date"}) [${String(snippet.role || "unknown").toUpperCase()}] ${snippet.content}`);
      }
    }
  }

  if (analysis.aggregateCandidates?.length > 0) {
    lines.push("Aggregate candidates:");
    for (const item of analysis.aggregateCandidates) {
      lines.push(`- ${item.entity}: ${item.count} supporting mention(s)`);
    }
  }

  if (analysis.dateCandidates?.length > 0) {
    lines.push("Date candidates:");
    for (const item of analysis.dateCandidates) {
      lines.push(`- (${item.date || "unknown date"}) [${String(item.role || "unknown").toUpperCase()}] ${item.content}`);
    }
  }

  if (analysis.comparisonValues?.length > 0) {
    lines.push("Comparison values:");
    for (const item of analysis.comparisonValues) {
      lines.push(`- ${item.entity}: ${item.values.join(", ")}% (${item.date || "unknown date"}) [${String(item.role || "unknown").toUpperCase()}] ${item.content}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "None";
}

function buildQuestionPrompt(instance, assembledMessages, analysis) {
  return [
    "You are answering a LongMemEval question using an oh-my-brain-assembled memory context.",
    "Use all available clues to reason, but do not invent missing facts.",
    "Match the language of the question.",
    "Answer concisely with just the answer, not a chain-of-thought.",
    "",
    buildReasoningPolicy(instance, analysis),
    "",
    `Question intent: ${analysis.intent}`,
    "",
    "Memory context:",
    assembledMessages,
    "",
    "Relevant snippets:",
    formatRelevantSnippets(analysis.relevantSnippets),
    "",
    "Structured evidence:",
    formatStructuredEvidence(analysis),
    "",
    `Question date: ${instance.question_date ?? "unknown"}`,
    `Question type: ${instance.question_type}`,
    `Question: ${instance.question}`,
  ].join("\n");
}

function askTool(tool, prompt) {
  const command = tool === "claude" ? "claude" : "codex";
  const args = tool === "claude" ? ["-p", prompt] : ["exec", prompt];
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      hypothesis: null,
      command,
      args,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr?.trim() || "",
      error: result.error?.message || null,
    };
  }
  return {
    ok: true,
    hypothesis: result.stdout.trim(),
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout?.trim() || "",
    stderr: result.stderr?.trim() || "",
    error: null,
  };
}

function appendJsonl(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(payload)}\n`);
}

function writeReport(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function buildReportPayload({
  startedAt,
  dataPath,
  args,
  outPath,
  selected,
  completed,
  interruption,
  status,
  activeWorkers = 0,
}) {
  return {
    benchmark: "LongMemEval oracle",
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    dataset_path: dataPath,
    subset: args.subset,
    tool: args.tool,
    hypotheses_path: outPath,
    total_selected: selected.length,
    completed,
    remaining: selected.length - completed,
    status,
    concurrency: args.concurrency,
    active_workers: activeWorkers,
    interruption,
  };
}

async function runInstance(instance, options) {
  const scratchDir = join(options.workdir, instance.question_id);
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(scratchDir, { recursive: true });

  const engine = new SqueezeContextEngine();
  await engine.bootstrap(join(scratchDir, "brain.pg"));

  let turnIndex = 0;
  for (const session of instance.haystack_sessions ?? []) {
    const turns = pairSessionTurns(session);
    for (const turn of turns) {
      turnIndex += 1;
      await engine.afterTurn({ ...turn, turnIndex });
    }
    await engine.compact();
  }

  const assembled = await engine.assemble({
    maxTokens: options.budget,
    usedTokens: 0,
    available: options.budget,
  });
  const analysis = analyzeQuestion(instance);
  const prompt = buildQuestionPrompt(
    instance,
    formatAssembledMessages(assembled.messages),
    analysis
  );
  const deterministicAnswer = buildDeterministicAnswer(instance, analysis);
  const toolResult = analysis.shouldForceAbstain || deterministicAnswer
    ? null
    : askTool(options.tool, prompt);
  const hypothesis = analysis.shouldForceAbstain
    ? buildInsufficientAnswer(instance, analysis)
    : deterministicAnswer ?? toolResult?.hypothesis ?? null;
  await engine.close();
  rmSync(scratchDir, { recursive: true, force: true });

  return {
    question_id: instance.question_id,
    question_type: instance.question_type,
    question: instance.question,
    answer: instance.answer,
    hypothesis,
    context_token_count: assembled.tokenCount,
    metadata: assembled.metadata,
    analysis,
    deterministicAnswer,
    toolFailure: toolResult && !toolResult.ok
      ? {
          command: toolResult.command,
          status: toolResult.status,
          signal: toolResult.signal,
          stderr: toolResult.stderr,
          stdout: toolResult.stdout,
          error: toolResult.error,
        }
      : null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const dataPath = resolvePath(args.data);
  const outPath = resolvePath(args.out);
  const reportPath = resolvePath(args.report);
  const workdir = resolvePath(args.workdir);

  if (args.fresh) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, "");
  }

  const dataset = loadDataset(dataPath);
  const selected = filterDataset(dataset, args.subset, args.offset, args.limit);
  const completedIds = loadCompleted(outPath);
  const startedAt = new Date().toISOString();
  let completed = 0;
  let interrupted = false;
  let interruption = null;
  let nextIndex = 0;
  let activeWorkers = 0;

  for (const instance of selected) {
    if (completedIds.has(instance.question_id)) {
      completed += 1;
    }
  }

  writeReport(
    reportPath,
    buildReportPayload({
      startedAt,
      dataPath,
      args,
      outPath,
      selected,
      completed,
      interruption,
      status: completed >= selected.length ? "complete" : "running",
      activeWorkers,
    })
  );

  function takeNextInstance() {
    while (nextIndex < selected.length) {
      const instance = selected[nextIndex];
      nextIndex += 1;
      if (!completedIds.has(instance.question_id)) {
        return instance;
      }
    }
    return null;
  }

  async function workerLoop(workerId) {
    while (!interrupted) {
      const instance = takeNextInstance();
      if (!instance) return;

      activeWorkers += 1;
      try {
        const result = await runInstance(instance, {
          tool: args.tool,
          budget: args.budget,
          workdir,
        });
        if (result.hypothesis === null) {
          interrupted = true;
          interruption = {
            question_id: result.question_id,
            question_type: result.question_type,
            worker_id: workerId,
            tool_failure: result.toolFailure,
            interrupted_at: new Date().toISOString(),
          };
          writeReport(
            reportPath,
            buildReportPayload({
              startedAt,
              dataPath,
              args,
              outPath,
              selected,
              completed,
              interruption,
              status: "interrupted",
              activeWorkers,
            })
          );
          continue;
        }

        appendJsonl(outPath, {
          question_id: result.question_id,
          hypothesis: result.hypothesis,
          question_type: result.question_type,
          expected_answer: result.answer,
          context_token_count: result.context_token_count,
          metadata: result.metadata,
          planner: {
            missing_entities: result.analysis.missingEntities,
            missing_options: result.analysis.missingOptions,
            forced_abstain: result.analysis.shouldForceAbstain,
            deterministic_answer: result.deterministicAnswer,
          },
          saved_at: new Date().toISOString(),
        });
        completed += 1;
        completedIds.add(result.question_id);

        writeReport(
          reportPath,
          buildReportPayload({
            startedAt,
            dataPath,
            args,
            outPath,
            selected,
            completed,
            interruption,
            status: completed >= selected.length ? "complete" : "running",
            activeWorkers,
          })
        );
        process.stdout.write(
          `[longmemeval] ${completed}/${selected.length} ${result.question_id} (worker ${workerId})\n`
        );
      } finally {
        activeWorkers -= 1;
      }
    }
  }

  const workerCount = Math.min(args.concurrency, Math.max(selected.length - completed, 0) || 1);
  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => workerLoop(index + 1))
  );

  writeReport(
    reportPath,
    buildReportPayload({
      startedAt,
      dataPath,
      args,
      outPath,
      selected,
      completed,
      interruption,
      status: interrupted ? "interrupted" : completed >= selected.length ? "complete" : "partial",
      activeWorkers,
    })
  );

  if (interrupted) {
    process.stderr.write(
      `[longmemeval] interrupted after ${completed}/${selected.length}; rerun the same command to resume\n`
    );
    if (interruption?.tool_failure) {
      process.stderr.write(
        `[longmemeval] tool failure: status=${interruption.tool_failure.status} signal=${interruption.tool_failure.signal ?? "none"} error=${interruption.tool_failure.error ?? "none"}\n`
      );
      if (interruption.tool_failure.stderr) {
        process.stderr.write(`[longmemeval] stderr: ${interruption.tool_failure.stderr}\n`);
      }
    }
    process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`[longmemeval] error: ${error.message}\n`);
  process.exit(1);
});
