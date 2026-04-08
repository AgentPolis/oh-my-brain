/**
 * Directive Types — typed memory categories with self-growth.
 *
 * This is the L2 self-growth path described in
 * docs/why-personal-world-model.md. v0.2 stored every directive as a
 * flat L3 "directive" with no further classification. v0.3 adds typed
 * categories so the agent can ask questions like "give me all
 * CodingPreferences scoped to TypeScript" or "list every PersonContact".
 *
 * Two parts:
 *
 * 1. **Built-in seed types.** A small registry of types we ship with
 *    the package. Five categories that cover the long tail of personal
 *    rules. The classifier tags each new directive with one of these
 *    or with `Uncategorized` if nothing matches.
 *
 * 2. **Self-growth via Type Candidates.** When N+ uncategorized
 *    directives accumulate that share a recognizable keyword cluster,
 *    the system proposes a new Directive Type with an auto-derived
 *    name and example list. The user approves, edits, or rejects via
 *    `brain-candidates list-types` / `approve-type` / `reject-type`.
 *    Approved types append to a user-defined registry at
 *    `.squeeze/types.json` and immediately get the same first-class
 *    treatment as built-in types.
 *
 * Why this matters:
 *   The user noted in the v0.3 design discussion that they had
 *   previously defined "memory by topic domain" — exactly this idea,
 *   but without a self-growth mechanism. A static schema is a dead
 *   schema. A self-growing one is a living ontology, which is what
 *   Palantir's actual deployments look like in practice.
 *
 * Storage:
 *   - User-defined types live at `.squeeze/types.json` (additive only;
 *     this file is hand-editable)
 *   - Type Candidates live at `.squeeze/type-candidates.json`
 *
 * Mutations to either file should go through Actions (Phase 4c) so
 * the audit trail covers schema evolution as well as data changes.
 * Type-related actions land in cli/actions.ts in the same Action log.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

// ── Directive Type definitions ───────────────────────────────────

export interface DirectiveTypeSchema {
  /** Stable identifier; matches the JSON key. */
  id: string;
  /** Human display name. */
  name: string;
  /** One-line description shown in CLI list. */
  description: string;
  /** Regex patterns that, if any matches the directive body, classify
   *  it as this type. Patterns are checked case-insensitively. */
  matchPatterns: string[];
  /** Whether this type was added by the user or shipped built-in. */
  origin: "builtin" | "user";
  /** ISO timestamp this type was added. Built-ins use the v0.3 release date. */
  addedAt: string;
}

const BUILTIN_TYPES: DirectiveTypeSchema[] = [
  {
    id: "CodingPreference",
    name: "Coding Preference",
    description:
      "How the user likes code written: language version, formatting, naming, framework choices",
    matchPatterns: [
      "\\b(typescript|javascript|python|rust|go)\\b",
      "\\b(strict|tabs|spaces|indent|format|lint|prettier|eslint|vitest|jest|mocha)\\b",
      "\\b(use|prefer)\\b.{0,40}\\b(library|framework|package)\\b",
    ],
    origin: "builtin",
    addedAt: "2026-04-08T00:00:00Z",
  },
  {
    id: "ToolBan",
    name: "Tool Ban",
    description:
      "Tools, libraries, patterns, or behaviors the user wants the agent to refuse",
    matchPatterns: [
      "\\b(never|don't|do not|avoid|ban|forbid|refuse)\\b",
      "\\bnot allowed\\b",
      "(不要|別|禁止|不准|絕對不|永遠不)",
    ],
    origin: "builtin",
    addedAt: "2026-04-08T00:00:00Z",
  },
  {
    id: "CommunicationStyle",
    name: "Communication Style",
    description:
      "How the user wants the agent to talk: language, tone, length, format",
    matchPatterns: [
      "\\b(reply|respond|answer|talk|speak|explain|write)\\b",
      "\\b(in english|in chinese|in 中文|terse|concise|brief|short)\\b",
      "\\b(no|without)\\b.{0,30}\\b(emoji|markdown|bullets|preamble)\\b",
      "(用中文|用英文|簡短|簡潔)",
    ],
    origin: "builtin",
    addedAt: "2026-04-08T00:00:00Z",
  },
  {
    id: "ProjectFact",
    name: "Project Fact",
    description:
      "Factual information about the project: structure, conventions, deployment, business rules",
    matchPatterns: [
      "\\b(deploy|deployment|production|staging|database|schema|api|endpoint)\\b",
      "\\b(version|node\\.?js|npm|sqlite|postgres|redis)\\b\\s*(>=|=|is|uses)",
      "\\b(architecture|repo|monorepo|workspace|path|directory)\\b",
    ],
    origin: "builtin",
    addedAt: "2026-04-08T00:00:00Z",
  },
  {
    id: "PersonContact",
    name: "Person / Contact",
    description:
      "People the user collaborates with: names, roles, contact info, preferences about them",
    matchPatterns: [
      "\\b(my (manager|teammate|colleague|client|customer|founder|investor))\\b",
      "\\b(@\\w+|email .{0,30}@)\\b",
      "\\bcontact\\b",
    ],
    origin: "builtin",
    addedAt: "2026-04-08T00:00:00Z",
  },
];

