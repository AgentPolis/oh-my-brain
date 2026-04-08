#!/usr/bin/env node
/**
 * brain-candidates — review queue CLI for Memory Candidates.
 *
 * This is the human-in-the-loop half of the two-stage capture model.
 * Soft-signal candidates detected during compress runs accumulate in
 * `.squeeze/candidates.json`. Use this CLI to approve them (promote to
 * MEMORY.md as real directives), reject them (never surface again), or
 * list what's pending.
 *
 * Commands:
 *   brain-candidates list                  # show pending candidates
 *   brain-candidates list --all            # show all (incl. approved/rejected)
 *   brain-candidates approve <id>          # promote to MEMORY.md as-is
 *   brain-candidates approve <id> --as "..." # edit then promote
 *   brain-candidates reject <id>           # dismiss; won't be re-flagged
 *   brain-candidates status                # summary counts
 *
 * All commands operate on the current working directory's project root.
 */

import {
  CandidateRecord,
  listCandidates,
  loadCandidateStore,
  pendingCount,
  resolveCandidateId,
} from "./candidates.js";
import {
  applyApproveType,
  applyPromoteCandidate,
  applyRejectCandidate,
  applyRejectType,
  applyRetireDirective,
  loadActionLog,
  undoLastAction,
  whyDirective,
} from "./actions.js";
import {
  listTypeCandidates,
  loadAllTypes,
  loadTypeCandidates,
  resolveTypeCandidateId,
  type TypeCandidateRecord,
} from "./types-store.js";
import { isDirectEntry } from "./is-main.js";

