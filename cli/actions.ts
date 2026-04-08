/**
 * Memory Actions — typed mutations with provenance + undo.
 *
 * This is the load-bearing primitive that turns oh-my-brain from a
 * "memory layer" into a personal world model in the Palantir Foundry
 * sense. Every mutation to MEMORY.md goes through an Action; every
 * Action is logged; every Action is reversible.
 *
 * Why it exists:
 *   v0.2 had four independent mutation paths (appendDirectivesToMemory,
 *   retireDirective, approveCandidate, rejectCandidate). They worked
 *   correctly but they were untracked string edits — there was no way
 *   to ask "why do you remember this about me" or "undo what just
 *   happened" without manually grep-ing MEMORY.md.
 *
 *   The Palantir ontology lesson is that the *only* sanctioned way to
 *   mutate the world should be through declared, typed Actions. The
 *   Action carries permission semantics, validation, an audit trail,
 *   and (critically) enough state to reverse itself. v0.3 makes this
 *   the canonical path.
 *
 * Design notes:
 *
 * - Append-only log at `.squeeze/actions.jsonl`. One Action per line.
 *   The .squeeze/ directory name is preserved from v0.2 to avoid
 *   orphaning existing user data; the path is implementation detail.
 *
 * - Each Action carries enough `prevState` to be reversed. For a
 *   `RememberDirective`, that's the state of MEMORY.md before the
 *   write. For a `RetireDirective`, that's the lines that moved to
 *   the archive. For a `PromoteCandidate`, that's both the candidate's
 *   prior status AND the MEMORY.md prevState.
 *
 * - Undo doesn't delete the original Action. It appends an `UndoAction`
 *   that records what was reversed. This preserves the full history
 *   for `brain_why` queries.
 *
 * - `brain_why(directive)` searches the log for any Action whose
 *   payload mentions the directive text. Returns the chain in
 *   chronological order so the user can trace exactly how a memory
 *   came to exist.
 *
 * - All Action mutations to MEMORY.md still go through the existing
 *   write lock in compress-core.ts. Actions sit *above* the lock, not
 *   in place of it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import {
  appendDirectivesToMemory,
  retireDirective,
  type WriteMetadata,
} from "./compress-core.js";
import {
  approveCandidate,
  loadCandidateStore,
  rejectCandidate,
  saveCandidateStore,
  type CandidateStore,
} from "./candidates.js";
import {
  approveTypeCandidate,
  loadTypeCandidates,
  loadUserTypes,
  rejectTypeCandidate,
  saveTypeCandidates,
  saveUserTypes,
  type DirectiveTypeSchema,
} from "./types-store.js";

// ── Action types ─────────────────────────────────────────────────

export type ActionKind =
  | "RememberDirective"
  | "PromoteCandidate"
  | "RejectCandidate"
  | "RetireDirective"
  | "ApproveType"
  | "RejectType"
  | "UndoAction";

export interface ActionBase {
  id: string;
  kind: ActionKind;
  timestamp: string;
  source: string;
  sessionId?: string;
}

export interface RememberDirectiveAction extends ActionBase {
  kind: "RememberDirective";
  payload: {
    text: string;
    finalText: string;
    written: boolean;
    memoryPathSnapshot: string | null;
  };
}

export interface PromoteCandidateAction extends ActionBase {
  kind: "PromoteCandidate";
  payload: {
    candidateId: string;
    originalText: string;
    finalText: string;
    written: boolean;
    memoryPathSnapshot: string | null;
    candidatePrevStatus: "pending";
  };
}

export interface RejectCandidateAction extends ActionBase {
  kind: "RejectCandidate";
  payload: {
    candidateId: string;
    text: string;
    candidatePrevStatus: "pending";
  };
}

export interface RetireDirectiveAction extends ActionBase {
  kind: "RetireDirective";
  payload: {
    matchText: string;
    retiredCount: number;
    memoryPathSnapshot: string | null;
  };
}

export interface ApproveTypeAction extends ActionBase {
  kind: "ApproveType";
  payload: {
    typeCandidateId: string;
    proposedName: string;
    finalName: string;
    description: string;
    matchPatterns: string[];
    /** Snapshot of the user-types file before this action ran. Used for undo. */
    userTypesSnapshot: DirectiveTypeSchema[];
  };
}

export interface RejectTypeAction extends ActionBase {
  kind: "RejectType";
  payload: {
    typeCandidateId: string;
    proposedName: string;
  };
}

export interface UndoActionRecord extends ActionBase {
  kind: "UndoAction";
  payload: {
    undidActionId: string;
    undidKind: ActionKind;
    notes: string;
  };
}

