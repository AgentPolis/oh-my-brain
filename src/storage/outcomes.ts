import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import type { OutcomeRecord } from "../types.js";

const OUTCOMES_FILE = "outcomes.jsonl";

export class OutcomeStore {
  private squeezePath: string;
  private outcomesPath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.outcomesPath = join(squeezePath, OUTCOMES_FILE);
  }

  append(records: OutcomeRecord[]): void {
    if (records.length === 0) return;
    mkdirSync(this.squeezePath, { recursive: true });
    const serialized = records.map((r) => `${JSON.stringify(r)}\n`).join("");
    appendFileSync(this.outcomesPath, serialized);
  }

  getAll(): OutcomeRecord[] {
    if (!existsSync(this.outcomesPath)) return [];
    const raw = readFileSync(this.outcomesPath, "utf8");
    if (!raw.trim()) return [];
    const records: OutcomeRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as OutcomeRecord);
      } catch {
        continue;
      }
    }
    return records;
  }

  getRecent(limit: number): OutcomeRecord[] {
    return this.getAll()
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  findRelevant(taskDescription: string, limit: number): OutcomeRecord[] {
    const keywords = taskDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return [];

    const scored = this.getAll().map((record) => {
      const text = `${record.failure_mode} ${record.context} ${record.lesson}`.toLowerCase();
      const matches = keywords.filter((kw) => text.includes(kw)).length;
      return { record, score: matches / keywords.length };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.record);
  }

  isDuplicate(failureMode: string, currentTimestamp: string): boolean {
    const current = Date.parse(currentTimestamp);
    const DAY_MS = 24 * 60 * 60 * 1000;
    const normalized = failureMode.toLowerCase().trim();
    return this.getAll().some((r) => {
      const age = current - Date.parse(r.timestamp);
      return age >= 0 && age < DAY_MS && r.failure_mode.toLowerCase().trim() === normalized;
    });
  }
}
