import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { join } from "path";
import { applyRememberDirective } from "./actions.js";
import { applyRetireDirective } from "./actions.js";
import { ingestCandidates, listCandidates, loadCandidateStore, saveCandidateStore } from "./candidates.js";
import { detectImportFiles, scanImportFile } from "./import.js";
import { loadLinks } from "./links-store.js";
import { loadHabits, saveHabits, detectHabits, type Habit } from "./habit-detector.js";
import { detectSchemas, SchemaStore, type CognitiveSchema } from "./schema-detector.js";
import { parseActiveDirectives } from "./import-memory.js";
import { loadDirectiveMetadata } from "../src/storage/directives.js";
import { EventStore } from "../src/storage/events.js";
import { TimelineIndex } from "../src/storage/timeline.js";
import { isDirectEntry } from "./is-main.js";

export interface ReflectionProposal {
  id: string;
  kind: "retire" | "resolve_conflict" | "review_merge" | "review_external";
  title: string;
  detail: string;
  evidence: string[];
  status: "pending" | "resolved" | "dismissed";
  createdAt: string;
  updatedAt: string;
  resolutionNote?: string;
  resolvedAt?: string;
}

interface ReflectionProposalFile {
  version: 1;
  proposals: ReflectionProposal[];
}

export interface GrowthJournalEntry {
  id: string;
  ts: string;
  kind: "consolidate";
  summary: string;
  highlights: string[];
  stats: {
    external_directives: number;
    external_candidates: number;
    reflection_proposals_created: number;
    habits_detected: number;
    schemas_detected: number;
  };
}

export interface ConsolidationReport {
  external: {
    scannedSources: number;
    directivesLearned: number;
    candidatesQueued: number;
    skipped: number;
    gitSignals: number;
  };
  reflection: {
    proposalsCreated: number;
    staleDirectives: number;
    conflicts: number;
    merges: number;
  };
  consolidation: {
    timelineRebuilt: boolean;
    newHabits: number;
    newSchemas: number;
    journalEntriesAdded: number;
  };
  journalEntry: GrowthJournalEntry;
}

export interface GrowthSnapshot {
  pendingProposals: number;
  proposalBreakdown: Record<string, number>;
  journalEntries: number;
  latestJournal: GrowthJournalEntry | null;
}

interface ConsolidateOptions {
  staleDays?: number;
}

const REFLECTION_FILE = "reflection-proposals.json";
const GROWTH_JOURNAL_FILE = "growth-journal.jsonl";

function reflectionPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", REFLECTION_FILE);
}

function growthJournalPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", GROWTH_JOURNAL_FILE);
}

function normalizeProposal(proposal: ReflectionProposal): ReflectionProposal {
  const createdAt = normalizeIso(proposal.createdAt);
  const updatedAt = normalizeIso(proposal.updatedAt || proposal.createdAt);
  return {
    ...proposal,
    id: proposal.id || randomUUID(),
    title: proposal.title.trim(),
    detail: proposal.detail.trim(),
    evidence: Array.isArray(proposal.evidence)
      ? Array.from(
          new Set(
            proposal.evidence
              .filter((entry) => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean)
          )
        )
      : [],
    status:
      proposal.status === "resolved" || proposal.status === "dismissed"
        ? proposal.status
        : "pending",
    createdAt,
    updatedAt,
    resolutionNote: proposal.resolutionNote?.trim() || undefined,
    resolvedAt: proposal.resolvedAt ? normalizeIso(proposal.resolvedAt) : undefined,
  };
}

function normalizeIso(value: string | undefined): string {
  const parsed = Date.parse(value ?? "");
  if (Number.isNaN(parsed)) return new Date(0).toISOString();
  return new Date(parsed).toISOString();
}

