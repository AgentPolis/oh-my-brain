import { existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { stdin as input, stdout as output } from "process";
import { join } from "path";
import { applyRememberDirective } from "./actions.js";
import { detectImportFiles, scanImportFile } from "./import.js";
import { ingestCandidates, loadCandidateStore, saveCandidateStore } from "./candidates.js";
import { parseExistingDirectives } from "./compress-core.js";

interface InitSummary {
  directives: string[];
  candidates: string[];
  skipped: number;
  sources: Array<{ name: string; count: number }>;
}

function detectProjectRules(projectRoot: string): string[] {
  const rules: string[] = [];

  const tsconfigPath = join(projectRoot, "tsconfig.json");
  if (existsSync(tsconfigPath)) {
    try {
      const parsed = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
        compilerOptions?: { strict?: boolean };
      };
      if (parsed.compilerOptions?.strict) {
        rules.push("TypeScript strict mode is enabled in this project");
      }
    } catch {}
  }

  const packagePath = join(projectRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as {
        type?: string;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      if (parsed.type === "module") {
        rules.push("This project uses ESM (import/export), not CommonJS (require)");
      }
      if (parsed.devDependencies?.vitest || parsed.dependencies?.vitest) {
        rules.push("This project uses Vitest for tests");
      }
    } catch {}
  }

  return rules;
}

function buildInitSummary(projectRoot: string): InitSummary {
  const directives: string[] = [];
  const candidates: string[] = [];
  let skipped = 0;
  const sources: Array<{ name: string; count: number }> = [];

  for (const file of detectImportFiles(projectRoot)) {
    const result = scanImportFile(projectRoot, join(projectRoot, file));
    directives.push(...result.directives);
    candidates.push(...result.candidates);
    skipped += result.skipped;
    sources.push({
      name: file,
      count: result.directives.length + result.candidates.length,
    });
  }

  const projectRules = detectProjectRules(projectRoot);
  directives.push(...projectRules);
  if (projectRules.length > 0) {
    sources.push({ name: "project config", count: projectRules.length });
  }

  const existingMemory = join(projectRoot, "MEMORY.md");
  if (existsSync(existingMemory)) {
    const existingCount = parseExistingDirectives(readFileSync(existingMemory, "utf8")).size;
    sources.push({ name: "MEMORY.md", count: existingCount });
  }

  return {
    directives: Array.from(new Set(directives)),
    candidates: Array.from(new Set(candidates)),
    skipped,
    sources,
  };
}

async function reviewCandidatesInteractively(
  projectRoot: string,
  candidates: string[]
): Promise<{ accepted: string[]; deferred: string[]; skipped: number }> {
  const rl = createInterface({ input, output });
  const accepted: string[] = [];
  const deferred: string[] = [];
  let skipped = 0;

  try {
    for (const candidate of candidates) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(
          `[brain] Found: "${candidate}"\nConfidence: medium — [A]dd, [S]kip, [C]andidate? `,
          resolve
        );
      });
      const normalized = answer.trim().toUpperCase();
      if (normalized === "A") accepted.push(candidate);
      else if (normalized === "S") skipped += 1;
      else deferred.push(candidate);
    }
  } finally {
    rl.close();
  }

  return { accepted, deferred, skipped };
}

export async function runInitCli(argv: string[], projectRoot: string): Promise<number> {
  const args = argv.slice(2);
  const autoYes = args.includes("--yes") || !process.stdin.isTTY;
  const summary = buildInitSummary(projectRoot);

  process.stdout.write("[brain] Scanning project...\n");
  process.stdout.write("[brain] Found these sources:\n");
  for (const source of summary.sources) {
    process.stdout.write(`  ${source.name} (${source.count} rules detected)\n`);
  }
  process.stdout.write("\n[brain] Analysis:\n");
  process.stdout.write(`  ✅ ${summary.directives.length} high-confidence rules\n`);
  process.stdout.write(`  🔍 ${summary.candidates.length} uncertain rules\n`);
  process.stdout.write(`  ⏭ ${summary.skipped} skipped lines\n`);

  let directivesToWrite = [...summary.directives];
  let candidatesToQueue = [...summary.candidates];
  let skipped = summary.skipped;

  if (!autoYes && candidatesToQueue.length > 0) {
    const reviewed = await reviewCandidatesInteractively(projectRoot, candidatesToQueue);
    directivesToWrite.push(...reviewed.accepted);
    candidatesToQueue = reviewed.deferred;
    skipped += reviewed.skipped;
  }

  const existingDirectives = existsSync(join(projectRoot, "MEMORY.md"))
    ? parseExistingDirectives(readFileSync(join(projectRoot, "MEMORY.md"), "utf8"))
    : new Set<string>();
  directivesToWrite = directivesToWrite.filter((directive) => !existingDirectives.has(directive));

  let written = 0;
  for (const directive of directivesToWrite) {
    const action = applyRememberDirective(
      { projectRoot, source: "unknown", sessionId: "init" },
      { text: directive }
    );
    if (action.payload.written) written += 1;
  }

  const store = loadCandidateStore(projectRoot);
  const createdCandidates = candidatesToQueue.flatMap((candidate) =>
    ingestCandidates(store, [candidate], {
      source: "unknown",
      sessionId: "init",
      projectRoot,
    })
  );
  saveCandidateStore(projectRoot, store);

  process.stdout.write(
    `\n[brain] Final report: ${written} directives written, ${createdCandidates.length} candidates added, ${skipped} skipped\n`
  );
  return 0;
}
