#!/usr/bin/env node
/**
 * oh-my-brain MCP server (minimal stdio JSON-RPC implementation).
 *
 * This exposes the core brain operations — remember, recall, directives,
 * status, retire — over the Model Context Protocol so any MCP-compatible
 * tool (Cursor, Windsurf, Claude Desktop, Gemini CLI) can read and write
 * to the same project brain without needing a bespoke adapter.
 *
 * Why a custom implementation instead of @modelcontextprotocol/sdk:
 * we want zero new dependencies for v0.2 so npm install stays fast and
 * offline-friendly. MCP is a documented JSON-RPC 2.0 protocol over stdio,
 * and the surface we need (initialize, tools/list, tools/call) is small
 * enough to implement honestly. This file can be swapped to the official
 * SDK in a later version without changing the tool shape seen by clients.
 *
 * Usage:
 *   oh-my-brain mcp                    # start the server (stdio transport)
 *   brain-mcp                          # equivalent standalone binary
 *
 * Wire it into a client by pointing at the binary:
 *   {
 *     "mcpServers": {
 *       "oh-my-brain": {
 *         "command": "brain-mcp",
 *         "args": [],
 *         "env": { "OH_MY_BRAIN_PROJECT_ROOT": "/path/to/project" }
 *       }
 *     }
 *   }
 *
 * Environment:
 *   OH_MY_BRAIN_PROJECT_ROOT  — project directory to read/write. Defaults
 *                                to process.cwd() at server start.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  ingestCandidates,
  listCandidates,
  loadCandidateStore,
  pendingCount,
  resolveCandidateId,
  saveCandidateStore,
} from "./candidates.js";
import {
  applyApproveLink,
  applyApproveType,
  applyPromoteCandidate,
  applyRejectCandidate,
  applyRejectLink,
  applyRejectType,
  applyRememberDirective,
  applyRetireDirective,
  loadActionLog,
  undoLastAction,
  whyDirective,
} from "./actions.js";
import {
  classifyDirective,
  listTypeCandidates,
  loadAllTypes,
  loadTypeCandidates,
  resolveTypeCandidateId,
} from "./types-store.js";
import {
  LINK_KINDS,
  type LinkKind,
  listLinkCandidates,
  loadLinkCandidates,
  loadLinks,
  resolveLinkCandidateId,
} from "./links-store.js";
import { isDirectEntry } from "./is-main.js";

const SERVER_NAME = "oh-my-brain";
const SERVER_VERSION = "0.3.0";
const PROTOCOL_VERSION = "2024-11-05";

// ── Tool definitions ────────────────────────────────────────────

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "brain_remember",
    description:
      "Remember a rule or directive permanently. Writes an L3 directive to " +
      "MEMORY.md so it survives every context reset, every agent switch, and " +
      "every compaction event. Use this for explicit 'always X' / 'never Y' " +
      "rules the user has committed to.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The directive text, phrased as a rule (e.g., 'Always use TypeScript strict mode').",
        },
        source: {
          type: "string",
          description:
            "Which agent is calling (claude, codex, cursor, etc.). Used for provenance in MEMORY.md.",
          enum: ["claude", "codex", "cursor", "windsurf", "copilot", "unknown"],
        },
        session_id: {
          type: "string",
          description: "Optional session identifier for provenance tracking.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "brain_recall",
    description:
      "Recall every active directive (L3) currently stored in the project " +
      "brain. Returns the raw MEMORY.md bullet bodies. Use this at the " +
      "start of a session to load the user's persistent rules.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brain_candidates",
    description:
      "List, approve, reject, or add Memory Candidates — the soft-signal " +
      "review queue. Soft signals are corrections, preferences, and friction " +
      "patterns that look important but aren't phrased as explicit rules. " +
      "The agent can enqueue observed soft signals (action=add) and the " +
      "human curates them via approve/reject.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "approve", "reject"],
          description: "What to do. Default: list.",
        },
        text: {
          type: "string",
          description: "Candidate text (required for action=add).",
        },
        id: {
          type: "string",
          description:
            "Candidate ID or prefix (required for action=approve or reject).",
        },
        final_text: {
          type: "string",
          description:
            "Optional edited text when approving (otherwise the original text is used).",
        },
      },
    },
  },
  {
    name: "brain_retire",
    description:
      "Retire a directive by moving it from the active section to the " +
      "archive section of MEMORY.md. Use this when the user pivots away " +
      "from a previous rule. Match is a case-insensitive substring of the " +
      "directive body.",
    inputSchema: {
      type: "object",
      properties: {
        match: {
          type: "string",
          description: "Substring of the directive to retire.",
        },
      },
      required: ["match"],
    },
  },
  {
    name: "brain_status",
    description:
      "Return counts and health info about the project brain: number of " +
      "active directives, pending candidates, and the MEMORY.md path.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brain_undo_last",
    description:
      "Reverse the most recent mutation (RememberDirective, PromoteCandidate, " +
      "RejectCandidate, or RetireDirective). The undo itself is logged so the " +
      "history is fully traceable. Returns the kind of action undone and a " +
      "human-readable summary of what was reverted.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brain_why",
    description:
      "Trace how a directive came to exist by searching the action log. " +
      "Returns the chain of actions that mention the given directive text " +
      "in chronological order. Use this when you need to answer 'why do you " +
      "remember this about me' — every memory has an audit trail.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Substring of the directive text to search for in the action log.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "brain_types",
    description:
      "Manage Directive Types — the typed categories that classify every " +
      "directive. With action=list, returns all built-in and user-defined " +
      "types. With action=classify, returns the type that a given directive " +
      "body would be classified as. With action=list_candidates, returns " +
      "type candidates the system has auto-proposed from emerging patterns. " +
      "With action=approve / reject, curates a pending type candidate.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "classify", "list_candidates", "approve", "reject"],
          description: "What to do. Default: list.",
        },
        text: {
          type: "string",
          description: "Directive body (required for action=classify).",
        },
        id: {
          type: "string",
          description:
            "Type candidate ID or prefix (required for action=approve or reject).",
        },
        final_name: {
          type: "string",
          description:
            "Optional edited name when approving (otherwise the proposed name is used).",
        },
      },
    },
  },
  {
    name: "brain_links",
    description:
      "Manage Directive Links — typed relations between directives. " +
      "Kinds are 'supersedes' (A replaces B), 'refines' (A adds detail to B), " +
      "'contradicts' (A and B are in tension), 'scopedTo' (A only applies " +
      "in B's context). With action=list, returns all current links. With " +
      "action=list_candidates, returns auto-proposed link candidates from " +
      "the most recent ontology scan. With action=approve / reject, curates " +
      "a pending link candidate.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "list_candidates", "approve", "reject"],
          description: "What to do. Default: list.",
        },
        id: {
          type: "string",
          description:
            "Link candidate ID or prefix (required for action=approve or reject).",
        },
        final_kind: {
          type: "string",
          enum: ["supersedes", "refines", "contradicts", "scopedTo"],
          description:
            "Optional override of the proposed link kind when approving.",
        },
      },
    },
  },
];

// ── JSON-RPC envelope types ──────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Tool handlers ────────────────────────────────────────────────

function projectRoot(): string {
  return process.env.OH_MY_BRAIN_PROJECT_ROOT || process.cwd();
}

function memoryPath(): string {
  return join(projectRoot(), "MEMORY.md");
}

type ToolContent = { type: "text"; text: string };

function textResult(text: string): { content: ToolContent[] } {
  return { content: [{ type: "text", text }] };
}

function handleBrainRemember(args: Record<string, unknown>): { content: ToolContent[] } {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) {
    return textResult("error: text is required and must be non-empty");
  }
  const source = typeof args.source === "string" ? args.source : "mcp";
  const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;

  const action = applyRememberDirective(
    { projectRoot: projectRoot(), source, sessionId },
    { text }
  );

  if (action.payload.written) {
    return textResult(
      `remembered: "${text}" → MEMORY.md (action ${action.id})`
    );
  }
  return textResult(
    `already remembered: "${text}" is already present in MEMORY.md (action ${action.id} logged anyway for traceability)`
  );
}

function handleBrainRecall(): { content: ToolContent[] } {
  const path = memoryPath();
  if (!existsSync(path)) {
    return textResult("no directives yet — MEMORY.md does not exist");
  }
  const content = readFileSync(path, "utf8");

  // Extract active bullets (skip the archive section). Use the same
  // parsing semantics as parseExistingDirectives but also return the
  // raw bullet lines so the agent can see provenance tags.
  const lines = content.split("\n");
  const bullets: string[] = [];
  let inArchive = false;
  const ARCHIVE_HEADING =
    "## oh-my-brain archive (superseded directives — do not use)";

  for (const line of lines) {
    if (line.trim() === ARCHIVE_HEADING) {
      inArchive = true;
      continue;
    }
    if (inArchive) {
      if (/^## /.test(line) && line.trim() !== ARCHIVE_HEADING) {
        inArchive = false;
      } else {
        continue;
      }
    }
    if (/^-\s+\[[^\]]*\]\s+/.test(line)) {
      bullets.push(line);
    }
  }

  if (bullets.length === 0) {
    return textResult("no active directives found in MEMORY.md");
  }
  return textResult(
    `Active directives (${bullets.length}):\n\n${bullets.join("\n")}`
  );
}

function handleBrainCandidates(args: Record<string, unknown>): { content: ToolContent[] } {
  const action = typeof args.action === "string" ? args.action : "list";
  const root = projectRoot();
  const store = loadCandidateStore(root);

  if (action === "list") {
    const pending = listCandidates(store, { status: "pending" });
    if (pending.length === 0) {
      return textResult("no pending candidates");
    }
    const lines = pending.map(
      (c) =>
        `${c.id.slice(0, 8)} [${c.source}] (seen ${c.mentionCount}x) ${c.text}`
    );
    return textResult(
      `${pending.length} pending candidate(s):\n\n${lines.join("\n")}`
    );
  }

  if (action === "add") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return textResult("error: text is required for action=add");
    const created = ingestCandidates(store, [text], { source: "unknown" });
    saveCandidateStore(root, store);
    if (created.length === 0) {
      return textResult(
        `candidate already existed (or was rejected earlier): "${text}"`
      );
    }
    return textResult(
      `added candidate ${created[0].id.slice(0, 8)}: "${text}" (${pendingCount(store)} pending)`
    );
  }

  if (action === "approve") {
    const idPrefix = typeof args.id === "string" ? args.id : "";
    const finalText =
      typeof args.final_text === "string" ? args.final_text : undefined;
    if (!idPrefix) return textResult("error: id is required for action=approve");
    const fullId = resolveCandidateId(store, idPrefix);
    if (!fullId) return textResult(`error: no pending candidate matches "${idPrefix}"`);
    const promoted = applyPromoteCandidate(
      { projectRoot: root, source: "mcp" },
      { candidateId: fullId, finalText }
    );
    if (!promoted) {
      return textResult(`error: candidate ${fullId} is not pending`);
    }
    return textResult(
      `approved ${fullId.slice(0, 8)}: "${promoted.payload.finalText}" → MEMORY.md (action ${promoted.id})`
    );
  }

  if (action === "reject") {
    const idPrefix = typeof args.id === "string" ? args.id : "";
    if (!idPrefix) return textResult("error: id is required for action=reject");
    const fullId = resolveCandidateId(store, idPrefix);
    if (!fullId) return textResult(`error: no pending candidate matches "${idPrefix}"`);
    const rejected = applyRejectCandidate(
      { projectRoot: root, source: "mcp" },
      fullId
    );
    if (!rejected) return textResult(`error: candidate ${fullId} is not pending`);
    return textResult(
      `rejected ${fullId.slice(0, 8)}: "${rejected.payload.text}" (action ${rejected.id})`
    );
  }

  return textResult(`error: unknown action "${action}" (expected list|add|approve|reject)`);
}

function handleBrainRetire(args: Record<string, unknown>): { content: ToolContent[] } {
  const match = typeof args.match === "string" ? args.match.trim() : "";
  if (!match) return textResult("error: match is required");
  const action = applyRetireDirective({ projectRoot: projectRoot(), source: "mcp" }, match);
  if (action.payload.retiredCount === 0) {
    return textResult(`no active directive matched "${match}"`);
  }
  return textResult(
    `retired ${action.payload.retiredCount} directive(s) matching "${match}" — moved to archive section (action ${action.id})`
  );
}

function handleBrainUndoLast(): { content: ToolContent[] } {
  const result = undoLastAction({ projectRoot: projectRoot(), source: "mcp" });
  if (!result) {
    return textResult("nothing to undo — action log is empty or all actions are already reversed");
  }
  return textResult(
    `undid ${result.undone.kind} (${result.undone.id}): ${result.notes}`
  );
}

function handleBrainTypes(args: Record<string, unknown>): { content: ToolContent[] } {
  const action = typeof args.action === "string" ? args.action : "list";
  const root = projectRoot();

  if (action === "list") {
    const types = loadAllTypes(root);
    if (types.length === 0) return textResult("no directive types defined");
    const lines = types.map(
      (t) => `${t.id} [${t.origin}] — ${t.description}`
    );
    return textResult(`${types.length} Directive Type(s):\n\n${lines.join("\n")}`);
  }

  if (action === "classify") {
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) return textResult("error: text is required for action=classify");
    const result = classifyDirective(root, text);
    return textResult(
      `classified as: ${result.typeId}\nmatched patterns: ${result.matchedPatterns.length > 0 ? result.matchedPatterns.join(", ") : "(none — uncategorized)"}`
    );
  }

  if (action === "list_candidates") {
    const store = loadTypeCandidates(root);
    const pending = listTypeCandidates(store, { status: "pending" });
    if (pending.length === 0) return textResult("no pending type candidates");
    const lines = pending.map(
      (c) =>
        `${c.id.slice(0, 10)}  ${c.proposedName}  (keywords: ${c.derivedKeywords.join(", ")}, ${c.exampleDirectives.length} examples)`
    );
    return textResult(
      `${pending.length} pending type candidate(s):\n\n${lines.join("\n")}`
    );
  }

  if (action === "approve") {
    const idPrefix = typeof args.id === "string" ? args.id : "";
    const finalName =
      typeof args.final_name === "string" ? args.final_name : undefined;
    if (!idPrefix) return textResult("error: id is required for action=approve");
    const store = loadTypeCandidates(root);
    const fullId = resolveTypeCandidateId(store, idPrefix);
    if (!fullId) return textResult(`error: no pending type candidate matches "${idPrefix}"`);
    const result = applyApproveType(
      { projectRoot: root, source: "mcp" },
      { typeCandidateId: fullId, finalName }
    );
    if (!result) return textResult(`error: type candidate ${fullId} is not pending`);
    return textResult(
      `approved type ${fullId.slice(0, 10)}: "${result.payload.finalName}" → user types registry (action ${result.id})`
    );
  }

  if (action === "reject") {
    const idPrefix = typeof args.id === "string" ? args.id : "";
    if (!idPrefix) return textResult("error: id is required for action=reject");
    const store = loadTypeCandidates(root);
    const fullId = resolveTypeCandidateId(store, idPrefix);
    if (!fullId) return textResult(`error: no pending type candidate matches "${idPrefix}"`);
    const result = applyRejectType({ projectRoot: root, source: "mcp" }, fullId);
    if (!result) return textResult(`error: type candidate ${fullId} is not pending`);
    return textResult(
      `rejected type ${fullId.slice(0, 10)}: "${result.payload.proposedName}" (action ${result.id})`
    );
  }

  return textResult(
    `error: unknown action "${action}" (expected list|classify|list_candidates|approve|reject)`
  );
}

function handleBrainLinks(args: Record<string, unknown>): { content: ToolContent[] } {
  const action = typeof args.action === "string" ? args.action : "list";
  const root = projectRoot();

  if (action === "list") {
    const links = loadLinks(root);
    if (links.length === 0) return textResult("no directive links defined");
    const lines = links.map((l) => {
      const truncate = (s: string): string =>
        s.length > 60 ? s.slice(0, 57) + "..." : s;
      return `${l.kind}  from "${truncate(l.fromDirective)}"  to "${truncate(l.toDirective)}"`;
    });
    return textResult(`${links.length} Directive Link(s):\n\n${lines.join("\n")}`);
  }

  if (action === "list_candidates") {
    const store = loadLinkCandidates(root);
    const pending = listLinkCandidates(store, { status: "pending" });
    if (pending.length === 0) return textResult("no pending link candidates");
    const lines = pending.map((c) => {
      const truncate = (s: string): string =>
        s.length > 60 ? s.slice(0, 57) + "..." : s;
      return `${c.id.slice(0, 10)}  ${c.proposedKind}  (sim ${(c.similarity * 100).toFixed(0)}%)\n    from "${truncate(c.fromDirective)}"\n    to   "${truncate(c.toDirective)}"\n    why  ${c.rationale}`;
    });
    return textResult(
      `${pending.length} pending link candidate(s):\n\n${lines.join("\n\n")}`
    );
  }

  if (action === "approve") {
    const idPrefix = typeof args.id === "string" ? args.id : "";
    if (!idPrefix) return textResult("error: id is required for action=approve");
    const store = loadLinkCandidates(root);
    const fullId = resolveLinkCandidateId(store, idPrefix);
    if (!fullId) return textResult(`error: no pending link candidate matches "${idPrefix}"`);

    let finalKind: LinkKind | undefined;
    if (typeof args.final_kind === "string") {
      if (!LINK_KINDS.includes(args.final_kind as LinkKind)) {
        return textResult(
          `error: invalid final_kind "${args.final_kind}". Must be one of: ${LINK_KINDS.join(", ")}`
        );
      }
      finalKind = args.final_kind as LinkKind;
    }

    const result = applyApproveLink(
      { projectRoot: root, source: "mcp" },
      { linkCandidateId: fullId, finalKind }
    );
    if (!result) return textResult(`error: link candidate ${fullId} is not pending`);
    return textResult(
      `approved link ${fullId.slice(0, 10)}: ${result.payload.finalKind} (action ${result.id})`
    );
  }

  if (action === "reject") {
    const idPrefix = typeof args.id === "string" ? args.id : "";
    if (!idPrefix) return textResult("error: id is required for action=reject");
    const store = loadLinkCandidates(root);
    const fullId = resolveLinkCandidateId(store, idPrefix);
    if (!fullId) return textResult(`error: no pending link candidate matches "${idPrefix}"`);
    const result = applyRejectLink({ projectRoot: root, source: "mcp" }, fullId);
    if (!result) return textResult(`error: link candidate ${fullId} is not pending`);
    return textResult(
      `rejected link ${fullId.slice(0, 10)}: ${result.payload.proposedKind} (action ${result.id})`
    );
  }

  return textResult(
    `error: unknown action "${action}" (expected list|list_candidates|approve|reject)`
  );
}

function handleBrainWhy(args: Record<string, unknown>): { content: ToolContent[] } {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return textResult("error: text is required");
  const result = whyDirective(projectRoot(), text);
  if (result.matches.length === 0) {
    return textResult(result.summary);
  }
  const lines = [result.summary, "", "Action chain:"];
  for (const action of result.matches) {
    const ts = action.timestamp.replace("T", " ").slice(0, 19);
    lines.push(`  ${ts}  [${action.source}]  ${action.kind}  ${action.id}`);
    switch (action.kind) {
      case "RememberDirective":
        lines.push(`      → "${action.payload.finalText}"`);
        break;
      case "PromoteCandidate":
        lines.push(
          `      candidate ${action.payload.candidateId.slice(0, 8)} → "${action.payload.finalText}"`
        );
        break;
      case "RejectCandidate":
        lines.push(
          `      candidate ${action.payload.candidateId.slice(0, 8)}: "${action.payload.text}"`
        );
        break;
      case "RetireDirective":
        lines.push(
          `      retired ${action.payload.retiredCount} matching "${action.payload.matchText}"`
        );
        break;
      case "UndoAction":
        lines.push(`      ${action.payload.notes}`);
        break;
    }
  }
  return textResult(lines.join("\n"));
}

function handleBrainStatus(): { content: ToolContent[] } {
  const root = projectRoot();
  const store = loadCandidateStore(root);
  const pending = pendingCount(store);
  const total = listCandidates(store).length;
  const mPath = memoryPath();
  const memoryExists = existsSync(mPath);
  const actionLog = loadActionLog(root);
  const actionsByKind = new Map<string, number>();
  for (const a of actionLog) {
    actionsByKind.set(a.kind, (actionsByKind.get(a.kind) ?? 0) + 1);
  }

  const parts = [
    `project: ${root}`,
    `memory_path: ${mPath}`,
    `memory_exists: ${memoryExists}`,
    `candidates_pending: ${pending}`,
    `candidates_total: ${total}`,
    `actions_total: ${actionLog.length}`,
  ];
  if (actionLog.length > 0) {
    const breakdown = Array.from(actionsByKind.entries())
      .map(([k, c]) => `${k}=${c}`)
      .join(", ");
    parts.push(`actions_by_kind: ${breakdown}`);
  }
  return textResult(parts.join("\n"));
}

function callTool(name: string, args: Record<string, unknown>): { content: ToolContent[] } {
  switch (name) {
    case "brain_remember":
      return handleBrainRemember(args);
    case "brain_recall":
      return handleBrainRecall();
    case "brain_candidates":
      return handleBrainCandidates(args);
    case "brain_retire":
      return handleBrainRetire(args);
    case "brain_status":
      return handleBrainStatus();
    case "brain_undo_last":
      return handleBrainUndoLast();
    case "brain_why":
      return handleBrainWhy(args);
    case "brain_types":
      return handleBrainTypes(args);
    case "brain_links":
      return handleBrainLinks(args);
    default:
      return textResult(`error: unknown tool "${name}"`);
  }
}

// ── Dispatcher ───────────────────────────────────────────────────

export function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  const id = req.id ?? null;

  try {
    if (req.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
        },
      };
    }

    if (req.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }

    if (req.method === "tools/call") {
      const params = (req.params ?? {}) as {
        name: string;
        arguments?: Record<string, unknown>;
      };
      const result = callTool(params.name, params.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    }

    // Notifications (no id) don't need a response, but we still return one
    // for unknown methods to surface integration bugs early.
    if (req.method === "notifications/initialized") {
      return { jsonrpc: "2.0", id, result: {} };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${req.method}` },
    };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: (err as Error).message },
    };
  }
}

// ── stdio transport ──────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  process.stdin.setEncoding("utf8");

  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    // Each JSON-RPC message is delimited by newline in our simple
    // framing (Content-Length framing would be more official but adds
    // complexity; MCP clients we target all accept newline-delimited).
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");

      if (!line) continue;

      let req: JsonRpcRequest | null = null;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        process.stderr.write(`[brain-mcp] ignoring malformed line: ${line.slice(0, 120)}\n`);
        continue;
      }

      const response = handleRequest(req);
      // Notifications have no id → don't respond
      if (req.id !== undefined && req.id !== null) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });

  process.stderr.write(
    `[brain-mcp] ${SERVER_NAME} ${SERVER_VERSION} listening on stdio (project: ${projectRoot()})\n`
  );
}

if (isDirectEntry(["mcp-server.js", "brain-mcp"])) {
  void startMcpServer();
}
