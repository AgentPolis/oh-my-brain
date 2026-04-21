/**
 * First-run onboarding for oh-my-brain.
 *
 * Detects the environment, asks the user where MEMORY.md should live,
 * and writes a config marker so compress hook knows the brain location.
 *
 * Called from `oh-my-brain init` (interactive) and compress hook (non-interactive hint).
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { defaultScopeConfig, hasBrainDir, initBrainDir, saveScopeConfig } from "./brain-store.js";
import { resolveMemoryPath, resolveMemoryScope } from "../src/scope.js";

// ── Environment detection ──────────────────────────────────────────

export interface EnvironmentInfo {
  cwd: string;
  cwdName: string;
  isProjectRoot: boolean;
  isWorkspace: boolean;
  subProjects: string[];
  hasExistingMemory: boolean;
  existingMemoryPath: string | null;
  projectMarkers: string[];
}

const PROJECT_MARKERS = [
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

export function detectEnvironment(cwd: string): EnvironmentInfo {
  const cwdName = basename(cwd);
  const projectMarkers = PROJECT_MARKERS.filter((m) => existsSync(join(cwd, m)));
  const hasGit = existsSync(join(cwd, ".git"));
  const isProjectRoot = projectMarkers.length > 0 || hasGit;

  // Scan subdirectories for .git (workspace detection)
  const subProjects: string[] = [];
  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (existsSync(join(cwd, entry.name, ".git"))) {
        subProjects.push(entry.name);
      }
    }
  } catch {
    // permission error or similar, skip
  }

  const isWorkspace = !hasGit && subProjects.length >= 2;

  const memoryPath = resolveMemoryPath(cwd);
  const hasExistingMemory = existsSync(memoryPath);

  return {
    cwd,
    cwdName,
    isProjectRoot,
    isWorkspace,
    subProjects,
    hasExistingMemory,
    existingMemoryPath: hasExistingMemory ? memoryPath : null,
    projectMarkers,
  };
}

// ── Onboarding config ──────────────────────────────────────────────

export interface OnboardingConfig {
  brainPath: string;       // absolute path to MEMORY.md
  onboardedAt: string;     // ISO timestamp
  environment: "project" | "workspace" | "directory";
}

export function getOnboardingConfig(cwd: string): OnboardingConfig | null {
  const scope = resolveMemoryScope(cwd);
  if (!existsSync(join(scope.brainRoot, "scope.json"))) return null;
  return {
    brainPath: scope.memoryPath,
    onboardedAt: new Date().toISOString(),
    environment: scope.scopeRoot === cwd ? "project" : "workspace",
  };
}

export function saveOnboardingConfig(cwd: string, config: OnboardingConfig): void {
  const scopeRoot = config.environment === "workspace" ? cwd : cwd;
  initBrainDir(scopeRoot);
  saveScopeConfig(scopeRoot, {
    ...defaultScopeConfig(scopeRoot),
    projectRoot: scopeRoot,
  });
}

export function isOnboarded(cwd: string): boolean {
  const scope = resolveMemoryScope(cwd);
  return hasBrainDir(scope.scopeRoot);
}

// ── Interactive onboarding (for `oh-my-brain init`) ────────────────

export function formatOnboardingMessage(env: EnvironmentInfo): string {
  const lines: string[] = [];

  lines.push(`\n🧠 oh-my-brain — 初次設定\n`);

  if (env.isWorkspace) {
    lines.push(`偵測到這是一個 workspace 目錄（${env.cwdName}/），底下有 ${env.subProjects.length} 個專案：`);
    for (const sub of env.subProjects.slice(0, 5)) {
      lines.push(`  • ${sub}/`);
    }
    if (env.subProjects.length > 5) {
      lines.push(`  ...還有 ${env.subProjects.length - 5} 個`);
    }
    lines.push("");
    lines.push("如果把記憶存在這裡，所有專案的記憶會混在一起。");
    lines.push("建議在各專案目錄分別跑 oh-my-brain init。\n");
  } else if (env.isProjectRoot) {
    lines.push(`偵測到專案：${env.cwdName}/`);
    if (env.projectMarkers.length > 0) {
      lines.push(`  標記：${env.projectMarkers.join(", ")}`);
    }
    lines.push("");
  } else {
    lines.push(`目前在：${env.cwd}`);
    lines.push("這個目錄沒有專案標記（package.json, go.mod 等）。\n");
  }

  if (env.hasExistingMemory) {
    lines.push(`找到現有的 MEMORY.md：${env.existingMemoryPath}`);
    const content = readFileSync(env.existingMemoryPath!, "utf8");
    const directiveCount = (content.match(/^- \[/gm) || []).length;
    lines.push(`  已有 ${directiveCount} 條記憶\n`);
  }

  return lines.join("\n");
}

export interface OnboardingChoice {
  action: "use-current" | "use-existing" | "skip-workspace";
  brainPath: string;
}

export function getOnboardingOptions(env: EnvironmentInfo): Array<{ key: string; label: string; choice: OnboardingChoice }> {
  const options: Array<{ key: string; label: string; choice: OnboardingChoice }> = [];
  const defaultPath = resolveMemoryPath(env.cwd);

  if (env.isWorkspace) {
    if (env.hasExistingMemory) {
      options.push({
        key: "A",
        label: `繼續用現有的 ${env.cwdName}/MEMORY.md（所有專案共享）`,
        choice: { action: "use-existing", brainPath: defaultPath },
      });
    }
    options.push({
      key: env.hasExistingMemory ? "B" : "A",
      label: "跳過，我會在各專案目錄分別設定",
      choice: { action: "skip-workspace", brainPath: defaultPath },
    });
    if (!env.hasExistingMemory) {
      options.push({
        key: "B",
        label: `在這裡建立共享的 ${env.cwdName}/MEMORY.md`,
        choice: { action: "use-current", brainPath: defaultPath },
      });
    }
  } else {
    if (env.hasExistingMemory) {
      options.push({
        key: "A",
        label: `繼續用現有的 MEMORY.md（${(readFileSync(defaultPath, "utf8").match(/^- \[/gm) || []).length} 條記憶）`,
        choice: { action: "use-existing", brainPath: defaultPath },
      });
      options.push({
        key: "B",
        label: "重新開始（清空 MEMORY.md，重新掃描專案）",
        choice: { action: "use-current", brainPath: defaultPath },
      });
    } else {
      options.push({
        key: "A",
        label: `在 ${env.cwdName}/MEMORY.md 建立大腦（推薦）`,
        choice: { action: "use-current", brainPath: defaultPath },
      });
    }
  }

  return options;
}

// ── Compress hook hint (non-interactive) ──────────────────────────

export function getCompressHookHint(cwd: string): string | null {
  if (isOnboarded(cwd)) return null;

  const env = detectEnvironment(cwd);

  if (env.isWorkspace) {
    return `[brain] ⚠️ 這是 workspace 目錄（${env.subProjects.length} 個專案）。記憶會混在一起。建議跑 oh-my-brain init 設定。`;
  }

  if (!env.hasExistingMemory) {
    return `[brain] 🧠 記憶存在 ${resolveMemoryPath(cwd)}。跑 oh-my-brain init 可以自訂設定。`;
  }

  return null;
}
