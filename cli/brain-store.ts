/**
 * .brain/ — Structured cognitive model storage.
 *
 * Source of truth for identity, goals, domains, projects, and episodes.
 * MEMORY.md is a projection of this data via assembleBrainToMemory().
 *
 * Directory structure:
 *   .brain/
 *   ├── identity.md        — stable user traits
 *   ├── goals.md           — long-term objectives
 *   ├── domains/
 *   │   ├── work.md        — role & standards per life domain
 *   │   └── ...
 *   ├── projects/
 *   │   ├── oh-my-brain.md — progress + handoff log + decisions
 *   │   └── ...
 *   ├── episodes/
 *   │   └── brain.pg/      — PGLite knowledge graph
 *   └── system/            — audit trail, candidates, archive
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  cpSync,
  lstatSync,
} from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { resolveMemoryPath, resolveMemoryScope } from "../src/scope.js";

// ── Types ──────────────────────────────────────────────────────────

export type BrainLayer = "identity" | "goals" | "domain" | "project" | "coding";

export interface BrainPaths {
  root: string;           // .brain/
  scope: string;          // .brain/scope.json
  identity: string;       // .brain/identity.md
  goals: string;          // .brain/goals.md
  coding: string;         // .brain/coding.md
  domainsDir: string;     // .brain/domains/
  projectsDir: string;    // .brain/projects/
  episodesDir: string;    // .brain/episodes/
  systemDir: string;      // .brain/system/
  lastSession: string;    // .brain/system/last-session.json
}

export interface ProjectInfo {
  name: string;
  domain: string;
  status: string;         // first line of 現況
  inProgress: string[];   // bullet items from 進行中
  lastHandoff: string;    // most recent handoff entry
}

export interface HandoffEntry {
  date: string;           // YYYY-MM-DD
  time?: string;          // AM/PM
  summary: string;        // 3-5 lines
}

export interface LastSession {
  domain: string;
  project: string;
  timestamp: string;
  incomplete?: boolean;   // true if session ended abruptly
}

export interface BrainScopeConfig {
  kind: "project";
  projectRoot: string;
  localFirst: true;
  overlayGlobalPreferences: boolean;
  globalBrainRoot?: string;
}

// ── Path Resolution ───────────────────────────────────────────────

export function resolveBrainPaths(projectRoot: string): BrainPaths {
  const scope = resolveMemoryScope(projectRoot);
  const root = scope.brainRoot;
  return {
    root,
    scope: join(root, "scope.json"),
    identity: join(root, "identity.md"),
    goals: join(root, "goals.md"),
    coding: join(root, "coding.md"),
    domainsDir: join(root, "domains"),
    projectsDir: join(root, "projects"),
    episodesDir: join(root, "episodes"),
    systemDir: join(root, "system"),
    lastSession: join(root, "system", "last-session.json"),
  };
}

export function hasBrainDir(projectRoot: string): boolean {
  return existsSync(resolveMemoryScope(projectRoot).brainRoot);
}

// ── Initialization ────────────────────────────────────────────────

export function initBrainDir(projectRoot: string): BrainPaths {
  const paths = resolveBrainPaths(projectRoot);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.domainsDir, { recursive: true });
  mkdirSync(paths.projectsDir, { recursive: true });
  mkdirSync(paths.episodesDir, { recursive: true });
  mkdirSync(paths.systemDir, { recursive: true });

  // Create defaults if not exist
  if (!existsSync(paths.identity)) {
    writeFileSync(paths.identity, "## Identity\n\n", "utf8");
  }
  if (!existsSync(paths.goals)) {
    writeFileSync(paths.goals, "## Goals\n\n", "utf8");
  }
  if (!existsSync(paths.coding)) {
    writeFileSync(paths.coding, "## Coding\n\n", "utf8");
  }
  if (!existsSync(paths.scope)) {
    writeFileSync(
      paths.scope,
      JSON.stringify(defaultScopeConfig(projectRoot), null, 2) + "\n",
      "utf8",
    );
  }

  // Ensure .brain/ is ignored (personal data protection).
  ensureGitignore(projectRoot, [".brain/"]);

  return paths;
}

/**
 * Ensure entries exist in .gitignore. Creates the file if missing.
 * Idempotent — won't add duplicates.
 */
function ensureGitignore(projectRoot: string, entries: string[]): void {
  const gitignorePath = join(projectRoot, ".gitignore");
  let content = "";
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, "utf8");
  }
  const lines = content.split("\n");
  const toAdd = entries.filter((e) => !lines.some((l) => l.trim() === e));
  if (toAdd.length === 0) return;
  const newContent = content.trimEnd() + "\n" + toAdd.join("\n") + "\n";
  writeFileSync(gitignorePath, newContent, "utf8");
}

// ── Read Helpers ──────────────────────────────────────────────────

