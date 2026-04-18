/**
 * Domain router: builds keyword profiles from domain files and routes
 * directives to the best-matching domain via keyword scoring.
 *
 * Also handles auto-migration from a flat MEMORY.md to per-domain files
 * by clustering directives via keyword co-occurrence (no hardcoded taxonomy).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KeywordProfile {
  domain: string;
  keywords: Set<string>;
}

export interface DomainScore {
  domain: string;
  score: number;
}

export interface SessionDomainScore {
  domain: string;
  score: number;
  include: boolean;
  reason: "above_threshold" | "below_threshold" | "small_file" | "fallback";
}

export interface AutoCreateResult {
  created: string[];
  skipped: boolean;
}

// ── Stop words ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Common English function words
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "up", "about", "into", "through", "during",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "may", "might",
  "shall", "can", "need", "dare", "ought", "used", "it", "its", "this",
  "that", "these", "those", "i", "me", "my", "we", "our", "you", "your",
  "he", "she", "they", "them", "his", "her", "their", "what", "which",
  "who", "whom", "when", "where", "why", "how", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "no", "not",
  "only", "same", "so", "than", "too", "very", "just", "also", "if",
  "as", "then", "there", "here", "out", "over", "under", "after", "before",
  // Domain-specific stop words
  "use", "always", "never",
]);

// ── Stemmer ───────────────────────────────────────────────────────────────────

/**
 * Simple English stemmer: strips common suffixes.
 * Designed to be fast and deterministic, not linguistically perfect.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;

  // Order matters: longest suffix first to avoid over-stripping
  if (word.endsWith("tion") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ment") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ness") && word.length > 6) return word.slice(0, -4);
  if (word.endsWith("ing") && word.length > 5) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("er") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ly") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("ies") && word.length > 5) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 4) return word.slice(0, -2);
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);

  return word;
}

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Tokenize text: lowercase, split on non-alphanumeric, filter stops, keep words > 1 char.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ── Keyword profile builder ───────────────────────────────────────────────────

/**
 * Build a keyword profile for a domain.
 * Includes both raw tokens and their stemmed forms.
 */
export function buildKeywordProfile(domainName: string, directiveBodies: string[]): KeywordProfile {
  const keywords = new Set<string>();

  function addTokens(text: string): void {
    const tokens = tokenize(text);
    for (const token of tokens) {
      keywords.add(token);
      const stemmed = stem(token);
      if (stemmed !== token) keywords.add(stemmed);
    }
  }

  // Add tokens from domain filename (treat hyphens/underscores as word separators)
  const normalizedName = domainName.replace(/[-_]/g, " ");
  addTokens(normalizedName);

  // Add tokens from directive bodies
  for (const body of directiveBodies) {
    addTokens(body);
  }

  return { domain: domainName, keywords };
}

// ── Domain scoring ────────────────────────────────────────────────────────────

/**
 * Score text against all domain profiles.
 * Score = matching keywords / total unique tokens in text.
 * Returns all domains sorted by score descending.
 */
export function scoreDomains(text: string, profiles: KeywordProfile[]): DomainScore[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return profiles.map((p) => ({ domain: p.domain, score: 0 }));
  }

  // Include stemmed forms of text tokens for matching
  const textKeywords = new Set<string>();
  for (const token of tokens) {
    textKeywords.add(token);
    textKeywords.add(stem(token));
  }

  const totalUnique = textKeywords.size;

  const scores: DomainScore[] = profiles.map((profile) => {
    let matches = 0;
    for (const kw of textKeywords) {
      if (profile.keywords.has(kw)) matches++;
    }
    return { domain: profile.domain, score: matches / totalUnique };
  });

  scores.sort((a, b) => b.score - a.score);
  return scores;
}

// ── Domain router ─────────────────────────────────────────────────────────────

/**
 * Route text to the best matching domain.
 * Tie-breaking (top two within 10% of each other):
 *   1. Fewer directives wins
 *   2. Alphabetical wins
 * Returns null when no domain scores above zero.
 */
