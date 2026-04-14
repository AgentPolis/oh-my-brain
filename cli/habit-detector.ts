import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { type BrainEvent } from "../src/storage/events.js";
import { jaccard, tokenSet } from "./links-store.js";

export interface Habit {
  id: string;
  pattern: string;
  confidence: number;
  evidence: string[];
  first_seen: string;
  occurrences: number;
}

interface HabitFile {
  version: 1;
  habits: Habit[];
}

const HABITS_FILE = "habits.json";
const TRIVIAL_TOKENS = new Set(["assistant", "chat", "conversation", "talked", "message"]);
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "the",
  "to",
  "for",
  "of",
  "in",
  "at",
  "my",
  "our",
  "we",
  "i",
  "got",
  "started",
  "attended",
  "joined",
  "went",
  "visited",
  "finished",
  "reading",
  "watching",
  "playing",
]);

export function detectHabits(events: BrainEvent[], existingHabits: Habit[]): Habit[] {
  const grouped = new Map<string, BrainEvent[]>();
  for (const event of events) {
    if (event.category === "other" || event.category === "viewpoint" || event.category === "sentiment") {
      continue;
    }
    const bucket = grouped.get(event.category) ?? [];
    bucket.push(event);
    grouped.set(event.category, bucket);
  }

  const detected: Habit[] = [];
  const existingPatterns = new Set(existingHabits.map((habit) => normalizePattern(habit.pattern)));

  for (const [category, items] of grouped.entries()) {
    const clusters = clusterEvents(items);
    for (const cluster of clusters) {
      if (cluster.length < 3) continue;
      const pattern = generateHabitPattern(category, cluster);
      if (!pattern) continue;
      const normalized = normalizePattern(pattern);
      if (existingPatterns.has(normalized)) continue;
      existingPatterns.add(normalized);
      detected.push({
        id: randomUUID(),
        pattern,
        confidence: confidenceForOccurrences(cluster.length),
        evidence: cluster.map((event) => event.id),
        first_seen: cluster
          .map((event) => event.ts)
          .sort((a, b) => a.localeCompare(b))[0],
        occurrences: cluster.length,
      });
    }
  }

  return detected.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export function loadHabits(projectRoot: string): Habit[] {
  const path = join(projectRoot, ".squeeze", HABITS_FILE);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HabitFile;
    return parsed.version === 1 && Array.isArray(parsed.habits) ? parsed.habits : [];
  } catch {
    return [];
  }
}

export function saveHabits(projectRoot: string, habits: Habit[]): void {
  const dir = join(projectRoot, ".squeeze");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, HABITS_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, habits }, null, 2));
  renameSync(tmp, path);
}

function clusterEvents(events: BrainEvent[]): BrainEvent[][] {
  const clusters: BrainEvent[][] = [];
  for (const event of events) {
    const eventTokens = tokenSet(event.what);
    let placed = false;
    for (const cluster of clusters) {
      const similar = cluster.some((entry) => jaccard(eventTokens, tokenSet(entry.what)) >= 0.4);
      if (!similar) continue;
      cluster.push(event);
      placed = true;
      break;
    }
    if (!placed) clusters.push([event]);
  }
  return clusters;
}

function generateHabitPattern(category: string, cluster: BrainEvent[]): string {
  const tokenCounts = new Map<string, number>();
  for (const event of cluster) {
    for (const token of tokenSet(event.what)) {
      if (STOPWORDS.has(token) || TRIVIAL_TOKENS.has(token)) continue;
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  const commonTokens = Array.from(tokenCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token);

  if (commonTokens.length === 0) return "";
  if (commonTokens.every((token) => TRIVIAL_TOKENS.has(token))) return "";

  if (category === "travel" && commonTokens.includes("united")) {
    return "frequently flies United Airlines";
  }
  if (category === "events" && commonTokens.includes("charity")) {
    return "regularly participates in charity events";
  }
  if (category === "shopping" && commonTokens.length > 0) {
    return `frequently buys ${commonTokens.slice(0, 2).join(" ")}`;
  }

  return `regularly ${category} around ${commonTokens.slice(0, 2).join(" ")}`;
}

function confidenceForOccurrences(occurrences: number): number {
  return Math.min(1, Number((0.6 + Math.max(0, occurrences - 3) * 0.1).toFixed(2)));
}

function normalizePattern(pattern: string): string {
  return pattern.trim().toLowerCase();
}
