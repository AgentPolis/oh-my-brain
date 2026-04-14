import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { detectEventCategory } from "../src/storage/events.js";

export type RelationType = "trust" | "influence" | "collaboration" | "conflict";
export type RelationLevel = "high" | "medium" | "low";
export type RelationSignalType = "positive" | "negative" | "influence";

export interface Relation {
  id: string;
  person: string;
  relation_type: RelationType;
  domain: string;
  level: RelationLevel;
  evidence: string[];
  last_updated: string;
  notes: string;
}

interface RelationFile {
  version: 1;
  relations: Relation[];
}

export interface RelationSignal {
  person: string;
  type: RelationSignalType;
  domain: string;
  evidence: string;
}

const RELATIONS_FILE = "relations.json";

const TRUST_POSITIVE = [
  /\b([A-Z][\w'-]+)(?:'s| his| her) (?:advice|recommendation|suggestion) (?:was|worked|helped)\b/i,
  /\bthanks to ([A-Z][\w'-]+)\b/i,
  /\b([A-Z][\w'-]+) (?:helped|saved|fixed|solved)\b/i,
  /\bagree with ([A-Z][\w'-]+)\b/i,
  /\b([A-Z][\w'-]+) was right\b/i,
  /\b([A-Z][\w'-]+) (?:recommended|suggested) .{0,80} (?:worked|helped|was right)\b/i,
  /\b([A-Z][\w'-]+) (?:is|was) (?:a )?(?:thorough|careful|reliable) reviewer\b/i,
];

const TRUST_NEGATIVE = [
  /\b([A-Z][\w'-]+)(?:'s| his| her) (?:advice|suggestion) (?:caused|broke|failed)\b/i,
  /\bdisagree with ([A-Z][\w'-]+)\b/i,
  /\b([A-Z][\w'-]+) was wrong\b/i,
  /\bignored ([A-Z][\w'-]+)(?:'s| his| her) advice\b/i,
  /\b([A-Z][\w'-]+) (?:suggested|recommended) .{0,80} (?:broke|failed|caused)\b/i,
];

const INFLUENCE = [
  /\b([A-Z][\w'-]+) (?:told|advised|suggested|recommended|said) (?:I|we|that)\b/i,
  /\bmy (mentor|boss|manager|lead)\b/i,
];

const REVIEW_WORDS = /\b(?:review|reviewer|code review|naming|test coverage|tests?|lint|error handling)\b/i;
const ARCHITECTURE_WORDS = /\b(?:architecture|architectural|microservices?|monolith|service boundaries|system design|design)\b/i;
const TECH_WORDS = /\b(?:tech|redis|postgres|typescript|node|react|database|infra|deployment|stack|library|framework|api)\b/i;

export class RelationStore {
  private readonly squeezePath: string;
  private readonly filePath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.filePath = join(squeezePath, RELATIONS_FILE);
  }

  upsert(relation: Relation): void {
    const relations = this.getAll();
    const normalized = normalizeRelation(relation);
    const key = relationKey(normalized.person, normalized.domain, normalized.relation_type);
    const index = relations.findIndex((entry) => relationKey(entry.person, entry.domain, entry.relation_type) === key);
    if (index >= 0) {
      relations[index] = {
        ...relations[index],
        ...normalized,
        id: relations[index].id,
      };
    } else {
      relations.push(normalized);
    }
    this.save(relations);
  }

  getByPerson(person: string): Relation[] {
    const normalizedPerson = normalizePersonName(person);
    return this.getAll().filter((relation) => normalizePersonName(relation.person) === normalizedPerson);
  }

  getTrusted(domain?: string): Relation[] {
    const normalizedDomain = typeof domain === "string" && domain.trim() ? normalizeDomain(domain) : "";
    return this.getAll().filter((relation) => {
      if (relation.relation_type !== "trust") return false;
      if (relation.level !== "high") return false;
      if (normalizedDomain && relation.domain !== normalizedDomain) return false;
      return true;
    });
  }

  toCompactString(): string {
    const relations = this.getAll();
    if (relations.length === 0) return "";

    const trusted = relations
      .filter((relation) => relation.relation_type === "trust" && relation.level === "high")
      .sort(compareRelations);
    const verify = relations
      .filter((relation) => relation.relation_type === "trust" && relation.level === "low")
      .sort(compareRelations);

    const lines: string[] = [];
    if (trusted.length > 0) {
      lines.push("People you trust:");
      lines.push(...trusted.map(formatCompactRelation));
    }
    if (verify.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("People to verify:");
      lines.push(...verify.map(formatCompactRelation));
    }
    return lines.join("\n");
  }

  getAll(): Relation[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as RelationFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.relations)) return [];
      return parsed.relations.map(normalizeRelation).sort(compareRelations);
    } catch {
      return [];
    }
  }

  getSummary(): { total: number; people: number; high_trust: number } {
    const relations = this.getAll();
    return {
      total: relations.length,
      people: new Set(relations.map((relation) => normalizePersonName(relation.person))).size,
      high_trust: relations.filter((relation) => relation.relation_type === "trust" && relation.level === "high").length,
    };
  }

  private save(relations: Relation[]): void {
    mkdirSync(this.squeezePath, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, relations: relations.sort(compareRelations) }, null, 2));
    renameSync(tmp, this.filePath);
  }
}

export function detectRelationSignals(text: string): RelationSignal[] {
  const signals: RelationSignal[] = [];
  for (const pattern of TRUST_POSITIVE) {
    const match = text.match(pattern);
    const person = normalizePersonName(match?.[1] ?? "");
    if (!person) continue;
    signals.push({
      person,
      type: "positive",
      domain: inferRelationDomain(text),
      evidence: text,
    });
  }
  for (const pattern of TRUST_NEGATIVE) {
    const match = text.match(pattern);
    const person = normalizePersonName(match?.[1] ?? "");
    if (!person) continue;
    signals.push({
      person,
      type: "negative",
      domain: inferRelationDomain(text),
      evidence: text,
    });
  }
  for (const pattern of INFLUENCE) {
    const match = text.match(pattern);
    const person = normalizePersonName(match?.[1] ?? "");
    if (!person) continue;
    signals.push({
      person,
      type: "influence",
      domain: inferRelationDomain(text),
      evidence: text,
    });
  }
  return dedupeSignals(signals);
}

export function updateRelation(
  store: RelationStore,
  person: string,
  signal: "positive" | "negative",
  domain: string,
  evidence: string
): void {
  const normalizedPerson = normalizePersonName(person);
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedPerson) return;

  const existing = store
    .getByPerson(normalizedPerson)
    .find((relation) => relation.relation_type === "trust" && relation.domain === normalizedDomain);

  if (!existing) {
    store.upsert({
      id: randomUUID(),
      person: normalizedPerson,
      relation_type: "trust",
      domain: normalizedDomain,
      level: signal === "negative" ? "low" : "medium",
      evidence: [evidence],
      last_updated: new Date().toISOString(),
      notes: summarizeEvidence(evidence),
    });
    return;
  }

  if (existing.evidence.includes(evidence)) return;
  store.upsert({
    ...existing,
    level: evolveLevel(existing.level, signal),
    evidence: [...existing.evidence, evidence],
    last_updated: new Date().toISOString(),
    notes: summarizeEvidence(evidence),
  });
}

export function upsertInfluenceRelation(
  store: RelationStore,
  person: string,
  domain: string,
  evidence: string
): void {
  const normalizedPerson = normalizePersonName(person);
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedPerson) return;

  const existing = store
    .getByPerson(normalizedPerson)
    .find((relation) => relation.relation_type === "influence" && relation.domain === normalizedDomain);
  if (existing?.evidence.includes(evidence)) return;

  store.upsert({
    id: existing?.id ?? randomUUID(),
    person: normalizedPerson,
    relation_type: "influence",
    domain: normalizedDomain,
    level: evolveLevel(existing?.level ?? "medium", "positive"),
    evidence: existing ? [...existing.evidence, evidence] : [evidence],
    last_updated: new Date().toISOString(),
    notes: summarizeEvidence(evidence),
  });
}

export function normalizePersonName(person: string): string {
  const cleaned = person.trim().replace(/^(?:my|our)\s+/i, "").replace(/\s+/g, " ");
  if (!cleaned) return "";

  const properNouns = cleaned.match(/[A-Z][\w'-]*/g);
  if (properNouns && properNouns.length > 0) {
    return properNouns.at(-1) ?? "";
  }

  const lower = cleaned.toLowerCase();
  const roleMatch = lower.match(/\b(mentor|boss|manager|lead|mechanic|doctor|friend|colleague|reviewer)\b/);
  if (roleMatch) return roleMatch[1];

  return cleaned;
}

export function inferRelationDomain(text: string): string {
  if (ARCHITECTURE_WORDS.test(text)) return "architecture";
  if (REVIEW_WORDS.test(text)) return "code-review";
  if (TECH_WORDS.test(text)) return "tech";

  const category = detectEventCategory(text);
  switch (category) {
    case "work":
      return "general";
    case "other":
      return "general";
    default:
      return category;
  }
}

function normalizeRelation(relation: Relation): Relation {
  return {
    ...relation,
    id: relation.id || randomUUID(),
    person: normalizePersonName(relation.person),
    relation_type: normalizeRelationType(relation.relation_type),
    domain: normalizeDomain(relation.domain),
    level: normalizeLevel(relation.level),
    evidence: Array.isArray(relation.evidence)
      ? Array.from(new Set(relation.evidence.filter((entry) => typeof entry === "string" && entry.trim().length > 0)))
      : [],
    last_updated: normalizeIso(relation.last_updated),
    notes: relation.notes?.trim() ?? "",
  };
}

function normalizeRelationType(value: RelationType | string): RelationType {
  switch (value) {
    case "trust":
    case "influence":
    case "collaboration":
    case "conflict":
      return value;
    default:
      return "trust";
  }
}

function normalizeLevel(value: RelationLevel | string): RelationLevel {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return "medium";
  }
}

function normalizeDomain(domain: string | undefined): string {
  const cleaned = domain?.trim().toLowerCase() ?? "";
  return cleaned || "general";
}

function relationKey(person: string, domain: string, relationType: RelationType): string {
  return `${normalizePersonName(person)}::${normalizeDomain(domain)}::${relationType}`;
}

function compareRelations(a: Relation, b: Relation): number {
  return a.person.localeCompare(b.person) || a.domain.localeCompare(b.domain) || a.relation_type.localeCompare(b.relation_type);
}

function formatCompactRelation(relation: Relation): string {
  const note = relation.notes ? ` — ${relation.notes}` : "";
  return `  ${relation.person} (${relation.domain}: ${relation.level})${note}`;
}

function summarizeEvidence(evidence: string): string {
  return evidence.trim().replace(/\s+/g, " ").slice(0, 100);
}

function evolveLevel(level: RelationLevel, signal: "positive" | "negative"): RelationLevel {
  if (signal === "positive") {
    if (level === "low") return "medium";
    if (level === "medium") return "high";
    return "high";
  }
  if (level === "high") return "medium";
  if (level === "medium") return "low";
  return "low";
}

function dedupeSignals(signals: RelationSignal[]): RelationSignal[] {
  const seen = new Set<string>();
  const deduped: RelationSignal[] = [];
  for (const signal of signals) {
    const key = `${signal.type}::${signal.person}::${signal.domain}::${signal.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signal);
  }
  return deduped;
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date(0).toISOString();
  return new Date(parsed).toISOString();
}
