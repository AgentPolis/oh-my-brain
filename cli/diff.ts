import { existsSync } from "fs";
import { join } from "path";
import { loadActionLog } from "./actions.js";
import { listCandidates, loadCandidateStore, pendingCount } from "./candidates.js";
import { loadLinks } from "./links-store.js";
import { parseActiveDirectives } from "./import-memory.js";
import { ArchiveStore } from "../src/storage/archive.js";

export interface DiffReport {
  period: { from: string; to: string; label: string };
  added: {
    directives: number;
    auto_saved: number;
    candidates_approved: number;
  };
  removed: {
    retired: number;
    rejected: number;
  };
  pending: {
    candidates: number;
    merge_proposals: number;
    conflicts: number;
  };
  growth: {
    rate_per_day: number;
    trend: "growing" | "stable" | "shrinking" | "insufficient data";
    total_directives: number;
  };
  archive?: {
    new_entries: number;
    total_entries: number;
  };
}

interface ParsedRange {
  from: string;
  to: string;
  label: string;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toLocalBoundary(input: string, edge: "start" | "end"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    const date =
      edge === "start"
        ? new Date(year, month - 1, day, 0, 0, 0, 0)
        : new Date(year, month - 1, day, 23, 59, 59, 999);
    return date.toISOString();
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(0).toISOString();
  }
  return parsed.toISOString();
}

function shiftLocalDays(date: Date, days: number, edge: "start" | "end"): string {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return toLocalBoundary(formatLocalDate(shifted), edge);
}

export function parseSinceInput(input: string, now = new Date()): ParsedRange {
  const normalized = input.trim().toLowerCase();

  if (normalized.includes("..")) {
    const [rawFrom, rawTo] = input.split("..", 2).map((part) => part.trim());
    return {
      from: toLocalBoundary(rawFrom, "start"),
      to: toLocalBoundary(rawTo, "end"),
      label: `${rawFrom}..${rawTo}`,
    };
  }

  if (normalized === "7 days") {
    return {
      from: shiftLocalDays(now, -7, "start"),
      to: toLocalBoundary(formatLocalDate(now), "end"),
      label: "last 7 days",
    };
  }

  const relativeMatch = normalized.match(/^(\d+)\s+days?$/);
  if (relativeMatch) {
    const days = Number(relativeMatch[1]);
    return {
      from: shiftLocalDays(now, -days, "start"),
      to: toLocalBoundary(formatLocalDate(now), "end"),
      label: input.trim(),
    };
  }

  if (normalized === "last month") {
    return {
      from: shiftLocalDays(now, -30, "start"),
      to: toLocalBoundary(formatLocalDate(now), "end"),
      label: "last month",
    };
  }

  return {
    from: toLocalBoundary(input, "start"),
    to: toLocalBoundary(formatLocalDate(now), "end"),
    label: input.trim(),
  };
}

function daysBetween(from: string, to: string): number {
  const diff = Date.parse(to) - Date.parse(from);
  return Math.max(1, diff / (1000 * 60 * 60 * 24));
}

function computeTrend(
  ratePerDay: number,
  daysObserved: number
): DiffReport["growth"]["trend"] {
  if (daysObserved < 3) return "insufficient data";
  if (ratePerDay > 0.5) return "growing";
  if (ratePerDay >= 0.1) return "stable";
  return "shrinking";
}

export function buildDiffReport(
  projectRoot: string,
  since = "7 days",
  now = new Date()
): DiffReport {
  const period = parseSinceInput(since, now);
  const fromMs = Date.parse(period.from);
  const toMs = Date.parse(period.to);
  const actions = loadActionLog(projectRoot).filter((action) => {
    const ts = Date.parse(action.timestamp);
    return ts >= fromMs && ts <= toMs;
  });

  const addedRemember = actions.filter((action) => action.kind === "RememberDirective").length;
  const addedPromoted = actions.filter((action) => action.kind === "PromoteCandidate").length;
  const retired = actions.filter((action) => action.kind === "RetireDirective").length;
  const rejected = actions.filter((action) => action.kind === "RejectCandidate").length;

  const store = loadCandidateStore(projectRoot);
  const pendingCandidates = pendingCount(store);
  const mergeProposals = listCandidates(store, { status: "pending" }).filter((candidate) =>
    candidate.text.startsWith("MERGE:")
  ).length;
  const conflicts = loadLinks(projectRoot).filter((link) => link.kind === "contradicts").length;
  const memoryPath = join(projectRoot, "MEMORY.md");
  const totalDirectives = existsSync(memoryPath) ? parseActiveDirectives(memoryPath).length : 0;
  const ratePerDay = Number(((addedRemember + addedPromoted) / daysBetween(period.from, period.to)).toFixed(1));
  const trend = computeTrend(ratePerDay, daysBetween(period.from, period.to));

  const archivePath = join(projectRoot, ".squeeze", "archive.jsonl");
  let archive: DiffReport["archive"];
  if (existsSync(archivePath)) {
    const archiveStore = new ArchiveStore(join(projectRoot, ".squeeze"));
    archive = {
      new_entries: archiveStore.searchByTime(period.from, period.to).length,
      total_entries: archiveStore.getSummary().count,
    };
  }

  return {
    period,
    added: {
      directives: addedRemember + addedPromoted,
      auto_saved: addedRemember,
      candidates_approved: addedPromoted,
    },
    removed: {
      retired,
      rejected,
    },
    pending: {
      candidates: pendingCandidates,
      merge_proposals: mergeProposals,
      conflicts,
    },
    growth: {
      rate_per_day: ratePerDay,
      trend,
      total_directives: totalDirectives,
    },
    archive,
  };
}

export function renderDiffReport(report: DiffReport): string {
  const lines = [
    `oh-my-brain diff (${report.period.label})`,
    "──────────────────────────────",
    `+ ${report.added.directives} new directives learned`,
    `  + ${report.added.auto_saved} auto-saved (high confidence)`,
    `  + ${report.added.candidates_approved} approved from candidates`,
    `- ${report.removed.retired} directive${report.removed.retired === 1 ? "" : "s"} retired`,
    `- ${report.removed.rejected} candidate${report.removed.rejected === 1 ? "" : "s"} rejected`,
    `⏳ ${report.pending.candidates} candidates waiting for review`,
    `⚠ ${report.pending.conflicts} conflict${report.pending.conflicts === 1 ? "" : "s"} detected`,
    "",
    `Growth: ${report.growth.rate_per_day}/day (${report.growth.trend})`,
    `Total: ${report.growth.total_directives} directives`,
  ];

  if (report.archive) {
    lines.push("");
    lines.push(`Archive: +${report.archive.new_entries} conversations archived`);
    lines.push(`         Total: ${report.archive.total_entries} entries`);
  }

  return lines.join("\n");
}

export async function runDiffCli(argv: string[], projectRoot: string): Promise<number> {
  const args = argv.slice(2);
  const sinceIndex = args.indexOf("--since");
  const since =
    sinceIndex >= 0 && typeof args[sinceIndex + 1] === "string" ? args[sinceIndex + 1] : "7 days";
  const report = buildDiffReport(projectRoot, since);
  process.stdout.write(`${renderDiffReport(report)}\n`);
  return 0;
}