// ── Storage ──────────────────────────────────────────────────────

interface UserTypesFile {
  version: 1;
  types: DirectiveTypeSchema[];
}

const EMPTY_USER_TYPES: UserTypesFile = { version: 1, types: [] };

function userTypesPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", "types.json");
}

export function loadUserTypes(projectRoot: string): DirectiveTypeSchema[] {
  const path = userTypesPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UserTypesFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.types)) return [];
    return parsed.types;
  } catch {
    return [];
  }
}

export function saveUserTypes(
  projectRoot: string,
  types: DirectiveTypeSchema[]
): void {
  const dir = join(projectRoot, ".squeeze");
  mkdirSync(dir, { recursive: true });
  const path = userTypesPath(projectRoot);
  const tmp = path + ".tmp";
  const file: UserTypesFile = { version: 1, types };
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

/** Return all available types (built-in + user) in stable order. */
export function loadAllTypes(projectRoot: string): DirectiveTypeSchema[] {
  return [...BUILTIN_TYPES, ...loadUserTypes(projectRoot)];
}

// ── Classifier ───────────────────────────────────────────────────

export interface ClassifyResult {
  typeId: string; // "Uncategorized" if nothing matched
  matchedPatterns: string[];
}

/**
 * Classify a directive body into one of the available types.
 * First match wins. If multiple types match, the earliest in the
 * combined list (built-in first) wins, which gives builtins priority
 * but lets user types override later additions of the same kind.
 */
export function classifyDirective(
  projectRoot: string,
  directiveBody: string
): ClassifyResult {
  const text = directiveBody.toLowerCase();
  const types = loadAllTypes(projectRoot);
  for (const type of types) {
    const matched: string[] = [];
    for (const pat of type.matchPatterns) {
      try {
        const re = new RegExp(pat, "i");
        if (re.test(text)) matched.push(pat);
      } catch {
        // Bad regex from user input — ignore that pattern
      }
    }
    if (matched.length > 0) {
      return { typeId: type.id, matchedPatterns: matched };
    }
  }
  return { typeId: "Uncategorized", matchedPatterns: [] };
}

// ── Type Candidates (the L2 self-growth path) ────────────────────

export interface TypeCandidateRecord {
  id: string;
  proposedName: string;
  proposedDescription: string;
  derivedKeywords: string[];
  exampleDirectives: string[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  finalName?: string; // editable on approve
}

interface TypeCandidateStore {
  version: 1;
  candidates: Record<string, TypeCandidateRecord>;
}

const EMPTY_CANDIDATE_STORE: TypeCandidateStore = { version: 1, candidates: {} };

function typeCandidatesPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", "type-candidates.json");
}

export function loadTypeCandidates(projectRoot: string): TypeCandidateStore {
  const path = typeCandidatesPath(projectRoot);
  if (!existsSync(path)) return { ...EMPTY_CANDIDATE_STORE, candidates: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TypeCandidateStore;
    if (parsed.version !== 1 || typeof parsed.candidates !== "object") {
      return { ...EMPTY_CANDIDATE_STORE, candidates: {} };
    }
    return parsed;
  } catch {
    return { ...EMPTY_CANDIDATE_STORE, candidates: {} };
  }
}

export function saveTypeCandidates(
  projectRoot: string,
  store: TypeCandidateStore
): void {
  const dir = join(projectRoot, ".squeeze");
  mkdirSync(dir, { recursive: true });
  const path = typeCandidatesPath(projectRoot);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}

export function listTypeCandidates(
  store: TypeCandidateStore,
  filter?: { status?: TypeCandidateRecord["status"] }
): TypeCandidateRecord[] {
  const all = Object.values(store.candidates);
  const filtered = filter?.status ? all.filter((c) => c.status === filter.status) : all;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function typeCandidateId(name: string, examples: string[]): string {
  const seed = name + "::" + examples.slice().sort().join("|");
  return "tc_" + createHash("sha256").update(seed).digest("hex").slice(0, 10);
}

// ── Self-growth: detect emerging type patterns ───────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "of", "to", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should", "could",
  "may", "might", "must", "shall", "can", "use", "uses", "used", "using",
  "this", "that", "these", "those", "it", "its", "i", "me", "my", "we", "our",
  "you", "your", "they", "them", "their", "always", "never", "all",
  "也", "都", "的", "了", "在", "和", "與", "或", "是", "不", "有", "我", "你", "他",
  "從", "把", "用", "要", "請", "說", "做",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

interface KeywordCluster {
  keyword: string;
  count: number;
  exampleIndices: number[];
}

/**
 * Examine a list of uncategorized directive bodies and look for
 * emerging keyword clusters. A cluster is N+ directives sharing a
 * non-trivial keyword. Returns proposals sorted by cluster size.
 *
 * Threshold defaults to 3 — fewer than 3 hits is noise; 3+ is a real
 * pattern that justifies asking the user about it.
 */
export interface ClusterProposal {
  keyword: string;
  exampleDirectives: string[];
  derivedKeywords: string[];
}

export function detectEmergingClusters(
  uncategorizedDirectives: string[],
  threshold = 3
): ClusterProposal[] {
  const clusters = new Map<string, KeywordCluster>();

  uncategorizedDirectives.forEach((directive, idx) => {
    const tokens = new Set(tokenize(directive));
    for (const token of tokens) {
      const existing = clusters.get(token);
      if (existing) {
        existing.count += 1;
        existing.exampleIndices.push(idx);
      } else {
        clusters.set(token, {
          keyword: token,
          count: 1,
          exampleIndices: [idx],
        });
      }
    }
  });

  const sorted = Array.from(clusters.values())
    .filter((c) => c.count >= threshold)
    .sort((a, b) => b.count - a.count);

  // For each cluster, derive a small list of related keywords (other
  // tokens that co-occur frequently with the cluster keyword in the
  // same directives). This makes the proposed schema richer than a
  // single keyword and gives the user something to edit.
  return sorted.map((cluster) => {
    const examples = cluster.exampleIndices.map(
      (i) => uncategorizedDirectives[i]
    );
    const cooccurring = new Map<string, number>();
    for (const ex of examples) {
      for (const tok of new Set(tokenize(ex))) {
        if (tok === cluster.keyword) continue;
        cooccurring.set(tok, (cooccurring.get(tok) ?? 0) + 1);
      }
    }
    const derivedKeywords = Array.from(cooccurring.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([kw]) => kw);

    return {
      keyword: cluster.keyword,
      exampleDirectives: examples.slice(0, 6),
      derivedKeywords: [cluster.keyword, ...derivedKeywords],
    };
  });
}

/**
 * Capitalize and humanize a keyword into a proposed type name.
 * "navbar" → "Navbar Preference"; "deployment" → "Deployment Preference".
 * The user can edit the name on approve, so this is just a starting point.
 */
function proposedNameFromKeyword(keyword: string): string {
  const base = keyword
    .split(/[\s_-]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return `${base}Preference`;
}

/**
 * Ingest fresh cluster proposals into the type candidate store. Returns
 * the list of newly created type candidates (existing ones with the
 * same id are updated, not duplicated).
 */
export function ingestClusterProposals(
  store: TypeCandidateStore,
  proposals: ClusterProposal[]
): TypeCandidateRecord[] {
  const now = new Date().toISOString();
  const newlyCreated: TypeCandidateRecord[] = [];

  for (const proposal of proposals) {
    const proposedName = proposedNameFromKeyword(proposal.keyword);
    const id = typeCandidateId(proposedName, proposal.exampleDirectives);
    if (store.candidates[id]) {
      // Already proposed; just freshen the examples (keeps it sorted by
      // createdAt for the user but doesn't pretend it's new).
      const existing = store.candidates[id];
      if (existing.status === "pending") {
        existing.exampleDirectives = proposal.exampleDirectives;
        existing.derivedKeywords = proposal.derivedKeywords;
      }
      continue;
    }
    const record: TypeCandidateRecord = {
      id,
      proposedName,
      proposedDescription: `Auto-proposed type derived from ${proposal.exampleDirectives.length} uncategorized directives sharing the keyword "${proposal.keyword}". Edit on approval to refine.`,
      derivedKeywords: proposal.derivedKeywords,
      exampleDirectives: proposal.exampleDirectives,
      status: "pending",
      createdAt: now,
    };
    store.candidates[id] = record;
    newlyCreated.push(record);
  }

  return newlyCreated;
}

// ── Approve / reject ─────────────────────────────────────────────

export function resolveTypeCandidateId(
  store: TypeCandidateStore,
  prefix: string
): string | null {
  if (store.candidates[prefix]) return prefix;
  const matches = Object.keys(store.candidates).filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  return null;
}

export interface ApproveTypeResult {
  candidate: TypeCandidateRecord;
  newType: DirectiveTypeSchema;
}

export function approveTypeCandidate(
  store: TypeCandidateStore,
  id: string,
  finalName?: string,
  finalDescription?: string
): ApproveTypeResult | null {
  const candidate = store.candidates[id];
  if (!candidate || candidate.status !== "pending") return null;

  const name = (finalName ?? candidate.proposedName).trim();
  if (name.length === 0) return null;

  const newType: DirectiveTypeSchema = {
    id: name,
    name,
    description: (finalDescription ?? candidate.proposedDescription).trim(),
    matchPatterns: candidate.derivedKeywords.map(
      (kw) => `\\b${kw.replace(/[.*+?^${}()|[\\]/g, "\\$&")}\\b`
    ),
    origin: "user",
    addedAt: new Date().toISOString(),
  };

  candidate.status = "approved";
  candidate.finalName = name;
  candidate.reviewedAt = new Date().toISOString();

  return { candidate, newType };
}

export function rejectTypeCandidate(
  store: TypeCandidateStore,
  id: string
): TypeCandidateRecord | null {
  const candidate = store.candidates[id];
  if (!candidate || candidate.status !== "pending") return null;
  candidate.status = "rejected";
  candidate.reviewedAt = new Date().toISOString();
  return candidate;
}

// ── High-level: scan for new type candidates ─────────────────────

/**
 * Scan all current MEMORY.md directives, classify each, find the
 * uncategorized ones, and propose new types based on emerging
 * keyword clusters. This is the main "self-growth tick" that the
 * compress hook calls after every session.
 *
 * Returns the count of newly proposed type candidates so the hook
 * can report it on stderr.
 */
export function scanForTypeCandidates(
  projectRoot: string,
  directiveBodies: string[],
  threshold = 3
): TypeCandidateRecord[] {
  // Find uncategorized directives
  const uncategorized = directiveBodies.filter(
    (body) => classifyDirective(projectRoot, body).typeId === "Uncategorized"
  );
  if (uncategorized.length < threshold) return [];

  const proposals = detectEmergingClusters(uncategorized, threshold);
  if (proposals.length === 0) return [];

  const store = loadTypeCandidates(projectRoot);
  const newlyCreated = ingestClusterProposals(store, proposals);
  if (newlyCreated.length > 0) {
    saveTypeCandidates(projectRoot, store);
  }
  return newlyCreated;
}
