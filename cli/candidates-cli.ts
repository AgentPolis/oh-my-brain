#!/usr/bin/env node
/**
 * squeeze-candidates — review queue CLI for Memory Candidates.
 *
 * This is the human-in-the-loop half of the two-stage capture model.
 * Soft-signal candidates detected during compress runs accumulate in
 * `.squeeze/candidates.json`. Use this CLI to approve them (promote to
 * MEMORY.md as real directives), reject them (never surface again), or
 * list what's pending.
 *
 * Commands:
 *   squeeze-candidates list                  # show pending candidates
 *   squeeze-candidates list --all            # show all (incl. approved/rejected)
 *   squeeze-candidates approve <id>          # promote to MEMORY.md as-is
 *   squeeze-candidates approve <id> --as "..." # edit then promote
 *   squeeze-candidates reject <id>           # dismiss; won't be re-flagged
 *   squeeze-candidates status                # summary counts
 *
 * All commands operate on the current working directory's project root.
 */

import { join } from "path";
import { appendDirectivesToMemory, retireDirective } from "./compress-core.js";
import {
  approveCandidate,
  CandidateRecord,
  listCandidates,
  loadCandidateStore,
  pendingCount,
  rejectCandidate,
  resolveCandidateId,
  saveCandidateStore,
} from "./candidates.js";

const HELP_TEXT = `squeeze-candidates — Memory Candidates review queue

Usage:
  squeeze-candidates                     show pending candidates (alias for 'list')
  squeeze-candidates list [--all]        list pending (or all) candidates
  squeeze-candidates approve <id>        approve and write to MEMORY.md
  squeeze-candidates approve <id> --as "..."   approve with edited text
  squeeze-candidates reject <id>         mark as rejected (won't be re-flagged)
  squeeze-candidates retire "<text>"     retire an existing MEMORY.md directive
                                         (moves it to the archive section)
  squeeze-candidates status              show counts by status
  squeeze-candidates --help              this message

Candidate IDs are content hashes; you can use any unique prefix.
`;

function formatCandidate(c: CandidateRecord): string {
  const shortId = c.id.slice(0, 8);
  const ageDays = Math.floor(
    (Date.now() - new Date(c.firstSeenAt).getTime()) / (1000 * 60 * 60 * 24)
  );
  const seenInfo = c.mentionCount > 1 ? ` [seen ${c.mentionCount}x]` : "";
  const ageInfo = ageDays > 0 ? ` [${ageDays}d old]` : "";
  const statusTag = c.status === "pending" ? "" : ` [${c.status.toUpperCase()}]`;
  const sourceTag = ` (${c.source}${c.sessionId ? ` ${c.sessionId.slice(0, 8)}` : ""})`;
  return `  ${shortId}${statusTag}${sourceTag}${seenInfo}${ageInfo}\n    ${c.text}`;
}

function cmdList(projectRoot: string, showAll: boolean): number {
  const store = loadCandidateStore(projectRoot);
  const records = showAll
    ? listCandidates(store)
    : listCandidates(store, { status: "pending" });

  if (records.length === 0) {
    process.stdout.write(
      showAll
        ? "No memory candidates found yet.\n"
        : "No pending memory candidates. Nothing to review.\n"
    );
    return 0;
  }

  process.stdout.write(
    `${records.length} ${showAll ? "total" : "pending"} candidate${records.length === 1 ? "" : "s"}:\n\n`
  );
  for (const record of records) {
    process.stdout.write(`${formatCandidate(record)}\n\n`);
  }
  process.stdout.write(
    "Review commands: squeeze-candidates approve <id> | reject <id>\n"
  );
  return 0;
}

