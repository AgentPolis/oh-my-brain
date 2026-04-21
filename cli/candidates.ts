/**
 * Memory Candidates store + review operations.
 *
 * This is the second half of the two-stage capture model described in
 * docs/why-memory-candidates.md:
 *
 *   Stage 1 (automatic): strong signals → MEMORY.md directly
 *   Stage 2 (human review): soft signals → candidate store → approve/reject/edit → MEMORY.md
 *
 * Soft signals are detected by extractMemoryCandidates() in compress-core.ts
 * using MEMORY_CANDIDATE_PATTERNS. This module persists them across runs,
 * gives them stable IDs, and exposes review operations.
 *
 * Storage: `.brain/system/candidates.json` at the project root. Single JSON file
 * for simplicity. Each record is keyed by a content hash so the same soft
 * signal from repeated sessions is de-duplicated automatically.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { logBlocked, scanForInjection } from "./compress-core.js";
import { resolveSystemRoot } from "../src/scope.js";

export type CandidateStatus = "pending" | "approved" | "rejected";

export interface CandidateRecord {
  id: string;                    // content hash, stable across sessions
  text: string;                  // the raw candidate text
  finalText?: string;            // text written to MEMORY.md after approve/edit (may differ from text)
  status: CandidateStatus;
  source: string;
  sessionId?: string;
  firstSeenAt: string;           // ISO timestamp
  lastSeenAt: string;            // ISO timestamp (updated on each re-detection)
  reviewedAt?: string;           // ISO timestamp of approve/reject
  mentionCount: number;          // how many runs have flagged this candidate
}

export interface CandidateStore {
  version: 1;
  candidates: Record<string, CandidateRecord>;
}

const EMPTY_STORE: CandidateStore = { version: 1, candidates: {} };

function candidatesPath(projectRoot: string): string {
  return join(resolveSystemRoot(projectRoot), "candidates.json");
}

/**
 * Compute a stable content-hash ID for a candidate. Normalizes whitespace
 * and lowercases so that trivially different phrasings don't fragment the
 * store. 12 hex chars is enough collision resistance for a per-project file.
 */
export function candidateId(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function loadCandidateStore(projectRoot: string): CandidateStore {
  const path = candidatesPath(projectRoot);
  if (!existsSync(path)) return { ...EMPTY_STORE, candidates: {} };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as CandidateStore;
    if (parsed.version !== 1 || typeof parsed.candidates !== "object") {
      return { ...EMPTY_STORE, candidates: {} };
    }
    return parsed;
  } catch {
    // Corrupted store — start fresh. Non-destructive; we never delete the
    // old file here, but a subsequent save will overwrite it atomically.
    return { ...EMPTY_STORE, candidates: {} };
  }
}

export function saveCandidateStore(projectRoot: string, store: CandidateStore): void {
  const dir = resolveSystemRoot(projectRoot);
  mkdirSync(dir, { recursive: true });
  const path = candidatesPath(projectRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
}

/**
 * Ingest freshly-detected candidate strings into the store. Existing records
 * are updated (lastSeenAt bumped, mentionCount incremented). Already-rejected
 * candidates are NOT resurrected — if the user rejected it once, the system
 * respects that and does not re-flag it.
 *
 * Returns the list of new candidates that were actually created (useful for
 * reporting "N new candidates flagged for review").
 */
export function ingestCandidates(
  store: CandidateStore,
  texts: string[],
  metadata: {
    source: string;
    sessionId?: string;
    projectRoot?: string;
  }
): CandidateRecord[] {
  const now = new Date().toISOString();
  const newlyCreated: CandidateRecord[] = [];

  for (const rawText of texts) {
    const text = rawText.trim();
    if (text.length === 0) continue;
    try {
      const scan = scanForInjection(text);
      if (!scan.safe) {
        if (metadata.projectRoot) {
          logBlocked(resolveSystemRoot(metadata.projectRoot), {
            ts: new Date().toISOString(),
            text,
            reason: scan.reason ?? "blocked",
            session: metadata.sessionId ?? "unknown",
            source: "candidates",
          });
        }
        continue;
      }
    } catch {
      // Guard failures should not block candidate ingestion.
    }

    const id = candidateId(text);
    const existing = store.candidates[id];

    if (!existing) {
      const record: CandidateRecord = {
        id,
        text,
        status: "pending",
        source: metadata.source,
        sessionId: metadata.sessionId,
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
      };
      store.candidates[id] = record;
      newlyCreated.push(record);
      continue;
    }

    // Respect prior user decisions — do not resurrect rejected candidates
    // and do not re-flag already-approved ones.
    if (existing.status !== "pending") continue;

    existing.lastSeenAt = now;
    existing.mentionCount += 1;
    // Keep the original text but prefer the first-seen phrasing. Source tags
    // follow the latest occurrence so the audit shows who last raised it.
    existing.source = metadata.source;
    if (metadata.sessionId) existing.sessionId = metadata.sessionId;
  }

  return newlyCreated;
}

export function listCandidates(
  store: CandidateStore,
  filter?: { status?: CandidateStatus }
): CandidateRecord[] {
  const all = Object.values(store.candidates);
  const filtered = filter?.status ? all.filter((c) => c.status === filter.status) : all;
  return filtered.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

/**
 * Resolve a short-prefix ID to a full candidate ID. Lets the CLI accept
 * `brain-candidates approve abc123` even when the full ID is 12 chars.
 * Returns null if no match or ambiguous.
 */
export function resolveCandidateId(store: CandidateStore, prefix: string): string | null {
  if (store.candidates[prefix]) return prefix;
  const matches = Object.keys(store.candidates).filter((id) => id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  return null;
}

export interface ApproveResult {
  record: CandidateRecord;
  finalText: string;
}

/**
 * Mark a candidate as approved and return the final directive text to write
 * to MEMORY.md. If `editedText` is provided, it supersedes the original.
 * The actual MEMORY.md write is the caller's responsibility — this function
 * only mutates the candidate record.
 */
export function approveCandidate(
  store: CandidateStore,
  id: string,
  editedText?: string
): ApproveResult | null {
  const record = store.candidates[id];
  if (!record) return null;
  if (record.status !== "pending") return null;

  const finalText = (editedText ?? record.text).trim();
  if (finalText.length === 0) return null;

  record.status = "approved";
  record.finalText = finalText;
  record.reviewedAt = new Date().toISOString();
  return { record, finalText };
}

export function rejectCandidate(store: CandidateStore, id: string): CandidateRecord | null {
  const record = store.candidates[id];
  if (!record) return null;
  if (record.status !== "pending") return null;

  record.status = "rejected";
  record.reviewedAt = new Date().toISOString();
  return record;
}

/**
 * Get the pending candidate count. Used by the hook CLI to report
 * "N pending candidates awaiting review" without loading the full list.
 */
export function pendingCount(store: CandidateStore): number {
  return Object.values(store.candidates).filter((c) => c.status === "pending").length;
}
