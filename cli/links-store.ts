/**
 * Directive Links — typed relations between directives, with self-growth.
 *
 * The L3 self-growth path described in docs/why-personal-world-model.md.
 * v0.3 step three: directives don't live in isolation. Real personal
 * rules form a graph — one directive supersedes another, refines it,
 * contradicts it, or scopes to a project. Without typed links, the
 * agent has to scan every directive on every query and can't answer
 * questions like "what's my current TypeScript rule, ignoring
 * superseded ones?"
 *
 * Two parts:
 *
 * 1. **Built-in link kinds.** Four typed relation kinds we ship with:
 *    - `supersedes`   — directive A replaces directive B (B was wrong
 *                       or outdated; B should be retired)
 *    - `refines`     — directive A adds detail to directive B (both
 *                       are still active; A is more specific)
 *    - `contradicts` — directive A is in tension with directive B and
 *                       the user has not yet decided which wins (the
 *                       agent should flag this on read)
 *    - `scopedTo`    — directive A applies only inside the context of
 *                       directive B (e.g. "use Vitest" scopedTo "in
 *                       TypeScript projects")
 *
 * 2. **Self-growth via Link Candidates.** When the system observes a
 *    pair of directives that look related (high Jaccard similarity AND
 *    negation/contradiction markers, OR keyword overlap with a scoping
 *    word), it proposes a typed link. The user approves, rejects, or
 *    edits the proposed kind.
 *
 * Storage:
 *   - Approved links live at `.brain/system/links.json`
 *   - Link candidates live at `.brain/system/link-candidates.json`
 *
 * Mutations to either file go through Actions in cli/actions.ts so the
 * audit trail covers the relation graph as well as data and types.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { resolveSystemRoot } from "../src/scope.js";

// ── Link kinds ──────────────────────────────────────────────────

export type LinkKind = "supersedes" | "refines" | "contradicts" | "scopedTo";

export const LINK_KINDS: LinkKind[] = [
  "supersedes",
  "refines",
  "contradicts",
  "scopedTo",
];

export interface DirectiveLink {
  id: string;
  fromDirective: string; // directive body text (the source)
  kind: LinkKind;
  toDirective: string; // directive body text (the target)
  addedAt: string;
  origin: "user" | "auto";
}

interface LinksFile {
  version: 1;
  links: DirectiveLink[];
}

const EMPTY_LINKS: LinksFile = { version: 1, links: [] };

function linksPath(projectRoot: string): string {
  return join(resolveSystemRoot(projectRoot), "links.json");
}

export function loadLinks(projectRoot: string): DirectiveLink[] {
  const path = linksPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LinksFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.links)) return [];
    return parsed.links;
  } catch {
    return [];
  }
}

export function saveLinks(projectRoot: string, links: DirectiveLink[]): void {
  const dir = resolveSystemRoot(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = linksPath(projectRoot);
  const tmp = path + ".tmp";
  const file: LinksFile = { version: 1, links };
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

// ── Link Candidate store ─────────────────────────────────────────

export interface LinkCandidateRecord {
  id: string;
  fromDirective: string;
  proposedKind: LinkKind;
  toDirective: string;
  /** Why we proposed this — the heuristic that fired. */
  rationale: string;
  /** Similarity score 0-1 between the two directives (Jaccard over tokens). */
  similarity: number;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  reviewedAt?: string;
  finalKind?: LinkKind;
}

interface LinkCandidateStore {
  version: 1;
  candidates: Record<string, LinkCandidateRecord>;
}

const EMPTY_CANDIDATE_STORE: LinkCandidateStore = { version: 1, candidates: {} };

function linkCandidatesPath(projectRoot: string): string {
  return join(resolveSystemRoot(projectRoot), "link-candidates.json");
}

export function loadLinkCandidates(projectRoot: string): LinkCandidateStore {
  const path = linkCandidatesPath(projectRoot);
  if (!existsSync(path)) return { ...EMPTY_CANDIDATE_STORE, candidates: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LinkCandidateStore;
    if (parsed.version !== 1 || typeof parsed.candidates !== "object") {
      return { ...EMPTY_CANDIDATE_STORE, candidates: {} };
    }
    return parsed;
  } catch {
    return { ...EMPTY_CANDIDATE_STORE, candidates: {} };
  }
}

