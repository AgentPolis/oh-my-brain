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

import { readFileSync, existsSync, readdirSync } from "fs";
import { basename, join } from "path";
import { resolveMemoryPath, resolveSystemRoot } from "../src/scope.js";
import { OutcomeStore } from "../src/storage/outcomes.js";
import { ProcedureStore } from "../src/storage/procedures.js";
import { extractProcedure } from "../src/procedure/extractor.js";
import { findSessionJsonl, parseSessionEntries, extractTextContent } from "./compress-core.js";
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
import {
  loadDirectiveEvidence,
  loadDirectiveMetadata,
  markDirectivesReferenced,
} from "../src/storage/directives.js";
import { loadDecisionScenarios } from "./eval.js";
import { buildDiffReport } from "./diff.js";
import { formatQuizHistorySummary, summarizeQuizHistory } from "./quiz.js";
import {
  approveReflectionProposal,
  buildGrowthSnapshot,
  consolidateProject,
  dismissReflectionProposal,
  listReflectionProposals,
  renderReflectionProposals,
  renderGrowthSnapshot,
  renderConsolidationReport,
  resolveReflectionProposalId,
} from "./consolidate.js";
import { ArchiveStore } from "../src/storage/archive.js";
import { EventStore, detectEventCategory, type BrainEvent } from "../src/storage/events.js";
import { TimelineIndex } from "../src/storage/timeline.js";
import { GraphStore } from "../src/storage/graph.js";
import { pgliteFactory } from "../src/storage/db.js";
import { initPgSchema } from "../src/storage/pg-schema.js";
import { loadHabits } from "./habit-detector.js";
import { RelationStore } from "./relation-store.js";
import { SchemaStore } from "./schema-detector.js";
import {
  hasBrainDir,
  resolveBrainPaths,
  loadScopeConfig,
  brainRemember,
  assembleBrainToMemory,
  refreshMemoryMd,
  migrateToBrain,
  auditBrain,
  listProjects,
  parseProjectInfo,
  appendHandoff,
  exportBrain,
  importBrain,
  detectDomain,
  detectProject,
  extractEpisodesFromHandoff,
  saveEpisode,
  searchEpisodes,
  trackEpisodeFrequency,
  trackAndPromote,
  listSkills,
  generateSkillFromEpisode,
  extractTags,
  saveLastSession,
  type HandoffEntry,
  type Episode,
} from "./brain-store.js";

const SERVER_NAME = "oh-my-brain";
const SERVER_VERSION = "0.9.0";
const PROTOCOL_VERSION = "2024-11-05";

function renderScopeRule(root: string): string {
  if (!hasBrainDir(root)) {
    return "Scope: project-local brain first; overlay global user preferences only when enabled.";
  }
  const scope = loadScopeConfig(root);
  if (scope.overlayGlobalPreferences && scope.globalBrainRoot) {
    return `Scope: project-local brain first; overlay global user preferences enabled (${scope.globalBrainRoot}).`;
  }
  return "Scope: project-local brain first; overlay global user preferences only when enabled.";
}

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
            "Which agent is calling (claude, codex, cursor, etc.). Used for provenance.",
          enum: ["claude", "codex", "cursor", "windsurf", "copilot", "unknown"],
        },
        is_correction: {
          type: "boolean",
          description:
            "True if this is a user correction ('no', 'wrong', 'I told you X'). " +
            "Corrections track faster toward skill promotion (2x = immediate skill).",
        },
        session_id: {
          type: "string",
          description: "Optional session identifier for provenance tracking.",
        },
        domain: {
          type: "string",
          description: "Target domain file (e.g., 'work'). Omit for auto-routing based on content.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "brain_recall",
    description:
      "Recall active directives (L3) plus a compact event-memory summary from the project brain. Call at session start. " +
      "For specific dates, events, people, categories, or conversation details, use brain_search instead. " +
      "AGENT BEHAVIOR: " +
      "(1) User says 'always/never/from now on/remember that' → call brain_remember directly. " +
      "(2) User corrects you clearly ('no','wrong','I told you X') → call brain_remember with the correction as a rule. " +
      "(3) User repeats same preference 2+ times → call brain_remember. " +
      "(4) Uncertain soft signals → call brain_candidates action=add. " +
      "(5) Reusable lesson after 5+ tool calls → brain_candidates action=add. " +
      "(6) Significant decision (architecture/scope/tradeoff) → brain_candidates action=add text=DECISION:<situation>→<choice>→<rationale>. " +
      "(7) Never write MEMORY.md directly. High-confidence → brain_remember. Uncertain → brain_candidates. Silent, no permission needed.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "summary (default), all, or type.",
          enum: ["summary", "all", "type"],
        },
        type: {
          type: "string",
          description: "Directive type name to load when mode=type.",
        },
        with_evidence: {
          type: "boolean",
          description:
            "Include stored evidence text and turn index for each directive. Default: false.",
        },
        domain: {
          type: "string",
          description: "Filter to a specific domain (e.g., 'work'). Omit to recall from all domains.",
        },
        query: {
          type: "string",
          description: "Search episodes by keyword (v2). Returns matching lessons, decisions, patterns from past sessions.",
        },
      },
    },
  },
  {
    name: "brain_search",
    description:
      "Search structured events first, then archived conversation history. Use this when " +
      "you need specific dates, events, people, categories, decisions, or full conversation details " +
      "that are no longer in active context. Supports when/query/who/category/relation/schema filters.",
    inputSchema: {
      type: "object",
      properties: {
        when: {
          type: "string",
          description:
            "Date or date range. Examples: '2026-04-06', '2026-04-01..2026-04-07', 'last week', 'last month'.",
        },
        query: {
          type: "string",
          description: "Keyword search. Case-insensitive.",
        },
        who: {
          type: "string",
          description: "Person/entity match against structured events.",
        },
        category: {
          type: "string",
          description: "Structured event category filter.",
        },
        relation: {
          type: "string",
          description: "Search by relationship. Example: 'trusted' returns high-trust people.",
          enum: ["trusted", "verify", "all"],
        },
        schema: {
          type: "string",
          description: "Get a decision framework by category. Example: 'code-review'.",
        },
        connected: {
          type: "string",
          description: "Find everything connected to this entity (person, event, topic). Uses knowledge graph traversal.",
        },
        limit: {
          type: "number",
          description: "Max results to return. Default: 10.",
        },
      },
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
      "active directives, pending candidates, events, habits, viewpoints, relations, schemas, and the MEMORY.md path.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brain_quiz",
    description:
      "Generate a decision scenario to test whether the agent has learned " +
      "the user's preferences. Returns a situation, options, expected answer, " +
      "and relevant directives so the user can watch the reasoning live.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "architecture",
            "scope",
            "security",
            "tradeoff",
            "operations",
            "communication",
            "random",
          ],
          description: "Scenario category. Default: random.",
        },
      },
    },
  },
  {
    name: "brain_diff",
    description:
      "Show what the brain learned recently. Returns a summary of new directives, retired rules, pending candidates, growth rate, and archive stats for a given time period.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "Time period. Default: '7 days'. Examples: '3 days', '2026-04-01', 'last month'.",
        },
      },
    },
  },
  {
    name: "brain_consolidate",
    description:
      "Run the offline growth loop immediately: external rule scan, reflection proposals, habit/schema consolidation, and growth journal update. Use this after major work or when you want the brain to reflect now instead of waiting for the next hook.",
    inputSchema: {
      type: "object",
      properties: {
        stale_days: {
          type: "number",
          description: "How many days of inactivity before a directive is considered stale. Default: 30.",
        },
      },
    },
  },
  {
    name: "brain_growth",
    description:
      "Read the current offline-growth state: pending reflection proposals, growth-journal count, and the latest growth summary.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "brain_reflect",
    description:
      "Review pending reflection proposals produced by the offline growth loop. Use action=list to inspect proposals, action=approve to apply a proposal's recommended mutation, and action=dismiss to close it without acting.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "approve", "dismiss"],
          description: "What to do. Default: list.",
        },
        id: {
          type: "string",
          description: "Proposal id or stable prefix. Required for approve/dismiss.",
        },
        status: {
          type: "string",
          enum: ["pending", "resolved", "dismissed", "all"],
          description: "Filter when action=list. Default: pending.",
        },
      },
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
  {
    name: "brain_save_procedure",
    description:
      "Extract a reusable procedure from the current session's tool calls. " +
      "Use when the user says 'remember this workflow' or 'save these steps'. " +
      "Reads the current session, extracts steps in order, detects pitfalls " +
      "from error/retry sequences, and saves as a candidate procedure.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Human-readable title for the procedure (e.g., 'Production Deploy').",
        },
        trigger: {
          type: "string",
          description: "Task description that should trigger this procedure (e.g., 'deploy to production').",
        },
      },
      required: ["title", "trigger"],
    },
  },
  {
    name: "brain_domains",
    description:
      "List available concrete context files with stats, such as work, life, investing, or learning. " +
      "Returns names, directive counts, and estimated token sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_procedures",
    description:
      "List, approve, or archive saved procedures. Procedures are multi-step " +
      "workflows extracted from sessions. Approved procedures are injected " +
      "into sub-agent context when the task matches the trigger.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "approve", "archive"],
          description: "What to do. Default: list.",
        },
        id: {
          type: "string",
          description: "Procedure ID or prefix (required for approve/archive).",
        },
      },
    },
  },
  // ── v2 .brain/ tools ──────────────────────────────────────────
  {
    name: "brain_handoff",
    description:
      "Write a session handoff entry to the active project's .brain/ file. " +
      "Call this at session end to record what was done, key decisions, and " +
      "what's next. This is how the next session knows where you left off. " +
      "If the session involved 5+ tool calls (complex task), a skill is auto-generated.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "3-5 line summary of what happened this session." },
        project: { type: "string", description: "Project name. Auto-detected from cwd if omitted." },
        incomplete: { type: "boolean", description: "True if session ended before completing the task." },
        tool_call_count: { type: "number", description: "Number of tool calls in this session. If >= 5, auto-generates a skill." },
        procedure_summary: { type: "string", description: "Optional: concise description of the procedure followed (for skill generation)." },
      },
      required: ["summary"],
    },
  },
  {
    name: "brain_projects",
    description:
      "List all projects in .brain/ with their status, in-progress work, and last handoff.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_refresh",
    description:
      "Manually trigger MEMORY.md reassembly from .brain/. Call after editing " +
      ".brain/ files directly, or when switching projects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_migrate",
    description:
      "Migrate from v0.8 memory/ format to v2 .brain/ structured format. " +
      "Classifies existing directives into concrete layers like identity, coding, goals, work/life context, and project memory. " +
      "One-time operation for upgrading.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_audit",
    description:
      "Show a human-readable health report of your .brain/. " +
      "Counts identity rules, coding rules, concrete context files, projects, handoff entries, and MEMORY.md token estimate.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_export",
    description:
      "Export .brain/ as a portable JSON bundle (excludes PGLite DB). " +
      "Use for cross-device sync or backup.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "brain_import",
    description:
      "Import a .brain/ JSON bundle (from brain_export). Merges with existing brain.",
    inputSchema: {
      type: "object",
      properties: {
        bundle: { type: "string", description: "JSON string from brain_export output." },
      },
      required: ["bundle"],
    },
  },
  {
    name: "brain_skills",
    description:
      "List auto-generated skills that emerged from repeated episodes or corrections. " +
      "Skills are structured procedures (steps + pitfalls + verification) that the agent " +
      "can follow when encountering similar tasks. Auto-generated when: " +
      "(1) user corrects the same thing twice, or " +
      "(2) a pattern appears 3+ times, or " +
      "(3) a complex task (5+ tool calls) completes successfully via brain_handoff.",
    inputSchema: { type: "object", properties: {} },
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
  return resolveMemoryPath(projectRoot());
}

