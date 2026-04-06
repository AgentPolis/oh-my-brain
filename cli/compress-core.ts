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

const STALE_TAIL_COUNT = 20;
const MIN_COMPRESS_CHARS = 300;
const HEAD_TAIL_CHARS = 100;
const CHARS_PER_TOKEN = 4;
const MAX_DIRECTIVE_CHARS = 500;

export const HELP_TEXT = `squeeze-compress

Hook-first context compression for Claude Code / OpenClaw-style session logs.

Usage:
  squeeze-compress
  squeeze-compress --help
  squeeze-compress --version

Behavior:
  - looks for the latest Claude Code session JSONL for the current cwd
  - classifies messages into L0-L3
  - compresses stale L1 observations
  - writes new L3 directives into ./MEMORY.md

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

    const effectiveLevel =
      classification.level === Level.Directive &&
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

  for (const rawLine of existing.split("\n")) {
    const line = rawLine.trimEnd();
    // Match bullets of the form "- [..anything..] body text"
    const match = line.match(/^-\s+\[[^\]]*\]\s+(.+)$/);
    if (match) {
      const body = match[1].trim();
      if (body.length > 0) directives.add(body);
    }
  }
  return directives;
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

  if (directives.length === 0) return 0;

  let existing = "";
  if (existsSync(memoryPath)) {
    existing = readFileSync(memoryPath, "utf8");
  }

  // Parse existing directive bodies from bullet lines like "- [source session:id] directive text".
  // Use exact-line comparison instead of substring `includes()` so that "always use TDD"
  // does NOT block "always use TDD strict mode" from being written.
  const existingDirectives = parseExistingDirectives(existing);
  const newDirectives = directives.filter((d) => !existingDirectives.has(d));
  if (newDirectives.length === 0) return 0;

  const tmpPath = memoryPath + ".tmp";
  const timestamp = new Date().toISOString().slice(0, 10);
  const sourceTag = metadata?.source ?? "unknown";
  const sessionTag = metadata?.sessionId ? ` session:${metadata.sessionId}` : "";
  const section = [
    "",
    `## squeeze-claw directives (${timestamp}) [source:${sourceTag}${sessionTag}]`,
    "",
    ...newDirectives.map((d) => `- [${sourceTag}${sessionTag ? ` ${metadata!.sessionId}` : ""}] ${d}`),
    "",
  ].join("\n");

  writeFileSync(tmpPath, existing + section);
  renameSync(tmpPath, memoryPath);
  return newDirectives.length;
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
    process.stdout.write("squeeze-claw 0.1.0\n");
    return;
  }

  const cwd = process.cwd();
  const sessionPath = findSessionJsonl(cwd);

  if (!sessionPath) {
    process.stderr.write(`[squeeze] no session found for ${cwd}\n`);
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
      `[squeeze] ${totalMsgs} msgs → ${remaining} after compression. Saved ~${savedTokens} tokens (${savedPercent}% chars)\n`
    );
  }
  if (directivesWritten > 0) {
    process.stderr.write(
      `[squeeze] ${directivesWritten} L3 directive${directivesWritten === 1 ? "" : "s"} → MEMORY.md\n`
    );
  }
  if (savedTokens === 0 && directivesWritten === 0) {
    process.stderr.write(`[squeeze] ${totalMsgs} msgs scanned. Nothing to compress.\n`);
  }
  if (directivesWritten === 0 && memoryCandidates.length > 0) {
    process.stderr.write(
      `[squeeze] ${memoryCandidates.length} memory candidate${memoryCandidates.length === 1 ? "" : "s"} flagged for review in .squeeze/LATEST.md\n`
    );
  }
  if (directivesWritten > 0) {
    process.stderr.write(`[squeeze] provenance logged → ${projectLogPath}\n`);
  }
}