export function saveLinkCandidates(
  projectRoot: string,
  store: LinkCandidateStore
): void {
  const dir = resolveSystemRoot(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = linkCandidatesPath(projectRoot);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}

export function listLinkCandidates(
  store: LinkCandidateStore,
  filter?: { status?: LinkCandidateRecord["status"] }
): LinkCandidateRecord[] {
  const all = Object.values(store.candidates);
  const filtered = filter?.status
    ? all.filter((c) => c.status === filter.status)
    : all;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function linkCandidateId(
  fromDirective: string,
  toDirective: string,
  kind: LinkKind
): string {
  const seed = `${kind}::${fromDirective}::${toDirective}`;
  return "lc_" + createHash("sha256").update(seed).digest("hex").slice(0, 10);
}

export function resolveLinkCandidateId(
  store: LinkCandidateStore,
  prefix: string
): string | null {
  if (store.candidates[prefix]) return prefix;
  const matches = Object.keys(store.candidates).filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  return null;
}

// ── Detection heuristic ─────────────────────────────────────────

const LINK_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "of", "to", "in", "on", "at",
  "by", "with", "from", "as", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "should", "could",
  "may", "might", "must", "shall", "can", "use", "uses", "used", "using",
  "this", "that", "these", "those", "it", "its", "i", "me", "my", "we", "our",
  "you", "your", "they", "them", "their",
  "也", "都", "的", "了", "在", "和", "與", "或", "是", "不", "有", "我", "你", "他",
]);