type ToolContent = { type: "text"; text: string };

function textResult(text: string): { content: ToolContent[] } {
  return { content: [{ type: "text", text }] };
}

function parseActiveDirectiveBullets(content: string): Array<{ line: string; body: string }> {
  const lines = content.split("\n");
  const bullets: Array<{ line: string; body: string }> = [];
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
    const match = line.match(/^-\s+\[[^\]]*\]\s+(.+)$/);
    if (match) {
      bullets.push({ line, body: match[1].trim() });
    }
  }

  return bullets;
}

// Agent instruction moved to brain_recall tool description to save ~300 tokens
// per brain_recall response. MCP clients read tool descriptions at session start.

async function handleBrainDomains(): Promise<{ content: ToolContent[] }> {
  const memoryDir = join(projectRoot(), "memory");
  if (!existsSync(memoryDir)) {
    return textResult("no domains — memory/ directory does not exist. Using flat MEMORY.md.");
  }
  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) return textResult("no domain files found in memory/");

  const domains = files.map((f) => {
    const domain = basename(f, ".md");
    const content = readFileSync(join(memoryDir, f), "utf8");
    const bullets = content.split("\n").filter((l) => /^-\s+/.test(l));
    const tokens = Math.ceil(content.length / 4);
    return { name: domain, directiveCount: bullets.length, tokens };
  });
  return textResult(JSON.stringify(domains, null, 2));
}

