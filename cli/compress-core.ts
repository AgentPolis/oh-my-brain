import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { classify } from "../src/triage/classifier.js";
import { Level } from "../src/types.js";
import { writeLatestAudit } from "./audit.js";
import {
  ingestCandidates,
  loadCandidateStore,
  pendingCount,
  saveCandidateStore,
} from "./candidates.js";
import { scanForTypeCandidates } from "./types-store.js";
import { scanForLinkCandidates } from "./links-store.js";
import { withLock } from "./lockfile.js";

const STALE_TAIL_COUNT = 20;
const MIN_COMPRESS_CHARS = 300;
const HEAD_TAIL_CHARS = 100;
const CHARS_PER_TOKEN = 4;
const MAX_DIRECTIVE_CHARS = 500;

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
  - queues soft signals (corrections, preferences) into .squeeze/candidates.json
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

const MEMORY_CANDIDATE_PATTERNS = [
  /\b(should|shouldn't|needs? to|must not|too much|too many|reduce|improve|fix|wrong)\b/i,
  /(應該|不應該|不要|別再|太多|太少|搞錯|改善|改成|保持|一律|永遠|都要|需要|不能|希望)/,
  /(提醒很多|有點吵|太擠|太亂|簡化一點)/,
];

interface NormalizedContent {
  text: string;
  syntheticRole?: "tool";
}

export interface WriteMetadata {
  source: "claude" | "codex";
  sessionId?: string;
  logPath?: string;
}

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
  const cleaned = directiveTexts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return 0;

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
  if (!existsSync(memoryPath)) return 0;

  try {
    return withLock(memoryPath, () => performRetireDirective(memoryPath, needle));
  } catch (err) {
    process.stderr.write(
      `[brain] warning: MEMORY.md lock unavailable (${(err as Error).message}). Retiring without lock.\n`
    );
    return performRetireDirective(memoryPath, needle);
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
  const newDirectives = cleaned.filter((d) => !existingDirectives.has(d));
  if (newDirectives.length === 0) return 0;

  const tmpPath = memoryPath + ".tmp";
  const timestamp = new Date().toISOString().slice(0, 10);
  const sourceTag = metadata?.source ?? "unknown";
  const sessionTag = metadata?.sessionId ? ` session:${metadata.sessionId}` : "";
  // Heading format is "## oh-my-brain directives (YYYY-MM-DD) [source:...]".
  // The audit parser and parseExistingDirectives also accept the legacy
  // "squeeze-claw directives" prefix so files from v0.1 keep working.
  const section = [
    "",
    `## oh-my-brain directives (${timestamp}) [source:${sourceTag}${sessionTag}]`,
    "",
    ...newDirectives.map((d) => `- [${sourceTag}${sessionTag ? ` ${metadata!.sessionId}` : ""}] ${d}`),
    "",
  ].join("\n");

  writeFileSync(tmpPath, existing + section);
  renameSync(tmpPath, memoryPath);
  return newDirectives.length;
}

export function writeDirectivesToMemory(
  processed: ProcessedMessage[],
  memoryPath: string,
  metadata?: WriteMetadata
): number {
  const directives = processed
    .filter((m) => m.level === Level.Directive)
    .map((m) => m.originalText.trim())
    .filter((text) => text.length > 0);

  // Delegate to the shared append path so both session-driven writes and
  // candidate-approval writes go through exactly the same dedup + format.
  return appendDirectivesToMemory(directives, memoryPath, metadata);
}

export function appendProjectRunLog(
  projectRoot: string,
  record: Record<string, unknown>
): string {
  const logDir = join(projectRoot, ".squeeze");
  const logPath = join(logDir, "runs.jsonl");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(logPath, `${JSON.stringify(record)}\n`, { flag: "a" });
  return logPath;
}

export async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write("oh-my-brain 0.3.0\n");
    return;
  }

  const cwd = process.cwd();
  const sessionPath = findSessionJsonl(cwd);

  if (!sessionPath) {
    process.stderr.write(`[brain] no session found for ${cwd}\n`);
    return;
  }

  const entries = parseSessionEntries(sessionPath);
  const processed = processMessages(entries);

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

  const memoryPath = join(cwd, "MEMORY.md");
  const sessionId = sessionPath.split("/").pop()?.replace(".jsonl", "") ?? sessionPath;
  const directivesWritten = writeDirectivesToMemory(processed, memoryPath, {
    source: "claude",
    sessionId,
  });
  const memoryCandidates = extractMemoryCandidates(processed);

  // Persist candidates across runs so `squeeze-candidates list` can show them
  // and the user can approve/reject later. Previously, candidates only lived
  // in the ephemeral run log and disappeared after LATEST.md rotated.
  const candidateStore = loadCandidateStore(cwd);
  const newCandidates = ingestCandidates(candidateStore, memoryCandidates, {
    source: "claude",
    sessionId,
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
  } catch (err) {
    process.stderr.write(
      `[brain] ontology scan skipped: ${(err as Error).message}\n`
    );
  }
}