export function routeToDomain(
  text: string,
  profiles: KeywordProfile[],
  directiveCounts?: Map<string, number>,
): string | null {
  const scores = scoreDomains(text, profiles);
  if (scores.length === 0 || scores[0].score === 0) return null;

  const top = scores[0];

  // Check if second-place is within 10% of top score
  if (scores.length >= 2 && scores[1].score > 0) {
    const second = scores[1];
    const threshold = top.score * 0.10;
    if (top.score - second.score <= threshold) {
      // Tie-break: fewer directives wins
      if (directiveCounts) {
        const topCount = directiveCounts.get(top.domain) ?? 0;
        const secondCount = directiveCounts.get(second.domain) ?? 0;
        if (secondCount < topCount) return second.domain;
        if (topCount < secondCount) return top.domain;
      }
      // Tie-break: alphabetical
      return [top.domain, second.domain].sort()[0];
    }
  }

  return top.domain;
}

// ── Session-level injection scoring ──────────────────────────────────────────

const INJECTION_THRESHOLD = 0.3;
const SMALL_FILE_TOKEN_CAP = 500;

/**
 * Score domains for session-level injection.
 * Determines which domains to include in context based on recent messages.
 */
export function scoreDomainsForSession(
  recentMessages: string[],
  profiles: KeywordProfile[],
  domainTokens?: Map<string, number>
): SessionDomainScore[] {
  const combined = recentMessages.join(" ");
  const rawScores = scoreDomains(combined, profiles);
  const maxScore = rawScores.length > 0 ? Math.max(...rawScores.map((s) => s.score), 0.001) : 1;
  const normalized = rawScores.map((s) => ({
    domain: s.domain,
    score: s.score / maxScore,
  }));

  const anyAboveThreshold = normalized.some((s) => s.score >= INJECTION_THRESHOLD);

  return normalized.map((s) => {
    const tokens = domainTokens?.get(s.domain) ?? Infinity;
    const isSmall = tokens <= SMALL_FILE_TOKEN_CAP;

    if (s.score >= INJECTION_THRESHOLD) {
      return { ...s, include: true, reason: "above_threshold" as const };
    }
    if (isSmall) {
      return { ...s, include: true, reason: "small_file" as const };
    }
    if (!anyAboveThreshold) {
      return { ...s, include: true, reason: "fallback" as const };
    }
    return { ...s, include: false, reason: "below_threshold" as const };
  });
}

// ── Domain file loaders ───────────────────────────────────────────────────

/**
 * Load keyword profiles for all domain files in memory/.
 */
export function loadDomainProfiles(projectRoot: string): KeywordProfile[] {
  const memoryDir = join(projectRoot, "memory");
  if (!existsSync(memoryDir)) return [];
  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md")).sort();
  return files.map((f) => {
    const domain = basename(f, ".md");
    const content = readFileSync(join(memoryDir, f), "utf8");
    const bodies: string[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(/^-\s+(?:\[[^\]]*\]\s+)?(.+)$/);
      if (match) bodies.push(match[1].trim());
    }
    return buildKeywordProfile(domain, bodies);
  });
}

/**
 * Count directives per domain file for tie-breaking.
 */
export function countDirectivesPerDomain(projectRoot: string): Map<string, number> {
  const memoryDir = join(projectRoot, "memory");
  if (!existsSync(memoryDir)) return new Map();
  const counts = new Map<string, number>();
  const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const domain = basename(f, ".md");
    const content = readFileSync(join(memoryDir, f), "utf8");
    const bullets = content.split("\n").filter((l) => /^-\s+/.test(l));
    counts.set(domain, bullets.length);
  }
  return counts;
}

// ── Auto-create domains ───────────────────────────────────────────────────────

/**
 * Cluster directives by keyword co-occurrence.
 * Derives domain names from content — no hardcoded taxonomy.
 *
 * Algorithm:
 * 1. Tokenize each directive, collect all tokens
 * 2. Find the most frequent token across unassigned directives as the anchor
 * 3. Group directives that share that anchor into one cluster
 * 4. Repeat for remaining directives until all are assigned
 * 5. Single-directive clusters (singletons) are merged into "general"
 * 6. Domain name = anchor keyword of the cluster
 */