const HELP_TEXT = `brain-candidates — Memory Candidates review queue

Directive review:
  brain-candidates                     show pending directive candidates
  brain-candidates list [--all]        list pending (or all) candidates
  brain-candidates approve <id>        approve and write to MEMORY.md
  brain-candidates approve <id> --as "..."   approve with edited text
  brain-candidates reject <id>         mark as rejected (won't be re-flagged)
  brain-candidates retire "<text>"     retire an existing MEMORY.md directive

Type review (self-growing ontology):
  brain-candidates types               list current Directive Types (built-in + user)
  brain-candidates list-types [--all]  list pending (or all) type candidates
  brain-candidates approve-type <id>   approve a new Directive Type
  brain-candidates approve-type <id> --as "TypeName"
  brain-candidates reject-type <id>    reject a proposed type

History:
  brain-candidates status              show counts by status
  brain-candidates undo                reverse the most recent mutation
  brain-candidates why "<text>"        trace how a directive came to exist
  brain-candidates log [--limit N]     show recent actions from the log
  brain-candidates --help              this message

Candidate IDs are content hashes; you can use any unique prefix.

Every approve / reject / retire is a typed Action with full provenance.
The action log lives at .squeeze/actions.jsonl. Use 'undo' to reverse
the latest action and 'why' to trace the chain that produced a directive.

Type candidates are auto-proposed when 3+ uncategorized directives share
a recognizable keyword cluster. Approving a candidate adds a new
Directive Type to .squeeze/types.json that future directives will be
classified against.
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
    "Review commands: brain-candidates approve <id> | reject <id>\n"
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
      `No pending candidate matches id "${idPrefix}". Run 'brain-candidates list' to see available IDs.\n`
    );
    return 1;
  }

  const action = applyPromoteCandidate(
    { projectRoot, source: "cli" },
    { candidateId: fullId, finalText: editedText }
  );
  if (!action) {
    process.stderr.write(
      `Candidate ${fullId} is not pending (already approved or rejected).\n`
    );
    return 1;
  }

  if (action.payload.written) {
    process.stdout.write(`✓ Approved ${fullId.slice(0, 8)} → MEMORY.md\n`);
    process.stdout.write(`  ${action.payload.finalText}\n`);
  } else {
    process.stdout.write(
      `✓ Approved ${fullId.slice(0, 8)} (already present in MEMORY.md, no duplicate written)\n`
    );
  }
  process.stdout.write(`  action: ${action.id}\n`);
  return 0;
}

function cmdReject(projectRoot: string, idPrefix: string): number {
  const store = loadCandidateStore(projectRoot);
  const fullId = resolveCandidateId(store, idPrefix);
  if (!fullId) {
    process.stderr.write(
      `No pending candidate matches id "${idPrefix}". Run 'brain-candidates list' to see available IDs.\n`
    );
    return 1;
  }

  const action = applyRejectCandidate({ projectRoot, source: "cli" }, fullId);
  if (!action) {
    process.stderr.write(
      `Candidate ${fullId} is not pending (already approved or rejected).\n`
    );
    return 1;
  }

  process.stdout.write(`✗ Rejected ${fullId.slice(0, 8)}\n`);
  process.stdout.write(`  ${action.payload.text}\n`);
  process.stdout.write(`  action: ${action.id}\n`);
  return 0;
}

function cmdRetire(projectRoot: string, matchText: string): number {
  const action = applyRetireDirective(
    { projectRoot, source: "cli" },
    matchText
  );
  if (action.payload.retiredCount === 0) {
    process.stderr.write(
      `No active directive matched "${matchText}". Check MEMORY.md for the exact text.\n`
    );
    return 1;
  }
  process.stdout.write(
    `✓ Retired ${action.payload.retiredCount} directive${action.payload.retiredCount === 1 ? "" : "s"} matching "${matchText}"\n`
  );
  process.stdout.write(
    `  Moved to the archive section of MEMORY.md. Bootstrap-read consumers will ignore them.\n`
  );
  process.stdout.write(`  action: ${action.id}\n`);
  return 0;
}

function cmdUndo(projectRoot: string): number {
  const result = undoLastAction({ projectRoot, source: "cli" });
  if (!result) {
    process.stdout.write("Nothing to undo.\n");
    return 0;
  }
  process.stdout.write(
    `↩ Undid ${result.undone.kind} (${result.undone.id})\n`
  );
  process.stdout.write(`  ${result.notes}\n`);
  return 0;
}

function cmdWhy(projectRoot: string, query: string): number {
  const result = whyDirective(projectRoot, query);
  process.stdout.write(`${result.summary}\n`);
  if (result.matches.length === 0) return 0;

  process.stdout.write("\nAction chain:\n");
  for (const action of result.matches) {
    const ts = action.timestamp.replace("T", " ").slice(0, 19);
    process.stdout.write(`  ${ts}  [${action.source}]  ${action.kind}  ${action.id}\n`);
    switch (action.kind) {
      case "RememberDirective":
        process.stdout.write(`      → "${action.payload.finalText}"\n`);
        break;
      case "PromoteCandidate":
        process.stdout.write(
          `      candidate ${action.payload.candidateId.slice(0, 8)} → "${action.payload.finalText}"\n`
        );
        if (action.payload.originalText !== action.payload.finalText) {
          process.stdout.write(
            `      (edited from: "${action.payload.originalText}")\n`
          );
        }
        break;
      case "RejectCandidate":
        process.stdout.write(
          `      candidate ${action.payload.candidateId.slice(0, 8)} text: "${action.payload.text}"\n`
        );
        break;
      case "RetireDirective":
        process.stdout.write(
          `      retired ${action.payload.retiredCount} matching "${action.payload.matchText}"\n`
        );
        break;
      case "UndoAction":
        process.stdout.write(`      ${action.payload.notes}\n`);
        break;
    }
  }
  return 0;
}

function cmdLog(projectRoot: string, limit: number): number {
  const log = loadActionLog(projectRoot);
  if (log.length === 0) {
    process.stdout.write("No actions recorded yet.\n");
    return 0;
  }
  const recent = log.slice(-limit).reverse();
  process.stdout.write(
    `${recent.length} most recent action(s) (of ${log.length} total):\n\n`
  );
  for (const action of recent) {
    const ts = action.timestamp.replace("T", " ").slice(0, 19);
    process.stdout.write(`  ${ts}  [${action.source}]  ${action.kind}  ${action.id}\n`);
  }
  return 0;
}

// ── Type management commands ─────────────────────────────────────

function formatTypeCandidate(c: TypeCandidateRecord): string {
  const shortId = c.id.slice(0, 10);
  const statusTag = c.status === "pending" ? "" : ` [${c.status.toUpperCase()}]`;
  const examples = c.exampleDirectives
    .slice(0, 3)
    .map((e) => `      • ${e}`)
    .join("\n");
  return [
    `  ${shortId}${statusTag}  ${c.proposedName}`,
    `    keywords: ${c.derivedKeywords.join(", ")}`,
    `    examples (${c.exampleDirectives.length}):`,
    examples,
  ].join("\n");
}

function cmdShowTypes(projectRoot: string): number {
  const types = loadAllTypes(projectRoot);
  if (types.length === 0) {
    process.stdout.write("No directive types defined.\n");
    return 0;
  }
  process.stdout.write(`${types.length} Directive Type(s):\n\n`);
  for (const t of types) {
    process.stdout.write(`  ${t.id}  [${t.origin}]\n`);
    process.stdout.write(`    ${t.description}\n\n`);
  }
  return 0;
}

function cmdListTypeCandidates(projectRoot: string, showAll: boolean): number {
  const store = loadTypeCandidates(projectRoot);
  const records = showAll
    ? listTypeCandidates(store)
    : listTypeCandidates(store, { status: "pending" });

  if (records.length === 0) {
    process.stdout.write(
      showAll
        ? "No type candidates found.\n"
        : "No pending type candidates. Nothing to review.\n"
    );
    return 0;
  }

  process.stdout.write(
    `${records.length} ${showAll ? "total" : "pending"} type candidate(s):\n\n`
  );
  for (const record of records) {
    process.stdout.write(`${formatTypeCandidate(record)}\n\n`);
  }
  process.stdout.write(
    "Review commands: brain-candidates approve-type <id> [--as \"Name\"] | reject-type <id>\n"
  );
  return 0;
}

function cmdApproveType(
  projectRoot: string,
  idPrefix: string,
  finalName: string | undefined
): number {
  const store = loadTypeCandidates(projectRoot);
  const fullId = resolveTypeCandidateId(store, idPrefix);
  if (!fullId) {
    process.stderr.write(
      `No pending type candidate matches id "${idPrefix}". Run 'brain-candidates list-types' to see available IDs.\n`
    );
    return 1;
  }

  const action = applyApproveType(
    { projectRoot, source: "cli" },
    { typeCandidateId: fullId, finalName }
  );
  if (!action) {
    process.stderr.write(
      `Type candidate ${fullId} is not pending (already approved or rejected).\n`
    );
    return 1;
  }

  process.stdout.write(`✓ Approved type ${fullId.slice(0, 10)}\n`);
  process.stdout.write(`  → New Directive Type: "${action.payload.finalName}"\n`);
  process.stdout.write(`  description: ${action.payload.description}\n`);
  process.stdout.write(`  patterns: ${action.payload.matchPatterns.length}\n`);
  process.stdout.write(`  action: ${action.id}\n`);
  return 0;
}

function cmdRejectType(projectRoot: string, idPrefix: string): number {
  const store = loadTypeCandidates(projectRoot);
  const fullId = resolveTypeCandidateId(store, idPrefix);
  if (!fullId) {
    process.stderr.write(
      `No pending type candidate matches id "${idPrefix}". Run 'brain-candidates list-types' to see available IDs.\n`
    );
    return 1;
  }

  const action = applyRejectType({ projectRoot, source: "cli" }, fullId);
  if (!action) {
    process.stderr.write(
      `Type candidate ${fullId} is not pending (already approved or rejected).\n`
    );
    return 1;
  }

  process.stdout.write(`✗ Rejected type ${fullId.slice(0, 10)}\n`);
  process.stdout.write(`  ${action.payload.proposedName}\n`);
  process.stdout.write(`  action: ${action.id}\n`);
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
      process.stderr.write("Usage: brain-candidates approve <id> [--as \"text\"]\n");
      return 1;
    }
    return cmdApprove(projectRoot, id, parseEditFlag(args));
  }

  if (cmd === "reject") {
    const id = args[1];
    if (!id) {
      process.stderr.write("Usage: brain-candidates reject <id>\n");
      return 1;
    }
    return cmdReject(projectRoot, id);
  }

  if (cmd === "retire") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      process.stderr.write('Usage: brain-candidates retire "<text prefix>"\n');
      return 1;
    }
    return cmdRetire(projectRoot, text);
  }

  if (cmd === "undo") {
    return cmdUndo(projectRoot);
  }

  if (cmd === "why") {
    const text = args.slice(1).join(" ").trim();
    if (!text) {
      process.stderr.write('Usage: brain-candidates why "<directive text>"\n');
      return 1;
    }
    return cmdWhy(projectRoot, text);
  }

  if (cmd === "log") {
    const limitIdx = args.indexOf("--limit");
    const limit =
      limitIdx !== -1 && limitIdx < args.length - 1
        ? Math.max(1, Number(args[limitIdx + 1]) || 10)
        : 10;
    return cmdLog(projectRoot, limit);
  }

  if (cmd === "types") {
    return cmdShowTypes(projectRoot);
  }

  if (cmd === "list-types") {
    return cmdListTypeCandidates(projectRoot, args.includes("--all"));
  }

  if (cmd === "approve-type") {
    const id = args[1];
    if (!id) {
      process.stderr.write(
        'Usage: brain-candidates approve-type <id> [--as "TypeName"]\n'
      );
      return 1;
    }
    return cmdApproveType(projectRoot, id, parseEditFlag(args));
  }

  if (cmd === "reject-type") {
    const id = args[1];
    if (!id) {
      process.stderr.write("Usage: brain-candidates reject-type <id>\n");
      return 1;
    }
    return cmdRejectType(projectRoot, id);
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP_TEXT}`);
  return 1;
}

// Only execute when run as a script (not when imported for testing).
if (isDirectEntry(["candidates-cli.js", "brain-candidates"])) {
  const exitCode = runCandidatesCli(process.argv, process.cwd());
  process.exit(exitCode);
}