export type Action =
  | RememberDirectiveAction
  | PromoteCandidateAction
  | RejectCandidateAction
  | RetireDirectiveAction
  | ApproveTypeAction
  | RejectTypeAction
  | UndoActionRecord;

// ── Storage ──────────────────────────────────────────────────────

function actionsLogPath(projectRoot: string): string {
  return join(projectRoot, ".squeeze", "actions.jsonl");
}

function memoryPath(projectRoot: string): string {
  return join(projectRoot, "MEMORY.md");
}

function generateActionId(): string {
  // ULID-ish: timestamp + 8 random hex chars. Sortable, unique enough
  // for a single user, no external dep.
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `act_${ts}_${rand}`;
}

function snapshotMemory(projectRoot: string): string | null {
  const path = memoryPath(projectRoot);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function appendActionToLog(projectRoot: string, action: Action): void {
  const dir = join(projectRoot, ".squeeze");
  mkdirSync(dir, { recursive: true });
  appendFileSync(actionsLogPath(projectRoot), JSON.stringify(action) + "\n");
}

export function loadActionLog(projectRoot: string): Action[] {
  const path = actionsLogPath(projectRoot);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const actions: Action[] = [];
  for (const line of lines) {
    try {
      actions.push(JSON.parse(line) as Action);
    } catch {
      // Tolerate corrupted lines — never let a bad log line crash
      // the brain. Bad lines are logged to stderr by callers if needed.
    }
  }
  return actions;
}

// ── Action constructors + dispatchers ────────────────────────────

export interface ActionContext {
  projectRoot: string;
  source?: string;
  sessionId?: string;
}

export interface RememberInput {
  text: string;
  finalText?: string;
}

export function applyRememberDirective(
  ctx: ActionContext,
  input: RememberInput
): RememberDirectiveAction {
  const finalText = (input.finalText ?? input.text).trim();
  const memoryPathSnapshot = snapshotMemory(ctx.projectRoot);

  const meta: WriteMetadata = {
    source: (ctx.source as "claude" | "codex") ?? "claude",
    sessionId: ctx.sessionId,
  };

  const written = appendDirectivesToMemory(
    [finalText],
    memoryPath(ctx.projectRoot),
    meta
  );

  const action: RememberDirectiveAction = {
    id: generateActionId(),
    kind: "RememberDirective",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      text: input.text,
      finalText,
      written: written > 0,
      memoryPathSnapshot,
    },
  };
  appendActionToLog(ctx.projectRoot, action);
  return action;
}

export interface PromoteInput {
  candidateId: string;
  finalText?: string;
}

export function applyPromoteCandidate(
  ctx: ActionContext,
  input: PromoteInput
): PromoteCandidateAction | null {
  const store = loadCandidateStore(ctx.projectRoot);
  const record = store.candidates[input.candidateId];
  if (!record || record.status !== "pending") return null;

  const memoryPathSnapshot = snapshotMemory(ctx.projectRoot);
  const result = approveCandidate(store, input.candidateId, input.finalText);
  if (!result) return null;

  const meta: WriteMetadata = {
    source:
      record.source === "unknown"
        ? ((ctx.source as "claude" | "codex") ?? "claude")
        : (record.source as "claude" | "codex"),
    sessionId: record.sessionId ?? ctx.sessionId,
  };

  const written = appendDirectivesToMemory(
    [result.finalText],
    memoryPath(ctx.projectRoot),
    meta
  );

  saveCandidateStore(ctx.projectRoot, store);

  const action: PromoteCandidateAction = {
    id: generateActionId(),
    kind: "PromoteCandidate",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      candidateId: input.candidateId,
      originalText: record.text,
      finalText: result.finalText,
      written: written > 0,
      memoryPathSnapshot,
      candidatePrevStatus: "pending",
    },
  };
  appendActionToLog(ctx.projectRoot, action);
  return action;
}

export function applyRejectCandidate(
  ctx: ActionContext,
  candidateId: string
): RejectCandidateAction | null {
  const store = loadCandidateStore(ctx.projectRoot);
  const record = store.candidates[candidateId];
  if (!record || record.status !== "pending") return null;

  rejectCandidate(store, candidateId);
  saveCandidateStore(ctx.projectRoot, store);

  const action: RejectCandidateAction = {
    id: generateActionId(),
    kind: "RejectCandidate",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      candidateId,
      text: record.text,
      candidatePrevStatus: "pending",
    },
  };
  appendActionToLog(ctx.projectRoot, action);
  return action;
}