export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u4e00-\u9fff]+/)
      .filter((w) => w.length >= 3 && !LINK_STOPWORDS.has(w))
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) if (b.has(tok)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const NEGATION_MARKERS = [
  "never",
  "don't",
  "do not",
  "stop",
  "avoid",
  "no longer",
  "not anymore",
  "instead",
  "rather than",
  "不要",
  "別",
  "停止",
  "改用",
  "改成",
];

// Scope markers must be reasonably long phrases to avoid false positives.
// Plain "for" matches too eagerly ("for testing", "for unit testing")
// and produced noise in the v0.3 smoke tests, so it has been removed.
const SCOPE_MARKERS = [
  "in typescript projects",
  "in javascript projects",
  "in python projects",
  "in rust projects",
  "in go projects",
  "only when",
  "only in",
  "only for",
  "during ",
  "scoped to",
  "in the context of",
  "在 typescript",
  "在 javascript",
  "在 python",
  "對於",
];

function hasMarker(text: string, markers: string[]): boolean {
  const lower = text.toLowerCase();
  return markers.some((m) => lower.includes(m));
}

interface LinkProposal {
  fromDirective: string;
  toDirective: string;
  kind: LinkKind;
  rationale: string;
  similarity: number;
}

/**
 * Examine a list of directive bodies and propose typed links between
 * pairs that look related. Heuristics (in order):
 *
 *   1. supersedes: Jaccard >= 0.4 AND the newer directive contains a
 *      negation marker AND shares enough tokens with an older one.
 *      "always use Vitest" + (later) "never use Jest, always use Vitest"
 *      → supersedes
 *
 *   2. contradicts: Jaccard >= 0.4 AND the two directives share most
 *      tokens but contain negation markers in different directions.
 *      "always use tabs" + "always use spaces" → contradicts
 *
 *   3. refines: Jaccard >= 0.5 AND one is strictly longer than the
 *      other (more specific) without conflict markers.
 *      "always use TypeScript" + "always use TypeScript strict mode"
 *      → refines
 *
 *   4. scopedTo: one directive contains a scope marker AND shares
 *      tokens with another directive.
 *      "in TypeScript projects, always use Vitest" → scopedTo
 *
 * The directives are passed in chronological order (oldest first), so
 * supersedes always points from the newer one to the older one.
 *
 * Returns proposals deduped by content-hash id.
 */
export function detectLinkProposals(
  directives: string[],
  similarityThreshold = 0.25
): LinkProposal[] {
  const proposals: LinkProposal[] = [];
  const seen = new Set<string>();

  function emit(p: LinkProposal): void {
    const id = linkCandidateId(p.fromDirective, p.toDirective, p.kind);
    if (seen.has(id)) return;
    seen.add(id);
    proposals.push(p);
  }

  const tokens = directives.map(tokenSet);

  for (let i = 0; i < directives.length; i++) {
    for (let j = 0; j < i; j++) {
      // i is newer, j is older
      const newer = directives[i];
      const older = directives[j];
      if (newer === older) continue;
      const sim = jaccard(tokens[i], tokens[j]);
      if (sim < similarityThreshold) continue;

      const newerHasNeg = hasMarker(newer, NEGATION_MARKERS);
      const olderHasNeg = hasMarker(older, NEGATION_MARKERS);

      // Both negations: contradiction
      if (newerHasNeg && olderHasNeg) {
        emit({
          fromDirective: newer,
          toDirective: older,
          kind: "contradicts",
          rationale: `both directives contain negation markers and share ${(sim * 100).toFixed(0)}% of tokens`,
          similarity: sim,
        });
        continue;
      }

      // Newer has negation, older doesn't: supersedes
      if (newerHasNeg && !olderHasNeg) {
        emit({
          fromDirective: newer,
          toDirective: older,
          kind: "supersedes",
          rationale: `newer directive contains a negation marker and shares ${(sim * 100).toFixed(0)}% of tokens with the older one`,
          similarity: sim,
        });
        continue;
      }

      // Strong overlap, no conflict markers: refines (prefer longer
      // directive as the refining one). Threshold is intentionally
      // lower than supersedes/contradicts because refines is the
      // common case for related directives.
      if (sim >= 0.25) {
        const refining = newer.length >= older.length ? newer : older;
        const base = refining === newer ? older : newer;
        emit({
          fromDirective: refining,
          toDirective: base,
          kind: "refines",
          rationale: `${(sim * 100).toFixed(0)}% token overlap and the refining directive is more specific`,
          similarity: sim,
        });
      }
    }

    // Scoped: any directive containing a scope marker creates a
    // scopedTo proposal pointing at any other directive that shares
    // tokens with the scope phrase.
    if (hasMarker(directives[i], SCOPE_MARKERS)) {
      for (let k = 0; k < directives.length; k++) {
        if (k === i) continue;
        const sim = jaccard(tokens[i], tokens[k]);
        if (sim >= similarityThreshold && sim < 0.95) {
          emit({
            fromDirective: directives[i],
            toDirective: directives[k],
            kind: "scopedTo",
            rationale: `directive contains a scope marker and shares ${(sim * 100).toFixed(0)}% of tokens with the target`,
            similarity: sim,
          });
        }
      }
    }
  }

  return proposals;
}

/**
 * Ingest fresh link proposals into the candidate store. Existing
 * candidates with the same id are not duplicated. Returns the list of
 * newly created candidates.
 */
export function ingestLinkProposals(
  store: LinkCandidateStore,
  proposals: LinkProposal[]
): LinkCandidateRecord[] {
  const now = new Date().toISOString();
  const newlyCreated: LinkCandidateRecord[] = [];

  for (const proposal of proposals) {
    const id = linkCandidateId(
      proposal.fromDirective,
      proposal.toDirective,
      proposal.kind
    );
    if (store.candidates[id]) continue;
    const record: LinkCandidateRecord = {
      id,
      fromDirective: proposal.fromDirective,
      proposedKind: proposal.kind,
      toDirective: proposal.toDirective,
      rationale: proposal.rationale,
      similarity: proposal.similarity,
      status: "pending",
      createdAt: now,
    };
    store.candidates[id] = record;
    newlyCreated.push(record);
  }

  return newlyCreated;
}

// ── Approve / reject ─────────────────────────────────────────────

export interface ApproveLinkResult {
  candidate: LinkCandidateRecord;
  newLink: DirectiveLink;
}

export function approveLinkCandidate(
  store: LinkCandidateStore,
  id: string,
  finalKind?: LinkKind
): ApproveLinkResult | null {
  const candidate = store.candidates[id];
  if (!candidate || candidate.status !== "pending") return null;

  const kind = finalKind ?? candidate.proposedKind;
  if (!LINK_KINDS.includes(kind)) return null;

  const newLink: DirectiveLink = {
    id: linkCandidateId(candidate.fromDirective, candidate.toDirective, kind),
    fromDirective: candidate.fromDirective,
    kind,
    toDirective: candidate.toDirective,
    addedAt: new Date().toISOString(),
    origin: "auto",
  };

  candidate.status = "approved";
  candidate.finalKind = kind;
  candidate.reviewedAt = new Date().toISOString();

  return { candidate, newLink };
}

export function rejectLinkCandidate(
  store: LinkCandidateStore,
  id: string
): LinkCandidateRecord | null {
  const candidate = store.candidates[id];
  if (!candidate || candidate.status !== "pending") return null;
  candidate.status = "rejected";
  candidate.reviewedAt = new Date().toISOString();
  return candidate;
}

// ── High-level: scan for new link candidates ────────────────────

/**
 * Scan all current MEMORY.md directives for emerging typed link
 * proposals. Called from the compress hook after every session.
 *
 * Returns the count of newly proposed link candidates.
 */
export function scanForLinkCandidates(
  projectRoot: string,
  directiveBodies: string[]
): LinkCandidateRecord[] {
  const systemRoot = resolveSystemRoot(projectRoot);
  const stampPath = join(systemRoot, "last-scan.json");
  mkdirSync(systemRoot, { recursive: true });
  writeFileSync(`${stampPath}.tmp`, JSON.stringify({ ts: new Date().toISOString() }, null, 2));
  renameSync(`${stampPath}.tmp`, stampPath);

  if (directiveBodies.length < 2) return [];

  const proposals = detectLinkProposals(directiveBodies);
  if (proposals.length === 0) return [];

  const store = loadLinkCandidates(projectRoot);
  const newlyCreated = ingestLinkProposals(store, proposals);
  if (newlyCreated.length > 0) {
    saveLinkCandidates(projectRoot, store);
  }
  return newlyCreated;
}
