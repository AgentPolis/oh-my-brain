import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

export interface ArchiveEntry {
  id: string;
  ts: string;
  ingest_ts: string;
  role: "user" | "assistant";
  content: string;
  summary: string;
  level: number;
  turn_index: number;
  session_id?: string;
  tags: string[];
}

const ARCHIVE_FILE = "archive.jsonl";
const DEFAULT_MAX_ARCHIVE_MB = 100;
const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "again",
  "all",
  "also",
  "and",
  "any",
  "are",
  "because",
  "been",
  "before",
  "being",
  "but",
  "can",
  "could",
  "did",
  "does",
  "doing",
  "done",
  "each",
  "even",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "most",
  "need",
  "only",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "those",
  "very",
  "want",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
  "你們",
  "我們",
  "這個",
  "那個",
  "如果",
  "因為",
  "而且",
  "已經",
  "還有",
  "可以",
  "需要",
  "現在",
  "就是",
  "不是",
  "沒有",
  "比較",
  "一下",
  "一些",
]);

export class ArchiveStore {
  private squeezePath: string;
  private archivePath: string;
  private maxArchiveBytes: number;

  constructor(squeezePath: string, maxArchiveMb = DEFAULT_MAX_ARCHIVE_MB) {
    this.squeezePath = squeezePath;
    this.archivePath = join(squeezePath, ARCHIVE_FILE);
    this.maxArchiveBytes = Math.max(1, Math.floor(maxArchiveMb * 1024 * 1024));
  }

  append(entries: ArchiveEntry[]): void {
    if (entries.length === 0) return;
    mkdirSync(this.squeezePath, { recursive: true });
    const serialized = entries.map((entry) => `${JSON.stringify(normalizeEntry(entry))}\n`).join("");
    appendFileSync(this.archivePath, serialized);
    this.enforceSoftLimit();
  }

  searchByTime(from: string, to: string): ArchiveEntry[] {
    const fromTime = normalizeBoundary(from, "start");
    const toTime = normalizeBoundary(to, "end");
    return this.readAll().filter((entry) => {
      const ts = Date.parse(entry.ts);
      return !Number.isNaN(ts) && ts >= fromTime && ts <= toTime;
    });
  }

  searchByKeyword(query: string, limit?: number): ArchiveEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const matches = this.readAll().filter((entry) =>
      entry.content.toLowerCase().includes(normalized)
    );
    return typeof limit === "number" ? matches.slice(0, limit) : matches;
  }

  getBySession(sessionId: string): ArchiveEntry[] {
    return this.readAll().filter((entry) => entry.session_id === sessionId);
  }

  getSummary(): { count: number; earliest: string; latest: string } {
    const entries = this.readAll();
    if (entries.length === 0) {
      return { count: 0, earliest: "", latest: "" };
    }

    let earliest = entries[0].ts;
    let latest = entries[0].ts;
    for (const entry of entries) {
      if (entry.ts < earliest) earliest = entry.ts;
      if (entry.ts > latest) latest = entry.ts;
    }
    return { count: entries.length, earliest, latest };
  }

  readAll(): ArchiveEntry[] {
    if (!existsSync(this.archivePath)) return [];
    const raw = readFileSync(this.archivePath, "utf8");
    if (!raw.trim()) return [];

    const entries: ArchiveEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(normalizeEntry(JSON.parse(trimmed) as ArchiveEntry));
      } catch {
        continue;
      }
    }
    return entries;
  }

  getArchivePath(): string {
    return this.archivePath;
  }

  getSizeBytes(): number {
    if (!existsSync(this.archivePath)) return 0;
    return statSync(this.archivePath).size;
  }

  private enforceSoftLimit(): void {
    if (!existsSync(this.archivePath)) return;
    const size = statSync(this.archivePath).size;
    if (size <= this.maxArchiveBytes) return;

    const entries = this.readAll();
    if (entries.length === 0) return;

    let kept = entries.slice();
    while (kept.length > 1) {
      const serialized = kept.map((entry) => JSON.stringify(entry)).join("\n");
      const bytes = Buffer.byteLength(`${serialized}\n`, "utf8");
      if (bytes <= this.maxArchiveBytes) {
        writeFileSync(this.archivePath, `${serialized}\n`);
        return;
      }
      kept = kept.slice(1);
    }

    writeFileSync(this.archivePath, `${JSON.stringify(kept[0])}\n`);
  }
}

export function extractTags(text: string): string[] {
  const englishTokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 3 && !STOPWORDS.has(token));
  const chineseTokens = text
    .split(/[\s,.;:!?()[\]{}"'、，。；：！？【】（）《》〈〉\n\r\t]+/)
    .map((token) => token.trim())
    .filter((token) => /[\u4e00-\u9fff]/.test(token) && token.length >= 2 && !STOPWORDS.has(token));

  const counts = new Map<string, number>();
  for (const token of [...englishTokens, ...chineseTokens]) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([token]) => token);
}

export function estimateArchiveTimestamp(
  createdAt: string | undefined,
  sessionStart: string | undefined,
  turnIndex: number
): string {
  const primary = createdAt && !Number.isNaN(Date.parse(createdAt)) ? createdAt : sessionStart;
  if (!primary || Number.isNaN(Date.parse(primary))) {
    return new Date().toISOString();
  }

  const baseMs = Date.parse(primary);
  const turnOffsetMs = Math.max(0, turnIndex) * 60_000;
  return new Date(baseMs + turnOffsetMs).toISOString();
}

function normalizeEntry(entry: ArchiveEntry): ArchiveEntry {
  return {
    ...entry,
    session_id: entry.session_id ?? undefined,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string") : [],
  };
}

function normalizeBoundary(value: string, edge: "start" | "end"): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const suffix = edge === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    return Date.parse(`${value}${suffix}`);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
