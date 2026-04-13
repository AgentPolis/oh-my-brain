import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { ArchiveStore, type ArchiveEntry } from "./archive.js";

export interface TimelineEntry {
  ts: string;
  count: number;
  topics: string[];
  summary: string;
}

const TIMELINE_FILE = "timeline.json";

export class TimelineIndex {
  private squeezePath: string;
  private timelinePath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.timelinePath = join(squeezePath, TIMELINE_FILE);
  }

  rebuild(): void {
    const archive = new ArchiveStore(this.squeezePath);
    const grouped = new Map<string, ArchiveEntry[]>();
    for (const entry of archive.readAll()) {
      const day = entry.ts.slice(0, 10);
      const bucket = grouped.get(day) ?? [];
      bucket.push(entry);
      grouped.set(day, bucket);
    }

    const timeline = Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, entries]) => buildTimelineEntry(day, entries));

    mkdirSync(this.squeezePath, { recursive: true });
    writeFileSync(this.timelinePath, JSON.stringify(timeline, null, 2));
  }

  range(from: string, to: string): TimelineEntry[] {
    const fromDay = from.slice(0, 10);
    const toDay = to.slice(0, 10);
    return this.readAll().filter((entry) => entry.ts >= fromDay && entry.ts <= toDay);
  }

  toCompactString(): string {
    const entries = this.readAll();
    if (entries.length === 0) return "";

    const recent = entries.slice(-30);
    const prefix = recent
      .map((entry) => `${formatDay(entry.ts)}: ${entry.count} msgs (${entry.topics.join(", ") || "misc"})`)
      .join(" | ");
    const earlierCount = Math.max(0, entries.length - recent.length);
    return earlierCount > 0 ? `${prefix} | and ${earlierCount} earlier days` : prefix;
  }

  bounds(): { earliest: string; latest: string } | null {
    const entries = this.readAll();
    if (entries.length === 0) return null;
    return { earliest: entries[0].ts, latest: entries.at(-1)!.ts };
  }

  readAll(): TimelineEntry[] {
    if (!existsSync(this.timelinePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.timelinePath, "utf8")) as TimelineEntry[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

function buildTimelineEntry(day: string, entries: ArchiveEntry[]): TimelineEntry {
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const topics = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([tag]) => tag);

  const headline = topics.join(", ") || "general conversation";
  const summary = truncateSummary(headline, 50);

  return {
    ts: day,
    count: entries.length,
    topics,
    summary,
  };
}

function truncateSummary(summary: string, maxChars: number): string {
  return summary.length <= maxChars ? summary : `${summary.slice(0, maxChars - 1)}…`;
}

function formatDay(day: string): string {
  const [year, month, date] = day.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1] ?? year}${date}`;
}
