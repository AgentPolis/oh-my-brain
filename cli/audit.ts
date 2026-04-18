#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs";
import { join, resolve } from "path";
import { isDirectEntry } from "./is-main.js";
import { buildKeywordProfile } from "../src/triage/domain-router.js";

interface ProjectRunRecord {
  timestamp?: string;
  source?: string;
  sessionId?: string;
  directivesWritten?: number;
  compressedCount?: number;
  totalMessages?: number;
  savedTokens?: number;
  savedPercent?: number;
  lastTokenUsage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  memoryCandidates?: string[];
}

interface MemoryEntry {
  heading: string;
  source: string;
  sessionId?: string;
  lines: string[];
}

const HELP_TEXT = `brain-audit

Produce a human-readable markdown audit for a project's oh-my-brain activity.

Usage:
  brain-audit
  brain-audit /path/to/project
  brain-audit --project /path/to/project
  brain-audit --stdout
`;

function parseArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

export function loadProjectRuns(projectRoot: string): ProjectRunRecord[] {
  const logPath = join(projectRoot, ".squeeze", "runs.jsonl");
  if (!existsSync(logPath)) return [];

  return readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ProjectRunRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is ProjectRunRecord => Boolean(record));
}

export function parseMemoryEntries(memoryPath: string): MemoryEntry[] {
  if (!existsSync(memoryPath)) return [];

  const lines = readFileSync(memoryPath, "utf8").split("\n");
  const entries: MemoryEntry[] = [];
  let current: MemoryEntry | null = null;

  for (const line of lines) {
    // Accept both the new "oh-my-brain directives" heading and the legacy
    // "squeeze-claw directives" heading so existing MEMORY.md files from
    // v0.1 are still audited correctly after the rename.
    const headingMatch = line.match(/^## (?:oh-my-brain|squeeze-claw) directives .* \[source:([a-z]+)(?: session:([^\]]+))?\]$/);
    if (headingMatch) {
      if (current) entries.push(current);
      current = {
        heading: line.trim(),
        source: headingMatch[1],
        sessionId: headingMatch[2],
        lines: [],
      };
      continue;
    }

    if (current && line.startsWith("- ")) {
      current.lines.push(line);
    }
  }

  if (current) entries.push(current);
  return entries;
}

function latestRunBySource(runs: ProjectRunRecord[]): Map<string, ProjectRunRecord> {
  const map = new Map<string, ProjectRunRecord>();
  for (const run of [...runs].reverse()) {
    if (!run.source || map.has(run.source)) continue;
    map.set(run.source, run);
  }
  return map;
}

export function renderMarkdown(projectRoot: string, runs: ProjectRunRecord[], memoryEntries: MemoryEntry[]): string {
  const latestBySource = latestRunBySource(runs);
  const recentRuns = [...runs].slice(-8).reverse();
  const recentMemory = [...memoryEntries].slice(-6).reverse();
  const projectName = projectRoot.split("/").filter(Boolean).pop() ?? projectRoot;

  const lines: string[] = [];
  lines.push(`# oh-my-brain audit: ${projectName}`);
  lines.push("");
  lines.push(`Project: \`${projectRoot}\``);
  lines.push(`Generated: \`${new Date().toISOString()}\``);
  lines.push("");

  lines.push("## Latest Status");
  lines.push("");
  if (runs.length === 0) {
    lines.push("- No `.squeeze/runs.jsonl` records found yet.");
  } else {
    for (const [source, run] of latestBySource.entries()) {
      const tokenInfo = run.savedTokens ? `~${run.savedTokens} est. tokens saved` : "no estimated savings recorded";
      const directiveInfo =
        typeof run.directivesWritten === "number"
          ? run.directivesWritten > 0
            ? `${run.directivesWritten} directives written`
            : "no memory written"
          : "directive count unknown";
      const candidateInfo =
        run.memoryCandidates && run.memoryCandidates.length > 0
          ? `, ${run.memoryCandidates.length} candidate${run.memoryCandidates.length === 1 ? "" : "s"} for review`
          : "";
      lines.push(`- \`${source}\`: session \`${run.sessionId ?? "unknown"}\`, ${directiveInfo}, ${tokenInfo}${candidateInfo}`);
    }
  }
  lines.push("");

  lines.push("## Recent Memory Writes");
  lines.push("");
  if (recentMemory.length === 0) {
    lines.push("- No `MEMORY.md` entries found yet.");
  } else {
    for (const entry of recentMemory) {
      lines.push(`### ${entry.source} ${entry.sessionId ? `(${entry.sessionId})` : ""}`.trim());
      lines.push("");
      lines.push(`Heading: \`${entry.heading}\``);
      lines.push("");
      if (entry.lines.length === 0) {
        lines.push("- No directive lines under this heading.");
      } else {
        lines.push(...entry.lines);
      }
      lines.push("");
    }
  }

  lines.push("## Memory Candidates");
  lines.push("");
  const candidateRuns = recentRuns.filter((run) => run.memoryCandidates && run.memoryCandidates.length > 0);
  if (candidateRuns.length === 0) {
    lines.push("- No review candidates flagged from recent runs.");
  } else {
    for (const run of candidateRuns) {
      lines.push(`### ${run.source ?? "unknown"} ${run.sessionId ? `(${run.sessionId})` : ""}`.trim());
      lines.push("");
      for (const candidate of run.memoryCandidates ?? []) {
        lines.push(`- ${candidate}`);
      }
      lines.push("");
    }
  }

  lines.push("## Recent Runs");
  lines.push("");
  if (recentRuns.length === 0) {
    lines.push("- No recent run records.");
  } else {
    for (const run of recentRuns) {
      const parts = [
        `source=${run.source ?? "unknown"}`,
        `session=${run.sessionId ?? "unknown"}`,
      ];
      if (typeof run.totalMessages === "number") parts.push(`msgs=${run.totalMessages}`);
      if (typeof run.compressedCount === "number") parts.push(`compressed=${run.compressedCount}`);
      if (typeof run.savedTokens === "number") parts.push(`saved≈${run.savedTokens}`);
      if (typeof run.directivesWritten === "number") parts.push(`directives=${run.directivesWritten}`);
      if (run.memoryCandidates?.length) parts.push(`candidates=${run.memoryCandidates.length}`);
      lines.push(`- ${run.timestamp ?? "unknown time"} — ${parts.join(", ")}`);
    }
  }
  lines.push("");

  lines.push("## Suggested Human Checks");
  lines.push("");
  if (recentMemory.length === 0) {
    if (candidateRuns.length > 0) {
      lines.push("- No memory was written yet, but there are candidate lines above that may be worth promoting after human review.");
      lines.push("- Ask whether each candidate is truly durable across sessions or just a one-off correction for the current task.");
    } else {
      lines.push("- No new memory entries to review yet. The current check is whether that absence feels correct for the recent sessions.");
    }
  } else {
    lines.push("- For each new memory line, ask: was this explicitly stated or confirmed by the user?");
    lines.push("- Check whether the line is durable across sessions, not just a one-off task update.");
    lines.push("- If a line came from `codex` or `claude`, compare the `sessionId` against the corresponding transcript before trusting it long-term.");
    lines.push("- If a directive feels too broad, delete it from `MEMORY.md` and keep the evidence in `.squeeze/runs.jsonl` for audit only.");
  }
  lines.push("");

  return lines.join("\n");
}

const SPLIT_THRESHOLD = 30;
const MERGE_OVERLAP_THRESHOLD = 0.5;

export function reportDomainStats(projectRoot: string): string {
  const memoryDir = join(projectRoot, "memory");
  if (!existsSync(memoryDir)) return "";
  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) return "";

  const lines: string[] = ["", "## Domain Stats", ""];

  const domains: { name: string; count: number; tokens: number; profile: ReturnType<typeof buildKeywordProfile> }[] = [];
  for (const f of files) {
    const name = f.replace(/\.md$/, "");
    const content = readFileSync(join(memoryDir, f), "utf8");
    const bullets = content.split("\n").filter((l) => /^-\s+/.test(l));
    const bodies = bullets.map((l) => l.replace(/^-\s+(?:\[[^\]]*\]\s+)?/, ""));
    const tokens = Math.ceil(content.length / 4);
    domains.push({ name, count: bullets.length, tokens, profile: buildKeywordProfile(name, bodies) });
  }

  for (const d of domains) {
    const plural = d.count === 1 ? "directive" : "directives";
    lines.push(`- **${d.name}**: ${d.count} ${plural} (~${d.tokens} tokens)`);
  }

  const large = domains.filter((d) => d.count > SPLIT_THRESHOLD);
  if (large.length > 0) {
    lines.push("");
    for (const d of large) {
      lines.push(`⚠️ **${d.name}** has ${d.count} directives — consider splitting into sub-domains`);
    }
  }

  for (let i = 0; i < domains.length; i++) {
    for (let j = i + 1; j < domains.length; j++) {
      const a = domains[i].profile.keywords;
      const b = domains[j].profile.keywords;
      const intersection = new Set([...a].filter((k) => b.has(k)));
      const smaller = Math.min(a.size, b.size);
      if (smaller > 0 && intersection.size / smaller > MERGE_OVERLAP_THRESHOLD) {
        lines.push(`⚠️ **${domains[i].name}** and **${domains[j].name}** share ${Math.round(intersection.size / smaller * 100)}% keywords — consider merging`);
      }
    }
  }

  return lines.join("\n");
}

