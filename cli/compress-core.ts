import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { resolveMemoryPath, resolveMemoryScope, resolveSystemRoot } from "../src/scope.js";
import { classify } from "../src/triage/classifier.js";
import { persistDirectives } from "../src/storage/directives.js";
import { Level } from "../src/types.js";
import { writeLatestAudit } from "./audit.js";
import {
  ingestCandidates,
  loadCandidateStore,
  pendingCount,
  saveCandidateStore,
} from "./candidates.js";
import { scanForTypeCandidates } from "./types-store.js";
import { jaccard, scanForLinkCandidates, tokenSet } from "./links-store.js";
import { withLock } from "./lockfile.js";
import { hasBrainDir, brainRemember, refreshMemoryMd, resolveBrainPaths } from "./brain-store.js";

/**
 * Resolve the canonical hidden system state directory.
 */
function resolveSqueezeDir(projectRoot: string): string {
  return resolveSystemRoot(projectRoot);
}
import { ArchiveStore, extractTags } from "../src/storage/archive.js";
import { EventStore, type BrainEvent } from "../src/storage/events.js";
import { TimelineIndex } from "../src/storage/timeline.js";
import { extractEvents } from "./event-extractor.js";
import { detectHabits, loadHabits, saveHabits } from "./habit-detector.js";
import { detectRelationSignals, RelationStore, updateRelation, upsertInfluenceRelation } from "./relation-store.js";
import { detectSchemas, SchemaStore } from "./schema-detector.js";
import { consolidateProject } from "./consolidate.js";
import { scanSessionForFailures } from "../src/outcome/detector.js";
import { maybeReflect } from "./llm-reflect.js";
import { OutcomeStore } from "../src/storage/outcomes.js";
import { buildGrowthOneLiner, detectChinese } from "../src/growth/one-liner.js";
import type { SessionStats } from "../src/types.js";
import { autoCreateDomains, loadDomainProfiles, routeToDomain, countDirectivesPerDomain, tokenize, stem } from "../src/triage/domain-router.js";

const STALE_TAIL_COUNT = 20;
const MIN_COMPRESS_CHARS = 300;
const HEAD_TAIL_CHARS = 100;
const CHARS_PER_TOKEN = 4;
const MAX_DIRECTIVE_CHARS = 500;
const MERGE_SCAN_THRESHOLD = 15;
const MERGE_NEGATION_MARKERS = [
  "never",
  "don't",
  "do not",
  "not",
  "avoid",
  "不要",
  "別",
  "不",
];

export const HELP_TEXT = `brain-compress (oh-my-brain)

Hook-first importance-aware memory for Claude Code session logs. Formerly
squeeze-compress. Classifies every message by importance, compresses stale
observations, and protects your explicit rules from ever being forgotten.

Usage:
  brain-compress
  brain-compress --help
  brain-compress --version

Behavior:
  - looks for the latest Claude Code session JSONL for the current cwd
  - classifies messages into L0 (discard), L1 (observation), L2
    (preference), L3 (directive)
  - compresses stale L1 observations
  - writes new L3 directives into ./MEMORY.md
  - queues soft signals (corrections, preferences) into .brain/system/candidates.json
    for review via brain-candidates list/approve/reject

Notes:
  - output is written to stderr so it is safe for hook usage
  - if no session is found, the command exits 0 without interrupting the user flow
`;

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: string | ContentBlock[];
  tool_name?: string;
  is_error?: boolean;
}

interface SessionEntry {
  type: string;
  cwd?: string;
  sessionId?: string;
  message?: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
  };
}

interface ProcessedMessage {
  index: number;
  role: "user" | "assistant";
  originalText: string;
  compressedText: string;
  level: Level;
  wasCompressed: boolean;
}

interface ArchiveWriteResult {
  appended: number;
  skipped: number;
  bounds: { earliest: string; latest: string } | null;
}

interface EventWriteResult {
  appended: number;
  skipped: number;
}

interface HabitWriteResult {
  detected: number;
  candidates: string[];
}

interface RelationWriteResult {
  updated: number;
  total: number;
  highTrust: number;
}

interface SchemaWriteResult {
  detected: number;
  total: number;
  candidates: string[];
}

// ── Domain memory types and helpers ──────────────────────────────

/**
 * Represents a resolved memory file path with its domain label.
 * domain is "work", "life", etc. for domain files, or "_flat" for legacy MEMORY.md.
 */
export interface DomainMemoryPath {
  domain: string; // "work", "life", or "_flat" for legacy
  path: string;   // absolute path to .md file
}

/**
 * Resolve memory file paths for a project.
 * - If memory/ dir exists with .md files, return those sorted alphabetically.
 * - If memory/ doesn't exist, fall back to MEMORY.md as { domain: "_flat" }.
 * - Returns empty array if nothing exists.
 */
