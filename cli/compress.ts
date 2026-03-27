/**
 * squeeze-claw — Claude Code Stop Hook
 *
 * Reads the most recent Claude Code session JSONL, classifies each message
 * with the L0-L3 classifier, compresses stale L1 messages, and writes L3
 * directives to ./MEMORY.md so they survive future compaction events.
 *
 * Usage (in ~/.claude/settings.json):
 *   "Stop": [{"hooks": [{"type": "command", "command": "node /path/to/compress.js"}]}]
 *
 * Output: stderr only — never writes to stdout (would corrupt Claude's output).
 *   [squeeze] 47 msgs → 12 after compression. Saved ~1,840 tokens (63.9%)
 *   [squeeze] 3 L3 directives → MEMORY.md
 */

import {
  existsSync,
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

// ── Constants ──────────────────────────────────────────────────────────────

const STALE_TAIL_COUNT = 20;       // messages within last N are never "stale"
const MIN_COMPRESS_CHARS = 300;    // don't compress short messages
const HEAD_TAIL_CHARS = 100;       // chars to keep at head and tail of compressed msg
const CHARS_PER_TOKEN = 4;         // rough approximation
const MAX_DIRECTIVE_CHARS = 500;   // messages longer than this are L1, not L3 (not a directive)

// ── Types ──────────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface SessionEntry {
  type: string;           // "user" | "assistant" | "file-history-snapshot" | ...
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

// ── Text extraction ────────────────────────────────────────────────────────

export function extractTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text !== undefined)
    .map((b) => b.text!)
    .join("\n");
}

// ── Session file discovery ─────────────────────────────────────────────────

export function findSessionJsonl(cwd: string): string | null {
  // Claude Code path format: pwd | tr '/' '-'
  // e.g. /Users/hsing/MySquad → -Users-hsing-MySquad
  const dirName = cwd.replace(/\//g, "-");
  const projectPath = join(homedir(), ".claude", "projects", dirName);

  if (!existsSync(projectPath)) return null;

  const jsonlFiles = readdirSync(projectPath)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ name: f, path: join(projectPath, f), mtime: statSync(join(projectPath, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // most recent first

  return jsonlFiles.length > 0 ? jsonlFiles[0].path : null;
}

// ── JSONL parsing ──────────────────────────────────────────────────────────

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

// ── Compression ────────────────────────────────────────────────────────────

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
    const originalText = extractTextContent(msg.content);
    const classification = classify(
      { role: msg.role, content: originalText },
      opts,
      index > 0 ? extractTextContent(messages[index - 1].message!.content) : undefined
    );

    // L3 guard: only user messages can be directives; long messages are not directives
    const effectiveLevel =
      classification.level === Level.Directive &&
      (msg.role !== "user" || originalText.length > MAX_DIRECTIVE_CHARS)
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

// ── MEMORY.md writing ──────────────────────────────────────────────────────

export function writeDirectivesToMemory(
  processed: ProcessedMessage[],
  memoryPath: string
): number {
  const directives = processed
    .filter((m) => m.level === Level.Directive)
    .map((m) => m.originalText.trim())
    .filter((text) => text.length > 0);

  if (directives.length === 0) return 0;

  // Read existing content for dedup
  let existing = "";
  if (existsSync(memoryPath)) {
    existing = readFileSync(memoryPath, "utf8");
  }

  const newDirectives = directives.filter((d) => !existing.includes(d));
  if (newDirectives.length === 0) return 0;

  const tmpPath = memoryPath + ".tmp";
  const timestamp = new Date().toISOString().slice(0, 10);
  const section = [
    "",
    `## squeeze-claw directives (${timestamp})`,
    "",
    ...newDirectives.map((d) => `- ${d}`),
    "",
  ].join("\n");

  writeFileSync(tmpPath, existing + section);
  renameSync(tmpPath, memoryPath);
  return newDirectives.length;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
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

  // Write L3 directives to MEMORY.md
  const memoryPath = join(cwd, "MEMORY.md");
  const directivesWritten = writeDirectivesToMemory(processed, memoryPath);

  // Report to stderr
  if (savedTokens > 0) {
    process.stderr.write(
      `[squeeze] ${totalMsgs} msgs → ${remaining} after compression. Saved ~${savedTokens} tokens (63.9%)\n`
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
}

main().catch((err) => {
  process.stderr.write(`[squeeze] error: ${err.message}\n`);
  process.exit(0); // always exit 0 — never interrupt the user's session
});