export function writeLatestAudit(projectRoot: string): string {
  const runs = loadProjectRuns(projectRoot);
  const memoryEntries = parseMemoryEntries(join(projectRoot, "MEMORY.md"));
  const markdown = renderMarkdown(projectRoot, runs, memoryEntries);
  const domainStats = reportDomainStats(projectRoot);
  const outputPath = join(projectRoot, ".squeeze", "LATEST.md");
  mkdirSync(join(projectRoot, ".squeeze"), { recursive: true });
  writeFileSync(outputPath, `${markdown}${domainStats}\n`);
  return outputPath;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  const positionalProject = args.find((arg) => !arg.startsWith("-"));
  const projectRoot = resolve(parseArgValue(args, "--project") ?? positionalProject ?? process.cwd());
  const outputPath = writeLatestAudit(projectRoot);
  const markdown = readFileSync(outputPath, "utf8").trimEnd();

  if (args.includes("--stdout")) {
    process.stdout.write(`${markdown}\n`);
    return;
  }

  process.stdout.write(`${outputPath}\n`);
}

// Only auto-execute when this file is the direct entry point, not when it's
// imported transitively (via compress-core → audit for writeLatestAudit).
// Without this guard, every `brain-compress` or `brain-candidates` run
// would accidentally execute audit's top-level main() and pollute stdout.
if (isDirectEntry(["audit.js", "brain-audit"])) {
  main();
}