export function resolveMemoryPaths(projectRoot: string): DomainMemoryPath[] {
  const memoryDir = join(projectRoot, "memory");

  if (existsSync(memoryDir)) {
    const files = readdirSync(memoryDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    return files.map((f) => ({
      domain: basename(f, ".md"),
      path: join(memoryDir, f),
    }));
  }

  const flatPath = resolveMemoryPath(projectRoot);
  if (existsSync(flatPath)) {
    return [{ domain: "_flat", path: flatPath }];
  }

  return [];
}

/**
 * Generate MEMORY.md shim from domain files in memory/*.md.
 * Merges all domain files alphabetically with an auto-generated header.
 * Atomic write via tmp file + rename.
 */
export function generateMemoryShim(projectRoot: string): void {
  // v2: use .brain/ assembler when available
  if (hasBrainDir(projectRoot)) {
    refreshMemoryMd(projectRoot, process.cwd());
    return;
  }

  const memoryDir = join(projectRoot, "memory");
  if (!existsSync(memoryDir)) return;

  const files = readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  if (files.length === 0) return;

  const parts: string[] = [
    "<!-- Auto-generated from memory/*.md — edit domain files directly -->",
  ];

  for (const f of files) {
    const content = readFileSync(join(memoryDir, f), "utf8");
    parts.push(content.trimEnd());
  }

  const merged = parts.join("\n\n") + "\n";
  const outputPath = resolveMemoryPath(projectRoot);
  const tmpPath = outputPath + ".tmp";
  writeFileSync(tmpPath, merged, "utf8");
  renameSync(tmpPath, outputPath);
}

const MEMORY_CANDIDATE_PATTERNS = [
  // EN: recommendations, requirements, complaints, corrections
  /\b(should|shouldn't|needs? to|must not|too much|too many|reduce|improve|fix|wrong)\b/i,
  /\b(not what I|that's not|no[,.]? (it|that|this)|actually[,.]? (it|I|we|the)|wait[,.]? (no|that))\b/i,
  /\b(I meant|I said|you('re| are) (wrong|confused|mistaken)|why (did|would) you)\b/i,
  /\b(don't|do not|stop) (do|mak|add|us|put|writ)\w*\b/i,
  // CJK: corrections, complaints, feedback (language-neutral CJK patterns)
  /(應該|不應該|不要|別再|太多|太少|搞錯|改善|改成|保持|一律|永遠|都要|需要|不能|希望)/,
  /(不對|不是這樣|搞錯了|為什麼要|怎麼會|沒有意義|糟糕|方向錯)/,
  /(提醒很多|有點吵|太擠|太亂|簡化一點)/,
  // JP/KR basic correction signals
  /(違う|間違|なんで|おかしい|아니|틀렸|왜 그런)/,
];

interface NormalizedContent {
  text: string;
  syntheticRole?: "tool";
}

export interface WriteMetadata {
  source: string;
  sessionId?: string;
  logPath?: string;
  guardSource?: "compress" | "mcp" | "candidates";
  targetDomain?: string;  // Skip auto-routing, write to this domain directly
}

export function extractEventTime(text: string, fallback: string): string {
  const absoluteMatch = text.match(
    /\b(?:on\s+)?([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\b/
  );
  if (absoluteMatch) {
    const normalized = absoluteMatch[1].replace(/(\d)(st|nd|rd|th)\b/g, "$1");
    const parts = normalized.match(/^([A-Z][a-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
    if (parts) {
      const monthNames = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
      ];
      const monthIndex = monthNames.indexOf(parts[1].toLowerCase());
      if (monthIndex >= 0) {
        const day = Number(parts[2]);
        const year = Number(parts[3] ?? new Date(fallback).getUTCFullYear());
        return new Date(Date.UTC(year, monthIndex, day)).toISOString();
      }
    }

    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return new Date(
        Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
      ).toISOString();
    }
  }

  const fallbackDate = new Date(fallback);
  if (Number.isNaN(fallbackDate.getTime())) return fallback;
  const lower = text.toLowerCase();
  if (/\byesterday\b/.test(lower)) {
    return new Date(fallbackDate.getTime() - 24 * 60 * 60 * 1000).toISOString();
  }
  if (/\blast week\b/.test(lower)) {
    return new Date(fallbackDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (/\blast month\b/.test(lower)) {
    const shifted = new Date(fallbackDate);
    shifted.setMonth(shifted.getMonth() - 1);
    return shifted.toISOString();
  }

  return fallback;
}

export interface MergeCandidate {
  a: string;
  b: string;
  merged: string;
  rationale: string;
}

interface BlockedEntry {
  ts: string;
  text: string;
  reason: string;
  session: string;
  source: "compress" | "mcp" | "candidates";
}

const INJECTION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bignore\s+(all\s+)?previous\s+instructions\b/i,
    reason: "system prompt override",
  },
  { pattern: /\bsystem\s*:\s/i, reason: "system prompt override" },
  { pattern: /\byou\s+are\s+now\b/i, reason: "system prompt override" },
  { pattern: /\bact\s+as\b/i, reason: "system prompt override" },
  { pattern: /\bforget\s+(everything|all|what)\b/i, reason: "system prompt override" },
  { pattern: /\b(curl|wget|fetch)\s+https?:/i, reason: "exfiltration attempt" },
  {
    pattern: /\bsend\s+(to|via)\s+(email|slack|webhook|http)/i,
    reason: "exfiltration attempt",
  },
  { pattern: /[\u200b\u200c\u200d\u2060\ufeff]/, reason: "invisible unicode" },
  { pattern: /<script\b/i, reason: "html/script injection" },
  { pattern: /<iframe\b/i, reason: "html/script injection" },
  { pattern: /javascript:/i, reason: "html/script injection" },
];

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateInline(text: string, maxChars = 300): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

export function scanForInjection(text: string): { safe: boolean; reason?: string } {
  for (const entry of INJECTION_PATTERNS) {
    if (entry.pattern.test(text)) {
      return { safe: false, reason: entry.reason };
    }
  }
  return { safe: true };
}

export function logBlocked(squeezePath: string, entry: BlockedEntry): void {
  mkdirSync(squeezePath, { recursive: true });
  appendFileSync(join(squeezePath, "guard-blocked.jsonl"), `${JSON.stringify(entry)}\n`);
}

function evaluateInjectionGuard(
  projectRoot: string,
  text: string,
  sessionId: string | undefined,
  source: "compress" | "mcp" | "candidates",
  warn: boolean
): { safe: boolean } {
  try {
    const result = scanForInjection(text);
    if (result.safe) return { safe: true };

    logBlocked(resolveSqueezeDir(projectRoot), {
      ts: new Date().toISOString(),
      text,
      reason: result.reason ?? "blocked",
      session: sessionId ?? "unknown",
      source,
    });
    if (warn) {
      process.stderr.write(
        `[brain] warning: blocked directive "${truncateInline(text, 120)}" (${result.reason ?? "blocked"})\n`
      );
    }
    return { safe: false };
  } catch (err) {
    if (warn) {
      process.stderr.write(
        `[brain] warning: injection guard failed for "${truncateInline(text, 120)}": ${(err as Error).message}\n`
      );
    }
    return { safe: true };
  }
}

function flattenToolResultContent(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;

  return content
    .map((block) => {
      if (block.type === "text" && block.text) {
        return block.text;
      }
      if (block.type === "tool_reference" && block.tool_name) {
        return `[tool_reference:${block.tool_name}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeContent(content: string | ContentBlock[]): NormalizedContent {
  if (typeof content === "string") {
    return { text: content };
  }

  const parts: string[] = [];
  let syntheticRole: "tool" | undefined;
  let hasVisibleText = false;

  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
      hasVisibleText = true;
      continue;
    }

    if (block.type === "tool_result") {
      const toolResultText = flattenToolResultContent(block.content);
      const prefix = block.is_error ? "[tool_result:error]" : "[tool_result]";
      if (toolResultText) {
        parts.push(`${prefix} ${toolResultText}`);
      } else {
        parts.push(prefix);
      }
      syntheticRole = "tool";
      continue;
    }

    if (block.type === "tool_use") {
      const toolName = block.name ?? "unknown";
      const inputText = truncateInline(stringifyUnknown(block.input), 240);
      parts.push(inputText ? `[tool_use:${toolName}] ${inputText}` : `[tool_use:${toolName}]`);
      if (!hasVisibleText) {
        syntheticRole = "tool";
      }
      continue;
    }

    if (block.type === "thinking") {
      continue;
    }
  }

  return {
    text: parts.filter(Boolean).join("\n"),
    syntheticRole,
  };
}

export function extractTextContent(content: string | ContentBlock[]): string {
  return normalizeContent(content).text;
}

export function findSessionJsonl(cwd: string): string | null {
  const explicitSession = process.env.SQUEEZE_SESSION_FILE;
  if (explicitSession) {
    return existsSync(explicitSession) ? explicitSession : null;
  }

  const projectsRoot =
    process.env.SQUEEZE_CLAUDE_PROJECTS_DIR ||
    join(homedir(), ".claude", "projects");

  const dirName = cwd.replace(/\//g, "-");
  const projectPath = join(projectsRoot, dirName);

  if (!existsSync(projectPath)) return null;

  const jsonlFiles = readdirSync(projectPath)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ name: f, path: join(projectPath, f), mtime: statSync(join(projectPath, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  return jsonlFiles.length > 0 ? jsonlFiles[0].path : null;
}

export function parseSessionEntries(filePath: string): SessionEntry[] {
  const raw = readFileSync(filePath, "utf8");
  const entries: SessionEntry[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as SessionEntry);
    } catch {
      // Partially-written final line — skip silently
    }
  }
  return entries;
}

function compressText(text: string): string {
  if (text.length <= MIN_COMPRESS_CHARS) return text;
  const head = text.slice(0, HEAD_TAIL_CHARS);
  const tail = text.slice(-HEAD_TAIL_CHARS);
  const saved = text.length - HEAD_TAIL_CHARS * 2;
  return `${head}…[compressed ${saved} chars]…${tail}`;
}

export function processMessages(entries: SessionEntry[]): ProcessedMessage[] {
  const messages = entries.filter(
    (e) => (e.type === "user" || e.type === "assistant") && e.message
  );

  const total = messages.length;
  const opts = { confidenceThreshold: 0.5, mode: "regex" as const };

  return messages.map((entry, index) => {
    const msg = entry.message!;
    const normalized = normalizeContent(msg.content);
    const originalText = normalized.text;
    const effectiveRole = normalized.syntheticRole ?? msg.role;
    const previousNormalized =
      index > 0 ? normalizeContent(messages[index - 1].message!.content) : undefined;
    const classification = classify(
      { role: effectiveRole, content: originalText },
      opts,
      previousNormalized?.text
    );

    // Apply the "only user messages can be durable memory" guard. Both L3
    // directives and L2 preferences are downgraded to L1 observations if
    // they originate from assistant or tool messages, or are suspiciously
    // long (likely a paragraph, not a rule).
    const isDurableLevel =
      classification.level === Level.Directive ||
      classification.level === Level.Preference;
    const effectiveLevel =
      isDurableLevel &&
      (effectiveRole !== "user" || originalText.length > MAX_DIRECTIVE_CHARS)
        ? Level.Observation
        : classification.level;

    const isStale = index < total - STALE_TAIL_COUNT;
    const shouldCompress =
      isStale &&
      effectiveLevel === Level.Observation &&
      originalText.length > MIN_COMPRESS_CHARS;

    const compressedText = shouldCompress ? compressText(originalText) : originalText;

    return {
      index,
      role: msg.role,
      originalText,
      compressedText,
      level: effectiveLevel,
      wasCompressed: shouldCompress,
    };
  });
}

function truncateCandidate(text: string, maxChars = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

export function extractMemoryCandidates(processed: ProcessedMessage[]): string[] {
  const candidates = processed
    .filter((message) => message.role === "user")
    .filter((message) => message.level !== Level.Directive)
    .filter((message) => MEMORY_CANDIDATE_PATTERNS.some((pattern) => pattern.test(message.originalText)))
    .map((message) => truncateCandidate(message.originalText))
    .filter((message) => message.length >= 20);

  return [...new Set(candidates)].slice(-3);
}

const ARCHIVE_HEADING =
  "## oh-my-brain archive (superseded directives — do not use)";

/**
 * Parse existing MEMORY.md content and return the set of directive bodies
 * already written by squeeze-claw / oh-my-brain. Bullet lines look like:
 *   "- [claude session:abc] always use TDD"
 * We extract the text after the first "] " and trim it. Lines that don't
 * match the bullet pattern are ignored (they may be human notes or other
 * content). Exact-string comparison prevents the substring-match bug where
 * "always use TDD" would block "always use TDD strict mode".
 */
export function parseExistingDirectives(existing: string): Set<string> {
  const directives = new Set<string>();
  if (!existing) return directives;

  let insideArchive = false;
  for (const rawLine of existing.split("\n")) {
    const line = rawLine.trimEnd();

    // Skip the archive section: retired directives should not block re-adding
    // the same directive later if the user changes their mind.
    if (line.trim() === ARCHIVE_HEADING) {
      insideArchive = true;
      continue;
    }
    if (insideArchive) {
      if (/^## /.test(line) && line.trim() !== ARCHIVE_HEADING) {
        insideArchive = false;
      } else {
        continue;
      }
    }

    // Match bullets of the form "- [..anything..] body text"
    const match = line.match(/^-\s+\[[^\]]*\]\s+(.+)$/);
    if (match) {
      const body = match[1].trim();
      if (body.length > 0) directives.add(body);
    }
  }
  return directives;
}

/**
 * Write an arbitrary list of directive strings to MEMORY.md, reusing the
 * same format and dedup logic as the session-driven writeDirectivesToMemory
 * path. This is the entry point used by the candidate-approval CLI — when a
 * user runs `squeeze-candidates approve <id>`, the approved candidate text
 * is passed through here to land in MEMORY.md as a first-class directive.
 */
export function appendDirectivesToMemory(
  directiveTexts: string[],
  memoryPath: string,
  metadata?: WriteMetadata
): number {
  const projectRoot = dirname(memoryPath);
  const cleaned = directiveTexts
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((text) => !isRant(text))
    .filter((text) =>
      evaluateInjectionGuard(
        projectRoot,
        text,
        metadata?.sessionId,
        metadata?.guardSource ?? "compress",
        true
      ).safe
    );
  if (cleaned.length === 0) return 0;

  // v2: route to .brain/ structured storage when available
  const projectRootDir = dirname(memoryPath);
  if (hasBrainDir(projectRootDir)) {
    let written = 0;
    for (const text of cleaned) {
      const result = brainRemember(projectRootDir, text, {
        domain: metadata?.targetDomain,
        cwd: process.cwd(),
      });
      if (result.written) written++;
    }
    return written;
  }

  // Domain mode: route to individual domain files
  // Also enters domain mode when targetDomain is explicitly specified.
  const memoryDir = join(projectRoot, "memory");
  if (
    metadata?.targetDomain ||
    (existsSync(memoryDir) && readdirSync(memoryDir).some((f) => f.endsWith(".md")))
  ) {
    return writeToDomains(cleaned, projectRoot, metadata);
  }

  // Legacy flat MEMORY.md path
  // The whole read-dedup-write sequence must run under a lock. Without the
  // lock, two concurrent writers each read the same "existing" snapshot,
  // both decide their directives are new, and the second writer's rename
  // silently clobbers the first writer's directives. This was an
  // architectural gap for a product whose core promise is "never forget".
  //
  // If the lock cannot be acquired within the timeout we fall back to an
  // unlocked write + stderr warning, because failing the user's Stop hook
  // is worse than a rare race. The lock should almost always succeed
  // because contention is limited to 1-3 agents on the same project.
  try {
    return withLock(memoryPath, () => {
      return performDirectiveWrite(cleaned, memoryPath, metadata);
    });
  } catch (err) {
    process.stderr.write(
      `[brain] warning: MEMORY.md lock unavailable (${(err as Error).message}). Writing without lock.\n`
    );
    return performDirectiveWrite(cleaned, memoryPath, metadata);
  }
}

function writeToDomains(directives: string[], projectRoot: string, metadata?: WriteMetadata): number {
  // If targetDomain specified, bypass routing
  if (metadata?.targetDomain) {
    const domainPath = join(projectRoot, "memory", `${metadata.targetDomain}.md`);
    try {
      return withLock(domainPath, () => performDirectiveWrite(directives, domainPath, metadata));
    } catch (err) {
      process.stderr.write(`[brain] warning: ${metadata.targetDomain}.md lock unavailable. Writing without lock.\n`);
      return performDirectiveWrite(directives, domainPath, metadata);
    }
  }

  const profiles = loadDomainProfiles(projectRoot);
  const counts = countDirectivesPerDomain(projectRoot);
  let written = 0;

  const routed = new Map<string, string[]>();
  for (const d of directives) {
    const domain = routeToDomain(d, profiles, counts) ?? "general";
    if (!routed.has(domain)) routed.set(domain, []);
    routed.get(domain)!.push(d);
  }

  for (const [domain, items] of routed) {
    const domainPath = join(projectRoot, "memory", `${domain}.md`);
    try {
      const w = withLock(domainPath, () => performDirectiveWrite(items, domainPath, metadata));
      written += w;
    } catch (err) {
      process.stderr.write(`[brain] warning: ${domain}.md lock unavailable. Writing without lock.\n`);
      written += performDirectiveWrite(items, domainPath, metadata);
    }
  }
  return written;
}

/**
 * Retire a directive by moving it out of the active section and into the
 * archive section at the bottom of MEMORY.md. The archive is clearly
 * labelled so that bootstrap-read consumers (runtime engines) know to
 * ignore it. This is the primary tool for preventing unbounded growth of
 * stale rules: a user who pivots from "always use TypeScript" to Rust can
 * retire the old directive instead of editing MEMORY.md by hand.
 *
 * Match strategy: we match on the bullet body text, case-insensitively,
 * by substring. This is intentionally loose so the CLI can accept short
 * prefixes like `squeeze-candidates retire "always use Type"`.
 *
 * Returns the number of directives that were retired. Zero means nothing
 * matched. The operation runs under the MEMORY.md write lock.
 */
export function retireDirective(
  memoryPath: string,
  matchText: string
): number {
  const needle = matchText.trim().toLowerCase();
  if (needle.length === 0) return 0;

  const projectRoot = dirname(memoryPath);
  const memoryDir = join(projectRoot, "memory");

  // Domain mode: retire from all domain files, then regenerate shim
  if (existsSync(memoryDir)) {
    const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    let totalRetired = 0;
    for (const f of files) {
      const domainPath = join(memoryDir, f);
      totalRetired += retireFromFile(domainPath, needle);
    }
    if (totalRetired > 0) {
      generateMemoryShim(projectRoot);
    }
    return totalRetired;
  }

  // Legacy flat mode
  if (!existsSync(memoryPath)) return 0;
  return retireFromFile(memoryPath, needle);
}

function retireFromFile(filePath: string, needle: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    return withLock(filePath, () => performRetireDirective(filePath, needle));
  } catch (err) {
    process.stderr.write(
      `[brain] warning: ${basename(filePath)} lock unavailable (${(err as Error).message}). Retiring without lock.\n`
    );
    return performRetireDirective(filePath, needle);
  }
}

function performRetireDirective(memoryPath: string, needle: string): number {
  const existing = readFileSync(memoryPath, "utf8");
  const lines = existing.split("\n");

  const retained: string[] = [];
  const retired: string[] = [];
  let insideArchive = false;
  const archiveExisting: string[] = [];

  for (const line of lines) {
    // Track when we enter/exit the archive section so we don't touch it.
    if (line.trim() === ARCHIVE_HEADING) {
      insideArchive = true;
      archiveExisting.push(line);
      continue;
    }
    if (insideArchive) {
      // Any new top-level heading ends the archive section.
      if (/^## /.test(line) && line.trim() !== ARCHIVE_HEADING) {
        insideArchive = false;
        retained.push(line);
        continue;
      }
      archiveExisting.push(line);
      continue;
    }

    // Outside archive: check whether this is a directive bullet line and,
    // if so, whether its body matches the needle.
    const match = line.match(/^-\s+\[[^\]]*\]\s+(.+)$/);
    if (match) {
      const body = match[1].trim().toLowerCase();
      if (body.includes(needle)) {
        retired.push(line);
        continue;
      }
    }
    retained.push(line);
  }

  if (retired.length === 0) return 0;

  // Rebuild the file: retained active content, then the archive section
  // (existing archive content + newly-retired bullets).
  let rebuilt = retained.join("\n").trimEnd();
  if (archiveExisting.length === 0) {
    rebuilt += `\n\n${ARCHIVE_HEADING}\n`;
  } else {
    rebuilt += `\n\n${archiveExisting.join("\n").trim()}\n`;
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  rebuilt += `\n<!-- retired ${timestamp} -->\n`;
  for (const line of retired) {
    rebuilt += `${line}\n`;
  }

  const tmpPath = memoryPath + ".tmp";
  writeFileSync(tmpPath, rebuilt);
  renameSync(tmpPath, memoryPath);
  return retired.length;
}

// ── Storage quality helpers ────────────────────────────────────────────────────

/**
 * Tokenize text for semantic dedup — like domain-router's tokenize but also
 * preserves digit sequences (including single digits) so that directives that
 * differ only by number ("rule 1" vs "rule 2") are NOT treated as duplicates.
 */
function tokenizeForSemanticDedup(text: string): string[] {
  const words = tokenize(text); // standard tokens (length > 1, no stops)
  const nums = text.match(/\d+/g) ?? [];
  return [...words, ...nums];
}

/**
 * Check if a new directive is semantically similar to any existing directive.
 * Returns true if >80% of the new directive's keywords appear in any single
 * existing directive (after stemming). Requires at least 2 meaningful keywords
 * to avoid single-token false positives.
 */
export function isSemanticDuplicate(newText: string, existingTexts: Iterable<string>): boolean {
  const newTokens = new Set(tokenizeForSemanticDedup(newText).map(stem));
  if (newTokens.size < 2) return false;

  for (const existing of existingTexts) {
    const existingTokens = new Set(tokenizeForSemanticDedup(existing).map(stem));
    let overlap = 0;
    for (const t of newTokens) {
      if (existingTokens.has(t)) overlap++;
    }
    if (overlap / newTokens.size > 0.8) return true;
  }
  return false;
}

const ONE_OFF_PATTERNS = [
  /^remove\b/i,
  /^clean\s*up\b/i,
  /^delete\b/i,
  /^fix\b/i,
  /^rename\b/i,
  /^migrate\b/i,
  /^update\b.*\bto\b/i,
  /^move\b/i,
  /^replace\b.*\bwith\b/i,
  /^get rid of\b/i,
  /^stop\s+using\b/i,
];

/**
 * Detect imperative one-off tasks that are not durable rules.
 * When detected, the directive gets a [one-off] tag so consolidate
 * can prioritize retiring it.
 */
export function isOneOffTask(text: string): boolean {
  return ONE_OFF_PATTERNS.some((p) => p.test(text.trim()));
}

const RANT_SIGNALS = [
  /[？?]{2,}/,           // multiple question marks
  /[！!]{2,}/,           // multiple exclamation marks
  /怎麼還在/,            // "how is this still here"
  /該不會/,              // "don't tell me..."
  /搞什麼/,              // "what the..."
  /為什麼又/,            // "why again..."
  /到底是/,              // "what on earth..."
  /wtf/i,
  /what the hell/i,
  /are you kidding/i,
  /seriously\?/i,
];

/**
 * Detect if text is an emotional rant rather than a durable directive.
 * Requires at least 2 rant signals to avoid false positives on legitimate
 * directives that happen to contain a question mark.
 */
export function isRant(text: string): boolean {
  const signals = RANT_SIGNALS.filter((p) => p.test(text));
  return signals.length >= 2;
}

function performDirectiveWrite(
  cleaned: string[],
  memoryPath: string,
  metadata?: WriteMetadata
): number {
  let existing = "";
  if (existsSync(memoryPath)) {
    existing = readFileSync(memoryPath, "utf8");
  }

  const existingDirectives = parseExistingDirectives(existing);
  const newDirectives = cleaned
    .filter((d) => !existingDirectives.has(d))
    .filter((d) => !isSemanticDuplicate(d, existingDirectives));
  if (newDirectives.length === 0) return 0;

  const tmpPath = memoryPath + ".tmp";
  const timestamp = new Date().toISOString().slice(0, 10);
  const sourceTag = metadata?.source ?? "unknown";
  const sessionTag = metadata?.sessionId ? ` session:${metadata.sessionId}` : "";
  // Heading format is "## oh-my-brain directives (YYYY-MM-DD) [source:...]".
  // The audit parser and parseExistingDirectives also accept the legacy
  // "squeeze-claw directives" prefix so files from v0.1 keep working.
  const bullets = newDirectives.map((d) => {
    const tag = isOneOffTask(d)
      ? `${sourceTag} one-off${sessionTag ? ` ${metadata!.sessionId}` : ""}`
      : `${sourceTag}${sessionTag ? ` ${metadata!.sessionId}` : ""}`;
    return `- [${tag}] ${d}`;
  });

  // Try to merge into existing section with same date+source
  const sectionPrefix = `## oh-my-brain directives (${timestamp}) [source:${sourceTag}`;
  const lines = existing.split("\n");
  let mergeIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(sectionPrefix)) {
      // Found matching section. Find the last bullet line in this section.
      let lastBullet = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].startsWith("## ")) break; // next section
        if (lines[j].startsWith("- ")) lastBullet = j;
      }
      mergeIndex = lastBullet;
      break;
    }
  }

  if (mergeIndex >= 0) {
    // Merge: insert new bullets after the last bullet in the matching section
    lines.splice(mergeIndex + 1, 0, ...bullets);
    writeFileSync(tmpPath, lines.join("\n"));
  } else {
    // No matching section: append new section
    const section = [
      "",
      `## oh-my-brain directives (${timestamp}) [source:${sourceTag}${sessionTag}]`,
      "",
      ...bullets,
      "",
    ].join("\n");
    writeFileSync(tmpPath, existing + section);
  }

  renameSync(tmpPath, memoryPath);
  return newDirectives.length;
}

export async function writeDirectivesToMemory(
  processed: ProcessedMessage[],
  memoryPath: string,
  metadata?: WriteMetadata
): Promise<number> {
  const directives = processed
    .filter((m) => m.level === Level.Directive)
    .map((m) => ({
      directiveText: m.originalText.trim(),
      evidenceText: m.originalText,
      evidenceTurn: m.index,
      eventTime: extractEventTime(m.originalText, new Date().toISOString()),
    }))
    .filter((record) => record.directiveText.length > 0);

  const existingDirectives = existsSync(memoryPath)
    ? parseExistingDirectives(readFileSync(memoryPath, "utf8"))
    : new Set<string>();
  const newDirectiveRecords = directives.filter(
    (record) => !existingDirectives.has(record.directiveText)
  );

  // Delegate to the shared append path so both session-driven writes and
  // candidate-approval writes go through exactly the same dedup + format.
  const written = appendDirectivesToMemory(
    directives.map((record) => record.directiveText),
    memoryPath,
    metadata
  );

  if (written > 0) {
    const activeDirectives = parseExistingDirectives(readFileSync(memoryPath, "utf8"));
    await persistDirectives(dirname(memoryPath), newDirectiveRecords.filter((record) =>
      activeDirectives.has(record.directiveText)
    ));
  }

  return written;
}

function hasMergeNegation(text: string): boolean {
  const lower = text.toLowerCase();
  return MERGE_NEGATION_MARKERS.some((marker) => lower.includes(marker));
}

export function detectMergeCandidates(
  directiveBodies: string[],
  _options?: { embeddings?: Map<string, number[]> }
): MergeCandidate[] {
  const merges: MergeCandidate[] = [];
  const seen = new Set<string>();
  const tokens = directiveBodies.map((directive) => tokenSet(directive));

  for (let i = 0; i < directiveBodies.length; i += 1) {
    for (let j = i + 1; j < directiveBodies.length; j += 1) {
      const first = directiveBodies[i];
      const second = directiveBodies[j];
      if (hasMergeNegation(first) || hasMergeNegation(second)) continue;

      const firstTokens = tokens[i];
      const secondTokens = tokens[j];
      const similarity = jaccard(firstTokens, secondTokens);
      if (similarity < 0.5) continue;

      const firstSubset = Array.from(firstTokens).every((token) => secondTokens.has(token));
      const secondSubset = Array.from(secondTokens).every((token) => firstTokens.has(token));
      const strictSubset =
        (firstSubset && firstTokens.size < secondTokens.size) ||
        (secondSubset && secondTokens.size < firstTokens.size);
      if (!strictSubset) continue;

      const shorter = first.length <= second.length ? first : second;
      const longer = shorter === first ? second : first;
      const id = `${shorter}::${longer}`;
      if (seen.has(id)) continue;
      seen.add(id);
      merges.push({
        a: shorter,
        b: longer,
        merged: longer,
        rationale: `subset token overlap with ${(similarity * 100).toFixed(0)}% Jaccard similarity`,
      });
    }
  }

  return merges;
}

export function enqueueMergeCandidates(
  projectRoot: string,
  directiveBodies: string[],
  sessionId?: string
): ReturnType<typeof ingestCandidates> {
  if (directiveBodies.length <= MERGE_SCAN_THRESHOLD) return [];

  const merges = detectMergeCandidates(directiveBodies);
  if (merges.length === 0) return [];

  const candidateStore = loadCandidateStore(projectRoot);
  const created = ingestCandidates(
    candidateStore,
    merges.map((merge) => `MERGE: "${merge.a}" → "${merge.b}" (retire the shorter one)`),
    {
      source: "claude",
      sessionId,
      projectRoot,
    }
  );
  if (created.length > 0) {
    saveCandidateStore(projectRoot, candidateStore);
  }
  return created;
}

export function appendProjectRunLog(
  projectRoot: string,
  record: Record<string, unknown>
): string {
  const logDir = resolveSqueezeDir(projectRoot);
  const logPath = join(logDir, "runs.jsonl");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(logPath, `${JSON.stringify(record)}\n`, { flag: "a" });
  return logPath;
}

export function archiveCompressedMessages(
  projectRoot: string,
  processed: ProcessedMessage[],
  options: {
    sessionId: string;
    sessionStart: string;
    maxArchiveMb?: number;
  }
): ArchiveWriteResult {
  const archive = new ArchiveStore(resolveSqueezeDir(projectRoot), options.maxArchiveMb);
  const existingHashes = new Set(
    archive
      .getBySession(options.sessionId)
      .map((entry) => hashArchiveIdentity(options.sessionId, entry.role, entry.content))
  );

  const archiveEntries = processed
    .filter(
      (message): message is ProcessedMessage & { role: "user" | "assistant" } =>
        message.wasCompressed &&
        message.level === Level.Observation &&
        (message.role === "user" || message.role === "assistant")
    )
    .map((message) => ({
      id: randomUUID(),
      ts: new Date(Date.parse(options.sessionStart) + message.index * 60_000).toISOString(),
      ingest_ts: new Date().toISOString(),
      role: message.role,
      content: message.originalText,
      summary: message.compressedText,
      level: message.level,
      turn_index: message.index,
      session_id: options.sessionId,
      tags: extractTags(message.originalText),
    }));

  const deduped = archiveEntries.filter((entry) => {
    const hash = hashArchiveIdentity(options.sessionId, entry.role, entry.content);
    if (existingHashes.has(hash)) return false;
    existingHashes.add(hash);
    return true;
  });
  archive.append(deduped);

  const timeline = new TimelineIndex(resolveSqueezeDir(projectRoot));
  timeline.rebuild();

  return {
    appended: deduped.length,
    skipped: archiveEntries.length - deduped.length,
    bounds: timeline.bounds(),
  };
}

function hashArchiveIdentity(sessionId: string, role: string, content: string): string {
  return createHash("sha256")
    .update(`${sessionId}\u0000${role}\u0000${content}`)
    .digest("hex");
}

export function extractSessionEvents(
  projectRoot: string,
  processed: ProcessedMessage[],
  options: {
    sessionId: string;
    sessionDate: string;
  }
): EventWriteResult {
  const store = new EventStore(resolveSqueezeDir(projectRoot));
  const existingHashes = new Set(
    store
      .getAll()
      .filter((event) => event.session_id === options.sessionId)
      .map((event) => hashEventIdentity(options.sessionId, event.source_text))
  );

  const events: BrainEvent[] = [];
  let skipped = 0;
  for (const message of processed) {
    if (message.role !== "user") continue;
    if (message.level === Level.Discard) continue;

    const sourceHash = hashEventIdentity(options.sessionId, message.originalText);
    if (existingHashes.has(sourceHash)) {
      skipped += 1;
      continue;
    }

    const extracted = extractEvents(
      { role: message.role, content: message.originalText },
      {
        sessionId: options.sessionId,
        turnIndex: message.index,
        sessionDate: options.sessionDate,
        previousMessage:
          message.index > 0 ? processed.find((item) => item.index === message.index - 1)?.originalText : undefined,
      }
    );
    if (extracted.length > 0) {
      events.push(...extracted);
      existingHashes.add(sourceHash);
    }
  }

  store.append(events);
  return {
    appended: events.length,
    skipped,
  };
}

function hashEventIdentity(sessionId: string, sourceText: string): string {
  return createHash("sha256")
    .update(`${sessionId}\u0000${sourceText}`)
    .digest("hex");
}

export function detectAndStoreHabits(projectRoot: string): HabitWriteResult {
  const events = new EventStore(resolveSqueezeDir(projectRoot)).getAll();
  const existingHabits = loadHabits(projectRoot);
  const newHabits = detectHabits(events, existingHabits);
  if (newHabits.length > 0) {
    saveHabits(projectRoot, [...existingHabits, ...newHabits]);
  } else if (existingHabits.length > 0) {
    saveHabits(projectRoot, existingHabits);
  }
  return {
    detected: newHabits.length,
    candidates: newHabits.map((habit) => `HABIT: ${habit.pattern}`),
  };
}

export function detectAndStoreRelations(projectRoot: string, processed: ProcessedMessage[]): RelationWriteResult {
  const store = new RelationStore(resolveSqueezeDir(projectRoot));
  let updated = 0;
  for (const message of processed) {
    if (message.role !== "user") continue;
    const signals = detectRelationSignals(message.originalText);
    for (const signal of signals) {
      const before = JSON.stringify(store.getByPerson(signal.person));
      if (signal.type === "influence") {
        upsertInfluenceRelation(store, signal.person, signal.domain, signal.evidence);
      } else {
        updateRelation(store, signal.person, signal.type, signal.domain, signal.evidence);
      }
      const after = JSON.stringify(store.getByPerson(signal.person));
      if (before !== after) updated += 1;
    }
  }

  const summary = store.getSummary();
  return {
    updated,
    total: summary.total,
    highTrust: summary.high_trust,
  };
}

export function detectAndStoreSchemas(projectRoot: string): SchemaWriteResult {
  const habits = loadHabits(projectRoot);
  if (habits.length < 2) {
    const existing = new SchemaStore(resolveSqueezeDir(projectRoot)).getSummary();
    return { detected: 0, total: existing.total, candidates: [] };
  }

  const memoryPath = resolveMemoryPath(projectRoot);
  const directives = existsSync(memoryPath)
    ? Array.from(parseExistingDirectives(readFileSync(memoryPath, "utf8")))
    : [];
  const store = new SchemaStore(resolveSqueezeDir(projectRoot));
  const newSchemas = detectSchemas(habits, directives, store.getAll());
  for (const schema of newSchemas) {
    store.upsert(schema);
  }
  const summary = store.getSummary();
  return {
    detected: newSchemas.length,
    total: summary.total,
    candidates: newSchemas.map((schema) => `SCHEMA: "${schema.name}" — ${schema.steps.join(" → ")}`),
  };
}

function parseMaxArchiveMbArg(args: string[]): number | undefined {
  const index = args.indexOf("--max-archive-mb");
  if (index === -1) return undefined;
  const raw = args[index + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("oh-my-brain 0.7.0\n");
    return;
  }

  const cwd = process.cwd();

  // First-run hint (non-blocking)
  try {
    const { getCompressHookHint } = await import("./onboarding.js");
    const hint = getCompressHookHint(cwd);
    if (hint) process.stderr.write(`${hint}\n`);
  } catch {
    // onboarding module missing or broken — never block compress
  }

  const sessionPath = findSessionJsonl(cwd);
  const maxArchiveMb = parseMaxArchiveMbArg(args);

  if (!sessionPath) {
    process.stderr.write(`[brain] no session found for ${cwd}\n`);
    return;
  }

  const entries = parseSessionEntries(sessionPath);
  const processed = processMessages(entries);
  const sessionStart = statSync(sessionPath).mtime.toISOString();

  const totalMsgs = processed.length;
  const compressedCount = processed.filter((m) => m.wasCompressed).length;
  const remaining = totalMsgs - compressedCount;

  const originalChars = processed.reduce((s, m) => s + m.originalText.length, 0);
  const compressedChars = processed.reduce((s, m) => s + m.compressedText.length, 0);
  const savedTokens = Math.round((originalChars - compressedChars) / CHARS_PER_TOKEN);
  const savedPercent =
    originalChars > 0
      ? (((originalChars - compressedChars) / originalChars) * 100).toFixed(1)
      : "0.0";

  const memoryDir = join(cwd, "memory");
  if (!existsSync(memoryDir)) {
    autoCreateDomains(cwd);
  }
  // Phase 1: write path unchanged — still writes to flat MEMORY.md.
  const memoryPath = resolveMemoryPath(cwd);
  const sessionId = sessionPath.split("/").pop()?.replace(".jsonl", "") ?? sessionPath;
  const directivesWritten = await writeDirectivesToMemory(processed, memoryPath, {
    source: "claude",
    sessionId,
  });
  const archiveResult = archiveCompressedMessages(cwd, processed, {
    sessionId,
    sessionStart,
    maxArchiveMb,
  });
  const eventResult = extractSessionEvents(cwd, processed, {
    sessionId,
    sessionDate: sessionStart,
  });
  const habitResult = detectAndStoreHabits(cwd);
  const relationResult = detectAndStoreRelations(cwd, processed);
  const schemaResult = detectAndStoreSchemas(cwd);
  const memoryCandidates = [
    ...extractMemoryCandidates(processed),
    ...habitResult.candidates,
    ...schemaResult.candidates,
  ];

  // Persist candidates across runs so `squeeze-candidates list` can show them
  // and the user can approve/reject later. Previously, candidates only lived
  // in the ephemeral run log and disappeared after LATEST.md rotated.
  const candidateStore = loadCandidateStore(cwd);
  const newCandidates = ingestCandidates(candidateStore, memoryCandidates, {
    source: "claude",
    sessionId,
    projectRoot: cwd,
  });
  if (memoryCandidates.length > 0) {
    saveCandidateStore(cwd, candidateStore);
  }
  const totalPending = pendingCount(candidateStore);
  const projectLogPath = appendProjectRunLog(cwd, {
    timestamp: new Date().toISOString(),
    source: "claude",
    sessionId,
    sessionPath,
    directivesWritten,
    compressedCount,
    totalMessages: totalMsgs,
    savedTokens,
    savedPercent: Number(savedPercent),
    memoryCandidates,
  });
  writeLatestAudit(cwd);
  generateMemoryShim(cwd);

  if (savedTokens > 0) {
    process.stderr.write(
      `[brain] ${totalMsgs} msgs → ${remaining} after compression. Saved ~${savedTokens} tokens (${savedPercent}% chars)\n`
    );
  }
  if (directivesWritten > 0) {
    process.stderr.write(
      `[brain] ${directivesWritten} L3 directive${directivesWritten === 1 ? "" : "s"} → MEMORY.md\n`
    );
  }
  if (savedTokens === 0 && directivesWritten === 0) {
    process.stderr.write(`[brain] ${totalMsgs} msgs scanned. Nothing to compress.\n`);
  }
  if (archiveResult.appended > 0 || archiveResult.skipped > 0) {
    process.stderr.write(
      `[brain] archived ${archiveResult.appended} message${archiveResult.appended === 1 ? "" : "s"}`
      + `${archiveResult.skipped > 0 ? ` (${archiveResult.skipped} deduped)` : ""}, `
      + `timeline: ${archiveResult.bounds?.earliest ?? "n/a"} ~ ${archiveResult.bounds?.latest ?? "n/a"}\n`
    );
  }
  if (eventResult.appended > 0 || eventResult.skipped > 0) {
    process.stderr.write(
      `[brain] extracted ${eventResult.appended} event${eventResult.appended === 1 ? "" : "s"}`
      + `${eventResult.skipped > 0 ? ` (${eventResult.skipped} deduped)` : ""}\n`
    );
  }
  if (habitResult.detected > 0) {
    process.stderr.write(
      `[brain] detected ${habitResult.detected} habit${habitResult.detected === 1 ? "" : "s"}\n`
    );
  }
  if (relationResult.updated > 0 || relationResult.total > 0) {
    process.stderr.write(
      `[brain] relations: ${relationResult.total} total, ${relationResult.highTrust} high trust`
      + `${relationResult.updated > 0 ? ` (${relationResult.updated} updated)` : ""}\n`
    );
  }
  if (schemaResult.detected > 0 || schemaResult.total > 0) {
    process.stderr.write(
      `[brain] schemas: ${schemaResult.total} total`
      + `${schemaResult.detected > 0 ? ` (${schemaResult.detected} new)` : ""}\n`
    );
  }
  if (newCandidates.length > 0) {
    process.stderr.write(
      `[brain] ${newCandidates.length} new candidate${newCandidates.length === 1 ? "" : "s"} flagged for review (${totalPending} total pending). Run 'brain-candidates list' to review.\n`
    );
  } else if (totalPending > 0 && directivesWritten === 0) {
    process.stderr.write(
      `[brain] ${totalPending} candidate${totalPending === 1 ? "" : "s"} still awaiting review. Run 'brain-candidates list'.\n`
    );
  }
  if (directivesWritten > 0) {
    process.stderr.write(`[brain] provenance logged → ${projectLogPath}\n`);
  }

  // L2 + L3 self-growth tick: scan all current MEMORY.md directives for
  // emerging type clusters AND typed link relations. Both run cheap regex
  // heuristics with no LLM call so they're safe to run every hook
  // invocation. Either failure is non-fatal.
  try {
    const existingMemory = existsSync(memoryPath)
      ? readFileSync(memoryPath, "utf8")
      : "";
    const directiveBodies = Array.from(parseExistingDirectives(existingMemory));

    // L2: type candidates
    const newTypeCandidates = scanForTypeCandidates(cwd, directiveBodies);
    if (newTypeCandidates.length > 0) {
      process.stderr.write(
        `[brain] ${newTypeCandidates.length} new directive type${newTypeCandidates.length === 1 ? "" : "s"} proposed. Run 'brain-candidates list-types' to review.\n`
      );
    }

    // L3: link candidates
    const newLinkCandidates = scanForLinkCandidates(cwd, directiveBodies);
    if (newLinkCandidates.length > 0) {
      process.stderr.write(
        `[brain] ${newLinkCandidates.length} new directive link${newLinkCandidates.length === 1 ? "" : "s"} proposed. Run 'brain-candidates list-links' to review.\n`
      );
    }

    const newMergeCandidates = enqueueMergeCandidates(cwd, directiveBodies, sessionId);
    if (newMergeCandidates.length > 0) {
      process.stderr.write(
        `[brain] ${newMergeCandidates.length} merge proposal${newMergeCandidates.length === 1 ? "" : "s"}. Run 'brain-candidates list'.\n`
      );
    }
  } catch (err) {
    process.stderr.write(
      `[brain] ontology scan skipped: ${(err as Error).message}\n`
    );
  }

  // --- Outcome detection ---
  const squeezePath = resolveSqueezeDir(cwd);
  const outcomeStore = new OutcomeStore(squeezePath);
  const sessionMessages = processed.map((m) => ({
    role: m.role as "user" | "assistant" | "tool" | "system",
    content: m.originalText,
  }));
  const outcomes = scanSessionForFailures(sessionMessages, sessionId);
  const newOutcomes = outcomes.filter(
    (o) => !outcomeStore.isDuplicate(o.failure_mode, o.timestamp)
  );
  if (newOutcomes.length > 0) {
    outcomeStore.append(newOutcomes);
    const outcomeCandidateStore = loadCandidateStore(cwd);
    const cautionTexts = newOutcomes.map((o) => o.lesson);
    ingestCandidates(outcomeCandidateStore, cautionTexts, { source: "claude", projectRoot: cwd });
    saveCandidateStore(cwd, outcomeCandidateStore);
    process.stderr.write(
      `[brain] ${newOutcomes.length} outcome${newOutcomes.length === 1 ? "" : "s"} detected and recorded\n`
    );
  }

  // --- LLM reflection (corrections + sentiment) ---
  try {
    const userTexts = processed
      .filter((m) => m.role === "user")
      .map((m) => m.originalText);
    const reflection = maybeReflect(userTexts);
    if (reflection) {
      if (reflection.corrections.length > 0) {
        const reflectCandidateStore = loadCandidateStore(cwd);
        ingestCandidates(reflectCandidateStore, reflection.corrections, {
          source: "claude",
          sessionId,
          projectRoot: cwd,
        });
        saveCandidateStore(cwd, reflectCandidateStore);
        process.stderr.write(
          `[brain] LLM reflection: ${reflection.corrections.length} correction${reflection.corrections.length === 1 ? "" : "s"} → candidates\n`
        );
      }
      if (reflection.sentiments.length > 0) {
        mkdirSync(squeezePath, { recursive: true });
        appendFileSync(
          join(squeezePath, "sentiments.jsonl"),
          reflection.sentiments
            .map((s) => JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, text: s }))
            .join("\n") + "\n"
        );
        process.stderr.write(
          `[brain] LLM reflection: ${reflection.sentiments.length} sentiment${reflection.sentiments.length === 1 ? "" : "s"} logged\n`
        );
      }
    }
  } catch (err) {
    // LLM reflection is best-effort, never crash the hook
    process.stderr.write(`[brain] LLM reflection skipped: ${(err as Error).message}\n`);
  }

  // --- Growth one-liner ---
  const sessionStats: SessionStats = {
    new_directives: directivesWritten ?? 0,
    new_preferences: 0,
    new_outcomes: newOutcomes,
    new_procedures: 0,
  };
  const isChinese = detectChinese(sessionMessages);
  const growthLine = buildGrowthOneLiner(sessionStats, isChinese);
  if (growthLine) {
    mkdirSync(squeezePath, { recursive: true });
    appendFileSync(join(squeezePath, "growth-journal.jsonl"), JSON.stringify({
      ts: new Date().toISOString(),
      kind: "session-end",
      summary: growthLine,
      stats: sessionStats,
    }) + "\n");
    process.stderr.write(`${growthLine}\n`);
  }

  if (process.env.OH_MY_BRAIN_SKIP_AUTO_CONSOLIDATE !== "1") {
    try {
      const report = await consolidateProject(cwd, { staleDays: 30 });
      process.stderr.write(
        `[brain] offline growth: ${report.reflection.proposalsCreated} proposal${report.reflection.proposalsCreated === 1 ? "" : "s"}, `
        + `${report.consolidation.newHabits} habit${report.consolidation.newHabits === 1 ? "" : "s"}, `
        + `${report.consolidation.newSchemas} schema${report.consolidation.newSchemas === 1 ? "" : "s"}, `
        + `journal updated\n`
      );
    } catch (err) {
      process.stderr.write(
        `[brain] offline growth skipped: ${(err as Error).message}\n`
      );
    }
  }
}
