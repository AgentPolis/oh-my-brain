import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ResolvedMemoryScope {
  scopeRoot: string;
  brainRoot: string;
  memoryPath: string;
  systemRoot: string;
  source:
    | "explicit-config"
    | "existing-brain"
    | "existing-memory"
    | "single-project-default"
    | "fallback-default";
}

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "CMakeLists.txt",
  "Makefile",
];

function hasProjectMarker(dir: string): boolean {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

function* ancestors(startDir: string): Generator<string> {
  let current = resolve(startDir);
  while (true) {
    yield current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function resolveMemoryScope(startDir: string): ResolvedMemoryScope {
  const resolvedStart = resolve(startDir);
  let fallbackProjectRoot: string | null = null;
  let memoryCandidate: string | null = null;
  let brainCandidate: string | null = null;

  for (const dir of ancestors(resolvedStart)) {
    const scopedBrain = join(dir, ".brain", "scope.json");
    if (existsSync(scopedBrain)) {
      return {
        scopeRoot: dir,
        brainRoot: join(dir, ".brain"),
        memoryPath: join(dir, "MEMORY.md"),
        systemRoot: join(dir, ".brain", "system"),
        source: "explicit-config",
      };
    }

    if (!brainCandidate && existsSync(join(dir, ".brain"))) {
      brainCandidate = dir;
    }

    if (!memoryCandidate && existsSync(join(dir, "MEMORY.md"))) {
      memoryCandidate = dir;
    }

    if (!fallbackProjectRoot && hasProjectMarker(dir)) {
      fallbackProjectRoot = dir;
    }
  }

  if (brainCandidate) {
    return {
      scopeRoot: brainCandidate,
      brainRoot: join(brainCandidate, ".brain"),
      memoryPath: join(brainCandidate, "MEMORY.md"),
      systemRoot: join(brainCandidate, ".brain", "system"),
      source: "existing-brain",
    };
  }

  if (memoryCandidate) {
    return {
      scopeRoot: memoryCandidate,
      brainRoot: join(memoryCandidate, ".brain"),
      memoryPath: join(memoryCandidate, "MEMORY.md"),
      systemRoot: join(memoryCandidate, ".brain", "system"),
      source: "existing-memory",
    };
  }

  if (fallbackProjectRoot) {
    return {
      scopeRoot: fallbackProjectRoot,
      brainRoot: join(fallbackProjectRoot, ".brain"),
      memoryPath: join(fallbackProjectRoot, "MEMORY.md"),
      systemRoot: join(fallbackProjectRoot, ".brain", "system"),
      source: "single-project-default",
    };
  }

  return {
    scopeRoot: resolvedStart,
    brainRoot: join(resolvedStart, ".brain"),
    memoryPath: join(resolvedStart, "MEMORY.md"),
    systemRoot: join(resolvedStart, ".brain", "system"),
    source: "fallback-default",
  };
}

export function resolveScopeRoot(startDir: string): string {
  return resolveMemoryScope(startDir).scopeRoot;
}

export function resolveBrainRoot(startDir: string): string {
  return resolveMemoryScope(startDir).brainRoot;
}

export function resolveMemoryPath(startDir: string): string {
  return resolveMemoryScope(startDir).memoryPath;
}

export function resolveSystemRoot(startDir: string): string {
  return resolveMemoryScope(startDir).systemRoot;
}