function clusterDirectivesByCooccurrence(directives: string[]): Map<string, string[]> {
  if (directives.length === 0) return new Map();

  // Tokenize all directives
  const tokenSets: string[][] = directives.map(tokenize);

  // Track which directives are still unassigned
  const unassigned = new Set(directives.map((_, i) => i));
  const clusters: Array<{ indices: number[]; label: string }> = [];

  while (unassigned.size > 0) {
    // Count token frequency across unassigned directives
    const freq = new Map<string, number>();
    for (const i of unassigned) {
      for (const token of tokenSets[i]) {
        freq.set(token, (freq.get(token) ?? 0) + 1);
      }
    }

    // Find the most frequent token (anchor)
    let anchor = "";
    let maxFreq = 0;
    for (const [token, count] of freq) {
      if (count > maxFreq) {
        maxFreq = count;
        anchor = token;
      }
    }

    // Collect directives that contain the anchor token
    const group: number[] = [];
    for (const i of unassigned) {
      if (anchor === "" || tokenSets[i].includes(anchor)) {
        group.push(i);
        unassigned.delete(i);
      }
    }

    if (group.length === 0) break;

    const label = anchor !== "" ? anchor : "general";
    clusters.push({ indices: group, label });
  }

  // Merge singleton clusters into "general"
  const result = new Map<string, string[]>();
  const generalDirectives: string[] = [];

  for (const cluster of clusters) {
    if (cluster.indices.length === 1) {
      generalDirectives.push(directives[cluster.indices[0]]);
    } else {
      const domain = cluster.label;
      const existing = result.get(domain) ?? [];
      for (const i of cluster.indices) {
        existing.push(directives[i]);
      }
      result.set(domain, existing);
    }
  }

  if (generalDirectives.length > 0) {
    const existingGeneral = result.get("general") ?? [];
    result.set("general", [...existingGeneral, ...generalDirectives]);
  }

  return result;
}

/**
 * Auto-migrate a flat MEMORY.md to per-domain memory/ files.
 *
 * - If memory/ already has .md files: return { created: [], skipped: true }
 * - Parse MEMORY.md bullet lines `- [tag] body text`
 * - Cluster by keyword co-occurrence → derive domain names from content
 * - Write clustered directives to memory/<domain>.md
 * - If no directives found: create memory/general.md
 */
export function autoCreateDomains(projectRoot: string): AutoCreateResult {
  const memoryDir = join(projectRoot, "memory");

  // If memory/ already exists with .md files, skip
  if (existsSync(memoryDir)) {
    const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    if (files.length > 0) {
      return { created: [], skipped: true };
    }
  }

  // Parse MEMORY.md bullet lines
  const memoryPath = join(projectRoot, "MEMORY.md");
  const directives: string[] = [];

  if (existsSync(memoryPath)) {
    const content = readFileSync(memoryPath, "utf8");
    for (const line of content.split("\n")) {
      // Match `- [tag] body text` format
      const match = line.match(/^-\s+\[[^\]]+\]\s+(.+)$/);
      if (match) {
        directives.push(match[1].trim());
      }
    }
  }

  // Ensure memory/ directory exists
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // No directives: create general.md
  if (directives.length === 0) {
    writeFileSync(join(memoryDir, "general.md"), "## general\n");
    return { created: ["general"], skipped: false };
  }

  // Cluster directives by keyword co-occurrence
  const clusters = clusterDirectivesByCooccurrence(directives);

  // Edge case: clustering produced nothing
  if (clusters.size === 0) {
    const lines = directives.map((d) => `- ${d}`).join("\n");
    writeFileSync(join(memoryDir, "general.md"), `## general\n\n${lines}\n`);
    return { created: ["general"], skipped: false };
  }

  const created: string[] = [];
  for (const [domain, domainDirectives] of clusters) {
    const lines = domainDirectives.map((d) => `- ${d}`).join("\n");
    writeFileSync(join(memoryDir, `${domain}.md`), `## ${domain}\n\n${lines}\n`);
    created.push(domain);
  }

  return { created, skipped: false };
}