async function handleBrainRemember(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return textResult("error: text is required and must be non-empty");
  const source = typeof args.source === "string" ? args.source : "mcp";
  const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
  const domain = typeof args.domain === "string" ? args.domain : undefined;
  const isCorrection = args.is_correction === true;
  const root = projectRoot();

  // v2: route to .brain/ if it exists
  if (hasBrainDir(root)) {
    // Track corrections for skill promotion (1x→think, 2x→skill)
    if (isCorrection) {
      const paths = resolveBrainPaths(root);
      const { episode, promoted, skillPath } = trackAndPromote(paths, text, "correction");
      // Also log to action log
      await applyRememberDirective(
        { projectRoot: root, source, sessionId, domain },
        { text }
      );
      if (promoted && skillPath) {
        return textResult(
          `SKILL CREATED from repeated correction: "${text}"\n` +
          `Skill file: ${skillPath}\n` +
          `This pattern was corrected ${episode.frequency}x — now a permanent skill.`
        );
      }
      if (episode.frequency === 1) {
        return textResult(
          `correction recorded as episode: "${text}"\n` +
          `First occurrence — thinking about the essence. ` +
          `If corrected again, this will become a permanent skill.`
        );
      }
      return textResult(
        `correction tracked (${episode.frequency}x): "${text}"`
      );
    }

    const result = brainRemember(root, text, {
      domain,
      project: detectProject(resolveBrainPaths(root), process.cwd()) ?? undefined,
      cwd: process.cwd(),
    });
    // Also log to action log for traceability
    await applyRememberDirective(
      { projectRoot: root, source, sessionId, domain },
      { text }
    );

    // Low confidence → route to candidates for user review
    if (result.needsReview) {
      const store = loadCandidateStore(root);
      ingestCandidates(store, [text], { source, sessionId, projectRoot: root });
      saveCandidateStore(root, store);
      return textResult(
        `low confidence (${(result.confidence * 100).toFixed(0)}%) — saved as candidate for review. ` +
        `Suggested layer: ${result.layer}/${result.target}. ` +
        `User can approve with brain_candidates action=approve.`
      );
    }

    if (result.written) {
      return textResult(`remembered: "${text}" → .brain/${result.layer}${result.layer === "domain" || result.layer === "project" ? "/" + result.target : ""}.md (${(result.confidence * 100).toFixed(0)}% confidence)`);
    }
    return textResult(`already remembered: "${text}" is already present in .brain/${result.layer}`);
  }

  // v1 fallback: write to memory/ or MEMORY.md
  const action = await applyRememberDirective(
    { projectRoot: root, source, sessionId, domain },
    { text }
  );

  const target = domain ? `memory/${domain}.md` : "MEMORY.md";
  if (action.payload.written) {
    return textResult(`remembered: "${text}" → ${target} (action ${action.id})`);
  }
  return textResult(`already remembered: "${text}" is already present (action ${action.id} logged anyway for traceability)`);
}

async function handleBrainRecall(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const mode = typeof args.mode === "string" ? args.mode : "summary";
  const requestedType = typeof args.type === "string" ? args.type : "";
  const withEvidence = args.with_evidence === true;
  const domain = typeof args.domain === "string" ? args.domain : undefined;
  const query = typeof args.query === "string" ? args.query : undefined;
  const root = projectRoot();
  const scopeRule = renderScopeRule(root);

  // v2: if .brain/ exists and query is provided, search episodes + skills
  if (hasBrainDir(root) && query) {
    const paths = resolveBrainPaths(root);
    const parts: string[] = [];

    // Search skills first (highest priority — learned procedures)
    const skills = listSkills(paths);
    const queryLower = query.toLowerCase();
    const matchedSkills = skills.filter((s) =>
      s.trigger.toLowerCase().includes(queryLower) ||
      s.title.toLowerCase().includes(queryLower)
    );
    if (matchedSkills.length > 0) {
      parts.push("## Relevant Skills (learned procedures)");
      for (const s of matchedSkills) {
        parts.push(`### ${s.title}`);
        parts.push(`Procedure:`);
        s.procedure.forEach((step, i) => parts.push(`  ${i + 1}. ${step}`));
        if (s.pitfalls.length > 0) {
          parts.push(`Pitfalls:`);
          s.pitfalls.forEach((p) => parts.push(`  - ${p}`));
        }
        parts.push("");
      }
    }

    // Search episodes
    const episodes = searchEpisodes(paths, query);
    if (episodes.length > 0) {
      parts.push("## Related Episodes");
      const formatted = episodes.map((ep) =>
        `- [${ep.episode_type}] ${ep.what}${ep.decision ? " → " + ep.decision : ""}${ep.outcome ? " (outcome: " + ep.outcome + ")" : ""} [${ep.date}]`
      ).join("\n");
      parts.push(formatted);
    }

    if (parts.length === 0) {
      return textResult(`${scopeRule}\n\nno episodes or skills match "${query}"`);
    }
    return textResult(`${scopeRule}\n\n${parts.join("\n")}`);
  }

  // v2: refresh MEMORY.md before recall if .brain/ exists
  if (hasBrainDir(root)) {
    refreshMemoryMd(root, process.cwd());
  }

  let content: string;
  if (domain) {
    // v2: check .brain/domains/ first
    if (hasBrainDir(root)) {
      const domainPath = join(root, ".brain", "domains", `${domain}.md`);
      if (existsSync(domainPath)) {
        content = readFileSync(domainPath, "utf8");
      } else {
        const legacyPath = join(root, "memory", `${domain}.md`);
        if (!existsSync(legacyPath)) return textResult(`domain "${domain}" not found`);
        content = readFileSync(legacyPath, "utf8");
      }
    } else {
      const domainPath = join(projectRoot(), "memory", `${domain}.md`);
      if (!existsSync(domainPath)) {
        return textResult(`domain "${domain}" not found — no memory/${domain}.md file`);
      }
      content = readFileSync(domainPath, "utf8");
    }
  } else {
    const path = memoryPath();
    if (!existsSync(path)) return textResult("no directives yet — MEMORY.md does not exist");
    content = readFileSync(path, "utf8");
  }

  const activeBullets = parseActiveDirectiveBullets(content);

  if (activeBullets.length === 0) {
    return textResult("no active directives found in MEMORY.md");
  }
  if (mode === "summary") {
    const counts = new Map<string, number>();
    for (const bullet of activeBullets) {
      const typeId = classifyDirective(projectRoot(), bullet.body).typeId;
      counts.set(typeId, (counts.get(typeId) ?? 0) + 1);
    }
    const categories = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([typeId, count]) => `${typeId} (${count})`);
    const events = new EventStore(resolveSystemRoot(projectRoot()));
    const relations = new RelationStore(resolveSystemRoot(projectRoot()));
    const schemas = new SchemaStore(resolveSystemRoot(projectRoot()));
    const habits = loadHabits(projectRoot());
    const eventSummary = events.getSummary();
    const viewpointsCaptured = events.searchByCategory("viewpoint").length;
    const lines = [
      scopeRule,
      "",
      `You have ${activeBullets.length} directives, ${eventSummary.count} events, ${viewpointsCaptured} viewpoints, ${habits.length} habits.`,
      `Directive categories: ${categories.join(" | ")}`,
      "Use brain_recall with type=<category> to load specific rules.",
      "Use brain_recall with mode=all to load everything.",
    ];
    const peopleSummary = summarizePeople(relations);
    if (peopleSummary) {
      lines.push(peopleSummary);
      lines.push("Use brain_search --relation trusted for trusted people.");
    }
    const frameworkSummary = summarizeFrameworks(schemas);
    if (frameworkSummary) {
      lines.push(frameworkSummary);
      lines.push('Use brain_search --schema "code-review" for your code review framework.');
    }
    if (eventSummary.count > 0) {
      const recent = events
        .getAll()
        .sort((a, b) => b.ts.localeCompare(a.ts))
        .slice(0, 4)
        .map((event) => `${formatDay(event.ts.slice(0, 10))} ${iconForCategory(event.category)} ${event.what}`)
        .join(" | ");
      const categoriesSummary = Object.entries(eventSummary.categories)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([category, count]) => `${category}(${count})`)
        .join(" ");
      lines.push("");
      lines.push(
        `Events (${eventSummary.count} total, ${eventSummary.earliest.slice(0, 10)} ~ ${eventSummary.latest.slice(0, 10)}):`
      );
      lines.push(`  Recent: ${recent}`);
      lines.push(`  Categories: ${categoriesSummary}`);
      lines.push("  Use brain_search --when/--query/--who/--category for details.");
    }
    const archive = new ArchiveStore(resolveSystemRoot(projectRoot()));
    const archiveSummary = archive.getSummary();
    const timeline = new TimelineIndex(resolveSystemRoot(projectRoot()));
    const timelineBounds = timeline.bounds();
    if (archiveSummary.count > 0 && timelineBounds) {
      const recent = timeline
        .readAll()
        .slice(-3)
        .reverse()
        .map((entry) => `${formatDay(entry.ts)} (${entry.count} msgs: ${entry.topics.join(", ") || "misc"})`)
        .join(" | ");
      lines.push("");
      lines.push(
        `Archived history: ${archiveSummary.count} conversations (${archiveSummary.earliest.slice(0, 10)} ~ ${archiveSummary.latest.slice(0, 10)})`
      );
      lines.push(`Recent: ${recent}`);
      lines.push("Use brain_search to look up specific dates or topics.");
    }
    return textResult(lines.join("\n"));
  }

  const selectedBullets =
    mode === "type"
      ? activeBullets.filter(
          (bullet) => classifyDirective(projectRoot(), bullet.body).typeId === requestedType
        )
      : activeBullets;

  if (selectedBullets.length === 0) {
    return textResult(`no active directives found for type "${requestedType}"`);
  }

  const evidenceByDirective = withEvidence ? await loadDirectiveEvidence(projectRoot()) : new Map();
  const directiveMetadata = withEvidence ? await loadDirectiveMetadata(projectRoot()) : [];
  const renderedBullets = selectedBullets.map((bullet) => {
    if (!withEvidence) return bullet.line;
    const evidence = evidenceByDirective.get(bullet.body);
    const directive = directiveMetadata.find((item) => item.value === bullet.body);
    const eventTimeLine = directive?.eventTime
      ? `\n  event_time: ${directive.eventTime}`
      : "";
    if (!evidence?.evidenceText) return `${bullet.line}${eventTimeLine}`;
    const turnText =
      typeof evidence.evidenceTurn === "number" ? ` (turn ${evidence.evidenceTurn})` : "";
    return `${bullet.line}${eventTimeLine}\n  evidence${turnText}: ${evidence.evidenceText}`;
  });
  const conflicts = loadLinks(projectRoot())
    .filter(
      (link) =>
        link.kind === "contradicts" &&
        selectedBullets.some((bullet) => bullet.body === link.fromDirective || bullet.body === link.toDirective)
    )
    .slice(0, 3)
    .map(
      (link) =>
        `⚠ CONFLICT: "${link.fromDirective}" may contradict "${link.toDirective}" (detected by brain_links)`
    );
  await markDirectivesReferenced(
    projectRoot(),
    selectedBullets.map((bullet) => bullet.body)
  );
  const label = mode === "type" ? `Active directives for ${requestedType}` : "Active directives";
  let output = `${scopeRule}\n\n${label} (${selectedBullets.length}):\n\n${renderedBullets.join("\n")}${
    conflicts.length > 0 ? `\n\n${conflicts.join("\n")}` : ""
  }`;

  // Append cautions from outcome store
  const outcomeRoot = projectRoot();
  const outcomeStore = new OutcomeStore(resolveSystemRoot(outcomeRoot));
  const cautions = outcomeStore.findRelevant(output, 3);
  if (cautions.length > 0) {
    const cautionLines = cautions.map(
      (c) => `- ⚠️ ${c.lesson} (${c.timestamp.slice(0, 10)})`
    );
    output += `\n\n## Cautions\n${cautionLines.join("\n")}`;
  }

  // Append relevant procedures
  const procedureStore = new ProcedureStore(resolveSystemRoot(outcomeRoot));
  const matchedProcedure = procedureStore.findApprovedByTrigger(output);
  if (matchedProcedure) {
    const stepLines = matchedProcedure.steps.map((s) => `${s.order}. ${s.action}`);
    const pitfallLines = matchedProcedure.pitfalls.map((p) => `⚠️ Pitfall: ${p}`);
    const verifyLines = matchedProcedure.verification.map((v) => `✅ Verify: ${v}`);
    output += `\n\n## Relevant Procedures\n### ${matchedProcedure.title}\n${stepLines.join("\n")}`;
    if (pitfallLines.length > 0) output += `\n${pitfallLines.join("\n")}`;
    if (verifyLines.length > 0) output += `\n${verifyLines.join("\n")}`;
  }

  return textResult(output);
}

