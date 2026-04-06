import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { appendProjectRunLog, extractMemoryCandidates, processMessages, writeDirectivesToMemory } from "./compress-core.js";
import { writeLatestAudit } from "./audit.js";
import { ingestCandidates, loadCandidateStore, saveCandidateStore } from "./candidates.js";

interface CodexTextBlock {
  type: string;
  text?: string;
}

interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface ClaudeCompatibleBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string | ClaudeCompatibleBlock[];
}

interface ClaudeCompatibleEntry {
  type: "user" | "assistant";
  message: {
    role: "user" | "assistant";
    content: string | ClaudeCompatibleBlock[];
  };
}

export interface CodexSessionSummary {
  sessionId: string;
  cwd: string | null;
  entries: ClaudeCompatibleEntry[];
  lastTokenUsage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface CodexSyncState {
  processed: Record<string, { mtimeMs: number; size: number }>;
}

export interface CodexSyncOptions {
  sessionsRoot?: string;
  stableMs?: number;
  statePath?: string;
  logPath?: string;
  now?: number;
}

export interface CodexSyncResult {
  scanned: number;
  processed: Array<{
    sessionFile: string;
    sessionId: string;
    cwd: string;
    directivesWritten: number;
    compressedCount: number;
    totalMessages: number;
    savedTokens: number;
  }>;
}

const DEFAULT_STABLE_MS = 30_000;

function extractCodexMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is CodexTextBlock => Boolean(block && typeof block === "object"))
    .filter((block) => block.type === "input_text" || block.type === "output_text")
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join("\n");
}

export function parseCodexSession(filePath: string | URL): CodexSessionSummary {
  const raw = readFileSync(filePath, "utf8");
  const fileLabel = typeof filePath === "string" ? filePath : filePath.pathname;
  const entries: ClaudeCompatibleEntry[] = [];
  let sessionId = fileLabel.split("/").pop()?.replace(".jsonl", "") ?? fileLabel;
  let cwd: string | null = null;
  let lastTokenUsage: CodexSessionSummary["lastTokenUsage"];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: CodexRecord;
    try {
      record = JSON.parse(trimmed) as CodexRecord;
    } catch {
      continue;
    }

    if (record.type === "session_meta") {
      const payload = record.payload ?? {};
      const metaId = payload.id;
      const metaCwd = payload.cwd;
      if (typeof metaId === "string") sessionId = metaId;
      if (typeof metaCwd === "string") cwd = metaCwd;
      continue;
    }

    if (record.type !== "response_item") {
      if (record.type === "event_msg" && record.payload?.type === "token_count") {
        const info = record.payload.info;
        if (info && typeof info === "object") {
          const last = (info as Record<string, unknown>).last_token_usage;
          if (last && typeof last === "object") {
            const usage = last as Record<string, unknown>;
            lastTokenUsage = {
              inputTokens: numberOrUndefined(usage.input_tokens),
              cachedInputTokens: numberOrUndefined(usage.cached_input_tokens),
              outputTokens: numberOrUndefined(usage.output_tokens),
              totalTokens: numberOrUndefined(usage.total_tokens),
            };
          }
        }
      }
      continue;
    }

    const payload = record.payload ?? {};
    const payloadType = payload.type;

    if (payloadType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = extractCodexMessageText(payload.content);
      if (!text) continue;
      entries.push({
        type: role,
        message: {
          role,
          content: text,
        },
      });
      continue;
    }

    if (payloadType === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "unknown";
      const argumentsValue = typeof payload.arguments === "string"
        ? tryParseJson(payload.arguments)
        : payload.arguments;
      entries.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name, input: argumentsValue }],
        },
      });
      continue;
    }

    if (payloadType === "function_call_output") {
      const output = typeof payload.output === "string" ? payload.output : stringifyUnknown(payload.output);
      entries.push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: output }],
        },
      });
    }
  }

  return { sessionId, cwd, entries, lastTokenUsage };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function defaultCodexSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

export function defaultCodexStatePath(): string {
  return join(homedir(), ".codex", "memories", "squeeze-codex-state.json");
}

