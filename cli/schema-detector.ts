import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import type { Habit } from "./habit-detector.js";
import { detectEventCategory } from "./event-extractor.js";

export interface CognitiveSchema {
  id: string;
  name: string;
  description: string;
  steps: string[];
  evidence: {
    habits: string[];
    directives: string[];
    events: string[];
  };
  confidence: number;
  category: string;
  first_detected: string;
  last_updated: string;
}

interface SchemaFile {
  version: 1;
  schemas: CognitiveSchema[];
}

const SCHEMAS_FILE = "schemas.json";
const ACTION_WORDS = /\b(?:check|verify|review|evaluate|compare|ensure|audit|test|validate|inspect)\b/i;
const GENERIC_PATTERN_WORDS = /\b(?:always|regularly|consistently|usually|first|before)\b/i;
const EXCLUDED_CATEGORIES = new Set(["travel", "shopping", "entertainment", "pets", "social", "other"]);

export class SchemaStore {
  private readonly squeezePath: string;
  private readonly filePath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.filePath = join(squeezePath, SCHEMAS_FILE);
  }

  upsert(schema: CognitiveSchema): void {
    const schemas = this.getAll();
    const normalized = normalizeSchema(schema);
    const index = schemas.findIndex((entry) => entry.category === normalized.category || entry.name === normalized.name);
    if (index >= 0) {
      schemas[index] = {
        ...schemas[index],
        ...normalized,
        id: schemas[index].id,
        first_detected: schemas[index].first_detected,
      };
    } else {
      schemas.push(normalized);
    }
    this.save(schemas);
  }

  getAll(): CognitiveSchema[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SchemaFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.schemas)) return [];
      return parsed.schemas.map(normalizeSchema).sort(compareSchemas);
    } catch {
      return [];
    }
  }

  getByCategory(category: string): CognitiveSchema[] {
    const normalized = normalizeCategory(category);
    return this.getAll().filter((schema) => schema.category === normalized);
  }

  toCompactString(): string {
    const schemas = this.getAll();
    if (schemas.length === 0) return "";
    const lines = ["Your decision frameworks:"];
    lines.push(
      ...schemas.map((schema) =>
        `  ${formatCategoryLabel(schema.category)}: ${schema.steps.join(" → ")} (confidence: ${trimConfidence(schema.confidence)})`
      )
    );
    return lines.join("\n");
  }

  getSummary(): { total: number; categories: string[] } {
    const schemas = this.getAll();
    return {
      total: schemas.length,
      categories: Array.from(new Set(schemas.map((schema) => schema.category))).sort((a, b) => a.localeCompare(b)),
    };
  }

  private save(schemas: CognitiveSchema[]): void {
    mkdirSync(this.squeezePath, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, schemas: schemas.sort(compareSchemas) }, null, 2));
    renameSync(tmp, this.filePath);
  }
}

export function detectSchemas(
  habits: Habit[],
  directives: string[],
  existingSchemas: CognitiveSchema[]
): CognitiveSchema[] {
  const grouped = new Map<string, Habit[]>();
  for (const habit of habits) {
    const category = inferCategory(habit.pattern);
    if (!isSchemaCategory(category)) continue;
    if (!isFrameworkStep(habit.pattern)) continue;
    const bucket = grouped.get(category) ?? [];
    bucket.push(habit);
    grouped.set(category, bucket);
  }

  const seenCategories = new Set(existingSchemas.map((schema) => normalizeCategory(schema.category)));
  const now = new Date().toISOString();
  const schemas: CognitiveSchema[] = [];

  for (const [category, categoryHabits] of grouped.entries()) {
    if (categoryHabits.length < 2) continue;
    if (seenCategories.has(category)) continue;

    const matchingDirectives = directives.filter((directive) => normalizeCategory(inferCategory(directive)) === category);
    if (matchingDirectives.length < 1) continue;

    const sortedHabits = [...categoryHabits].sort((a, b) => b.confidence - a.confidence || a.pattern.localeCompare(b.pattern));
    const steps = sortedHabits.map((habit) => habit.pattern);

    schemas.push({
      id: randomUUID(),
      name: `${formatCategoryLabel(category)} Framework`,
      description: `How you approach ${category} decisions`,
      steps,
      evidence: {
        habits: sortedHabits.map((habit) => habit.id),
        directives: matchingDirectives,
        events: Array.from(new Set(sortedHabits.flatMap((habit) => habit.evidence))),
      },
      confidence: computeConfidence(sortedHabits.length, matchingDirectives.length),
      category,
      first_detected: now,
      last_updated: now,
    });
  }

  return schemas.sort(compareSchemas);
}

export function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(?:review|code review|error handling|naming|test coverage|tests?|lint)\b/.test(lower)) {
    return "code-review";
  }
  if (/\b(?:architecture|architectural|monolith|microservices?|service boundaries|team size|team >|split|package)\b/.test(lower)) {
    return "architecture";
  }

  const detected = detectEventCategory(text);
  return normalizeCategory(detected);
}

function isFrameworkStep(pattern: string): boolean {
  return ACTION_WORDS.test(pattern) || GENERIC_PATTERN_WORDS.test(pattern);
}

function isSchemaCategory(category: string): boolean {
  return !EXCLUDED_CATEGORIES.has(category);
}

function normalizeSchema(schema: CognitiveSchema): CognitiveSchema {
  return {
    ...schema,
    id: schema.id || randomUUID(),
    name: schema.name?.trim() || `${formatCategoryLabel(schema.category)} Framework`,
    description: schema.description?.trim() || `How you approach ${normalizeCategory(schema.category)} decisions`,
    steps: Array.isArray(schema.steps)
      ? schema.steps.filter((step) => typeof step === "string").map((step) => step.trim()).filter(Boolean)
      : [],
    evidence: {
      habits: Array.isArray(schema.evidence?.habits)
        ? Array.from(new Set(schema.evidence.habits.filter((value) => typeof value === "string" && value.trim().length > 0)))
        : [],
      directives: Array.isArray(schema.evidence?.directives)
        ? Array.from(new Set(schema.evidence.directives.filter((value) => typeof value === "string" && value.trim().length > 0)))
        : [],
      events: Array.isArray(schema.evidence?.events)
        ? Array.from(new Set(schema.evidence.events.filter((value) => typeof value === "string" && value.trim().length > 0)))
        : [],
    },
    confidence: normalizeConfidence(schema.confidence),
    category: normalizeCategory(schema.category),
    first_detected: normalizeIso(schema.first_detected),
    last_updated: normalizeIso(schema.last_updated),
  };
}

function normalizeCategory(category: string | undefined): string {
  return category?.trim().toLowerCase() || "general";
}

function computeConfidence(habitCount: number, directiveCount: number): number {
  return Math.min(1, Number((0.35 + habitCount * 0.15 + directiveCount * 0.1).toFixed(2)));
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Number(value.toFixed(2))));
}

function normalizeIso(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date(0).toISOString();
  return new Date(parsed).toISOString();
}

function compareSchemas(a: CognitiveSchema, b: CognitiveSchema): number {
  return a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
}

function formatCategoryLabel(category: string): string {
  return category
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function trimConfidence(confidence: number): string {
  return confidence.toFixed(2).replace(/0+$/g, "").replace(/\.$/, "");
}