async function handleBrainCandidates(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
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
    const created = ingestCandidates(store, [text], {
      source: "unknown",
      projectRoot: root,
    });
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
    const promoted = await applyPromoteCandidate(
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

async function handleBrainSearch(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  const archive = new ArchiveStore(resolveSystemRoot(root));
  const events = new EventStore(resolveSystemRoot(root));
  const relations = new RelationStore(resolveSystemRoot(root));
  const schemas = new SchemaStore(resolveSystemRoot(root));
  const archiveSummary = archive.getSummary();
  const eventSummary = events.getSummary();

  const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
    ? Math.max(1, Math.floor(args.limit))
    : 10;
  const when = typeof args.when === "string" ? args.when.trim() : "";
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const who = typeof args.who === "string" ? args.who.trim() : "";
  const category = typeof args.category === "string" ? args.category.trim() : "";
  const relation = typeof args.relation === "string" ? args.relation.trim() : "";
  const schemaCategory = typeof args.schema === "string" ? args.schema.trim() : "";
  const connected = typeof args.connected === "string" ? args.connected.trim() : "";

  if (connected) {
    try {
      const pgDir = join(resolveSystemRoot(root), "brain.pg");
      const db = await pgliteFactory.create(pgDir);
      try {
        await initPgSchema(db);
        const graph = new GraphStore(db);
        // Search for matching nodes
        const matches = await graph.searchNodes({ keyword: connected, limit: 5 });
        if (matches.length === 0) {
          return textResult(`No graph nodes found matching "${connected}".`);
        }
        const lines: string[] = [`Connected to "${connected}":\n`];
        for (const match of matches) {
          lines.push(`[${match.type}] ${match.label}${match.ts ? ` (${match.ts})` : ""}`);
          const neighbors = await graph.getNeighbors(match.id);
          for (const neighbor of neighbors.slice(0, 10)) {
            // Find the edge type
            const edges = await db.query<{ type: string }>(
              `SELECT type FROM graph_edges
               WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)`,
              [match.id, neighbor.id],
            );
            const edgeType = edges[0]?.type ?? "related";
            lines.push(`  → ${edgeType} → [${neighbor.type}] ${neighbor.label}`);
          }
        }
        return textResult(lines.join("\n"));
      } finally {
        await db.close();
      }
    } catch {
      return textResult(`Knowledge graph not available. Run brain_consolidate first.`);
    }
  }

  if (relation) {
    return textResult(formatRelationSearchResults(relations, relation, limit));
  }

  if (schemaCategory) {
    return textResult(formatSchemaSearchResults(schemas, schemaCategory));
  }

  if (archiveSummary.count === 0 && eventSummary.count === 0) {
    return textResult("No archived conversations yet. Use oh-my-brain for a few sessions to build history.");
  }

  if (when) {
    const { from, to, label } = parseDateRange(when);
    const eventMatches = events.searchByTime(from, to);
    const archiveMatches = eventMatches.length < 3 ? archive.searchByTime(from, to) : [];
    return textResult(formatSearchResults(eventMatches, archiveMatches, label, limit));
  }

  if (query) {
    const countQuery = parseCountQuery(query, events);
    if (countQuery) {
      return textResult(formatCountSearchResult(countQuery));
    }
    const eventMatches = events.searchByKeyword(query);
    const archiveMatches = archive.searchByKeyword(query);
    return textResult(formatSearchResults(eventMatches, archiveMatches, `query: ${query}`, limit));
  }

  if (who) {
    const eventMatches = events.searchByPerson(who);
    return textResult(formatSearchResults(eventMatches, [], `who: ${who}`, limit));
  }

  if (category) {
    const eventMatches = events.searchByCategory(category);
    return textResult(formatSearchResults(eventMatches, [], `category: ${category}`, limit));
  }

  const timeline = new TimelineIndex(resolveSystemRoot(root));
  const timelineSummary = timeline.toCompactString();
  const eventTimeline = events.toTimelineString(6);
  if (eventTimeline && timelineSummary) {
    return textResult(`${eventTimeline}\n\nArchive timeline:\n${timelineSummary}`);
  }
  return textResult(eventTimeline || timelineSummary || "No archived conversations yet. Use oh-my-brain for a few sessions to build history.");
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

async function handleBrainStatus(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  const scopeRule = renderScopeRule(root);
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
  const memoryText = memoryExists ? readFileSync(mPath, "utf8") : "";
  const activeBullets = parseActiveDirectiveBullets(memoryText);
  const activeDirectiveCount = activeBullets.length;
  const estimatedTokens = Math.round(
    activeBullets.reduce((sum, bullet) => sum + bullet.body.length, 0) / 4
  );
  const guardLogPath = join(resolveSystemRoot(root), "guard-blocked.jsonl");
  const guardBlockedTotal = existsSync(guardLogPath)
    ? readFileSync(guardLogPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0).length
    : 0;
  const mergeProposalsPending = listCandidates(store, { status: "pending" }).filter((candidate) =>
    candidate.text.startsWith("MERGE:")
  ).length;
  const lastScanPath = join(resolveSystemRoot(root), "last-scan.json");
  let lastOntologyScan: string | null = null;
  if (existsSync(lastScanPath)) {
    try {
      lastOntologyScan =
        (JSON.parse(readFileSync(lastScanPath, "utf8")) as { ts?: string }).ts ?? null;
    } catch {
      lastOntologyScan = null;
    }
  }
  const health =
    activeDirectiveCount > 30
      ? "bloated"
      : pending > 5 || mergeProposalsPending > 0
        ? "needs_review"
        : "healthy";
  const archive = new ArchiveStore(resolveSystemRoot(root));
  const archiveSummary = archive.getSummary();
  const archiveSizeKb = Math.round(archive.getSizeBytes() / 1024);
  const events = new EventStore(resolveSystemRoot(root));
  const eventSummary = events.getSummary();
  const eventCategories = Object.entries(eventSummary.categories)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category, count]) => `${category}(${count})`)
    .join(" ");
  const habits = loadHabits(root);
  const relations = new RelationStore(resolveSystemRoot(root));
  const relationSummary = relations.getSummary();
  const schemas = new SchemaStore(resolveSystemRoot(root));
  const schemaSummary = schemas.getSummary();
  const viewpointsCaptured = events.searchByCategory("viewpoint").length;
  const growth = buildGrowthSnapshot(root);
  const directiveMetadata = (await loadDirectiveMetadata(root)).filter((directive) =>
    activeBullets.some((bullet) => bullet.body === directive.value)
  );
  const staleDirective =
    directiveMetadata.length > 0
      ? directiveMetadata.reduce((oldest, directive) => {
          const oldestTime = Date.parse(oldest.lastReferencedAt ?? oldest.createdAt);
          const directiveTime = Date.parse(directive.lastReferencedAt ?? directive.createdAt);
          return directiveTime < oldestTime ? directive : oldest;
        })
      : null;
  const staleAgeDays =
    staleDirective !== null
      ? Math.max(
          0,
          Math.floor(
            (Date.now() -
              Date.parse(staleDirective.lastReferencedAt ?? staleDirective.createdAt)) /
              (1000 * 60 * 60 * 24)
          )
        )
      : 0;

  const parts = [
    scopeRule,
    `project: ${root}`,
    `memory_path: ${mPath}`,
    `memory_exists: ${memoryExists}`,
    `candidates_pending: ${pending}`,
    `candidates_total: ${total}`,
    `actions_total: ${actionLog.length}`,
    `guard_blocked_total: ${guardBlockedTotal}`,
    `merge_proposals_pending: ${mergeProposalsPending}`,
    `last_ontology_scan: ${lastOntologyScan ?? "null"}`,
    `health: ${health}`,
    `archive_entries: ${archiveSummary.count}`,
    `archive_date_range: ${
      archiveSummary.count > 0
        ? `${archiveSummary.earliest.slice(0, 10)} ~ ${archiveSummary.latest.slice(0, 10)}`
        : "null"
    }`,
    `archive_size_kb: ${archiveSizeKb}`,
    `events_total: ${eventSummary.count}`,
    `events_categories: ${eventCategories || "none"}`,
    `habits_detected: ${habits.length}`,
    `viewpoints_captured: ${viewpointsCaptured}`,
    `relations_total: ${relationSummary.total}`,
    `relations_high_trust: ${relationSummary.high_trust}`,
    `schemas_total: ${schemaSummary.total}`,
    `reflection_proposals_pending: ${growth.pendingProposals}`,
    `growth_journal_entries: ${growth.journalEntries}`,
    `latest_growth_at: ${growth.latestJournal?.ts ?? "null"}`,
    `token_budget.total_directives: ${activeDirectiveCount}`,
    `token_budget.estimated_tokens: ${estimatedTokens}`,
    `token_budget.startup_cost_tokens: 100`,
    `token_budget.full_load_tokens: ${estimatedTokens}`,
    `token_budget.stalest_directive: ${staleDirective?.value ?? "null"}`,
    `token_budget.stalest_age_days: ${staleAgeDays}`,
  ];

  // Graph summary
  try {
    const pgDir = join(resolveSystemRoot(root), "brain.pg");
    const graphDb = await pgliteFactory.create(pgDir);
    try {
      await initPgSchema(graphDb);
      const graph = new GraphStore(graphDb);
      const graphSummary = await graph.getSummary();
      parts.push(`graph_nodes: ${graphSummary.totalNodes}`);
      parts.push(`graph_edges: ${graphSummary.totalEdges}`);
    } finally {
      await graphDb.close();
    }
  } catch {
    parts.push(`graph_nodes: 0`);
    parts.push(`graph_edges: 0`);
  }
  if (actionLog.length > 0) {
    const breakdown = Array.from(actionsByKind.entries())
      .map(([k, c]) => `${k}=${c}`)
      .join(", ");
    parts.push(`actions_by_kind: ${breakdown}`);
  }
  parts.push(formatQuizHistorySummary(summarizeQuizHistory(root)));
  return textResult(parts.join("\n"));
}

