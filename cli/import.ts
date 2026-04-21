import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { resolveMemoryPath } from "../src/scope.js";
import { classify } from "../src/triage/classifier.js";
import { Level } from "../src/types.js";
import { applyRememberDirective } from "./actions.js";
import { ingestCandidates, loadCandidateStore, saveCandidateStore } from "./candidates.js";
import { parseExistingDirectives, scanForInjection } from "./compress-core.js";

const SUPPORTED_IMPORT_FILES = [
  ".cursorrules",
  ".clinerules",
  ".github/copilot-instructions.md",
  "CLAUDE.md",
  ".windsurfrules",
];

interface ImportResult {
  imported: number;
  candidates: number;
  skipped: number;
}

export interface ImportScanResult {
  directives: string[];
  candidates: string[];
  skipped: number;
}

function detectEncoding(buffer: Buffer): "utf8" | "utf16le" | "utf16be" | "binary" {
  if (buffer.length === 0) return "utf8";
  if (buffer.includes(0)) return "binary";
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf16le";
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return "utf16be";
  return "utf8";
}

function decodeFile(filePath: string): string | null {
  const buffer = readFileSync(filePath);
  const encoding = detectEncoding(buffer);
  if (encoding === "binary") return null;
  if (encoding === "utf16le") {
    return buffer.slice(2).toString("utf16le");
  }
  if (encoding === "utf16be") {
    const body = buffer.slice(2);
    const swapped = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i += 2) {
      swapped[i] = body[i + 1] ?? 0;
      swapped[i + 1] = body[i] ?? 0;
    }
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}

function normalizeImportLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim();
}

function shouldSkipLine(line: string): boolean {
  return (
    line.length === 0 ||
    line.startsWith("#") ||
    line.startsWith("//") ||
    line.startsWith("<!--")
  );
}

export function detectImportFiles(projectRoot: string): string[] {
  return SUPPORTED_IMPORT_FILES.filter((file) => existsSync(join(projectRoot, file)));
}

export function scanImportFile(projectRoot: string, filePath: string): ImportScanResult {
  if (filePath.endsWith("MEMORY.md")) {
    process.stderr.write(`[brain] warning: skipping ${filePath}; do not import from MEMORY.md\n`);
    return { directives: [], candidates: [], skipped: 0 };
  }
  if (!existsSync(filePath)) {
    process.stderr.write(`[brain] warning: file not found: ${filePath}\n`);
    return { directives: [], candidates: [], skipped: 0 };
  }

  const decoded = decodeFile(filePath);
  if (decoded === null) {
    process.stderr.write(`[brain] warning: skipping binary file ${filePath}\n`);
    return { directives: [], candidates: [], skipped: 0 };
  }
  if (decoded.trim().length === 0) {
    process.stderr.write(`[brain] warning: skipping empty file ${filePath}\n`);
    return { directives: [], candidates: [], skipped: 0 };
  }

  const memoryPath = resolveMemoryPath(projectRoot);
  const existingDirectives = existsSync(memoryPath)
    ? parseExistingDirectives(readFileSync(memoryPath, "utf8"))
    : new Set<string>();
  const directives: string[] = [];
  const candidates: string[] = [];
  let skipped = 0;

  for (const rawLine of decoded.split(/\r?\n/)) {
    const line = normalizeImportLine(rawLine);
    if (shouldSkipLine(line)) continue;

    const guard = scanForInjection(line);
    if (!guard.safe) {
      skipped += 1;
      continue;
    }

    if (existingDirectives.has(line)) {
      continue;
    }

    const classification = classify(
      { role: "user", content: line },
      { confidenceThreshold: 0.5, mode: "regex" }
    );

    if (classification.level === Level.Directive && classification.confidence >= 0.8) {
      directives.push(line);
      existingDirectives.add(line);
      continue;
    }

    if (
      classification.confidence >= 0.4 &&
      (classification.level === Level.Preference || classification.level === Level.Directive)
    ) {
      candidates.push(line);
      continue;
    }

    skipped += 1;
  }

  return { directives, candidates, skipped };
}

export async function importRulesFromFile(projectRoot: string, filePath: string): Promise<ImportResult> {
  const plan = scanImportFile(projectRoot, filePath);
  const candidateStore = loadCandidateStore(projectRoot);
  let imported = 0;

  for (const directive of plan.directives) {
    const action = await applyRememberDirective(
      { projectRoot, source: "unknown", sessionId: `import:${filePath}` },
      { text: directive }
    );
    if (action.payload.written) imported += 1;
  }

  const createdCandidates = plan.candidates.flatMap((candidate) =>
    ingestCandidates(candidateStore, [candidate], {
      source: "unknown",
      sessionId: `import:${filePath}`,
      projectRoot,
    })
  );
  saveCandidateStore(projectRoot, candidateStore);
  return { imported, candidates: createdCandidates.length, skipped: plan.skipped };
}

export async function runImportCli(argv: string[], projectRoot: string): Promise<number> {
  const args = argv.slice(2);
  const fromIndex = args.indexOf("--from");
  const explicitPath = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
  const targets = explicitPath
    ? [join(projectRoot, explicitPath)]
    : detectImportFiles(projectRoot).map((file) => join(projectRoot, file));

  if (targets.length === 0) {
    process.stdout.write("Imported: 0 directives, 0 candidates, 0 skipped\n");
    return 0;
  }

  let imported = 0;
  let candidates = 0;
  let skipped = 0;

  for (const target of targets) {
    const result = await importRulesFromFile(projectRoot, target);
    imported += result.imported;
    candidates += result.candidates;
    skipped += result.skipped;
  }

  process.stdout.write(
    `Imported: ${imported} directives, ${candidates} candidates, ${skipped} skipped\n`
  );
  return 0;
}
