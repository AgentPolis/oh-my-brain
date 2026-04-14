import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

export type EventPrecision = "exact" | "day" | "week" | "month" | "relative";
export type EventSentiment =
  | "positive"
  | "negative"
  | "neutral"
  | "frustrated"
  | "excited"
  | "anxious"
  | "";

export interface BrainEvent {
  id: string;
  ts: string;
  ts_ingest: string;
  ts_precision: EventPrecision;
  what: string;
  detail: string;
  category: string;
  who: string[];
  where: string;
  related_to: string[];
  sentiment: EventSentiment;
  viewpoint: string;
  insight: string;
  source_text: string;
  session_id: string;
  turn_index: number;
}

const EVENTS_FILE = "events.jsonl";

export class EventStore {
  private squeezePath: string;
  private eventsPath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.eventsPath = join(squeezePath, EVENTS_FILE);
  }

  append(events: BrainEvent[]): void {
    if (events.length === 0) return;
    mkdirSync(this.squeezePath, { recursive: true });
    const serialized = events.map((event) => `${JSON.stringify(normalizeEvent(event))}\n`).join("");
    appendFileSync(this.eventsPath, serialized);
  }

  searchByTime(from: string, to: string): BrainEvent[] {
    const fromTime = normalizeBoundary(from, "start");
    const toTime = normalizeBoundary(to, "end");
    return this.getAll().filter((event) => {
      const range = getEventRange(event);
      return range.start <= toTime && range.end >= fromTime;
    });
  }

  searchByKeyword(query: string, limit?: number): BrainEvent[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const results = this.getAll().filter((event) =>
      `${event.what}\n${event.detail}\n${event.source_text}`.toLowerCase().includes(normalized)
    );
    return typeof limit === "number" ? results.slice(0, limit) : results;
  }

  searchByCategory(category: string, limit?: number): BrainEvent[] {
    const normalized = category.trim().toLowerCase();
    if (!normalized) return [];
    const results = this.getAll().filter((event) => event.category.toLowerCase() === normalized);
    return typeof limit === "number" ? results.slice(0, limit) : results;
  }

  searchByPerson(who: string): BrainEvent[] {
    const normalized = who.trim().toLowerCase();
    if (!normalized) return [];
    return this.getAll().filter((event) =>
      event.who.some((person) => person.toLowerCase().includes(normalized))
    );
  }

  getAll(): BrainEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const raw = readFileSync(this.eventsPath, "utf8");
    if (!raw.trim()) return [];

    const events: BrainEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(normalizeEvent(JSON.parse(trimmed) as BrainEvent));
      } catch {
        continue;
      }
    }
    return events;
  }

  getSummary(): {
    count: number;
    earliest: string;
    latest: string;
    categories: Record<string, number>;
  } {
    const events = this.getAll();
    if (events.length === 0) {
      return { count: 0, earliest: "", latest: "", categories: {} };
    }

    const categories: Record<string, number> = {};
    let earliest = events[0].ts;
    let latest = events[0].ts;
    for (const event of events) {
      if (event.ts < earliest) earliest = event.ts;
      if (event.ts > latest) latest = event.ts;
      categories[event.category] = (categories[event.category] ?? 0) + 1;
    }

    return { count: events.length, earliest, latest, categories };
  }

  toTimelineString(limit = 10): string {
    const events = this.getAll().sort((a, b) => a.ts.localeCompare(b.ts));
    if (events.length === 0) return "";

    const summary = this.getSummary();
    const visible = limit > 0 ? events.slice(-limit) : events;
    const lines = visible.map((event) => `  ${formatTimelineDay(event.ts)}: ${event.what}`);
    if (visible.length < events.length) {
      lines.push("  ...");
    }

    return [
      `Events (${summary.count} total, ${summary.earliest.slice(0, 10)} ~ ${summary.latest.slice(0, 10)}):`,
      ...lines,
    ].join("\n");
  }
}