function parseDateRange(input: string): { from: string; to: string; label: string } {
  const normalized = input.trim().toLowerCase();
  const today = new Date();

  if (normalized.includes("..")) {
    const [rawFrom, rawTo] = input.split("..", 2).map((part) => part.trim());
    return {
      from: toLocalBoundary(rawFrom, "start"),
      to: toLocalBoundary(rawTo, "end"),
      label: `${rawFrom}..${rawTo}`,
    };
  }

  if (normalized === "last week") {
    return {
      from: shiftLocalDays(today, -7, "start"),
      to: toLocalBoundary(formatLocalDate(today), "end"),
      label: "last week",
    };
  }

  if (normalized === "last month") {
    return {
      from: shiftLocalDays(today, -30, "start"),
      to: toLocalBoundary(formatLocalDate(today), "end"),
      label: "last month",
    };
  }

  return {
    from: toLocalBoundary(input, "start"),
    to: toLocalBoundary(input, "end"),
    label: input,
  };
}

function formatSearchResults(
  eventMatches: BrainEvent[],
  archiveMatches: ReturnType<ArchiveStore["readAll"]>,
  label: string,
  limit: number
): string {
  if (eventMatches.length === 0 && archiveMatches.length === 0) {
    return `No results found for ${label}.`;
  }

  const lines: string[] = [];
  if (eventMatches.length > 0 || archiveMatches.length > 0) {
    lines.push(
      `Found ${eventMatches.length} event${eventMatches.length === 1 ? "" : "s"} + ${archiveMatches.length} archived message${archiveMatches.length === 1 ? "" : "s"} (${label}):`
    );
  }
  if (eventMatches.length > 0) {
    lines.push("");
    lines.push("EVENTS:");
    lines.push(
      ...eventMatches.slice(0, limit).map((event) => `  ${formatEventLine(event)}`)
    );
  }
  if (archiveMatches.length > 0) {
    lines.push("");
    lines.push("ARCHIVED (additional context):");
    lines.push(
      ...archiveMatches.slice(0, Math.min(5, limit)).map((entry) => {
        const stamp = entry.ts.replace("T", " ").slice(0, 16);
        return `  [${stamp}] ${entry.role}: ${entry.content}`;
      })
    );
  }
  return lines.join("\n");
}