export function readBrainFile(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

export function defaultScopeConfig(projectRoot: string): BrainScopeConfig {
  return {
    kind: "project",
    projectRoot,
    localFirst: true,
    overlayGlobalPreferences: false,
  };
}

export function loadScopeConfig(projectRoot: string): BrainScopeConfig {
  const paths = resolveBrainPaths(projectRoot);
  const fallback = defaultScopeConfig(projectRoot);
  if (!existsSync(paths.scope)) {
    saveScopeConfig(projectRoot, fallback);
    return fallback;
  }
  try {
    const parsed = JSON.parse(readFileSync(paths.scope, "utf8")) as Partial<BrainScopeConfig>;
    const config = {
      kind: "project",
      projectRoot,
      localFirst: true,
      overlayGlobalPreferences: parsed.overlayGlobalPreferences === true,
      globalBrainRoot: typeof parsed.globalBrainRoot === "string" ? parsed.globalBrainRoot : undefined,
    };
    saveScopeConfig(projectRoot, config);
    return config;
  } catch {
    saveScopeConfig(projectRoot, fallback);
    return fallback;
  }
}

export function saveScopeConfig(projectRoot: string, config: BrainScopeConfig): void {
  const paths = resolveBrainPaths(projectRoot);
  writeFileSync(paths.scope, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function resolveGlobalOverlayPaths(projectRoot: string): BrainPaths | null {
  const scope = loadScopeConfig(projectRoot);
  if (!scope.overlayGlobalPreferences) return null;
  const globalRoot = scope.globalBrainRoot;
  if (!globalRoot || globalRoot === projectRoot) return null;
  const globalPaths = resolveBrainPaths(globalRoot);
  if (!existsSync(globalPaths.root)) return null;
  return globalPaths;
}

export function listDomains(paths: BrainPaths): string[] {
  if (!existsSync(paths.domainsDir)) return [];
  return readdirSync(paths.domainsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"));
}

export function listProjects(paths: BrainPaths): string[] {
  if (!existsSync(paths.projectsDir)) return [];
  return readdirSync(paths.projectsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"));
}

export function readDomain(paths: BrainPaths, domain: string): string {
  return readBrainFile(join(paths.domainsDir, `${domain}.md`));
}

export function readProject(paths: BrainPaths, project: string): string {
  return readBrainFile(join(paths.projectsDir, `${project}.md`));
}

export function getLastSession(paths: BrainPaths): LastSession | null {
  if (!existsSync(paths.lastSession)) return null;
  try {
    return JSON.parse(readFileSync(paths.lastSession, "utf8"));
  } catch {
    return null;
  }
}

export function saveLastSession(paths: BrainPaths, session: LastSession): void {
  writeFileSync(paths.lastSession, JSON.stringify(session, null, 2), "utf8");
}

// ── Write Helpers ─────────────────────────────────────────────────

function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

export function appendToIdentity(paths: BrainPaths, line: string): void {
  const content = readBrainFile(paths.identity);
  const trimmed = line.trim();
  // Dedup: skip if already present
  if (content.includes(trimmed)) return;
  atomicWrite(paths.identity, content.trimEnd() + "\n- " + trimmed + "\n");
}

export function appendToGoals(paths: BrainPaths, line: string): void {
  const content = readBrainFile(paths.goals);
  const trimmed = line.trim();
  if (content.includes(trimmed)) return;
  atomicWrite(paths.goals, content.trimEnd() + "\n- " + trimmed + "\n");
}

export function appendToCoding(paths: BrainPaths, line: string): void {
  const content = readBrainFile(paths.coding);
  const trimmed = line.trim();
  if (content.includes(trimmed)) return;
  atomicWrite(paths.coding, content.trimEnd() + "\n- " + trimmed + "\n");
}

export function writeDomain(paths: BrainPaths, domain: string, content: string): void {
  atomicWrite(join(paths.domainsDir, `${domain}.md`), content);
}

export function appendToDomain(paths: BrainPaths, domain: string, line: string): void {
  const filePath = join(paths.domainsDir, `${domain}.md`);
  const content = readBrainFile(filePath);
  const trimmed = line.trim();
  if (content.includes(trimmed)) return;

  if (content.length === 0) {
    atomicWrite(filePath, `# ${domain}\n\n- ${trimmed}\n`);
  } else {
    atomicWrite(filePath, content.trimEnd() + "\n- " + trimmed + "\n");
  }
}

export function writeProject(paths: BrainPaths, project: string, content: string): void {
  atomicWrite(join(paths.projectsDir, `${project}.md`), content);
}

// ── Handoff Log ───────────────────────────────────────────────────

export function appendHandoff(
  paths: BrainPaths,
  project: string,
  entry: HandoffEntry,
): void {
  const filePath = join(paths.projectsDir, `${project}.md`);
  let content = readBrainFile(filePath);

  const handoffHeader = "## Handoff Log";
  const entryLine = `- ${entry.date}${entry.time ? " " + entry.time : ""}: ${entry.summary}`;

  if (content.includes(handoffHeader)) {
    // Insert after the header
    const idx = content.indexOf(handoffHeader);
    const afterHeader = idx + handoffHeader.length;
    const rest = content.slice(afterHeader);
    // Find the insertion point (right after the header line)
    const newlineIdx = rest.indexOf("\n");
    if (newlineIdx >= 0) {
      content =
        content.slice(0, afterHeader + newlineIdx + 1) +
        entryLine + "\n" +
        rest.slice(newlineIdx + 1);
    } else {
      content = content + "\n" + entryLine + "\n";
    }
  } else {
    // Append new section
    content = content.trimEnd() + "\n\n" + handoffHeader + "\n" + entryLine + "\n";
  }

  // Trim to max 10 entries
  const lines = content.split("\n");
  let count = 0;
  const filtered: string[] = [];
  let inHandoff = false;
  for (const line of lines) {
    if (line.startsWith("## Handoff Log")) {
      inHandoff = true;
      filtered.push(line);
      continue;
    }
    if (inHandoff && line.startsWith("## ")) {
      inHandoff = false;
    }
    if (inHandoff && line.startsWith("- ")) {
      count++;
      if (count > 10) continue; // skip oldest entries beyond 10
    }
    filtered.push(line);
  }

  atomicWrite(filePath, filtered.join("\n"));
}

// ── Project Info Parsing ──────────────────────────────────────────

export function parseProjectInfo(paths: BrainPaths, project: string): ProjectInfo | null {
  const content = readProject(paths, project);
  if (!content) return null;

  const domainMatch = content.match(/^domain:\s*(.+)$/m);
  const domain = domainMatch ? domainMatch[1].trim() : "general";

  const statusMatch = content.match(/## 現況\n([^\n]+)/);
  const status = statusMatch ? statusMatch[1].trim() : "";

  const inProgress: string[] = [];
  const progressMatch = content.match(/## 進行中\n((?:- .+\n?)*)/);
  if (progressMatch) {
    for (const line of progressMatch[1].split("\n")) {
      const m = line.match(/^- (.+)/);
      if (m) inProgress.push(m[1].trim());
    }
  }

  const handoffMatch = content.match(/## Handoff Log\n(- .+)/);
  const lastHandoff = handoffMatch ? handoffMatch[1].replace(/^- /, "").trim() : "";

  return { name: project, domain, status, inProgress, lastHandoff };
}

// ── Domain Detection ──────────────────────────────────────────────

/**
 * Detect which domain is active.
 * Priority: cwd → conversation content → last session → "general".
 */
export function detectDomain(paths: BrainPaths, cwd: string, conversationHint?: string): string {
  const projects = listProjects(paths);
  const cwdLower = cwd.toLowerCase();

  // 1. Check if cwd contains a project name → derive domain from project
  for (const proj of projects) {
    if (cwdLower.includes(proj.toLowerCase())) {
      const info = parseProjectInfo(paths, proj);
      if (info?.domain) return info.domain;
    }
  }

  // 2. Check conversation content for domain signals
  if (conversationHint) {
    const hint = conversationHint.toLowerCase();
    const domains = listDomains(paths);
    // Direct domain name match
    for (const d of domains) {
      if (hint.includes(d)) return d;
    }
    // Content-based signals
    if (/(?:投資|stock|portfolio|trading|基金|ETF|dividend)/i.test(conversationHint)) return "investing";
    if (/(?:學習|study|research|paper|course|書|reading)/i.test(conversationHint)) return "learning";
    if (/(?:code|deploy|ship|bug|feature|PR|commit|test)/i.test(conversationHint)) return "work";
  }

  // 3. Fallback to last session
  const last = getLastSession(paths);
  if (last?.domain) return last.domain;

  // 4. Default
  return "general";
}

/**
 * Detect active project based on cwd.
 */
export function detectProject(paths: BrainPaths, cwd: string): string | null {
  const projects = listProjects(paths);
  const cwdLower = cwd.toLowerCase();

  for (const proj of projects) {
    if (cwdLower.includes(proj.toLowerCase())) {
      return proj;
    }
  }

  const last = getLastSession(paths);
  if (last?.project) return last.project;

  // Fallback: treat the current repo root as an active project even
  // before a dedicated .brain/projects/<name>.md file exists.
  const projectRoot = dirname(paths.root);
  const resolvedCwd = resolve(cwd);
  if (resolvedCwd === projectRoot || resolvedCwd.startsWith(projectRoot + "/")) {
    return basename(projectRoot);
  }

  return null;
}

// ── Context Assembly (MEMORY.md projection) ───────────────────────

/**
 * Assemble .brain/ contents into MEMORY.md working memory.
 * Stable section (identity + coding + goals) first for KV cache.
 * Dynamic section (domain + project) based on detected context.
 */
export function assembleBrainToMemory(
  projectRoot: string,
  cwd?: string,
): string {
  const paths = resolveBrainPaths(projectRoot);
  if (!existsSync(paths.root)) return "";
  const scope = loadScopeConfig(projectRoot);
  const globalPaths = resolveGlobalOverlayPaths(projectRoot);
  const scopeRule = globalPaths
    ? "Scope: project-local brain first; overlay global user preferences enabled."
    : "Scope: project-local brain first; overlay global user preferences only when enabled.";

  const parts: string[] = [
    "<!-- Working Memory — auto-assembled by oh-my-brain -->",
    "<!-- .brain/ is source of truth — do not edit this file -->",
    `<!-- ${scopeRule} -->`,
    `<!-- scope.kind=${scope.kind} project_root=${scope.projectRoot}${globalPaths ? ` global_overlay=${scope.globalBrainRoot}` : ""} -->`,
    "",
    "<!-- ═══ Stable (KV cache friendly) ═══ -->",
    "",
  ];

  // Identity (always full)
  const identity = readBrainFile(paths.identity).trim();
  if (identity) {
    parts.push(identity);
    parts.push("");
  }

  if (globalPaths) {
    const globalIdentity = readBrainFile(globalPaths.identity).trim();
    if (globalIdentity) {
      const overlayBullets = globalIdentity
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "));
      if (overlayBullets.length > 0) {
        parts.push("## Global Preferences (overlay)");
        parts.push(...overlayBullets);
        parts.push("");
      }
    }
  }

  const coding = readBrainFile(paths.coding).trim();
  if (coding) {
    parts.push(coding);
    parts.push("");
  }

  // Goals (always full)
  const goals = readBrainFile(paths.goals).trim();
  if (goals) {
    parts.push(goals);
    parts.push("");
  }

  parts.push("<!-- ═══ Dynamic (per session) ═══ -->");
  parts.push("");

  // Detect domain and project
  const effectiveCwd = cwd ?? projectRoot;
  const domain = detectDomain(paths, effectiveCwd);
  const project = detectProject(paths, effectiveCwd);

  // Domain content
  const domainContent = readDomain(paths, domain).trim();
  if (domainContent) {
    parts.push(domainContent);
    parts.push("");
  }

  // Project content (with handoff)
  if (project) {
    const projectContent = readProject(paths, project).trim();
    if (projectContent) {
      parts.push(projectContent);
      parts.push("");
    }
  }

  // Also include projects from active domain that aren't the detected one
  const domainFile = readDomain(paths, domain);
  const projectRefs = domainFile.match(/→ projects\/(.+)\.md/g);
  if (projectRefs) {
    for (const ref of projectRefs) {
      const projName = ref.match(/→ projects\/(.+)\.md/)?.[1];
      if (projName && projName !== project) {
        // Include a brief summary only
        const info = parseProjectInfo(paths, projName);
        if (info) {
          parts.push(`## Project: ${projName} (secondary)`);
          parts.push(info.status);
          if (info.lastHandoff) {
            parts.push(`Last handoff: ${info.lastHandoff}`);
          }
          parts.push("");
        }
      }
    }
  }

  // Episode surfacing: high-importance lessons in working memory
  const highEpisodes = getHighImportanceEpisodes(paths);
  if (highEpisodes.length > 0) {
    parts.push("## Lessons Learned");
    for (const ep of highEpisodes) {
      parts.push(`- ${ep.what}${ep.decision ? " → " + ep.decision : ""} (${ep.frequency}x)`);
    }
    parts.push("");
  }

  parts.push("<!-- Need more? Use brain_recall to search episodes -->");
  parts.push("");

  return parts.join("\n");
}

/**
 * Write the assembled working memory to MEMORY.md.
 */
export function refreshMemoryMd(projectRoot: string, cwd?: string): void {
  const content = assembleBrainToMemory(projectRoot, cwd);
  if (!content) return;
  const outputPath = join(projectRoot, "MEMORY.md");
  const resolved = resolveMemoryPath(projectRoot);
  const targetPath = resolved || outputPath;
  const tmp = targetPath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, targetPath);
}

// ── Noise Filter (shared by migrate and brainRemember) ────────────

/**
 * Returns true if text looks like noise rather than a genuine directive.
 * Used by both migrate and real-time brainRemember to prevent
 * conversation fragments, prompts, and file paths from polluting memory.
 */
export function isNoise(text: string): boolean {
  if (text.length < 10) return true;
  // IDE metadata
  if (text.includes("<ide_opened_file>") || text.includes("</ide_")) return true;
  // System/extractor prompts
  if (text.includes("You are analyzing") || text.includes("Extract the following")) return true;
  if (text.includes("JSON format") && text.length > 100) return true;
  // Multi-line conversation dumps
  if (text.includes("\n") && text.length > 200) return true;
  // Numbered list items (conversation, not directives)
  if (/^[0-9]+\.\s/.test(text)) return true;
  // Chinese conversation fragments
  if (/^(都要|你認為|怎麼|我覺得|看看|確認一下|剛那|對了|另外|好，|是的|所以|為什麼|能補|最關鍵)/.test(text)) return true;
  // HTML/XML tags
  if (/^<[a-z_]/.test(text)) return true;
  // One-time task instructions
  if (/^(全部做|remove all squeeze|砍掉)/.test(text)) return true;
  // File paths as standalone content
  if (/^\/Users\//.test(text)) return true;
  // Contains file paths inline (likely conversation about files)
  if (/\/Users\/\w+\//.test(text) && text.length > 100) return true;
  // Too many sentences (conversation paragraph, not a rule)
  if ((text.match(/[.。！？!?]/g) || []).length >= 3) return true;
  // Questions are almost never durable directives
  if (/[?？]/.test(text)) return true;
  return false;
}

function directiveStrength(text: string): number {
  const normalized = text.trim();
  const lower = normalized.toLowerCase();
  let score = 0;

  if (normalized.length <= 140) score += 1;
  if (!/[?？]/.test(normalized)) score += 1;

  // Durable preference / operating-rule signals
  if (/^(?:always|never|prefer|default to|use|avoid|keep|before |after |if |commit messages:|memory age annotation|challenge |separate )/i.test(normalized)) {
    score += 3;
  }
  if (/^(?:一律|永遠|預設|用中文|避免|保持|提交訊息|在.+之前|先.+再|不要|別再)/.test(normalized)) {
    score += 3;
  }
  if (/(?:always|never|must|should|default|prefer|一律|永遠|預設|不要|別再|用中文|before storing|memory age annotation)/i.test(normalized)) {
    score += 2;
  }

  // Product / direction signals that belong in goals or project memory
  if (/(?:goal|vision|aspiration|long.?term|目標是|要成為|整體方向|長期)/i.test(normalized)) {
    score += 2;
  }
  if (/(?:branch:|pr #|blocked|in progress|deploy|做到|進行中)/i.test(normalized)) {
    score += 1;
  }

  // Conversational / ephemeral signals
  if (/^(?:i think|i feel|let me|can you|could you|please|maybe|we should|我覺得|我想|幫我|可以|能不能|要不要|先幫|這次|等等|等一下|先這樣)/i.test(normalized)) {
    score -= 4;
  }
  if (/\b(?:today|tomorrow|this time|for now|right now|later)\b/i.test(lower)) {
    score -= 2;
  }
  if (/(?:今天|明天|這次|現在|之後再|晚點)/.test(normalized)) {
    score -= 2;
  }
  if ((normalized.match(/[,.，。；;]/g) || []).length >= 3) {
    score -= 2;
  }
  if (/\b(?:I|we|you)\b/.test(normalized) && !/(?:always|never|must|should|prefer|default)/i.test(normalized)) {
    score -= 1;
  }

  return score;
}

// ── brain_remember Routing ────────────────────────────────────────

export interface RouteResult {
  layer: BrainLayer;
  target: string;
  confidence: number; // 0.0-1.0, below 0.7 → candidates
}

/**
 * Route a directive to the appropriate .brain/ layer.
 * Returns confidence score. Below 0.7 → should go to candidates for user review.
 */
export function routeDirective(
  text: string,
  paths: BrainPaths,
  currentDomain?: string,
  currentProject?: string,
): RouteResult {
  const lower = text.toLowerCase();
  const strength = directiveStrength(text);

  if (strength <= 0) {
    return { layer: "identity", target: "identity", confidence: 0.35 };
  }

  // Project-specific: mentions a known project name → high confidence
  const projects = listProjects(paths);
  for (const proj of projects) {
    if (lower.includes(proj.toLowerCase())) {
      return { layer: "project", target: proj, confidence: strength >= 3 ? 0.95 : 0.65 };
    }
  }
  // Project-scoped work: positioning, progress, handoff, benchmark, release notes
  if (
    currentProject &&
    /(?:handoff|next step|next steps|decision|decided|status|current status|roadmap|milestone|release|launch|benchmark|judge|report|readme|messaging|positioning|product|repo|this project|this repo|session summary|summary|diff|compare|push|shipped|進度|現況|下一步|交接|決策|定位|產品|README|benchmark|judge|報告|這個 repo|這個專案|這輪|這次先)/i.test(text)
  ) {
    return { layer: "project", target: currentProject, confidence: strength >= 2 ? 0.86 : 0.72 };
  }
  // Progress keywords → medium-high (project detected from context, not explicit)
  if (/(?:做到|shipped|進行中|in progress|blocked|branch:|pr #|deploy)/i.test(text)) {
    const target = currentProject ?? projects[0] ?? "default";
    return { layer: "project", target, confidence: strength >= 3 ? (currentProject ? 0.85 : 0.72) : 0.58 };
  }

  // Goals: direction, vision → high confidence
  if (/(?:目標是|要成為|vision|goal|aspiration|整體方向|長期|long.?term)/i.test(text)) {
    return { layer: "goals", target: "goals", confidence: strength >= 3 ? 0.9 : 0.62 };
  }

  // Coding: build/review/test/ship rules that should travel across repos
  if (/(?:typescript|strict mode|esm|commonjs|vitest|jest|test|tests|commit|committing|code review|refactor|architecture|raw output|validation|llm output|workspace directories|generated files|ship code|branch|pr |pull request|coding|implementation|run tests|before committing|review workflow|workspace clean|codebase)/i.test(text)) {
    return { layer: "coding", target: "coding", confidence: strength >= 3 ? 0.88 : 0.64 };
  }

  // Domain-specific: work patterns → medium confidence
  if (/(?:開源|apache|license|github|npm|pre-ship|ship|deploy|review workflow)/i.test(text)) {
    return { layer: "domain", target: currentDomain ?? "work", confidence: strength >= 3 ? 0.8 : 0.6 };
  }

  // Strong identity signals → high confidence
  if (/(?:always|never|永遠|一律|不要|別再|用中文|communicate|use .+ for communication|溝通)/i.test(text)) {
    return { layer: "identity", target: "identity", confidence: strength >= 3 ? 0.85 : 0.62 };
  }

  // Default: identity, but low confidence (no strong signal matched)
  return { layer: "identity", target: "identity", confidence: strength >= 3 ? 0.72 : 0.5 };
}

/**
 * Write a directive to the appropriate .brain/ layer and refresh MEMORY.md.
 * Low confidence (< 0.7) → returns needsReview=true, caller should use candidates.
 */
export function brainRemember(
  projectRoot: string,
  text: string,
  options?: { domain?: string; project?: string; cwd?: string },
): { layer: BrainLayer; target: string; written: boolean; confidence: number; needsReview: boolean } {
  const paths = resolveBrainPaths(projectRoot);
  if (!existsSync(paths.root)) {
    initBrainDir(projectRoot);
  }

  // Filter noise before routing
  if (isNoise(text)) {
    return { layer: "identity", target: "identity", written: false, confidence: 0, needsReview: false };
  }

  const route = routeDirective(
    text,
    paths,
    options?.domain,
    options?.project,
  );

  // Low confidence → don't write directly, flag for candidates review
  if (route.confidence < 0.7) {
    return { ...route, written: false, needsReview: true };
  }

  let written = false;
  switch (route.layer) {
    case "identity":
      appendToIdentity(paths, text);
      written = true;
      break;
    case "goals":
      appendToGoals(paths, text);
      written = true;
      break;
    case "domain":
      appendToDomain(paths, route.target, text);
      written = true;
      break;
    case "coding":
      appendToCoding(paths, text);
      written = true;
      break;
    case "project": {
      const filePath = join(paths.projectsDir, `${route.target}.md`);
      const content = readBrainFile(filePath);
      if (content.includes(text.trim())) {
        written = false;
      } else if (content.length === 0) {
        atomicWrite(filePath, `# ${route.target}\ndomain: ${options?.domain ?? "work"}\n\n- ${text.trim()}\n`);
        written = true;
      } else {
        atomicWrite(filePath, content.trimEnd() + "\n- " + text.trim() + "\n");
        written = true;
      }
      break;
    }
  }

  if (written) {
    refreshMemoryMd(projectRoot, options?.cwd);
  }

  return { ...route, written, needsReview: false };
}

// ── Migration ─────────────────────────────────────────────────────

/**
 * Migrate from v0.8 memory/ + .squeeze/ to v2 .brain/ structure.
 * Reads existing directives from memory/*.md, classifies them,
 * and writes to the appropriate .brain/ layer.
 */
export function migrateToBrain(projectRoot: string): {
  migrated: number;
  identity: number;
  coding: number;
  domains: number;
  projects: number;
  goals: number;
} {
  const paths = initBrainDir(projectRoot);
  const stats = { migrated: 0, identity: 0, coding: 0, domains: 0, projects: 0, goals: 0 };

  // Read all existing directives from memory/ or MEMORY.md
  const memoryDir = join(projectRoot, "memory");
  const sources: string[] = [];

  if (existsSync(memoryDir)) {
    const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      sources.push(readFileSync(join(memoryDir, f), "utf8"));
    }
  } else {
    const flat = join(projectRoot, "MEMORY.md");
    if (existsSync(flat)) {
      sources.push(readFileSync(flat, "utf8"));
    }
  }

  // Extract directive lines with quality filtering
  const directives: string[] = [];
  for (const src of sources) {
    for (const line of src.split("\n")) {
      const m = line.match(/^-\s+(?:\[[^\]]*\]\s+)?(.+)/);
      if (m) {
        // Strip session tags like [claude consolidated], [claude 8db14531...]
        let clean = m[1].replace(/^\[[^\]]*\]\s*/, "").trim();
        if (clean.length === 0) continue;

        // Filter out noise (shared logic with brainRemember)
        if (isNoise(clean)) continue;

        directives.push(clean);
      }
    }
  }

  // Route each directive
  for (const d of directives) {
    const route = routeDirective(d, paths);
    switch (route.layer) {
      case "identity":
        appendToIdentity(paths, d);
        stats.identity++;
        break;
      case "goals":
        appendToGoals(paths, d);
        stats.goals++;
        break;
      case "domain":
        appendToDomain(paths, route.target, d);
        stats.domains++;
        break;
      case "coding":
        appendToCoding(paths, d);
        stats.coding++;
        break;
      case "project":
        const filePath = join(paths.projectsDir, `${route.target}.md`);
        const content = readBrainFile(filePath);
        if (!content.includes(d)) {
          if (content.length === 0) {
            writeFileSync(filePath, `# ${route.target}\ndomain: work\n\n- ${d}\n`, "utf8");
          } else {
            writeFileSync(filePath, content.trimEnd() + "\n- " + d + "\n", "utf8");
          }
        }
        stats.projects++;
        break;
    }
    stats.migrated++;
  }

  // Migrate legacy .squeeze/ → .brain/system/
  const oldSqueeze = join(projectRoot, ".squeeze");
  if (existsSync(oldSqueeze)) {
    const squeezeDest = paths.systemDir;
    // Copy files (not dirs like brain.pg which goes to episodes)
    for (const entry of readdirSync(oldSqueeze)) {
      const src = join(oldSqueeze, entry);
      const dest = join(squeezeDest, entry);
      if (entry === "brain.pg") {
        // Move PGLite DB to episodes/
        if (!existsSync(join(paths.episodesDir, "brain.pg"))) {
          try {
            cpSync(src, join(paths.episodesDir, "brain.pg"), { recursive: true });
          } catch {
            // Ignore errors on pg dir copy
          }
        }
      } else if (!existsSync(dest)) {
        try {
          cpSync(src, dest, { recursive: true });
        } catch {
          // Best effort copy
        }
      }
    }
  }

  // Delete old .squeeze/ after migration (data is now in .brain/system/)
  const oldSqueezePath = join(projectRoot, ".squeeze");
  if (existsSync(oldSqueezePath)) {
    try {
      const stat = lstatSync(oldSqueezePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const { rmSync } = require("node:fs");
        rmSync(oldSqueezePath, { recursive: true });
      }
    } catch {
      // best effort — if it fails, it's just a stale dir
    }
  }

  // Delete old memory/ after migration (data is now in .brain/)
  const oldMemoryDir = join(projectRoot, "memory");
  if (existsSync(oldMemoryDir)) {
    try {
      const { rmSync } = require("node:fs");
      rmSync(oldMemoryDir, { recursive: true });
    } catch {
      // best effort
    }
  }

  // Refresh MEMORY.md
  refreshMemoryMd(projectRoot);

  return stats;
}

// ── Audit ─────────────────────────────────────────────────────────

export interface BrainAudit {
  hasBrain: boolean;
  identityLines: number;
  codingLines: number;
  goalsLines: number;
  domainCount: number;
  domains: string[];
  projectCount: number;
  projects: string[];
  handoffCount: number;
  lastHandoffDate: string | null;
  memoryMdTokenEstimate: number;
}

export function auditBrain(projectRoot: string): BrainAudit {
  const paths = resolveBrainPaths(projectRoot);
  const hasBrain = existsSync(paths.root);

  if (!hasBrain) {
    return {
      hasBrain: false,
      identityLines: 0,
      codingLines: 0,
      goalsLines: 0,
      domainCount: 0,
      domains: [],
      projectCount: 0,
      projects: [],
      handoffCount: 0,
      lastHandoffDate: null,
      memoryMdTokenEstimate: 0,
    };
  }

  const identity = readBrainFile(paths.identity);
  const coding = readBrainFile(paths.coding);
  const goals = readBrainFile(paths.goals);
  const domains = listDomains(paths);
  const projects = listProjects(paths);

  // Count handoff entries across all projects
  let handoffCount = 0;
  let lastHandoffDate: string | null = null;
  for (const proj of projects) {
    const content = readProject(paths, proj);
    const matches = content.match(/^- \d{4}-\d{2}-\d{2}/gm);
    if (matches) {
      handoffCount += matches.length;
      for (const m of matches) {
        const date = m.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        if (date && (!lastHandoffDate || date > lastHandoffDate)) {
          lastHandoffDate = date;
        }
      }
    }
  }

  // Estimate MEMORY.md tokens (rough: ~4 chars per token)
  const memoryMd = resolveMemoryPath(projectRoot);
  const memoryContent = existsSync(memoryMd) ? readFileSync(memoryMd, "utf8") : "";
  const memoryMdTokenEstimate = Math.ceil(memoryContent.length / 4);

  return {
    hasBrain,
    identityLines: identity.split("\n").filter((l) => l.startsWith("- ")).length,
    codingLines: coding.split("\n").filter((l) => l.startsWith("- ")).length,
    goalsLines: goals.split("\n").filter((l) => l.startsWith("- ")).length,
    domainCount: domains.length,
    domains,
    projectCount: projects.length,
    projects,
    handoffCount,
    lastHandoffDate,
    memoryMdTokenEstimate,
  };
}

// ── Export / Import ───────────────────────────────────────────────

/**
 * Export .brain/ as a JSON bundle (excludes PGLite DB and audit trail).
 */
export function exportBrain(projectRoot: string): string {
  const paths = resolveBrainPaths(projectRoot);
  if (!existsSync(paths.root)) {
    throw new Error(".brain/ directory not found");
  }

  const bundle: Record<string, string> = {};
  bundle["scope.json"] = readBrainFile(paths.scope);
  bundle["identity.md"] = readBrainFile(paths.identity);
  bundle["coding.md"] = readBrainFile(paths.coding);
  bundle["goals.md"] = readBrainFile(paths.goals);

  for (const d of listDomains(paths)) {
    bundle[`domains/${d}.md`] = readDomain(paths, d);
  }
  for (const p of listProjects(paths)) {
    bundle[`projects/${p}.md`] = readProject(paths, p);
  }

  return JSON.stringify(bundle, null, 2);
}

/**
 * Import .brain/ from a JSON bundle.
 */
export function importBrain(projectRoot: string, bundleJson: string): number {
  const paths = initBrainDir(projectRoot);
  const bundle: Record<string, string> = JSON.parse(bundleJson);
  let count = 0;

  for (const [key, content] of Object.entries(bundle)) {
    const dest = join(paths.root, key);
    // Ensure parent dir exists
    const dir = join(dest, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, content, "utf8");
    count++;
  }

  const scope = loadScopeConfig(projectRoot);
  saveScopeConfig(projectRoot, scope);
  refreshMemoryMd(projectRoot);
  return count;
}

// ── Episodes (JSONL-based, no PGLite dependency for portability) ──

export interface Episode {
  id: string;
  what: string;
  detail?: string;
  decision?: string;
  outcome?: string;
  tags: string[];
  domain?: string;
  project?: string;
  episode_type: "lesson" | "decision" | "pattern" | "correction";
  frequency: number;
  date: string;
}

function episodesPath(paths: BrainPaths): string {
  return join(paths.systemDir, "episodes.jsonl");
}

export function loadEpisodes(paths: BrainPaths): Episode[] {
  const filePath = episodesPath(paths);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => {
    try { return JSON.parse(line); }
    catch { return null; }
  }).filter(Boolean) as Episode[];
}

export function saveEpisode(paths: BrainPaths, episode: Episode): void {
  const filePath = episodesPath(paths);
  appendFileSync(filePath, JSON.stringify(episode) + "\n", "utf8");
}

/**
 * Extract episodes from a handoff summary.
 * Looks for patterns like "learned that...", "decided to...", "found that...",
 * "discovered...", "key insight:", decision markers.
 */
export function extractEpisodesFromHandoff(
  summary: string,
  context: { domain?: string; project?: string },
): Omit<Episode, "id" | "frequency">[] {
  const episodes: Omit<Episode, "id" | "frequency">[] = [];
  const date = new Date().toISOString().slice(0, 10);

  // Pattern: learned/discovered/found that...
  const lessonPatterns = [
    /(?:learned|discovered|found|realized|noticed|觀察到|發現|學到|意識到)\s+(?:that\s+)?(.{10,})/gi,
    /(?:key insight|takeaway|教訓|重要發現)[:\s]+(.{10,})/gi,
  ];

  for (const pattern of lessonPatterns) {
    for (const match of summary.matchAll(pattern)) {
      episodes.push({
        what: match[1].trim().slice(0, 200),
        episode_type: "lesson",
        tags: extractTags(match[1]),
        domain: context.domain,
        project: context.project,
        date,
      });
    }
  }

  // Pattern: decided to... / decision:
  const decisionPatterns = [
    /(?:decided|chose|confirmed|確定|決定|選擇)\s+(?:to\s+)?(.{10,})/gi,
    /(?:decision)[:\s]+(.{10,})/gi,
  ];

  for (const pattern of decisionPatterns) {
    for (const match of summary.matchAll(pattern)) {
      episodes.push({
        what: match[1].trim().slice(0, 200),
        episode_type: "decision",
        tags: extractTags(match[1]),
        domain: context.domain,
        project: context.project,
        date,
      });
    }
  }

  return episodes;
}

export function extractTags(text: string): string[] {
  const tags: string[] = [];
  // Extract technical terms (camelCase, kebab-case, common tech words)
  const techWords = text.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g); // camelCase
  if (techWords) tags.push(...techWords.map((w) => w.toLowerCase()));
  const kebab = text.match(/\b[a-z]+-[a-z]+(?:-[a-z]+)*\b/g);
  if (kebab) tags.push(...kebab);
  return [...new Set(tags)].slice(0, 5);
}

/**
 * Search episodes by keyword query.
 */
export function searchEpisodes(paths: BrainPaths, query: string): Episode[] {
  const episodes = loadEpisodes(paths);
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter((t) => t.length > 1);

  return episodes
    .map((ep) => {
      const text = `${ep.what} ${ep.detail ?? ""} ${ep.decision ?? ""} ${ep.outcome ?? ""} ${ep.tags.join(" ")}`.toLowerCase();
      const score = queryTokens.filter((t) => text.includes(t)).length / queryTokens.length;
      return { ep, score };
    })
    .filter(({ score }) => score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ ep }) => ep);
}

/**
 * Increment frequency for episodes matching a pattern.
 * Returns episodes that hit the skill promotion threshold (≥3).
 */
export function trackEpisodeFrequency(
  paths: BrainPaths,
  what: string,
): { promoted: Episode[]; matched: boolean } {
  const episodes = loadEpisodes(paths);
  const whatLower = what.toLowerCase();
  const promoted: Episode[] = [];
  let matched = false;

  // Find similar episodes (>60% token overlap)
  const whatTokens = new Set(whatLower.split(/\s+/).filter((t) => t.length > 2));

  for (const ep of episodes) {
    const epTokens = new Set(ep.what.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
    const overlap = [...whatTokens].filter((t) => epTokens.has(t)).length;
    const similarity = overlap / Math.max(whatTokens.size, epTokens.size);

    if (similarity > 0.6) {
      matched = true;
      ep.frequency = (ep.frequency || 1) + 1;
      if (ep.frequency >= 3) {
        promoted.push(ep);
      }
    }
  }

  if (matched) {
    // Rewrite the file with updated frequencies
    const filePath = episodesPath(paths);
    writeFileSync(filePath, episodes.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  return { promoted, matched };
}

/**
 * Get high-importance episodes for surfacing in MEMORY.md.
 * Returns episodes with frequency ≥ 2 (recurring patterns worth remembering).
 */
export function getHighImportanceEpisodes(paths: BrainPaths, limit = 3): Episode[] {
  const episodes = loadEpisodes(paths);
  return episodes
    .filter((ep) => ep.frequency >= 2)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit);
}

// ── Skill Promotion (Hermes-inspired) ─────────────────────────────

export interface Skill {
  id: string;
  title: string;
  trigger: string;        // when to use this skill
  procedure: string[];    // step-by-step
  pitfalls: string[];     // known failure modes
  verification: string[]; // how to confirm it worked
  source_episodes: string[]; // episode IDs that led to this skill
  created_at: string;
  promoted_at_frequency: number; // frequency when promoted
}

function skillsDir(paths: BrainPaths): string {
  return join(paths.root, "skills");
}

export function listSkills(paths: BrainPaths): Skill[] {
  const dir = skillsDir(paths);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const content = readFileSync(join(dir, f), "utf8");
      try {
        const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
        if (!frontmatter) return null;
        return JSON.parse(frontmatter[1]) as Skill;
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Skill[];
}

/**
 * Generate a SKILL.md from an episode that hit promotion threshold.
 * Format follows Hermes Agent convention: YAML frontmatter + sections.
 */
export function generateSkillFromEpisode(
  paths: BrainPaths,
  episode: Episode,
): string {
  const dir = skillsDir(paths);
  mkdirSync(dir, { recursive: true });

  const slug = episode.what
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");

  const skill: Skill = {
    id: `skill_${Date.now().toString(36)}`,
    title: episode.what.slice(0, 100),
    trigger: episode.what,
    procedure: [
      episode.decision ?? episode.what,
      ...(episode.outcome ? [`Expected outcome: ${episode.outcome}`] : []),
    ],
    pitfalls: [`Without this: ${episode.what}`],
    verification: ["Confirm the procedure was followed before proceeding"],
    source_episodes: [episode.id],
    created_at: new Date().toISOString(),
    promoted_at_frequency: episode.frequency,
  };

  const content = `---
${JSON.stringify(skill, null, 2)}
---

# ${skill.title}

## When to Use
${skill.trigger}

## Procedure
${skill.procedure.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Pitfalls
${skill.pitfalls.map((p) => `- ${p}`).join("\n")}

## Verification
${skill.verification.map((v) => `- ${v}`).join("\n")}

---
*Auto-generated by oh-my-brain from episode ${episode.id} (appeared ${episode.frequency}x)*
`;

  const filePath = join(dir, `${slug}.md`);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Track correction frequency for skill promotion.
 *
 * oh-my-brain's correction-to-skill model:
 *   1x correction → save as episode, think about the essence
 *   2x correction → immediately promote to skill (agent was corrected twice = clear pattern)
 *   3x+ any episode → also promote (repeated pattern from any source)
 *
 * This is more aggressive than Hermes (which waits for 5+ tool calls).
 * Rationale: if a user corrects you, they shouldn't have to correct you again.
 */
export function trackAndPromote(
  paths: BrainPaths,
  what: string,
  episodeType: "lesson" | "decision" | "pattern" | "correction",
): { episode: Episode; promoted: boolean; skillPath?: string } {
  const episodes = loadEpisodes(paths);
  const whatLower = what.toLowerCase();
  const whatTokens = new Set(whatLower.split(/\s+/).filter((t) => t.length > 2));

  // Find similar existing episode
  let match: Episode | null = null;
  for (const ep of episodes) {
    const epTokens = new Set(ep.what.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
    const overlap = [...whatTokens].filter((t) => epTokens.has(t)).length;
    const similarity = overlap / Math.max(whatTokens.size, epTokens.size);
    if (similarity > 0.6) {
      match = ep;
      break;
    }
  }

  if (match) {
    // Existing similar episode — increment frequency
    match.frequency = (match.frequency || 1) + 1;
    if (episodeType === "correction") {
      match.episode_type = "correction";
    }
    // Rewrite episodes file
    const filePath = episodesPath(paths);
    writeFileSync(filePath, episodes.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    // Promotion check:
    // - correction + frequency >= 2 → immediate skill
    // - any type + frequency >= 3 → skill
    const threshold = episodeType === "correction" ? 2 : 3;
    if (match.frequency >= threshold) {
      const skillPath = generateSkillFromEpisode(paths, match);
      return { episode: match, promoted: true, skillPath };
    }
    return { episode: match, promoted: false };
  }

  // New episode
  const episode: Episode = {
    id: `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    what,
    episode_type: episodeType,
    tags: extractTags(what),
    frequency: 1,
    date: new Date().toISOString().slice(0, 10),
  };
  saveEpisode(paths, episode);

  // First correction → save but don't promote yet
  // (agent should "think about the essence" — the episode is saved for context)
  return { episode, promoted: false };
}

// ── Brain Cleanup ─────────────────────────────────────────────────

export interface CleanupResult {
  staleEpisodes: number;
  handoffsTrimmed: number;
  totalEpisodesBefore: number;
  totalEpisodesAfter: number;
}

/**
 * Clean up .brain/:
 * - Remove episodes older than 90 days with frequency = 1 (never reinforced)
 * - Trim handoff logs to 10 entries per project
 * - Refresh MEMORY.md
 */
export function cleanupBrain(projectRoot: string, maxAgeDays = 90): CleanupResult {
  const paths = resolveBrainPaths(projectRoot);
  if (!existsSync(paths.root)) {
    return { staleEpisodes: 0, handoffsTrimmed: 0, totalEpisodesBefore: 0, totalEpisodesAfter: 0 };
  }

  // Clean stale episodes (old + never reinforced)
  const episodes = loadEpisodes(paths);
  const totalBefore = episodes.length;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - maxAgeDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const kept = episodes.filter((ep) => {
    if (ep.frequency >= 2) return true; // reinforced, keep
    if (ep.date >= cutoffStr) return true; // recent, keep
    return false; // stale, remove
  });

  const staleCount = totalBefore - kept.length;
  if (staleCount > 0) {
    const filePath = episodesPath(paths);
    writeFileSync(filePath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  }

  // Handoff logs are already trimmed to 10 in appendHandoff()
  // But do a pass to ensure consistency
  let handoffsTrimmed = 0;
  for (const proj of listProjects(paths)) {
    const filePath = join(paths.projectsDir, `${proj}.md`);
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    let inHandoff = false;
    let count = 0; // reset per project
    let trimmedThisProject = 0;
    const filtered: string[] = [];
    for (const line of lines) {
      if (line.startsWith("## Handoff Log")) {
        inHandoff = true;
        filtered.push(line);
        continue;
      }
      if (inHandoff && line.startsWith("## ")) inHandoff = false;
      if (inHandoff && line.startsWith("- ")) {
        count++;
        if (count > 10) { trimmedThisProject++; continue; }
      }
      filtered.push(line);
    }
    if (trimmedThisProject > 0) {
      writeFileSync(filePath, filtered.join("\n"), "utf8");
      handoffsTrimmed += trimmedThisProject;
    }
  }

  refreshMemoryMd(projectRoot);

  return {
    staleEpisodes: staleCount,
    handoffsTrimmed,
    totalEpisodesBefore: totalBefore,
    totalEpisodesAfter: kept.length,
  };
}

// (appendFileSync imported from node:fs at top of file)
