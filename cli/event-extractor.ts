import { randomUUID } from "crypto";
import { detectEventCategory, type BrainEvent, type EventPrecision, type EventSentiment } from "../src/storage/events.js";
export { detectEventCategory } from "../src/storage/events.js";

export interface ExtractEventMessage {
  role: string;
  content: string;
}

export interface ExtractEventContext {
  sessionId: string;
  turnIndex: number;
  sessionDate: string;
  previousMessage?: string;
}

interface ActionPattern {
  kind: string;
  pattern: RegExp;
  buildWhat: (match: RegExpMatchArray) => string;
  buildDetail?: (match: RegExpMatchArray) => string;
  buildWho?: (match: RegExpMatchArray) => string[];
}

const ACTION_PATTERNS: ActionPattern[] = [
  {
    kind: "service",
    pattern:
      /\b(?:I\s+)?(?:got|had)\s+(?:my\s+)?(.{3,30}?)\s+(serviced|repaired|fixed|checked|detailed)(?:\s+(?:last\s+\w+|yesterday|today|on\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?|in\s+\w+))?(?=[,.!;]|$|\s+and\b|\s+but\b)/i,
    buildWhat: (match) => `${cleanFragment(match[1])} ${match[2].toLowerCase()}`,
  },
  {
    kind: "pet-acquisition",
    pattern:
      /\b(?:got|bought|ordered)\s+(?:a |an |the )?(.{3,30}?)\s+for\s+(?:my\s+)?(?:dog|cat|pet)\s+(\w+)(?:[,.!;]|$)/i,
    buildWhat: (match) => `got ${cleanFragment(match[1])} for ${cleanFragment(match[2])}`,
    buildWho: (match) => [cleanFragment(match[2])],
  },
  {
    kind: "named-pet-acquisition",
    pattern:
      /\b(?:got|bought|ordered)\s+(?:a |an |the )?(.{3,30}?)\s+for\s+([A-Z][\w'-]+)(?:[,.!;]|$)/,
    buildWhat: (match) => `got ${cleanFragment(match[1])} for ${cleanFragment(match[2])}`,
    buildWho: (match) => [cleanFragment(match[2])],
  },
  {
    kind: "setup",
    pattern:
      /\b(?:I|i|we)\s+(?:set up|installed|configured|connected|hooked up)\s+(.{3,60}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `${leadingVerb(match[0])} ${cleanFragment(match[1]).replace(/^(?:a|an|the)\s+/i, "")}`,
  },
  {
    kind: "home-improvement",
    pattern:
      /\b(?:I|i|we)\s+(?:rearranged|redecorated|moved|placed|put up|hung)\s+(.{3,40}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `${leadingVerb(match[0])} ${cleanFragment(match[1])}`,
  },
  {
    kind: "room-acquisition",
    pattern:
      /\b(?:got|bought)\s+(?:a |an |the )?(?:new\s+)?(.{3,30}?)\s+for\s+(?:the |my )(.{3,30}?)(?:[,.!;]|$)/i,
    buildWhat: (match) => `got ${cleanFragment(match[1])} for ${cleanFragment(match[2])}`,
  },
  {
    kind: "membership",
    pattern:
      /\b(?:I|i|we)\s+(?:became a member(?:\s+of)?|signed up for|subscribed to|registered for)\s+(.{3,60}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `${leadingVerb(match[0])} ${cleanFragment(match[1])}`,
  },
  {
    kind: "duration-activity",
    pattern:
      /\b(?:I've been|I have been)\s+(.{3,40}?)\s+for\s+(.{3,30}?)(?:[,.!;]|$)/i,
    buildWhat: (match) => cleanFragment(match[1]),
    buildDetail: (match) => {
      const duration = extractDuration(`for ${match[2]}`);
      if (!duration) return `for ${cleanFragment(match[2])}`;
      return `for ${duration.value} ${duration.unit}${duration.value === 1 ? "" : "s"}`;
    },
  },
  {
    kind: "comparison",
    pattern:
      /\b(?:got|bought|started|joined)\s+(.{3,30}?)\s+(before|after)\s+(.{3,30}?)(?:[,.!;]|$)/i,
    buildWhat: (match) => `${leadingVerb(match[0])} ${cleanFragment(match[1])}`,
    buildDetail: (match) => `${match[2].toLowerCase()} ${cleanFragment(match[3])}`,
  },
  {
    kind: "charity-event",
    pattern:
      /\b(?:I|i|we)\s+(?:participated in|volunteered at|walked in|ran in)\s+(?:the\s+)?['"]?(.{3,60}?)['"]?(?:[,.!;]|$)/,
    buildWhat: (match) => `${leadingVerb(match[0])} ${cleanFragment(match[1])}`,
  },
  {
    kind: "acquisition",
    pattern:
      /\b(?:I|i|we)\s+(?:got|bought|purchased|ordered|received|picked up)\s+(.{3,60}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `got ${cleanFragment(match[1])}`,
  },
  {
    kind: "travel",
    pattern: /\b(?:I|i|we)\s+(?:flew|drove|traveled|travelled|went|visited)\s+(?:to\s+)?(.{3,40}?)(?:[,.!;]|$)/,
    buildWhat: (match) => normalizeTravelWhat(match[0], cleanFragment(match[1])),
  },
  {
    kind: "join",
    pattern:
      /\b(?:I|i|we)\s+(?:started|joined|began|enrolled|signed up)\s+(?:for\s+)?(.{3,60}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `${leadingVerb(match[0])} ${cleanFragment(match[1])}`,
  },
  {
    kind: "attend",
    pattern:
      /\b(?:I|i|we)\s+(?:attended|participated in|went to)\s+(?:the\s+)?(.{3,60}?)(?:[,.!;]|$)/,
    buildWhat: (match) =>
      `${leadingVerb(match[0])} ${cleanFragment(match[1]).replace(/\s+in\s+[A-Z][\w&.-]+(?:\s+[A-Z][\w&.-]+){0,3}$/i, "")}`,
  },
  {
    kind: "work",
    pattern:
      /\b(?:I\s+)?(?:started working|got a job|began working)\s+(?:at\s+)?(.{3,40}?)(?=[,.!;]|$|\s+and\b|\s+but\b)/i,
    buildWhat: (match) => `started working at ${cleanFragment(match[1])}`,
  },
  {
    kind: "watch-read-play",
    pattern:
      /\b(?:I|i|we)\s+(started|began|finished)\s+(watching|reading|playing)\s+(.{3,40}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `${match[1].toLowerCase()} ${match[2].toLowerCase()} ${cleanFragment(match[3])}`,
  },
  {
    kind: "meet",
    pattern: /\b(?:I|i|we)\s+met\s+(?:with\s+)?(.{3,40}?)(?:[,.!;]|$)/,
    buildWhat: (match) => `met ${cleanFragment(match[1])}`,
  },
  {
    kind: "problem",
    pattern:
      /\b(.{3,30}?)\s+(?:wasn't working|broke|failed|crashed|had (?:a |an )?(?:issue|problem|error))(?:\s+\w+){0,3}(?:[,.!;]|$)/i,
    buildWhat: (match) => `${cleanFragment(match[1])} problem`,
    buildDetail: (match) => cleanFragment(match[0]),
  },
  {
    kind: "zh-acquisition",
    pattern: /我(?:買了|買到|訂了|拿到|收到)了?\s*(.{1,30}?)(?:[，。！；]|$)/,
    buildWhat: (match) => `買了${cleanFragment(match[1])}`,
  },
  {
    kind: "zh-travel",
    pattern: /我(?:去了|飛去|到過)\s*(.{1,30}?)(?:[，。！；]|$)/,
    buildWhat: (match) => `去了${cleanFragment(match[1])}`,
  },
  {
    kind: "zh-start",
    pattern: /我(?:開始|加入|參加了|參加)\s*(.{1,30}?)(?:[，。！；]|$)/,
    buildWhat: (match) => `${leadingChineseVerb(match[0])}${cleanFragment(match[1])}`,
  },
];

const TIME_PATTERNS = [
  { pattern: /\bon\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/i, precision: "exact" as const },
  { pattern: /from\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?)\s+to\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?)/i, precision: "day" as const },
  {
    pattern:
      /\b(last\s+\w+day|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|yesterday|today|(?:about\s+)?(?:a|\d+|one|two|three|four|five|six)\s+(?:days?|weeks?|months?|years?)\s+ago)\b/i,
    precision: "relative" as const,
  },
  {
    pattern:
      /\bin\s+(?:early|mid|late)[-\s]+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
    precision: "week" as const,
  },
  { pattern: /\bin\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i, precision: "month" as const },
  { pattern: /\bfor\s+(?:about\s+)?(\d+|a|one|two|three|four|five)\s+(weeks?|months?|days?|years?)\b/i, precision: "relative" as const },
  { pattern: /\b(\d+|a|one|two|three|four|five|six|about\s+a)\s+(weeks?|months?|days?|years?)\s+ago\b/i, precision: "relative" as const },
  { pattern: /(?:上週.|上星期.|昨天|今天|前天|上個月|這個月|三天前|兩週前)/, precision: "relative" as const },
  { pattern: /在\s*(\d{1,2})月(\d{1,2})日/, precision: "exact" as const },
  { pattern: /在\s*(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)/, precision: "month" as const },
];

const SENTIMENT_PATTERNS: Array<{ pattern: RegExp; sentiment: EventSentiment }> = [
  { pattern: /\b(?:frustrated|annoyed|upset|disappointed|angry)\b/i, sentiment: "frustrated" },
  { pattern: /\b(?:excited|thrilled|happy|glad|love|great|amazing)\b/i, sentiment: "positive" },
  { pattern: /\b(?:worried|anxious|nervous|concerned)\b/i, sentiment: "anxious" },
  { pattern: /\b(?:unfortunately|sadly|too bad|sucks)\b/i, sentiment: "negative" },
  { pattern: /(?:煩|挫折|失望|生氣|焦慮|擔心|開心|興奮|很棒|太好了)/, sentiment: "positive" },
];

const VIEWPOINT_PATTERNS = [
  /\b(?:I think|I believe|I feel that|in my opinion|my take is)\s+(.{10,100})/i,
  /\b(\w+(?:\s+\w+)?)\s+is\s+(?:overengineered|underrated|overrated|the best|terrible|amazing|broken)\b/i,
  /(?:我覺得|我認為|本質上|其實)\s*(.{5,60})/,
];

const STRONG_VIEWPOINT_MARKERS = [
  /\b(?:overengineered|underrated|overrated|the best|terrible|amazing|broken|always|never)\b/i,
  /(?:太複雜|太麻煩|最好|最糟|本質上|其實)/,
];

const PERSON_PATTERNS = [
  /\bmy\s+(mechanic|doctor|friend|colleague|boss|manager|wife|husband|partner|sister|brother)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i,
  /\b(?:met|with|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
  /(?:我的|我跟)(?:機械師|醫生|朋友|同事|老闆|經理|老婆|先生|太太|夥伴)\s*([\u4e00-\u9fff]{2,4})/,
];

const NOISE_PATTERNS = [
  /^\s*(?:ok|okay|kk|thanks|thank you|sure|cool|got it|好的|好喔|嗯|恩)\s*$/i,
];

const INTENTION_MARKERS = [
  /\b(?:thinking about|want to|wanna|might|maybe|planning to|plan to|considering)\b/i,
  /(?:想要|打算|考慮|可能會|想去|準備要)/,
];

export function extractEvents(message: ExtractEventMessage, context: ExtractEventContext): BrainEvent[] {
  if (message.role !== "user") return [];
  const content = message.content.trim();
  if (!content) return [];
  if (NOISE_PATTERNS.some((pattern) => pattern.test(content))) return [];

  const sentiment = detectSentiment(content);
  const viewpoint = detectViewpoint(content);
  const who = extractPeople(content);
  const where = extractWhere(content);
  const time = detectTime(content, context.sessionDate);
  const problemContext = collectProblemContext(content);
  const sentences = splitSentences(content);

  const events: BrainEvent[] = [];
  for (const sentence of sentences) {
    if (INTENTION_MARKERS.some((pattern) => pattern.test(sentence))) continue;
    for (const action of ACTION_PATTERNS) {
      const match = sentence.match(action.pattern);
      if (!match) continue;
      const what = normalizeWhat(action.buildWhat(match));
      if (!what) continue;
      const patternWho = action.buildWho?.(match).map(cleanFragment).filter(Boolean) ?? [];
      const detail = mergeDetails([
        action.buildDetail?.(match) ?? "",
        ...collectDetailFragments(sentence),
        ...(action.kind === "service" ? problemContext : []),
      ]);
      events.push(
        buildEvent({
          what,
          detail,
          category: detectEventCategory(`${what} ${detail}`),
          who: mergeWho(who, patternWho),
          where,
          sentiment,
          sourceText: content,
          context,
          time,
        })
      );
      break;
    }
  }

  if (viewpoint) {
    events.push(
      buildEvent({
        what: "viewpoint",
        detail: viewpoint,
        category: "viewpoint",
        who,
        where,
        sentiment,
        sourceText: content,
        context,
        time,
      })
    );
  } else if (events.length === 0 && sentiment) {
    events.push(
      buildEvent({
        what: "sentiment",
        detail: extractSentimentDetail(content, sentiment),
        category: "sentiment",
        who,
        where,
        sentiment,
        sourceText: content,
        context,
        time,
      })
    );
  }

  return dedupeEvents(events);
}

export function resolveDate(
  matchText: string,
  precision: EventPrecision | string,
  sessionDate: string
): { ts: string; precision: EventPrecision } {
  const base = startOfUtcDay(sessionDate);
  const normalizedPrecision = normalizePrecision(precision);
  const raw = matchText.trim();
  const sessionYear = base.getUTCFullYear();

  const relative = resolveRelativeDate(raw, sessionDate);
  if (relative) {
    return { ts: relative.ts, precision: relative.precision };
  }

  const chineseDate = raw.match(/(\d{1,2})月(\d{1,2})日/);
  if (chineseDate) {
    const month = Number(chineseDate[1]) - 1;
    const day = Number(chineseDate[2]);
    return {
      ts: new Date(Date.UTC(sessionYear, month, day)).toISOString(),
      precision: "exact",
    };
  }

  const exactDate = raw.match(/([A-Z][a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  if (exactDate) {
    const monthIndex = monthNameToIndex(exactDate[1]);
    if (monthIndex >= 0) {
      const year = Number(exactDate[3] ?? sessionYear);
      const day = Number(exactDate[2]);
      return {
        ts: new Date(Date.UTC(year, monthIndex, day)).toISOString(),
        precision: "exact",
      };
    }
  }

  const rangeMatch = raw.match(/from\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(?:the\s+)?(\d{1,2})/i);
  if (rangeMatch) {
    return {
      ts: new Date(Date.UTC(sessionYear, base.getUTCMonth(), Number(rangeMatch[1]))).toISOString(),
      precision: "day",
    };
  }

  const monthMatch = raw.match(/\b(?:in\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (monthMatch) {
    return {
      ts: new Date(Date.UTC(sessionYear, monthNameToIndex(monthMatch[1]), 1)).toISOString(),
      precision: "month",
    };
  }

  const chineseMonthMatch = raw.match(/(一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月)/);
  if (chineseMonthMatch) {
    return {
      ts: new Date(Date.UTC(sessionYear, chineseMonthToIndex(chineseMonthMatch[1]), 1)).toISOString(),
      precision: "month",
    };
  }

  if (raw === "上個月") {
    return { ts: shiftMonths(base, -1).toISOString(), precision: "month" };
  }
  if (raw === "這個月") {
    return { ts: new Date(Date.UTC(sessionYear, base.getUTCMonth(), 1)).toISOString(), precision: "month" };
  }

  return { ts: base.toISOString(), precision: normalizedPrecision === "exact" ? "relative" : normalizedPrecision };
}

function buildEvent(input: {
  what: string;
  detail: string;
  category: string;
  who: string[];
  where: string;
  sentiment: EventSentiment;
  sourceText: string;
  context: ExtractEventContext;
  time: { ts: string; precision: EventPrecision };
}): BrainEvent {
  return {
    id: randomUUID(),
    ts: input.time.ts,
    ts_ingest: normalizeSessionTimestamp(input.context.sessionDate),
    ts_precision: input.time.precision,
    what: input.what,
    detail: input.detail,
    category: input.category,
    who: input.who,
    where: input.where,
    related_to: [],
    sentiment: input.sentiment,
    viewpoint: "",
    insight: "",
    source_text: input.sourceText,
    session_id: input.context.sessionId,
    turn_index: input.context.turnIndex,
  };
}

function detectTime(content: string, sessionDate: string): { ts: string; precision: EventPrecision } {
  for (const candidate of TIME_PATTERNS) {
    const match = content.match(candidate.pattern);
    if (!match) continue;
    return resolveDate(match[0], candidate.precision, sessionDate);
  }
  return { ts: normalizeSessionTimestamp(sessionDate), precision: "relative" };
}

interface ResolvedDate {
  ts: string;
  precision: "exact" | "day" | "week" | "month";
  original: string;
}

export function resolveRelativeDate(text: string, referenceDate: string): ResolvedDate | null {
  const ref = startOfUtcDay(referenceDate);
  const lower = text.trim().toLowerCase();

  const yesterday = text.match(/\byesterday\b/i);
  if (yesterday || text.trim() === "昨天") {
    return {
      ts: shiftDays(ref, -1).toISOString(),
      precision: "exact",
      original: yesterday?.[0] ?? text.trim(),
    };
  }

  const today = text.match(/\btoday\b/i);
  if (today || text.trim() === "今天") {
    return {
      ts: ref.toISOString(),
      precision: "exact",
      original: today?.[0] ?? text.trim(),
    };
  }

  const lastWeekdayMatch = text.match(/\blast\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i);
  if (lastWeekdayMatch) {
    return {
      ts: lastWeekday(ref, lastWeekdayMatch[1]).toISOString(),
      precision: "day",
      original: lastWeekdayMatch[0],
    };
  }

  if (/last\s+\w+day/i.test(lower)) {
    return {
      ts: shiftDays(ref, -1).toISOString(),
      precision: "day",
      original: text.trim(),
    };
  }

  const rangeMatch = text.match(/from\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+to\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?/i);
  if (rangeMatch) {
    return {
      ts: new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), Number(rangeMatch[1]))).toISOString(),
      precision: "day",
      original: rangeMatch[0],
    };
  }

  const monthPhaseMatch = text.match(/\bin\s+(early|mid|late)[-\s]+(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (monthPhaseMatch) {
    const targetDay = monthPhaseMatch[1].toLowerCase() === "early" ? 5 : monthPhaseMatch[1].toLowerCase() === "late" ? 25 : 15;
    return {
      ts: new Date(Date.UTC(ref.getUTCFullYear(), monthNameToIndex(monthPhaseMatch[2]), targetDay)).toISOString(),
      precision: "week",
      original: monthPhaseMatch[0],
    };
  }

  const agoMatch = text.match(/\b(?:about\s+)?(\d+|a|one|two|three|four|five|six)\s+(days?|weeks?|months?|years?)\s+ago\b/i);
  if (agoMatch) {
    const amount = parseCountToken(agoMatch[1]);
    const unit = agoMatch[2].toLowerCase();
    const precision = unit.startsWith("day") ? "day" : unit.startsWith("week") ? "week" : "month";
    if (unit.startsWith("day")) {
      return { ts: shiftDays(ref, -amount).toISOString(), precision, original: agoMatch[0] };
    }
    if (unit.startsWith("week")) {
      return { ts: shiftDays(ref, -(amount * 7)).toISOString(), precision, original: agoMatch[0] };
    }
    if (unit.startsWith("month")) {
      return { ts: shiftDays(ref, -(amount * 30)).toISOString(), precision, original: agoMatch[0] };
    }
    return { ts: shiftDays(ref, -(amount * 365)).toISOString(), precision: "month", original: agoMatch[0] };
  }

  if (text.trim() === "兩週前") {
    return { ts: shiftDays(ref, -14).toISOString(), precision: "week", original: text.trim() };
  }
  if (text.trim() === "兩天前") {
    return { ts: shiftDays(ref, -2).toISOString(), precision: "day", original: text.trim() };
  }
  if (text.trim() === "三天前") {
    return { ts: shiftDays(ref, -3).toISOString(), precision: "day", original: text.trim() };
  }

  return null;
}

export function extractDuration(text: string): { value: number; unit: string } | null {
  const match = text.match(
    /\bfor\s+(?:about\s+)?(\d+|a|one|two|three|four|five)\s+(days?|weeks?|months?|years?)\b/i
  );
  if (!match) return null;
  return { value: parseCountToken(match[1]), unit: match[2].toLowerCase().replace(/s$/, "") };
}

function detectSentiment(content: string): EventSentiment {
  for (const candidate of SENTIMENT_PATTERNS) {
    if (candidate.pattern.test(content)) {
      if (candidate.sentiment === "positive" && /(?:煩|挫折|失望|生氣|焦慮|擔心)/.test(content)) {
        continue;
      }
      return candidate.sentiment;
    }
  }
  return "";
}

function detectViewpoint(content: string): string {
  if (!STRONG_VIEWPOINT_MARKERS.some((pattern) => pattern.test(content))) return "";

  for (const pattern of VIEWPOINT_PATTERNS) {
    const match = content.match(pattern);
    if (!match) continue;
    const candidate = cleanFragment(match[1] ?? match[0]);
    if (candidate && STRONG_VIEWPOINT_MARKERS.some((entry) => entry.test(candidate))) {
      return candidate;
    }
  }

  return "";
}

function extractPeople(content: string): string[] {
  const people = new Set<string>();
  for (const pattern of PERSON_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    for (const match of content.matchAll(global)) {
      const candidate = cleanFragment((match.at(-1) ?? "").replace(/\b(?:said|told|mentioned)\b.*$/i, ""));
      if (candidate) people.add(candidate);
    }
  }
  return Array.from(people);
}

function extractWhere(content: string): string {
  const english = content.match(/\b(?:to|at|in)\s+([A-Z][\w&.-]+(?:\s+[A-Z][\w&.-]+){0,3})\b/);
  if (english) return cleanFragment(english[1]);
  const chinese = content.match(/(?:去了|在)\s*([\u4e00-\u9fff]{2,12})/);
  if (chinese) return cleanFragment(chinese[1]);
  return "";
}

function collectDetailFragments(content: string): string[] {
  const fragments: string[] = [];
  for (const sentence of splitSentences(content)) {
    if (/\b(?:wasn't working|broke|failed|crashed|issue|problem|error|conference|for\s+\w+)/i.test(sentence)) {
      fragments.push(cleanFragment(sentence));
    }
    if (/(?:壞了|故障|出問題|活動|會議|演唱會)/.test(sentence)) {
      fragments.push(cleanFragment(sentence));
    }
  }
  return fragments;
}

function collectProblemContext(content: string): string[] {
  return splitSentences(content)
    .filter((sentence) => /\b(?:wasn't working|broke|failed|crashed|issue|problem|error)\b/i.test(sentence))
    .map(cleanFragment);
}

function extractSentimentDetail(content: string, sentiment: EventSentiment): string {
  const aboutMatch = content.match(/\b(?:with|about)\s+(.{3,80})/i);
  if (aboutMatch) return cleanFragment(`${sentiment} with ${aboutMatch[1]}`);

  const chineseMatch = content.match(/(?:對|跟)\s*(.{2,30})(?:很|太)?(?:煩|失望|焦慮|擔心|開心|興奮)/);
  if (chineseMatch) return cleanFragment(`${sentiment} ${chineseMatch[1]}`);

  return cleanFragment(content);
}

function dedupeEvents(events: BrainEvent[]): BrainEvent[] {
  const seen = new Set<string>();
  const deduped: BrainEvent[] = [];
  for (const event of events) {
    const key = `${event.what}::${event.ts}::${event.source_text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function mergeWho(base: string[], extra: string[]): string[] {
  return Array.from(new Set([...base, ...extra].map(cleanFragment).filter(Boolean)));
}

function splitSentences(content: string): string[] {
  return content
    .replace(/\s+\band\s+I\s+/g, ". I ")
    .replace(/，我/g, "。我")
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanFragment(text: string): string {
  return text.replace(/^[\s"'“”'‘’]+|[\s"'“”'‘’,.;:!?。！，；：]+$/g, "").replace(/\s+/g, " ").trim();
}

function normalizeWhat(text: string): string {
  return cleanFragment(text)
    .replace(/\bmy\s+/gi, "")
    .replace(/\b(?:last|this)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\b(?:yesterday|today|in\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)|on\s+[A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function mergeDetails(parts: string[]): string {
  const cleaned = parts.map(cleanFragment).filter(Boolean);
  return Array.from(new Set(cleaned)).join(" | ");
}

function normalizeTravelWhat(sentence: string, target: string): string {
  const verb = leadingVerb(sentence);
  if (verb === "went") return `went to ${target}`;
  if (verb === "visited") return `visited ${target}`;
  if (verb === "drove") return `drove to ${target}`;
  return `${verb} to ${target}`;
}

function leadingVerb(sentence: string): string {
  const match = sentence.match(/\b(flew|drove|traveled|travelled|went|visited|attended|participated in|volunteered at|walked in|ran in|started|joined|began|enrolled|signed up|set up|installed|configured|connected|hooked up|rearranged|redecorated|moved|placed|put up|hung|became a member|subscribed to|registered for|got|bought|ordered)\b/i);
  return match ? match[1].toLowerCase() : "did";
}

function leadingChineseVerb(sentence: string): string {
  const match = sentence.match(/(開始|加入|參加了|參加)/);
  return match?.[1] ?? "";
}

function normalizeSessionTimestamp(sessionDate: string): string {
  const parsed = Date.parse(sessionDate);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return startOfUtcDay(sessionDate).toISOString();
}

function normalizePrecision(precision: EventPrecision | string): EventPrecision {
  switch (precision) {
    case "exact":
    case "day":
    case "week":
    case "month":
    case "relative":
      return precision;
    default:
      return "relative";
  }
}

function parseCountToken(value: string): number {
  const normalized = value.trim().toLowerCase();
  const direct = Number.parseInt(normalized, 10);
  if (Number.isFinite(direct)) return direct;
  const numbers: Record<string, number> = {
    a: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
  };
  return numbers[normalized] ?? 1;
}

function startOfUtcDay(input: string): Date {
  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  const fallback = new Date();
  return new Date(Date.UTC(fallback.getUTCFullYear(), fallback.getUTCMonth(), fallback.getUTCDate()));
}

function shiftDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function shiftMonths(base: Date, months: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, base.getUTCDate()));
}

function lastWeekday(base: Date, weekday: string): Date {
  const target = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(
    weekday.toLowerCase()
  );
  if (target < 0) return base;

  const current = base.getUTCDay();
  let diff = current - target;
  if (diff <= 0) diff += 7;
  return shiftDays(base, -diff);
}

function monthNameToIndex(month: string): number {
  return [
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
  ].indexOf(month.toLowerCase());
}

function chineseMonthToIndex(month: string): number {
  return [
    "一月",
    "二月",
    "三月",
    "四月",
    "五月",
    "六月",
    "七月",
    "八月",
    "九月",
    "十月",
    "十一月",
    "十二月",
  ].indexOf(month);
}