function formatCountSearchResult(result: {
  count: number;
  label: string;
  category?: string;
  whatContains?: string;
}): string {
  const filters = [
    result.category ? `category=${result.category}` : "",
    result.whatContains ? `what~"${result.whatContains}"` : "",
  ].filter(Boolean);
  const suffix = filters.length > 0 ? ` (${filters.join(", ")})` : "";
  return `Found ${result.count} event${result.count === 1 ? "" : "s"} matching ${result.label}${suffix}.`;
}

function parseCountQuery(
  query: string,
  events: EventStore
):
  | {
      count: number;
      label: string;
      category?: string;
      whatContains?: string;
    }
  | null {
  const trimmed = query.trim();
  if (!/^how many\b/i.test(trimmed)) return null;

  const rangeMatch = trimmed.match(
    /^how many\s+(.+?)\s+(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+)$/i
  );
  if (rangeMatch) {
    const filters = deriveCountFilters(rangeMatch[1]);
    const from = parseDateRange(rangeMatch[2]).from;
    const to = parseDateRange(rangeMatch[3]).to;
    return {
      count: events.countInRange({ from, to, ...filters }),
      label: `from ${rangeMatch[2]} to ${rangeMatch[3]}`,
      ...filters,
    };
  }

  const beforeMatch = trimmed.match(/^how many\s+(.+?)\s+before\s+(.+)$/i);
  if (beforeMatch) {
    const filters = deriveCountFilters(beforeMatch[1]);
    const before = resolveCountBeforeBoundary(beforeMatch[2], events);
    if (!before) return null;
    return {
      count: events.countBefore({ before, ...filters }),
      label: `before ${beforeMatch[2]}`,
      ...filters,
    };
  }

  return null;
}