function cmdApprove(
  projectRoot: string,
  idPrefix: string,
  editedText: string | undefined
): number {
  const store = loadCandidateStore(projectRoot);
  const fullId = resolveCandidateId(store, idPrefix);
  if (!fullId) {
    process.stderr.write(
      `No pending candidate matches id "${idPrefix}". Run 'squeeze-candidates list' to see available IDs.\n`
    );
    return 1;
  }

  const result = approveCandidate(store, fullId, editedText);
  if (!result) {
    process.stderr.write(
      `Candidate ${fullId} is not pending (already approved or rejected).\n`
    );
    return 1;
  }

  const memoryPath = join(projectRoot, "MEMORY.md");
  const written = appendDirectivesToMemory([result.finalText], memoryPath, {
    source: result.record.source === "unknown" ? "claude" : result.record.source,
    sessionId: result.record.sessionId,
  });

  saveCandidateStore(projectRoot, store);

  if (written > 0) {
    process.stdout.write(`✓ Approved ${fullId.slice(0, 8)} → MEMORY.md\n`);
    process.stdout.write(`  ${result.finalText}\n`);
  } else {
    process.stdout.write(
      `✓ Approved ${fullId.slice(0, 8)} (already present in MEMORY.md, no duplicate written)\n`
    );
  }
  return 0;
}

function cmdReject(projectRoot: string, idPrefix: string): number {
  const store = loadCandidateStore(projectRoot);
  const fullId = resolveCandidateId(store, idPrefix);
  if (!fullId) {
    process.stderr.write(
      `No pending candidate matches id "${idPrefix}". Run 'squeeze-candidates list' to see available IDs.\n`
    );
    return 1;
  }

  const record = rejectCandidate(store, fullId);
  if (!record) {
    process.stderr.write(
      `Candidate ${fullId} is not pending (already approved or rejected).\n`
    );
    return 1;
  }

  saveCandidateStore(projectRoot, store);
  process.stdout.write(`✗ Rejected ${fullId.slice(0, 8)}\n`);
  process.stdout.write(`  ${record.text}\n`);
  return 0;
}

function cmdRetire(projectRoot: string, matchText: string): number {
  const memoryPath = join(projectRoot, "MEMORY.md");
  const retired = retireDirective(memoryPath, matchText);
  if (retired === 0) {
    process.stderr.write(
      `No active directive matched "${matchText}". Check MEMORY.md for the exact text.\n`
    );
    return 1;
  }
  process.stdout.write(
    `✓ Retired ${retired} directive${retired === 1 ? "" : "s"} matching "${matchText}"\n`
  );
  process.stdout.write(
    `  Moved to the archive section of MEMORY.md. Bootstrap-read consumers will ignore them.\n`
  );
  return 0;
}

function cmdStatus(projectRoot: string): number {
  const store = loadCandidateStore(projectRoot);
  const all = listCandidates(store);
  const pending = all.filter((c) => c.status === "pending").length;
  const approved = all.filter((c) => c.status === "approved").length;
  const rejected = all.filter((c) => c.status === "rejected").length;

  process.stdout.write(`Memory Candidates at ${projectRoot}\n`);
  process.stdout.write(`  pending:  ${pending}\n`);
  process.stdout.write(`  approved: ${approved}\n`);
  process.stdout.write(`  rejected: ${rejected}\n`);
  process.stdout.write(`  total:    ${all.length}\n`);
  return 0;
}

function parseEditFlag(args: string[]): string | undefined {
  const asIdx = args.indexOf("--as");
  if (asIdx === -1 || asIdx === args.length - 1) return undefined;
  return args[asIdx + 1];
}

export function runCandidatesCli(argv: string[], projectRoot: string): number {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const cmd = args[0] ?? "list";

  if (cmd === "list") {
    return cmdList(projectRoot, args.includes("--all"));
  }

  if (cmd === "status") {
    return cmdStatus(projectRoot);
  }

  if (cmd === "approve") {
    const id = args[1];
    if (!id) {
      process.stderr.write("Usage: squeeze-candidates approve <id> [--as \"text\"]\n");
      return 1;
    }
    return cmdApprove(projectRoot, id, parseEditFlag(args));
  }

  if (cmd === "reject") {
    const id = args[1];
    if (!id) {
      process.stderr.write("Usage: squeeze-candidates reject <id>\n");
      return 1;
    }
    return cmdReject(projectRoot, id);
  }

  if (cmd === "retire") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      process.stderr.write('Usage: squeeze-candidates retire "<text prefix>"\n');
      return 1;
    }
    return cmdRetire(projectRoot, text);
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP_TEXT}`);
  return 1;
}

// Only execute when run as a script (not when imported for testing).
if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = runCandidatesCli(process.argv, process.cwd());
  process.exit(exitCode);
}