export interface ApproveTypeInput {
  typeCandidateId: string;
  finalName?: string;
  finalDescription?: string;
}

export function applyApproveType(
  ctx: ActionContext,
  input: ApproveTypeInput
): ApproveTypeAction | null {
  const store = loadTypeCandidates(ctx.projectRoot);
  const userTypesSnapshot = loadUserTypes(ctx.projectRoot);

  const result = approveTypeCandidate(
    store,
    input.typeCandidateId,
    input.finalName,
    input.finalDescription
  );
  if (!result) return null;

  // Append the new type to the user-types registry and persist both files.
  const newUserTypes = [...userTypesSnapshot, result.newType];
  saveUserTypes(ctx.projectRoot, newUserTypes);
  saveTypeCandidates(ctx.projectRoot, store);

  const action: ApproveTypeAction = {
    id: generateActionId(),
    kind: "ApproveType",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      typeCandidateId: input.typeCandidateId,
      proposedName: result.candidate.proposedName,
      finalName: result.newType.name,
      description: result.newType.description,
      matchPatterns: result.newType.matchPatterns,
      userTypesSnapshot,
    },
  };
  appendActionToLog(ctx.projectRoot, action);
  return action;
}

export function applyRejectType(
  ctx: ActionContext,
  typeCandidateId: string
): RejectTypeAction | null {
  const store = loadTypeCandidates(ctx.projectRoot);
  const result = rejectTypeCandidate(store, typeCandidateId);
  if (!result) return null;
  saveTypeCandidates(ctx.projectRoot, store);

  const action: RejectTypeAction = {
    id: generateActionId(),
    kind: "RejectType",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      typeCandidateId,
      proposedName: result.proposedName,
    },
  };
  appendActionToLog(ctx.projectRoot, action);
  return action;
}

export function applyRetireDirective(
  ctx: ActionContext,
  matchText: string
): RetireDirectiveAction {
  const memoryPathSnapshot = snapshotMemory(ctx.projectRoot);
  const retiredCount = retireDirective(memoryPath(ctx.projectRoot), matchText);

  const action: RetireDirectiveAction = {
    id: generateActionId(),
    kind: "RetireDirective",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      matchText,
      retiredCount,
      memoryPathSnapshot,
    },
  };
  appendActionToLog(ctx.projectRoot, action);
  return action;
}

// ── Undo ─────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "fs";