function deriveCountFilters(subject: string): { category?: string; whatContains?: string } {
  const cleaned = subject
    .trim()
    .replace(/\b(events?|activities?|things?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const category = detectEventCategory(cleaned);
  if (category !== "other") {
    return { category };
  }
  return cleaned ? { whatContains: cleaned.toLowerCase() } : {};
}

function resolveCountBeforeBoundary(reference: string, events: EventStore): string | null {
  const trimmed = reference.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || /^last\s+(week|month)$/i.test(trimmed)) {
    return parseDateRange(trimmed).from;
  }
  const matches = events.searchByKeyword(trimmed).sort((a, b) => a.ts.localeCompare(b.ts));
  return matches[0]?.ts.slice(0, 10) ?? null;
}

function formatRelationSearchResults(store: RelationStore, relation: string, limit: number): string {
  const normalized = relation.trim().toLowerCase();
  const matches =
    normalized === "trusted"
      ? store.getTrusted()
      : normalized === "verify"
        ? store.getAll().filter((item) => item.relation_type === "trust" && item.level === "low")
        : store.getAll();
  if (matches.length === 0) {
    return `No relation results found for ${normalized}.`;
  }

  const heading =
    normalized === "trusted"
      ? "Trusted people"
      : normalized === "verify"
        ? "People to verify"
        : "All relations";
  return [
    `${heading} (${matches.length}):`,
    ...matches
      .slice(0, limit)
      .map((item) => `  ${item.person} (${item.domain}: ${item.level})${item.notes ? ` — ${item.notes}` : ""}`),
  ].join("\n");
}

function formatSchemaSearchResults(store: SchemaStore, category: string): string {
  const matches = store.getByCategory(category);
  if (matches.length === 0) {
    return `No schema found for category "${category}".`;
  }

  const schema = matches[0];
  return [
    `${schema.name} (${schema.category}, confidence ${schema.confidence.toFixed(2)}):`,
    `  ${schema.description}`,
    "Steps:",
    ...schema.steps.map((step, index) => `  ${index + 1}. ${step}`),
  ].join("\n");
}

function summarizePeople(store: RelationStore): string {
  const visible = store
    .getAll()
    .filter((relation) => relation.relation_type === "trust" && (relation.level === "high" || relation.level === "low"))
    .slice(0, 4);
  if (visible.length === 0) return "";
  return `People: ${visible
    .map((relation) => `${relation.person} (${relation.domain}: ${relation.level === "low" ? "verify" : `${relation.level} trust`})`)
    .join(" | ")}`;
}

function summarizeFrameworks(store: SchemaStore): string {
  const visible = store.getAll().slice(0, 4);
  if (visible.length === 0) return "";
  return `Frameworks: ${visible
    .map((schema) => `${schema.name.replace(/\s+Framework$/, "")} (${schema.steps.length} steps)`)
    .join(" | ")}`;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDay(day: string): string {
  const [_, month, date] = day.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1] ?? day}${date}`;
}

function formatEventLine(event: BrainEvent): string {
  const day = event.ts.slice(0, 10);
  const precision = event.ts_precision;
  const detail = event.detail ? ` — ${event.detail}` : "";
  const sentiment = event.sentiment ? ` (${event.sentiment})` : "";
  return `[${formatDay(day)}, ${precision}] ${iconForCategory(event.category)} ${event.what}${detail}${sentiment}`;
}

function iconForCategory(category: string): string {
  switch (category) {
    case "vehicle":
      return "🚗";
    case "travel":
      return "✈️";
    case "shopping":
      return "🛒";
    case "work":
      return "💼";
    case "health":
      return "🏥";
    case "social":
      return "👥";
    case "entertainment":
      return "🎬";
    case "events":
      return "📅";
    case "pets":
      return "🐕";
    case "viewpoint":
      return "💭";
    case "sentiment":
      return "❤️";
    default:
      return "📦";
  }
}

function shiftLocalDays(date: Date, days: number, edge: "start" | "end"): string {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return toLocalBoundary(formatLocalDate(shifted), edge);
}

function toLocalBoundary(input: string, edge: "start" | "end"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    const date = edge === "start"
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

function handleBrainQuiz(args: Record<string, unknown>): { content: ToolContent[] } {
  const path = memoryPath();
  if (!existsSync(path)) {
    return textResult(
      "Not enough directives to generate meaningful scenarios. Use oh-my-brain for a few sessions first."
    );
  }

  const directives = parseActiveDirectiveBullets(readFileSync(path, "utf8"));
  if (directives.length < 3) {
    return textResult(
      "Not enough directives to generate meaningful scenarios. Use oh-my-brain for a few sessions first."
    );
  }

  const category = typeof args.category === "string" ? args.category : "random";
  const scenarios = loadDecisionScenarios(projectRoot());
  const candidates =
    category === "random"
      ? scenarios
      : scenarios.filter((scenario) => scenario.category === category);
  if (candidates.length === 0) {
    return textResult(`error: no quiz scenarios available for category "${category}"`);
  }

  const scenario = candidates[Math.floor(Math.random() * candidates.length)];
  return textResult(
    JSON.stringify(
      {
        scenario: scenario.situation,
        options: scenario.options,
        hint: "Think about which directives apply here.",
        expected: scenario.expected_decision,
        relevant_directives: scenario.relevant_directives,
        instructions:
          "Answer the scenario above based on the user's rules you have loaded. Then reveal the expected answer and compare.",
      },
      null,
      2
    )
  );
}

function handleBrainDiff(args: Record<string, unknown>): { content: ToolContent[] } {
  const since = typeof args.since === "string" ? args.since : "7 days";
  const report = buildDiffReport(projectRoot(), since);
  return textResult(JSON.stringify(report, null, 2));
}

async function handleBrainConsolidate(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const staleDays =
    typeof args.stale_days === "number" && Number.isFinite(args.stale_days)
      ? args.stale_days
      : 30;
  const report = await consolidateProject(projectRoot(), { staleDays });
  return textResult(renderConsolidationReport(report));
}

function handleBrainGrowth(): { content: ToolContent[] } {
  const snapshot = buildGrowthSnapshot(projectRoot());
  return textResult(renderGrowthSnapshot(snapshot));
}

async function handleBrainReflect(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const action = typeof args.action === "string" ? args.action : "list";

  if (action === "list") {
    const status =
      typeof args.status === "string" ? args.status : "pending";
    const proposals = listReflectionProposals(
      projectRoot(),
      status as "pending" | "resolved" | "dismissed" | "all"
    );
    return textResult(renderReflectionProposals(proposals));
  }

  const rawId = typeof args.id === "string" ? args.id : "";
  if (!rawId) {
    return textResult("error: id is required for approve/dismiss");
  }
  const id = resolveReflectionProposalId(projectRoot(), rawId);
  if (!id) {
    return textResult(`error: reflection proposal not found: ${rawId}`);
  }

  if (action === "approve") {
    const result = await approveReflectionProposal(projectRoot(), id);
    if (!result) {
      return textResult(`error: reflection proposal is not pending: ${rawId}`);
    }
    return textResult(`approved ${id}: ${result.note}`);
  }

  if (action === "dismiss") {
    const result = dismissReflectionProposal(projectRoot(), id);
    if (!result) {
      return textResult(`error: reflection proposal is not pending: ${rawId}`);
    }
    return textResult(`dismissed ${id}`);
  }

  return textResult(`error: unknown reflect action "${action}"`);
}

async function handleBrainSaveProcedure(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const trigger = typeof args.trigger === "string" ? args.trigger.trim() : "";
  if (!title) return textResult("error: title is required");
  if (!trigger) return textResult("error: trigger is required");

  const root = projectRoot();
  const sessionPath = findSessionJsonl(root);
  if (!sessionPath) {
    return textResult("error: no active session found");
  }

  const entries = parseSessionEntries(sessionPath);
  const sessionId = sessionPath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";

  // Convert SessionEntry[] to SimpleMessage[] for extractProcedure
  const messages = entries
    .filter((e) => e.message)
    .map((e) => {
      const msg = e.message!;
      const content = typeof msg.content === "string"
        ? msg.content
        : extractTextContent(msg.content);
      // Map tool_result type entries to "tool" role
      const role = e.type === "tool_result" ? "tool" as const : msg.role;
      return { role, content };
    });

  const procedure = extractProcedure(messages, title, trigger, sessionId);
  const store = new ProcedureStore(resolveSystemRoot(root));
  store.append(procedure);

  const stepCount = procedure.steps.length;
  const pitfallCount = procedure.pitfalls.length;
  return textResult(
    `Procedure '${title}' saved as candidate (${stepCount} steps, ${pitfallCount} pitfalls). ` +
    `Use brain_procedures action=approve id=${procedure.id} to approve.`
  );
}

async function handleBrainProcedures(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const action = typeof args.action === "string" ? args.action : "list";
  const root = projectRoot();
  const store = new ProcedureStore(resolveSystemRoot(root));

  if (action === "list") {
    const all = store.getAll();
    if (all.length === 0) {
      return textResult("no procedures saved yet");
    }
    const lines = all.map((p) => {
      const stepCount = p.steps.length;
      return `${p.id} [${p.status}] ${p.title} (${stepCount} steps, trigger: "${p.trigger}")`;
    });
    return textResult(`${all.length} procedure(s):\n\n${lines.join("\n")}`);
  }

  if (action === "approve" || action === "archive") {
    const rawId = typeof args.id === "string" ? args.id.trim() : "";
    if (!rawId) return textResult(`error: id is required for action=${action}`);

    const all = store.getAll();
    const match = all.find((p) => p.id === rawId || p.id.startsWith(rawId));
    if (!match) return textResult(`error: no procedure matches "${rawId}"`);

    const newStatus = action === "approve" ? "approved" : "archived";
    const updated = store.updateStatus(match.id, newStatus);
    if (!updated) return textResult(`error: failed to update procedure ${rawId}`);

    return textResult(`procedure '${match.title}' → ${newStatus}`);
  }

  return textResult(`error: unknown procedures action "${action}"`);
}

// ── v2 .brain/ handlers ─────────────────────────────────────────

async function handleBrainHandoff(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  if (!hasBrainDir(root)) {
    return textResult("error: .brain/ not found. Run brain_migrate first.");
  }

  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) return textResult("error: summary is required");

  const paths = resolveBrainPaths(root);
  const projectName =
    typeof args.project === "string"
      ? args.project
      : detectProject(paths, process.cwd()) ?? "default";
  const incomplete = args.incomplete === true;

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const hour = now.getHours();
  const time = hour < 12 ? "AM" : "PM";

  const entry: HandoffEntry = { date, time, summary };
  appendHandoff(paths, projectName, entry);

  // Extract episodes from handoff summary
  const domainName = detectDomain(paths, process.cwd());
  const extracted = extractEpisodesFromHandoff(summary, {
    domain: domainName,
    project: projectName,
  });
  let episodeCount = 0;
  const promoted: string[] = [];
  for (const ep of extracted) {
    // Use trackAndPromote to avoid double-counting
    const { episode, promoted: wasPromoted, skillPath } = trackAndPromote(
      paths, ep.what, ep.episode_type ?? "lesson",
    );
    episodeCount++;
    if (wasPromoted && skillPath) {
      promoted.push(episode.what);
    }
  }

  // Save last session state
  saveLastSession(paths, {
    domain: domainName,
    project: projectName,
    timestamp: now.toISOString(),
    incomplete,
  });

  refreshMemoryMd(root, process.cwd());

  // Auto-generate skill from complex tasks (5+ tool calls, Hermes-style)
  const toolCallCount = typeof args.tool_call_count === "number" ? args.tool_call_count : 0;
  const procedureSummary = typeof args.procedure_summary === "string" ? args.procedure_summary : undefined;
  let skillGenerated: string | null = null;

  if (toolCallCount >= 5 && !incomplete && procedureSummary) {
    const complexEpisode: Episode = {
      id: `ep_${Date.now().toString(36)}_complex`,
      what: procedureSummary,
      detail: summary,
      episode_type: "pattern",
      tags: extractTags(procedureSummary),
      frequency: 3, // auto-promote complex tasks
      date: new Date().toISOString().slice(0, 10),
      domain: domainName,
      project: projectName,
    };
    saveEpisode(paths, complexEpisode);
    skillGenerated = generateSkillFromEpisode(paths, complexEpisode);
  }

  let msg = `handoff written to .brain/projects/${projectName}.md`;
  if (incomplete) msg += " (marked incomplete)";
  if (episodeCount > 0) msg += `. ${episodeCount} episode(s) extracted.`;
  if (skillGenerated) {
    msg += ` SKILL GENERATED: ${skillGenerated}`;
  }
  if (promoted.length > 0 && !skillGenerated) {
    msg += ` SKILL CANDIDATE: "${promoted[0]}" appeared 3+ times.`;
  }
  return textResult(msg);
}

async function handleBrainProjectsList(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  if (!hasBrainDir(root)) {
    return textResult("no .brain/ found. Run brain_migrate to create one.");
  }

  const paths = resolveBrainPaths(root);
  const projects = listProjects(paths);
  if (projects.length === 0) return textResult("no projects in .brain/projects/");

  const infos = projects
    .map((p) => parseProjectInfo(paths, p))
    .filter(Boolean);

  return textResult(JSON.stringify(infos, null, 2));
}

async function handleBrainRefresh(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  if (!hasBrainDir(root)) {
    return textResult("no .brain/ found. Nothing to refresh.");
  }
  refreshMemoryMd(root, process.cwd());
  const audit = auditBrain(root);
  return textResult(`MEMORY.md refreshed (~${audit.memoryMdTokenEstimate} tokens). ` +
    `${audit.identityLines} identity rules, ${audit.codingLines} coding rules, ${audit.domainCount} domains, ${audit.projectCount} projects.`);
}

async function handleBrainMigrate(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  if (hasBrainDir(root)) {
    return textResult(".brain/ already exists. Migration not needed.");
  }
  const stats = migrateToBrain(root);
  return textResult(
    `Migration complete: ${stats.migrated} directives migrated.\n` +
    `  identity: ${stats.identity}\n` +
    `  goals: ${stats.goals}\n` +
    `  domains: ${stats.domains}\n` +
    `  projects: ${stats.projects}\n` +
    `.brain/ structure created. MEMORY.md refreshed.`
  );
}

async function handleBrainAudit(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  const audit = auditBrain(root);
  if (!audit.hasBrain) {
    return textResult("no .brain/ found. Run brain_migrate to create one.");
  }
  const lines = [
    "## .brain/ Health Report",
    "",
    `Identity rules: ${audit.identityLines}`,
    `Coding rules: ${audit.codingLines}`,
    `Goals: ${audit.goalsLines}`,
    `Domains: ${audit.domainCount} (${audit.domains.join(", ") || "none"})`,
    `Projects: ${audit.projectCount} (${audit.projects.join(", ") || "none"})`,
    `Handoff entries: ${audit.handoffCount}`,
    `Last handoff: ${audit.lastHandoffDate ?? "never"}`,
    `MEMORY.md: ~${audit.memoryMdTokenEstimate} tokens`,
  ];
  return textResult(lines.join("\n"));
}

async function handleBrainExport(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  try {
    const bundle = exportBrain(root);
    return textResult(bundle);
  } catch (err) {
    return textResult(`error: ${(err as Error).message}`);
  }
}

async function handleBrainImport(args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  const bundle = typeof args.bundle === "string" ? args.bundle : "";
  if (!bundle) return textResult("error: bundle is required");
  try {
    const count = importBrain(root, bundle);
    return textResult(`imported ${count} files into .brain/. MEMORY.md refreshed.`);
  } catch (err) {
    return textResult(`error: ${(err as Error).message}`);
  }
}

async function handleBrainSkills(): Promise<{ content: ToolContent[] }> {
  const root = projectRoot();
  if (!hasBrainDir(root)) {
    return textResult("no .brain/ found. Run brain_migrate to create one.");
  }
  const paths = resolveBrainPaths(root);
  const skills = listSkills(paths);
  if (skills.length === 0) {
    return textResult("no skills yet. Skills are auto-generated when:\n" +
      "- User corrects the same thing twice (2x correction → skill)\n" +
      "- A pattern appears 3+ times\n" +
      "- A complex task (5+ tool calls) completes successfully");
  }
  const formatted = skills.map((s) =>
    `## ${s.title}\n` +
    `Trigger: ${s.trigger}\n` +
    `Steps: ${s.procedure.length} | Pitfalls: ${s.pitfalls.length}\n` +
    `Created: ${s.created_at.slice(0, 10)} (from ${s.promoted_at_frequency}x occurrences)`
  ).join("\n\n");
  return textResult(`${skills.length} skill(s):\n\n${formatted}`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: ToolContent[] }> {
  switch (name) {
    case "brain_remember":
      return handleBrainRemember(args);
    case "brain_recall":
      return handleBrainRecall(args);
    case "brain_search":
      return handleBrainSearch(args);
    case "brain_candidates":
      return handleBrainCandidates(args);
    case "brain_retire":
      return handleBrainRetire(args);
    case "brain_status":
      return handleBrainStatus();
    case "brain_quiz":
      return handleBrainQuiz(args);
    case "brain_diff":
      return handleBrainDiff(args);
    case "brain_consolidate":
      return handleBrainConsolidate(args);
    case "brain_growth":
      return handleBrainGrowth();
    case "brain_reflect":
      return handleBrainReflect(args);
    case "brain_undo_last":
      return handleBrainUndoLast();
    case "brain_why":
      return handleBrainWhy(args);
    case "brain_types":
      return handleBrainTypes(args);
    case "brain_links":
      return handleBrainLinks(args);
    case "brain_save_procedure":
      return handleBrainSaveProcedure(args);
    case "brain_procedures":
      return handleBrainProcedures(args);
    case "brain_domains":
      return handleBrainDomains();
    case "brain_handoff":
      return handleBrainHandoff(args);
    case "brain_projects":
      return handleBrainProjectsList();
    case "brain_refresh":
      return handleBrainRefresh();
    case "brain_migrate":
      return handleBrainMigrate();
    case "brain_audit":
      return handleBrainAudit();
    case "brain_export":
      return handleBrainExport();
    case "brain_import":
      return handleBrainImport(args);
    case "brain_skills":
      return handleBrainSkills();
    default:
      return textResult(`error: unknown tool "${name}"`);
  }
}

// ── Dispatcher ───────────────────────────────────────────────────

export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
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
      const result = await callTool(params.name, params.arguments ?? {});
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