function loadProposalFile(projectRoot: string): ReflectionProposalFile {
  const path = reflectionPath(projectRoot);
  if (!existsSync(path)) {
    return { version: 1, proposals: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ReflectionProposalFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.proposals)) {
      return { version: 1, proposals: [] };
    }
    return {
      version: 1,
      proposals: parsed.proposals.map(normalizeProposal),
    };
  } catch {
    return { version: 1, proposals: [] };
  }
}

export function loadReflectionProposals(projectRoot: string): ReflectionProposal[] {
  return loadProposalFile(projectRoot).proposals;
}

export function listReflectionProposals(
  projectRoot: string,
  status: "pending" | "resolved" | "dismissed" | "all" = "pending"
): ReflectionProposal[] {
  const proposals = loadReflectionProposals(projectRoot).sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt)
  );
  if (status === "all") return proposals;
  return proposals.filter((proposal) => proposal.status === status);
}

function saveReflectionProposals(projectRoot: string, proposals: ReflectionProposal[]): void {
  const dir = join(projectRoot, ".squeeze");
  mkdirSync(dir, { recursive: true });
  const path = reflectionPath(projectRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, proposals }, null, 2));
  renameSync(tmp, path);
}

export function loadGrowthJournal(projectRoot: string): GrowthJournalEntry[] {
  const path = growthJournalPath(projectRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return [];
  const entries: GrowthJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as GrowthJournalEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

export function buildGrowthSnapshot(projectRoot: string): GrowthSnapshot {
  const proposals = loadReflectionProposals(projectRoot).filter((proposal) => proposal.status === "pending");
  const journal = loadGrowthJournal(projectRoot);
  const breakdown: Record<string, number> = {};
  for (const proposal of proposals) {
    breakdown[proposal.kind] = (breakdown[proposal.kind] ?? 0) + 1;
  }
  return {
    pendingProposals: proposals.length,
    proposalBreakdown: breakdown,
    journalEntries: journal.length,
    latestJournal: journal.at(-1) ?? null,
  };
}

export function resolveReflectionProposalId(
  projectRoot: string,
  prefix: string
): string | null {
  const proposals = loadReflectionProposals(projectRoot);
  if (proposals.some((proposal) => proposal.id === prefix)) return prefix;
  const matches = proposals
    .map((proposal) => proposal.id)
    .filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  return null;
}

function saveUpdatedProposal(projectRoot: string, updated: ReflectionProposal): void {
  const proposals = loadReflectionProposals(projectRoot);
  const next = proposals.map((proposal) =>
    proposal.id === updated.id ? normalizeProposal(updated) : proposal
  );
  saveReflectionProposals(projectRoot, next);
}

async function pickDirectiveToRetire(projectRoot: string, values: string[]): Promise<string | null> {
  const metadata = await loadDirectiveMetadata(projectRoot);
  const active = metadata.filter((directive) => values.includes(directive.value));
  if (active.length === 0) return values[0] ?? null;
  const sorted = [...active].sort((a, b) => {
    const aTime = Date.parse(a.lastReferencedAt ?? a.createdAt);
    const bTime = Date.parse(b.lastReferencedAt ?? b.createdAt);
    return aTime - bTime || Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
  return sorted[0]?.value ?? null;
}

function parseMergeCandidate(text: string): { left: string; right: string } | null {
  const match = text.match(/^MERGE:\s+"(.+?)"\s+→\s+"(.+?)"/);
  if (!match) return null;
  return { left: match[1], right: match[2] };
}

function shorterDirective(a: string, b: string): string {
  if (a.length === b.length) return a.localeCompare(b) <= 0 ? a : b;
  return a.length < b.length ? a : b;
}

export async function approveReflectionProposal(
  projectRoot: string,
  proposalId: string
): Promise<{ proposal: ReflectionProposal; note: string } | null> {
  const proposals = loadReflectionProposals(projectRoot);
  const proposal = proposals.find((entry) => entry.id === proposalId);
  if (!proposal || proposal.status !== "pending") return null;

  let note = "";
  if (proposal.kind === "retire") {
    const target = proposal.evidence[0] ?? proposal.title;
    const action = applyRetireDirective(
      { projectRoot, source: "reflection", sessionId: proposal.id },
      target
    );
    note =
      action.payload.retiredCount > 0
        ? `retired ${action.payload.retiredCount} directive(s) matching "${target}"`
        : `no active directive matched "${target}"`;
  } else if (proposal.kind === "resolve_conflict") {
    const target = await pickDirectiveToRetire(projectRoot, proposal.evidence);
    if (!target) {
      note = "no active conflicting directive could be resolved";
    } else {
      const action = applyRetireDirective(
        { projectRoot, source: "reflection", sessionId: proposal.id },
        target
      );
      note =
        action.payload.retiredCount > 0
          ? `retired the staler conflicting directive "${target}"`
          : `unable to retire "${target}"`;
    }
  } else if (proposal.kind === "review_merge") {
    const merge = parseMergeCandidate(proposal.evidence[0] ?? "");
    if (!merge) {
      note = "merge proposal did not contain a parseable candidate";
    } else {
      const target = shorterDirective(merge.left, merge.right);
      const action = applyRetireDirective(
        { projectRoot, source: "reflection", sessionId: proposal.id },
        target
      );
      note =
        action.payload.retiredCount > 0
          ? `retired the shorter directive "${target}" after merge review`
          : `unable to retire the shorter directive "${target}"`;
    }
  } else {
    const store = loadCandidateStore(projectRoot);
    const created = ingestCandidates(store, proposal.evidence, {
      source: "unknown",
      sessionId: `reflection:${proposal.id}`,
      projectRoot,
    });
    if (created.length > 0) {
      saveCandidateStore(projectRoot, store);
    }
    note =
      created.length > 0
        ? `queued ${created.length} follow-up candidate(s) from external reflection`
        : "no new follow-up candidates were queued";
  }

  const resolved: ReflectionProposal = {
    ...proposal,
    status: "resolved",
    updatedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    resolutionNote: note,
  };
  saveUpdatedProposal(projectRoot, resolved);
  return { proposal: resolved, note };
}

export function dismissReflectionProposal(
  projectRoot: string,
  proposalId: string
): ReflectionProposal | null {
  const proposals = loadReflectionProposals(projectRoot);
  const proposal = proposals.find((entry) => entry.id === proposalId);
  if (!proposal || proposal.status !== "pending") return null;

  const dismissed: ReflectionProposal = {
    ...proposal,
    status: "dismissed",
    updatedAt: new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    resolutionNote: "dismissed by user",
  };
  saveUpdatedProposal(projectRoot, dismissed);
  return dismissed;
}

function appendGrowthJournal(projectRoot: string, entry: GrowthJournalEntry): void {
  const dir = join(projectRoot, ".squeeze");
  mkdirSync(dir, { recursive: true });
  appendFileSync(growthJournalPath(projectRoot), `${JSON.stringify(entry)}\n`);
}

function fingerprintProposal(proposal: Pick<ReflectionProposal, "kind" | "title">): string {
  return `${proposal.kind}::${proposal.title.trim().toLowerCase()}`;
}

function upsertReflectionProposals(
  projectRoot: string,
  proposals: ReflectionProposal[]
): number {
  if (proposals.length === 0) return 0;
  const file = loadProposalFile(projectRoot);
  const existing = new Map(
    file.proposals.map((proposal) => [fingerprintProposal(proposal), proposal])
  );
  let created = 0;

  for (const proposal of proposals) {
    const normalized = normalizeProposal(proposal);
    const key = fingerprintProposal(normalized);
    const found = existing.get(key);
    if (!found) {
      file.proposals.push(normalized);
      existing.set(key, normalized);
      created += 1;
      continue;
    }
    if (found.status !== "pending") continue;
    found.detail = normalized.detail;
    found.evidence = Array.from(new Set([...found.evidence, ...normalized.evidence]));
    found.updatedAt = normalized.updatedAt;
  }

  saveReflectionProposals(projectRoot, file.proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  return created;
}

function detectProjectRules(projectRoot: string): string[] {
  const rules: string[] = [];

  const tsconfigPath = join(projectRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
        compilerOptions?: { strict?: boolean };
      };
      if (parsed.compilerOptions?.strict) {
        rules.push("TypeScript strict mode is enabled in this project");
      }
    } catch {}
  }

  const packagePath = join(projectRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
        type?: string;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      if (parsed.type === "module") {
        rules.push("This project uses ESM (import/export), not CommonJS (require)");
      }
      if (parsed.devDependencies?.vitest || parsed.dependencies?.vitest) {
        rules.push("This project uses Vitest for tests");
      }
    } catch {}
  }

  return rules;
}

function detectGitSignals(projectRoot: string): string[] {
  if (!existsSync(join(projectRoot, ".git"))) return [];

  try {
    const raw = execFileSync(
      "git",
      ["-C", projectRoot, "log", "--since=30 days ago", "--pretty=%s", "--max-count=30"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const candidates = new Set<string>();
    for (const line of raw.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      let match =
        line.match(/\b(?:migrate|switch|move)\s+to\s+(.+)/i) ??
        line.match(/\bstandardi[sz]e(?:\s+on)?\s+(.+)/i) ??
        line.match(/\badopt(?:ed)?\s+(.+)/i);
      if (!match) continue;
      const subject = match[1].replace(/[.]+$/g, "").trim();
      if (!subject) continue;
      candidates.add(`Recent git history suggests the project is standardizing on ${subject}`);
    }
    return Array.from(candidates);
  } catch {
    return [];
  }
}

async function applyExternalLearning(projectRoot: string): Promise<ConsolidationReport["external"] & {
  highlights: string[];
}> {
  const importFiles = detectImportFiles(projectRoot);
  const candidateStore = loadCandidateStore(projectRoot);

  let directivesLearned = 0;
  let candidatesQueued = 0;
  let skipped = 0;
  const highlights: string[] = [];

  for (const file of importFiles) {
    const result = scanImportFile(projectRoot, join(projectRoot, file));
    skipped += result.skipped;

    for (const directive of result.directives) {
      const action = await applyRememberDirective(
        { projectRoot, source: "unknown", sessionId: `consolidate:${file}` },
        { text: directive }
      );
      if (action.payload.written) {
        directivesLearned += 1;
        highlights.push(`learned rule from ${file}: ${directive}`);
      }
    }

    const created = ingestCandidates(candidateStore, result.candidates, {
      source: "unknown",
      sessionId: `consolidate:${file}`,
      projectRoot,
    });
    candidatesQueued += created.length;
    highlights.push(...created.slice(0, 2).map((entry) => `queued candidate from ${file}: ${entry.text}`));
  }

  for (const directive of detectProjectRules(projectRoot)) {
    const action = await applyRememberDirective(
      { projectRoot, source: "unknown", sessionId: "consolidate:project-config" },
      { text: directive }
    );
    if (action.payload.written) {
      directivesLearned += 1;
      highlights.push(`learned project rule: ${directive}`);
    }
  }

  const gitSignals = detectGitSignals(projectRoot);
  const createdFromGit = ingestCandidates(candidateStore, gitSignals, {
    source: "unknown",
    sessionId: "consolidate:git-log",
    projectRoot,
  });
  candidatesQueued += createdFromGit.length;
  highlights.push(...createdFromGit.slice(0, 2).map((entry) => `queued git signal: ${entry.text}`));

  saveCandidateStore(projectRoot, candidateStore);

  return {
    scannedSources: importFiles.length + 1 + (gitSignals.length > 0 ? 1 : 0),
    directivesLearned,
    candidatesQueued,
    skipped,
    gitSignals: createdFromGit.length,
    highlights,
  };
}

async function buildReflectionProposals(
  projectRoot: string,
  staleDays: number
): Promise<{
  proposals: ReflectionProposal[];
  staleDirectives: number;
  conflicts: number;
  merges: number;
}> {
  const now = Date.now();
  const directives = await loadDirectiveMetadata(projectRoot);
  const links = loadLinks(projectRoot);
  const pendingCandidates = listCandidates(loadCandidateStore(projectRoot), { status: "pending" });
  const proposals: ReflectionProposal[] = [];

  let staleDirectives = 0;
  for (const directive of directives) {
    const lastSeen = directive.lastReferencedAt ?? directive.createdAt;
    const ageDays = Math.floor((now - Date.parse(lastSeen)) / (1000 * 60 * 60 * 24));
    if (!Number.isFinite(ageDays) || ageDays < staleDays) continue;
    staleDirectives += 1;
    proposals.push({
      id: randomUUID(),
      kind: "retire",
      title: `Retire stale directive: ${directive.value}`,
      detail: `This rule has not been referenced for ${ageDays} day(s). Consider retiring or rewriting it if it no longer reflects current practice.`,
      evidence: [directive.value],
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const conflicts = links.filter((link) => link.kind === "contradicts").length;
  for (const link of links.filter((entry) => entry.kind === "contradicts")) {
    proposals.push({
      id: randomUUID(),
      kind: "resolve_conflict",
      title: `Resolve directive conflict: ${link.fromDirective}`,
      detail: `Approved link marks this rule as contradicting "${link.toDirective}". Decide which directive should remain active.`,
      evidence: [link.fromDirective, link.toDirective],
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const mergeCandidates = pendingCandidates.filter((candidate) => candidate.text.startsWith("MERGE:"));
  for (const candidate of mergeCandidates) {
    proposals.push({
      id: randomUUID(),
      kind: "review_merge",
      title: `Review merge proposal: ${candidate.text}`,
      detail: "The system found overlapping directives that may be better expressed as one canonical rule.",
      evidence: [candidate.text],
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    proposals,
    staleDirectives,
    conflicts,
    merges: mergeCandidates.length,
  };
}

function runSleepConsolidation(projectRoot: string): {
  timelineRebuilt: boolean;
  newHabits: number;
  newSchemas: number;
  highlights: string[];
} {
  const squeezePath = join(projectRoot, ".squeeze");
  const events = new EventStore(squeezePath).getAll();
  const existingHabits = loadHabits(projectRoot);
  const newHabits = detectHabits(events, existingHabits);
  const mergedHabits = [...existingHabits, ...newHabits];
  if (newHabits.length > 0) {
    saveHabits(projectRoot, mergedHabits);
  }

  const directives = existsSync(join(projectRoot, "MEMORY.md"))
    ? parseActiveDirectives(join(projectRoot, "MEMORY.md"))
    : [];
  const schemaStore = new SchemaStore(squeezePath);
  const existingSchemas = schemaStore.getAll();
  const newSchemas = detectSchemas(mergedHabits, directives, existingSchemas);
  for (const schema of newSchemas) {
    schemaStore.upsert(schema);
  }

  new TimelineIndex(squeezePath).rebuild();

  const highlights: string[] = [];
  highlights.push(...newHabits.slice(0, 2).map((habit) => `detected habit: ${habit.pattern}`));
  highlights.push(...newSchemas.slice(0, 2).map((schema) => `detected schema: ${schema.name}`));

  return {
    timelineRebuilt: true,
    newHabits: newHabits.length,
    newSchemas: newSchemas.length,
    highlights,
  };
}

function buildJournalEntry(input: {
  external: ConsolidationReport["external"] & { highlights: string[] };
  reflectionCreated: number;
  sleep: { newHabits: number; newSchemas: number; highlights: string[] };
}): GrowthJournalEntry {
  const highlights = [...input.external.highlights, ...input.sleep.highlights].slice(0, 6);
  const summary =
    input.external.directivesLearned === 0 &&
    input.external.candidatesQueued === 0 &&
    input.reflectionCreated === 0 &&
    input.sleep.newHabits === 0 &&
    input.sleep.newSchemas === 0
      ? "No major offline growth signals were detected."
      : `Learned ${input.external.directivesLearned} directive(s), queued ${input.external.candidatesQueued} candidate(s), proposed ${input.reflectionCreated} reflection item(s), detected ${input.sleep.newHabits} habit(s), and detected ${input.sleep.newSchemas} schema(s).`;

  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind: "consolidate",
    summary,
    highlights,
    stats: {
      external_directives: input.external.directivesLearned,
      external_candidates: input.external.candidatesQueued,
      reflection_proposals_created: input.reflectionCreated,
      habits_detected: input.sleep.newHabits,
      schemas_detected: input.sleep.newSchemas,
    },
  };
}

export async function consolidateProject(
  projectRoot: string,
  options: ConsolidateOptions = {}
): Promise<ConsolidationReport> {
  const staleDays = Math.max(0, Math.floor(options.staleDays ?? 30));

  const external = await applyExternalLearning(projectRoot);
  const reflectionScan = await buildReflectionProposals(projectRoot, staleDays);
  const proposalsCreated = upsertReflectionProposals(projectRoot, reflectionScan.proposals);
  const sleep = runSleepConsolidation(projectRoot);
  const journalEntry = buildJournalEntry({
    external,
    reflectionCreated: proposalsCreated,
    sleep,
  });
  appendGrowthJournal(projectRoot, journalEntry);

  return {
    external: {
      scannedSources: external.scannedSources,
      directivesLearned: external.directivesLearned,
      candidatesQueued: external.candidatesQueued,
      skipped: external.skipped,
      gitSignals: external.gitSignals,
    },
    reflection: {
      proposalsCreated,
      staleDirectives: reflectionScan.staleDirectives,
      conflicts: reflectionScan.conflicts,
      merges: reflectionScan.merges,
    },
    consolidation: {
      timelineRebuilt: sleep.timelineRebuilt,
      newHabits: sleep.newHabits,
      newSchemas: sleep.newSchemas,
      journalEntriesAdded: 1,
    },
    journalEntry,
  };
}

export function renderConsolidationReport(report: ConsolidationReport): string {
  return [
    "oh-my-brain consolidate",
    "──────────────────────────────",
    `External learning: ${report.external.directivesLearned} directives, ${report.external.candidatesQueued} candidates, ${report.external.gitSignals} git signals`,
    `Reflection loop: ${report.reflection.proposalsCreated} proposals (${report.reflection.staleDirectives} stale, ${report.reflection.conflicts} conflicts, ${report.reflection.merges} merges)`,
    `Sleep consolidation: timeline rebuilt=${report.consolidation.timelineRebuilt ? "yes" : "no"}, ${report.consolidation.newHabits} habits, ${report.consolidation.newSchemas} schemas`,
    "",
    `Growth journal: ${report.journalEntry.summary}`,
    ...report.journalEntry.highlights.map((highlight) => `- ${highlight}`),
  ].join("\n");
}

export function renderGrowthSnapshot(snapshot: GrowthSnapshot): string {
  const breakdown = Object.entries(snapshot.proposalBreakdown)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind}=${count}`)
    .join(", ");

  const lines = [
    "oh-my-brain growth",
    "──────────────────────────────",
    `pending_reflection_proposals: ${snapshot.pendingProposals}`,
    `proposal_breakdown: ${breakdown || "none"}`,
    `growth_journal_entries: ${snapshot.journalEntries}`,
  ];

  if (snapshot.latestJournal) {
    lines.push(`latest_growth_at: ${snapshot.latestJournal.ts}`);
    lines.push(`latest_growth_summary: ${snapshot.latestJournal.summary}`);
    for (const highlight of snapshot.latestJournal.highlights) {
      lines.push(`- ${highlight}`);
    }
  } else {
    lines.push("latest_growth_at: null");
    lines.push("latest_growth_summary: none");
  }

  return lines.join("\n");
}

export function renderReflectionProposals(proposals: ReflectionProposal[]): string {
  if (proposals.length === 0) {
    return "No reflection proposals.";
  }
  return [
    "oh-my-brain reflect",
    "──────────────────────────────",
    ...proposals.map((proposal) => {
      const suffix = proposal.resolutionNote ? ` — ${proposal.resolutionNote}` : "";
      return `${proposal.id.slice(0, 8)} [${proposal.status}] ${proposal.kind}: ${proposal.title}${suffix}`;
    }),
  ].join("\n");
}

export async function runConsolidateCli(argv: string[], projectRoot: string): Promise<number> {
  const args = argv.slice(2);
  const staleIndex = args.indexOf("--stale-days");
  const staleDays =
    staleIndex >= 0 && typeof args[staleIndex + 1] === "string"
      ? Number(args[staleIndex + 1])
      : 30;
  const report = await consolidateProject(projectRoot, { staleDays });
  process.stdout.write(`${renderConsolidationReport(report)}\n`);
  return 0;
}

export async function runGrowthCli(_argv: string[], projectRoot: string): Promise<number> {
  const snapshot = buildGrowthSnapshot(projectRoot);
  process.stdout.write(`${renderGrowthSnapshot(snapshot)}\n`);
  return 0;
}

export async function runReflectCli(argv: string[], projectRoot: string): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0] ?? "list";

  if (cmd === "list") {
    const statusArg = args.includes("--all")
      ? "all"
      : (args.includes("--resolved")
        ? "resolved"
        : (args.includes("--dismissed") ? "dismissed" : "pending"));
    const proposals = listReflectionProposals(
      projectRoot,
      statusArg as "pending" | "resolved" | "dismissed" | "all"
    );
    process.stdout.write(`${renderReflectionProposals(proposals)}\n`);
    return 0;
  }

  if (cmd === "approve") {
    const rawId = args[1];
    if (!rawId) {
      process.stderr.write('Usage: brain-reflect approve <proposal-id>\n');
      return 1;
    }
    const id = resolveReflectionProposalId(projectRoot, rawId);
    if (!id) {
      process.stderr.write(`[brain] reflection proposal not found: ${rawId}\n`);
      return 1;
    }
    const result = await approveReflectionProposal(projectRoot, id);
    if (!result) {
      process.stderr.write(`[brain] reflection proposal is not pending: ${rawId}\n`);
      return 1;
    }
    process.stdout.write(`Approved ${id}: ${result.note}\n`);
    return 0;
  }

  if (cmd === "dismiss" || cmd === "reject") {
    const rawId = args[1];
    if (!rawId) {
      process.stderr.write('Usage: brain-reflect dismiss <proposal-id>\n');
      return 1;
    }
    const id = resolveReflectionProposalId(projectRoot, rawId);
    if (!id) {
      process.stderr.write(`[brain] reflection proposal not found: ${rawId}\n`);
      return 1;
    }
    const result = dismissReflectionProposal(projectRoot, id);
    if (!result) {
      process.stderr.write(`[brain] reflection proposal is not pending: ${rawId}\n`);
      return 1;
    }
    process.stdout.write(`Dismissed ${id}\n`);
    return 0;
  }

  process.stderr.write(
    "Usage: brain-reflect <list|approve|dismiss> [args]\n"
  );
  return 1;
}

if (isDirectEntry(["consolidate.js", "brain-consolidate"])) {
  runConsolidateCli(process.argv, process.cwd()).catch((err) => {
    process.stderr.write(`[brain] consolidate error: ${err.message}\n`);
    process.exit(1);
  });
}
