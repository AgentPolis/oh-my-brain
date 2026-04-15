import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ProcedureRecord } from "../types.js";

const PROCEDURES_FILE = "procedures.jsonl";

export class ProcedureStore {
  private squeezePath: string;
  private proceduresPath: string;

  constructor(squeezePath: string) {
    this.squeezePath = squeezePath;
    this.proceduresPath = join(squeezePath, PROCEDURES_FILE);
  }

  append(record: ProcedureRecord): void {
    mkdirSync(this.squeezePath, { recursive: true });
    appendFileSync(this.proceduresPath, `${JSON.stringify(record)}\n`);
  }

  getAll(): ProcedureRecord[] {
    if (!existsSync(this.proceduresPath)) return [];
    const raw = readFileSync(this.proceduresPath, "utf8");
    if (!raw.trim()) return [];
    const records: ProcedureRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as ProcedureRecord);
      } catch {
        continue;
      }
    }
    return records;
  }

  getApproved(): ProcedureRecord[] {
    return this.getAll().filter((r) => r.status === "approved");
  }

  findApprovedByTrigger(taskDescription: string): ProcedureRecord | null {
    const keywords = taskDescription.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (keywords.length === 0) return null;

    const approved = this.getApproved();
    let bestMatch: ProcedureRecord | null = null;
    let bestScore = 0;

    for (const record of approved) {
      const triggerWords = record.trigger.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      if (triggerWords.length === 0) continue;

      const unionSize = new Set([...keywords, ...triggerWords]).size;
      const intersectionSize = keywords.filter((kw) => triggerWords.some((tw) => tw.includes(kw) || kw.includes(tw))).length;
      const score = intersectionSize / unionSize;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = record;
      }
    }

    return bestScore > 0.3 ? bestMatch : null;
  }

  updateStatus(id: string, status: ProcedureRecord["status"]): boolean {
    const all = this.getAll();
    const idx = all.findIndex((r) => r.id === id);
    if (idx === -1) return false;

    all[idx].status = status;
    all[idx].updated_at = new Date().toISOString();

    mkdirSync(this.squeezePath, { recursive: true });
    const serialized = all.map((r) => `${JSON.stringify(r)}\n`).join("");
    writeFileSync(this.proceduresPath, serialized);
    return true;
  }
}