export function defaultCodexLogPath(): string {
  return join(homedir(), ".codex", "memories", "squeeze-codex-runs.jsonl");
}

function loadState(statePath: string): CodexSyncState {
  if (!existsSync(statePath)) return { processed: {} };
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as CodexSyncState;
  } catch {
    return { processed: {} };
  }
}

function saveState(statePath: string, state: CodexSyncState): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function appendRunLog(logPath: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${JSON.stringify(record)}\n`, { flag: "a" });
}

function latestSessionFiles(root: string, limit = 100): string[] {
  const files: Array<{ path: string; mtimeMs: number }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ path: fullPath, mtimeMs: statSync(fullPath).mtimeMs });
      }
    }
  };

  if (!existsSync(root)) return [];
  walk(root);
  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((file) => file.path);
}

export function syncCodexSessions(options: CodexSyncOptions = {}): CodexSyncResult {
  const sessionsRoot = options.sessionsRoot ?? defaultCodexSessionsRoot();
  const statePath = options.statePath ?? defaultCodexStatePath();
  const logPath = options.logPath ?? defaultCodexLogPath();
  const stableMs = options.stableMs ?? DEFAULT_STABLE_MS;
  const now = options.now ?? Date.now();
  const state = loadState(statePath);
  const files = latestSessionFiles(sessionsRoot);
  const result: CodexSyncResult = { scanned: files.length, processed: [] };

  for (const file of files) {
    const stats = statSync(file);
    if (now - stats.mtimeMs < stableMs) continue;

    const previous = state.processed[file];
    if (previous && previous.mtimeMs === stats.mtimeMs && previous.size === stats.size) {
      continue;
    }

    const parsed = parseCodexSession(file);
    if (!parsed.cwd || !existsSync(parsed.cwd)) {
      state.processed[file] = { mtimeMs: stats.mtimeMs, size: stats.size };
      continue;
    }

    const processed = processMessages(parsed.entries as never[]);
    const memoryPath = join(parsed.cwd, "MEMORY.md");
    const directivesWritten = writeDirectivesToMemory(processed, memoryPath, {
      source: "codex",
      sessionId: parsed.sessionId,
    });
    const memoryCandidates = extractMemoryCandidates(processed);

    // Persist candidates into the per-project store so Codex-detected soft
    // signals show up in `squeeze-candidates list` alongside Claude Code ones.
    if (memoryCandidates.length > 0) {
      const candidateStore = loadCandidateStore(parsed.cwd);
      ingestCandidates(candidateStore, memoryCandidates, {
        source: "codex",
        sessionId: parsed.sessionId,
      });
      saveCandidateStore(parsed.cwd, candidateStore);
    }

    const originalChars = processed.reduce((sum, item) => sum + item.originalText.length, 0);
    const compressedChars = processed.reduce((sum, item) => sum + item.compressedText.length, 0);
    const savedTokens = Math.round((originalChars - compressedChars) / 4);
    const compressedCount = processed.filter((item) => item.wasCompressed).length;

    const summary = {
      sessionFile: file,
      sessionId: parsed.sessionId,
      cwd: parsed.cwd,
      directivesWritten,
      compressedCount,
      totalMessages: processed.length,
      savedTokens,
      memoryCandidates,
    };

    appendRunLog(logPath, {
      timestamp: new Date(now).toISOString(),
      kind: "codex_sync",
      ...summary,
      lastTokenUsage: parsed.lastTokenUsage,
    });

    appendProjectRunLog(parsed.cwd, {
      timestamp: new Date(now).toISOString(),
      source: "codex",
      sessionId: parsed.sessionId,
      directivesWritten,
      compressedCount,
      totalMessages: processed.length,
      savedTokens,
      memoryCandidates,
      lastTokenUsage: parsed.lastTokenUsage,
    });
    writeLatestAudit(parsed.cwd);

    result.processed.push(summary);
    state.processed[file] = { mtimeMs: stats.mtimeMs, size: stats.size };
  }

  saveState(statePath, state);
  return result;
}