function restoreMemory(projectRoot: string, snapshot: string | null): void {
  const path = memoryPath(projectRoot);
  if (snapshot === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  // Write atomically to avoid partial state during the swap.
  const tmp = path + ".tmp";
  writeFileSync(tmp, snapshot);
  // Use rename to swap atomically. fs.renameSync handles overwrite on
  // POSIX, which is what we need.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { renameSync } = require("fs") as typeof import("fs");
  renameSync(tmp, path);
}

function restoreCandidateToPending(
  store: CandidateStore,
  candidateId: string
): boolean {
  const record = store.candidates[candidateId];
  if (!record) return false;
  if (record.status === "pending") return false;
  record.status = "pending";
  delete record.reviewedAt;
  delete record.finalText;
  return true;
}

export interface UndoResult {
  undone: Action;
  notes: string;
}

/**
 * Reverse the most recent non-Undo Action.
 *
 * Walks the action log from the end, finds the latest Action that has
 * not already been undone, and applies the inverse of its effect. The
 * UndoAction itself is appended to the log so future undo calls don't
 * try to reverse it again.
 *
 * Returns null if there is nothing to undo.
 */
export function undoLastAction(ctx: ActionContext): UndoResult | null {
  const log = loadActionLog(ctx.projectRoot);
  if (log.length === 0) return null;

  // Build the set of action ids that have already been undone, so we
  // can skip them.
  const alreadyUndone = new Set<string>();
  for (const a of log) {
    if (a.kind === "UndoAction") {
      alreadyUndone.add(a.payload.undidActionId);
    }
  }

  // Find the latest reversible action that hasn't been undone yet.
  let target: Action | null = null;
  for (let i = log.length - 1; i >= 0; i--) {
    const a = log[i];
    if (a.kind === "UndoAction") continue;
    if (alreadyUndone.has(a.id)) continue;
    target = a;
    break;
  }
  if (!target) return null;

  let notes = "";
  switch (target.kind) {
    case "RememberDirective":
      restoreMemory(ctx.projectRoot, target.payload.memoryPathSnapshot);
      notes = `removed directive "${target.payload.finalText}" from MEMORY.md`;
      break;
    case "PromoteCandidate": {
      restoreMemory(ctx.projectRoot, target.payload.memoryPathSnapshot);
      const store = loadCandidateStore(ctx.projectRoot);
      restoreCandidateToPending(store, target.payload.candidateId);
      saveCandidateStore(ctx.projectRoot, store);
      notes = `removed promoted candidate "${target.payload.finalText}" from MEMORY.md and reverted candidate to pending`;
      break;
    }
    case "RejectCandidate": {
      const store = loadCandidateStore(ctx.projectRoot);
      restoreCandidateToPending(store, target.payload.candidateId);
      saveCandidateStore(ctx.projectRoot, store);
      notes = `restored rejected candidate "${target.payload.text}" to pending`;
      break;
    }
    case "RetireDirective":
      restoreMemory(ctx.projectRoot, target.payload.memoryPathSnapshot);
      notes = `restored ${target.payload.retiredCount} directive(s) matching "${target.payload.matchText}" from archive`;
      break;
    case "ApproveType": {
      // Roll back: restore the prior user-types file AND mark the
      // type candidate back to pending so it shows up for review again.
      saveUserTypes(ctx.projectRoot, target.payload.userTypesSnapshot);
      const tcStore = loadTypeCandidates(ctx.projectRoot);
      const candidate = tcStore.candidates[target.payload.typeCandidateId];
      if (candidate) {
        candidate.status = "pending";
        delete candidate.reviewedAt;
        delete candidate.finalName;
      }
      saveTypeCandidates(ctx.projectRoot, tcStore);
      notes = `removed user type "${target.payload.finalName}" and restored type candidate to pending`;
      break;
    }
    case "RejectType": {
      const tcStore = loadTypeCandidates(ctx.projectRoot);
      const candidate = tcStore.candidates[target.payload.typeCandidateId];
      if (candidate && candidate.status === "rejected") {
        candidate.status = "pending";
        delete candidate.reviewedAt;
      }
      saveTypeCandidates(ctx.projectRoot, tcStore);
      notes = `restored rejected type candidate "${target.payload.proposedName}" to pending`;
      break;
    }
    default:
      return null;
  }

  const undo: UndoActionRecord = {
    id: generateActionId(),
    kind: "UndoAction",
    timestamp: new Date().toISOString(),
    source: ctx.source ?? "unknown",
    sessionId: ctx.sessionId,
    payload: {
      undidActionId: target.id,
      undidKind: target.kind,
      notes,
    },
  };
  appendActionToLog(ctx.projectRoot, undo);
  return { undone: target, notes };
}

// ── Provenance query: brain_why ──────────────────────────────────

export interface WhyResult {
  query: string;
  matches: Action[];
  summary: string;
}

/**
 * Trace how a directive came to exist by searching the action log
 * for any Action whose payload references the directive text.
 *
 * Match strategy is case-insensitive substring on the relevant text
 * fields per kind. Returns matches in chronological order so the user
 * can read the history forward.
 */
export function whyDirective(
  projectRoot: string,
  directiveText: string
): WhyResult {
  const needle = directiveText.trim().toLowerCase();
  const log = loadActionLog(projectRoot);
  const matches: Action[] = [];

  for (const action of log) {
    let hit = false;
    switch (action.kind) {
      case "RememberDirective":
        hit =
          action.payload.text.toLowerCase().includes(needle) ||
          action.payload.finalText.toLowerCase().includes(needle);
        break;
      case "PromoteCandidate":
        hit =
          action.payload.originalText.toLowerCase().includes(needle) ||
          action.payload.finalText.toLowerCase().includes(needle);
        break;
      case "RejectCandidate":
        hit = action.payload.text.toLowerCase().includes(needle);
        break;
      case "RetireDirective":
        hit = action.payload.matchText.toLowerCase().includes(needle);
        break;
      case "ApproveType":
        hit =
          action.payload.finalName.toLowerCase().includes(needle) ||
          action.payload.proposedName.toLowerCase().includes(needle);
        break;
      case "RejectType":
        hit = action.payload.proposedName.toLowerCase().includes(needle);
        break;
      case "UndoAction":
        hit = action.payload.notes.toLowerCase().includes(needle);
        break;
    }
    if (hit) matches.push(action);
  }

  const summary =
    matches.length === 0
      ? `No actions found matching "${directiveText}".`
      : `Found ${matches.length} action(s) referencing "${directiveText}". Earliest: ${matches[0].timestamp} (${matches[0].kind}). Latest: ${matches[matches.length - 1].timestamp} (${matches[matches.length - 1].kind}).`;

  return { query: directiveText, matches, summary };
}