export function detectEventCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(?:car|vehicle|drive|mechanic|gas|tire|engine|gps)\b/.test(lower)) return "vehicle";
  if (/\b(?:fly|flew|flight|airline|airport|trip|travel|hotel|airbnb|vacation)\b/.test(lower)) {
    return "travel";
  }
  if (/\b(?:buy|bought|purchase|purchased|order|ordered|shop|store|price|received|got|picked up)\b|買了|買到|訂了|收到/.test(lower)) {
    return "shopping";
  }
  if (/\b(?:watch|movie|show|book|read|reading|game|play|concert|episode)\b|看了|讀完|開始看|開始讀/.test(lower)) {
    return "entertainment";
  }
  if (/\b(?:work|working|job|office|meeting|team|colleague|manager|boss)\b|工作|上班|同事|會議/.test(lower)) {
    return "work";
  }
  if (/\b(?:doctor|health|gym|exercise|run|workout|therapy|clinic|vet)\b/.test(lower)) {
    return "health";
  }
  if (/\b(?:friend|party|dinner|meet|date|social|club|community)\b|朋友|聚會|社團/.test(lower)) return "social";
  if (/\b(?:charity|volunteer|donate|event|festival|meetup|conference)\b|活動|會議|聚會|慈善/.test(lower)) {
    return "events";
  }
  if (/\b(?:dog|cat|pet|puppy|kitten|luna)\b|狗|貓|寵物/.test(lower)) return "pets";
  if (/\b(?:fly|flew|flight|airline|airport|trip|travel|hotel|airbnb|vacation)\b|飛去|去了|旅行|航班|機場/.test(lower)) {
    return "travel";
  }
  return "other";
}

function normalizeEvent(event: BrainEvent): BrainEvent {
  return {
    ...event,
    ts: normalizeIso(event.ts),
    ts_ingest: normalizeIso(event.ts_ingest),
    ts_precision: normalizePrecision(event.ts_precision),
    what: event.what?.trim() ?? "",
    detail: event.detail?.trim() ?? "",
    category: event.category?.trim() || "other",
    who: Array.isArray(event.who)
      ? event.who.filter((person) => typeof person === "string").map((person) => person.trim()).filter(Boolean)
      : [],
    where: event.where?.trim() ?? "",
    related_to: Array.isArray(event.related_to)
      ? event.related_to.filter((id) => typeof id === "string").map((id) => id.trim()).filter(Boolean)
      : [],
    sentiment: normalizeSentiment(event.sentiment),
    viewpoint: event.viewpoint?.trim() ?? "",
    insight: event.insight?.trim() ?? "",
    source_text: event.source_text ?? "",
    session_id: event.session_id ?? "",
    turn_index: Number.isFinite(event.turn_index) ? event.turn_index : 0,
  };
}

function normalizePrecision(precision: EventPrecision | string | undefined): EventPrecision {
  switch (precision) {
    case "exact":
    case "day":
    case "week":
    case "month":
    case "relative":
      return precision;
    default:
      return "exact";
  }
}

function normalizeSentiment(sentiment: EventSentiment | string | undefined): EventSentiment {
  switch (sentiment) {
    case "positive":
    case "negative":
    case "neutral":
    case "frustrated":
    case "excited":
    case "anxious":
    case "":
      return sentiment;
    default:
      return "";
  }
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date(0).toISOString();
  return new Date(parsed).toISOString();
}

function getEventRange(event: BrainEvent): { start: number; end: number } {
  const base = Date.parse(event.ts);
  if (Number.isNaN(base)) {
    return { start: Number.POSITIVE_INFINITY, end: Number.NEGATIVE_INFINITY };
  }

  const date = new Date(base);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  switch (event.ts_precision) {
    case "month":
      return {
        start,
        end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1,
      };
    case "week":
      return {
        start,
        end: start + 7 * 24 * 60 * 60 * 1000 - 1,
      };
    case "day":
    case "relative":
    case "exact":
    default:
      return {
        start,
        end: start + 24 * 60 * 60 * 1000 - 1,
      };
  }
}

function normalizeBoundary(input: string, edge: "start" | "end"): number {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    return edge === "start"
      ? Date.UTC(year, month - 1, day)
      : Date.UTC(year, month - 1, day + 1) - 1;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return edge === "start" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return parsed;
}

function formatTimelineDay(ts: string): string {
  const date = new Date(ts);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[date.getUTCMonth()] ?? "?"}${String(date.getUTCDate()).padStart(2, "0")}`;
}
