import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  initBrainDir,
  hasBrainDir,
  resolveBrainPaths,
  appendToIdentity,
  appendToGoals,
  appendToCoding,
  appendToDomain,
  writeProject,
  appendHandoff,
  brainRemember,
  assembleBrainToMemory,
  refreshMemoryMd,
  migrateToBrain,
  auditBrain,
  routeDirective,
  detectDomain,
  detectProject,
  parseProjectInfo,
  exportBrain,
  importBrain,
  listDomains,
  listProjects,
  isNoise,
  loadScopeConfig,
  saveScopeConfig,
} from "../cli/brain-store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "brain-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("initBrainDir", () => {
  it("creates the full directory structure", () => {
    const paths = initBrainDir(tmpDir);
    expect(existsSync(paths.root)).toBe(true);
    expect(existsSync(paths.domainsDir)).toBe(true);
    expect(existsSync(paths.projectsDir)).toBe(true);
    expect(existsSync(paths.episodesDir)).toBe(true);
    expect(existsSync(paths.squeezeDir)).toBe(true);
    expect(existsSync(paths.identity)).toBe(true);
    expect(existsSync(paths.goals)).toBe(true);
  });

  it("is idempotent", () => {
    initBrainDir(tmpDir);
    initBrainDir(tmpDir); // no error
    expect(hasBrainDir(tmpDir)).toBe(true);
  });

  it("creates default scope.json", () => {
    initBrainDir(tmpDir);
    const scope = loadScopeConfig(tmpDir);
    expect(scope.kind).toBe("project");
    expect(scope.localFirst).toBe(true);
    expect(scope.overlayGlobalPreferences).toBe(false);
    expect(scope.projectRoot).toBe(tmpDir);
  });

  it("recreates scope.json if missing", () => {
    const paths = initBrainDir(tmpDir);
    rmSync(paths.scope, { force: true });
    const scope = loadScopeConfig(tmpDir);
    expect(scope.projectRoot).toBe(tmpDir);
    expect(existsSync(paths.scope)).toBe(true);
  });
});

describe("hasBrainDir", () => {
  it("returns false when .brain/ does not exist", () => {
    expect(hasBrainDir(tmpDir)).toBe(false);
  });

  it("returns true when .brain/ exists", () => {
    initBrainDir(tmpDir);
    expect(hasBrainDir(tmpDir)).toBe(true);
  });
});

describe("Identity", () => {
  it("appends to identity.md", () => {
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "use Chinese for communication");
    const content = readFileSync(paths.identity, "utf8");
    expect(content).toContain("- use Chinese for communication");
  });

  it("deduplicates", () => {
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "use Chinese");
    appendToIdentity(paths, "use Chinese");
    const content = readFileSync(paths.identity, "utf8");
    const count = (content.match(/use Chinese/g) || []).length;
    expect(count).toBe(1);
  });
});

describe("Goals", () => {
  it("appends to goals.md", () => {
    const paths = initBrainDir(tmpDir);
    appendToGoals(paths, "oh-my-brain: become the standard for AI memory");
    const content = readFileSync(paths.goals, "utf8");
    expect(content).toContain("oh-my-brain: become the standard");
  });
});

describe("Coding", () => {
  it("appends to coding.md", () => {
    const paths = initBrainDir(tmpDir);
    appendToCoding(paths, "always run tests before committing");
    const content = readFileSync(paths.coding, "utf8");
    expect(content).toContain("always run tests before committing");
  });
});

describe("Domains", () => {
  it("creates domain file on first write", () => {
    const paths = initBrainDir(tmpDir);
    appendToDomain(paths, "work", "pre-ship: internal audit then CEO review");
    const content = readFileSync(join(paths.domainsDir, "work.md"), "utf8");
    expect(content).toContain("# work");
    expect(content).toContain("pre-ship");
  });

  it("lists domains", () => {
    const paths = initBrainDir(tmpDir);
    appendToDomain(paths, "work", "rule 1");
    appendToDomain(paths, "investing", "rule 2");
    expect(listDomains(paths).sort()).toEqual(["investing", "work"]);
  });
});

describe("Projects", () => {
  it("creates and parses project file", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "oh-my-brain", `# oh-my-brain
domain: work

## 現況
v0.9.0 in development.

## 進行中
- memory architecture v2
- benchmark refactor

## Handoff Log
- 2026-04-18 PM: discussed v2 architecture
`);
    const info = parseProjectInfo(paths, "oh-my-brain");
    expect(info).not.toBeNull();
    expect(info!.domain).toBe("work");
    expect(info!.status).toBe("v0.9.0 in development.");
    expect(info!.inProgress).toHaveLength(2);
    expect(info!.lastHandoff).toContain("discussed v2");
  });

  it("lists projects", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "proj-a", "# A");
    writeProject(paths, "proj-b", "# B");
    expect(listProjects(paths).sort()).toEqual(["proj-a", "proj-b"]);
  });
});

describe("Handoff Log", () => {
  it("appends handoff entry", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "test-proj", "# test-proj\ndomain: work\n\n## Handoff Log\n");
    appendHandoff(paths, "test-proj", {
      date: "2026-04-18",
      time: "PM",
      summary: "implemented .brain/ architecture",
    });
    const content = readFileSync(join(paths.projectsDir, "test-proj.md"), "utf8");
    expect(content).toContain("2026-04-18 PM: implemented .brain/ architecture");
  });

  it("creates handoff section if missing", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "test-proj", "# test-proj\ndomain: work\n");
    appendHandoff(paths, "test-proj", {
      date: "2026-04-18",
      summary: "first handoff",
    });
    const content = readFileSync(join(paths.projectsDir, "test-proj.md"), "utf8");
    expect(content).toContain("## Handoff Log");
    expect(content).toContain("2026-04-18: first handoff");
  });
});

describe("routeDirective", () => {
  it("routes project-specific text to project", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "oh-my-brain", "# oh-my-brain\ndomain: work\n");
    const result = routeDirective("oh-my-brain benchmark should checkpoint", paths);
    expect(result.layer).toBe("project");
    expect(result.target).toBe("oh-my-brain");
  });

  it("routes goals to goals", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("目標是成為 AI agent 記憶的標準", paths);
    expect(result.layer).toBe("goals");
  });

  it("routes stable preferences to identity", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("use Chinese for communication", paths);
    expect(result.layer).toBe("identity");
  });

  it("routes work-specific to domain", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("開源 projects use Apache-2.0 license", paths);
    expect(result.layer).toBe("domain");
  });

  it("routes coding rules to coding", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("always run tests before committing", paths);
    expect(result.layer).toBe("coding");
  });

  it("routes project positioning and benchmark notes to project when a project is active", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective(
      "README positioning and benchmark wording should stay conservative",
      paths,
      "work",
      "oh-my-brain",
    );
    expect(result.layer).toBe("project");
    expect(result.target).toBe("oh-my-brain");
  });
});

describe("brainRemember", () => {
  it("writes to correct layer and refreshes MEMORY.md", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(tmpDir, "use Chinese for communication");
    expect(result.layer).toBe("identity");
    expect(result.written).toBe(true);

    // MEMORY.md should exist and contain the directive
    const memoryMd = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(memoryMd).toContain("use Chinese for communication");
  });

  it("writes coding rules to coding.md", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(tmpDir, "always run tests before committing");
    expect(result.layer).toBe("coding");
    expect(result.written).toBe(true);

    const coding = readFileSync(join(tmpDir, ".brain", "coding.md"), "utf8");
    expect(coding).toContain("always run tests before committing");
  });

  it("writes project-scoped README and benchmark notes into the active project", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(
      tmpDir,
      "README positioning and benchmark wording should stay conservative",
      {
        project: "oh-my-brain",
        cwd: join(tmpDir, "oh-my-brain"),
      },
    );
    expect(result.layer).toBe("project");
    expect(result.written).toBe(true);

    const projectFile = readFileSync(join(tmpDir, ".brain", "projects", "oh-my-brain.md"), "utf8");
    expect(projectFile).toContain("README positioning and benchmark wording should stay conservative");
  });
});

describe("assembleBrainToMemory", () => {
  it("produces stable + dynamic sections", () => {
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "communicate in Chinese");
    appendToCoding(paths, "run tests before committing");
    appendToGoals(paths, "build the best AI memory");
    appendToDomain(paths, "work", "ship fast, ship quality");
    writeProject(paths, "my-project", "# my-project\ndomain: work\n\n## 現況\nv1.0\n");

    const output = assembleBrainToMemory(tmpDir);
    expect(output).toContain("auto-assembled by oh-my-brain");
    expect(output).toContain("communicate in Chinese");
    expect(output).toContain("run tests before committing");
    expect(output).toContain("build the best AI memory");
    // Stable section comes before dynamic
    const identityIdx = output.indexOf("communicate in Chinese");
    const stableMarker = output.indexOf("Stable");
    expect(stableMarker).toBeLessThan(identityIdx);
  });

  it("returns empty string when no .brain/", () => {
    const output = assembleBrainToMemory(tmpDir);
    expect(output).toBe("");
  });

  it("includes scope rule in MEMORY projection", () => {
    initBrainDir(tmpDir);
    const output = assembleBrainToMemory(tmpDir);
    expect(output).toContain("Scope: project-local brain first; overlay global user preferences only when enabled.");
  });

  it("overlays global identity when scope enables it", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "brain-global-"));
    try {
      const globalPaths = initBrainDir(globalDir);
      appendToIdentity(globalPaths, "communicate in Chinese");

      const localPaths = initBrainDir(tmpDir);
      appendToIdentity(localPaths, "use TypeScript strict mode");
      saveScopeConfig(tmpDir, {
        kind: "project",
        projectRoot: tmpDir,
        localFirst: true,
        overlayGlobalPreferences: true,
        globalBrainRoot: globalDir,
      });

      const output = assembleBrainToMemory(tmpDir);
      expect(output).toContain("## Global Preferences (overlay)");
      expect(output).toContain("communicate in Chinese");
      expect(output).toContain("use TypeScript strict mode");
    } finally {
      rmSync(globalDir, { recursive: true, force: true });
    }
  });
});

describe("refreshMemoryMd", () => {
  it("writes MEMORY.md from .brain/ contents", () => {
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "rule 1");
    refreshMemoryMd(tmpDir);
    const content = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(content).toContain("rule 1");
  });
});

describe("detectDomain", () => {
  it("detects domain from project in cwd", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "oh-my-brain", "# oh-my-brain\ndomain: work\n");
    const domain = detectDomain(paths, "/Users/test/oh-my-brain");
    expect(domain).toBe("work");
  });

  it("falls back to general", () => {
    const paths = initBrainDir(tmpDir);
    const domain = detectDomain(paths, "/some/random/path");
    expect(domain).toBe("general");
  });
});

describe("detectProject", () => {
  it("detects project from cwd", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "oh-my-brain", "# oh-my-brain\n");
    const proj = detectProject(paths, "/Users/test/oh-my-brain/src");
    expect(proj).toBe("oh-my-brain");
  });

  it("falls back to repo root name before a project file exists", () => {
    const paths = initBrainDir(tmpDir);
    const proj = detectProject(paths, tmpDir);
    expect(proj).toBe(tmpDir.split("/").at(-1));
  });
});

describe("migrateToBrain", () => {
  it("migrates memory/general.md to .brain/", () => {
    // Set up v0.8 structure
    mkdirSync(join(tmpDir, "memory"), { recursive: true });
    writeFileSync(
      join(tmpDir, "memory", "general.md"),
      `## oh-my-brain directives (2026-04-17) [source:claude session:consolidated]

- [claude consolidated] communicate in Chinese, especially for reviews
- [claude consolidated] separate LLM generation from validation
- [claude consolidated] open-source default: Apache-2.0 + CLA
`,
      "utf8",
    );

    const stats = migrateToBrain(tmpDir);
    expect(stats.migrated).toBe(3);
    expect(hasBrainDir(tmpDir)).toBe(true);

    // Check identity got the stable preferences
    const paths = resolveBrainPaths(tmpDir);
    const identity = readFileSync(paths.identity, "utf8");
    expect(identity).toContain("communicate in Chinese");
    const coding = readFileSync(paths.coding, "utf8");
    expect(coding).toContain("separate LLM generation from validation");

    // Check MEMORY.md was refreshed
    const memoryMd = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(memoryMd).toContain("auto-assembled by oh-my-brain");
  });

  it("strips session tags during migration", () => {
    mkdirSync(join(tmpDir, "memory"), { recursive: true });
    writeFileSync(
      join(tmpDir, "memory", "general.md"),
      "- [claude 8db14531-79f0-45ed-8f7a-7971f97c8198] some directive\n",
      "utf8",
    );

    migrateToBrain(tmpDir);
    const paths = resolveBrainPaths(tmpDir);
    const identity = readFileSync(paths.identity, "utf8");
    // Should not contain the session tag
    expect(identity).not.toContain("8db14531");
    expect(identity).toContain("some directive");
  });

  it("migrates coding rules into coding.md", () => {
    mkdirSync(join(tmpDir, "memory"), { recursive: true });
    writeFileSync(
      join(tmpDir, "memory", "general.md"),
      "- [claude consolidated] always run tests before committing\n",
      "utf8",
    );

    const stats = migrateToBrain(tmpDir);
    expect(stats.coding).toBe(1);

    const paths = resolveBrainPaths(tmpDir);
    const coding = readFileSync(paths.coding, "utf8");
    expect(coding).toContain("always run tests before committing");
  });
});

describe("auditBrain", () => {
  it("reports brain health", () => {
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "rule 1");
    appendToIdentity(paths, "rule 2");
    appendToCoding(paths, "coding rule");
    appendToGoals(paths, "goal 1");
    appendToDomain(paths, "work", "work rule");
    writeProject(paths, "proj", "# proj\n\n## Handoff Log\n- 2026-04-18: did stuff\n");
    refreshMemoryMd(tmpDir);

    const audit = auditBrain(tmpDir);
    expect(audit.hasBrain).toBe(true);
    expect(audit.identityLines).toBe(2);
    expect(audit.codingLines).toBe(1);
    expect(audit.goalsLines).toBe(1);
    expect(audit.domainCount).toBe(1);
    expect(audit.projectCount).toBe(1);
    expect(audit.handoffCount).toBe(1);
    expect(audit.lastHandoffDate).toBe("2026-04-18");
    expect(audit.memoryMdTokenEstimate).toBeGreaterThan(0);
  });

  it("reports no brain", () => {
    const audit = auditBrain(tmpDir);
    expect(audit.hasBrain).toBe(false);
  });
});

describe("export / import", () => {
  it("round-trips brain content", () => {
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "exported rule");
    appendToCoding(paths, "exported coding rule");
    appendToGoals(paths, "exported goal");
    appendToDomain(paths, "work", "work rule");
    writeProject(paths, "proj", "# proj\ndomain: work\n");

    const bundle = exportBrain(tmpDir);
    expect(bundle).toContain("exported rule");

    // Import to new dir
    const tmpDir2 = mkdtempSync(join(tmpdir(), "brain-import-"));
    try {
      const count = importBrain(tmpDir2, bundle);
      expect(count).toBeGreaterThan(0);

      const paths2 = resolveBrainPaths(tmpDir2);
      const identity2 = readFileSync(paths2.identity, "utf8");
      expect(identity2).toContain("exported rule");
      const coding2 = readFileSync(paths2.coding, "utf8");
      expect(coding2).toContain("exported coding rule");
      const scope2 = loadScopeConfig(tmpDir2);
      expect(scope2.localFirst).toBe(true);

      // MEMORY.md refreshed
      const memoryMd = readFileSync(join(tmpDir2, "MEMORY.md"), "utf8");
      expect(memoryMd).toContain("exported rule");
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

describe("routing confidence", () => {
  it("returns high confidence for explicit project match", () => {
    const paths = initBrainDir(tmpDir);
    writeProject(paths, "oh-my-brain", "# oh-my-brain\n");
    const result = routeDirective("oh-my-brain benchmark should checkpoint", paths);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("returns low confidence for ambiguous text", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("maybe do something different next time", paths);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it("returns high confidence for strong identity signal", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("always use Chinese for communication", paths);
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("returns high confidence for coding rules", () => {
    const paths = initBrainDir(tmpDir);
    const result = routeDirective("always run tests before committing", paths);
    expect(result.layer).toBe("coding");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });
});

describe("brainRemember with confidence", () => {
  it("flags low confidence for review", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(tmpDir, "some random thought about stuff");
    expect(result.needsReview).toBe(true);
    expect(result.written).toBe(false);
  });

  it("writes directly for high confidence", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(tmpDir, "always validate LLM output");
    expect(result.needsReview).toBe(false);
    expect(result.written).toBe(true);
  });

  it("does not write conversational Chinese requests into identity", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(tmpDir, "能補的都補上吧，然後我們等等再看 README");
    expect(result.written).toBe(false);
    expect(result.needsReview).toBe(false);

    const identity = readFileSync(join(tmpDir, ".brain", "identity.md"), "utf8");
    expect(identity).not.toContain("能補的都補上吧");
  });

  it("filters conversational guidance as noise instead of direct write", () => {
    initBrainDir(tmpDir);
    const result = brainRemember(tmpDir, "我覺得這次先把 benchmark 改一下就好");
    expect(result.written).toBe(false);
    expect(result.needsReview).toBe(false);
  });
});

describe("isNoise", () => {
  it("treats questions as noise", () => {
    expect(isNoise("你怎麼看這個？")).toBe(true);
  });

  it("allows durable preferences through noise filter", () => {
    expect(isNoise("always use Chinese for communication")).toBe(false);
  });
});

describe("episodes", () => {
  it("saves and loads episodes", async () => {
    const { saveEpisode, loadEpisodes } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);
    const ep = {
      id: "ep_test1",
      what: "PGLite timestamp precision causes unstable sort",
      episode_type: "lesson" as const,
      tags: ["pglite", "timestamp"],
      domain: "work",
      project: "oh-my-brain",
      frequency: 1,
      date: "2026-04-18",
    };
    saveEpisode(paths, ep);
    const loaded = loadEpisodes(paths);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].what).toContain("PGLite");
  });

  it("searches episodes by keyword", async () => {
    const { saveEpisode, searchEpisodes } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);
    saveEpisode(paths, {
      id: "ep1", what: "PGLite timestamp precision issue", episode_type: "lesson" as const,
      tags: ["pglite"], frequency: 1, date: "2026-04-18",
    });
    saveEpisode(paths, {
      id: "ep2", what: "React hooks must follow rules of hooks", episode_type: "lesson" as const,
      tags: ["react"], frequency: 1, date: "2026-04-18",
    });

    const results = searchEpisodes(paths, "PGLite timestamp");
    expect(results).toHaveLength(1);
    expect(results[0].what).toContain("PGLite");
  });

  it("tracks frequency and detects skill promotion", async () => {
    const { saveEpisode, trackEpisodeFrequency } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);
    saveEpisode(paths, {
      id: "ep1", what: "benchmark should checkpoint each shard", episode_type: "lesson" as const,
      tags: ["benchmark"], frequency: 2, date: "2026-04-18",
    });

    const { promoted } = trackEpisodeFrequency(paths, "benchmark should checkpoint each shard");
    expect(promoted).toHaveLength(1);
    expect(promoted[0].frequency).toBeGreaterThanOrEqual(3);
  });
});

describe("episode extraction from handoff", () => {
  it("extracts lessons from handoff summary", async () => {
    const { extractEpisodesFromHandoff } = await import("../cli/brain-store.js");
    const episodes = extractEpisodesFromHandoff(
      "We learned that PGLite has a timestamp precision issue. Decided to use ISO strings instead.",
      { domain: "work", project: "oh-my-brain" },
    );
    expect(episodes.length).toBeGreaterThanOrEqual(1);
    expect(episodes.some((e: any) => e.episode_type === "lesson")).toBe(true);
  });
});

describe("skill promotion", () => {
  it("1x correction saves episode, 2x correction creates skill", async () => {
    const { trackAndPromote, listSkills } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);

    // First correction → episode saved, no skill
    const r1 = trackAndPromote(paths, "always run tests before committing", "correction");
    expect(r1.promoted).toBe(false);
    expect(r1.episode.frequency).toBe(1);

    // Second correction → skill created
    const r2 = trackAndPromote(paths, "always run tests before committing", "correction");
    expect(r2.promoted).toBe(true);
    expect(r2.skillPath).toBeDefined();
    expect(r2.episode.frequency).toBe(2);

    // Verify skill file exists
    const skills = listSkills(paths);
    expect(skills.length).toBe(1);
    expect(skills[0].title).toContain("always run tests");
  });

  it("3x regular pattern creates skill", async () => {
    const { trackAndPromote } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);

    trackAndPromote(paths, "checkpoint each shard in benchmarks", "lesson");
    trackAndPromote(paths, "checkpoint each shard in benchmarks", "lesson");
    const r3 = trackAndPromote(paths, "checkpoint each shard in benchmarks", "lesson");
    expect(r3.promoted).toBe(true);
    expect(r3.skillPath).toBeDefined();
  });

  it("generates valid SKILL.md format", async () => {
    const { trackAndPromote } = await import("../cli/brain-store.js");
    const { readFileSync } = await import("fs");
    const paths = initBrainDir(tmpDir);

    trackAndPromote(paths, "validate output format", "correction");
    const r = trackAndPromote(paths, "validate output format", "correction");
    expect(r.skillPath).toBeDefined();

    const content = readFileSync(r.skillPath!, "utf8");
    expect(content).toContain("# validate output format");
    expect(content).toContain("## When to Use");
    expect(content).toContain("## Procedure");
    expect(content).toContain("## Pitfalls");
    expect(content).toContain("## Verification");
    expect(content).toContain("Auto-generated by oh-my-brain");
  });
});

describe("brain cleanup", () => {
  it("removes stale unreinforced episodes", async () => {
    const { saveEpisode, cleanupBrain } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);

    // Old unreinforced episode
    saveEpisode(paths, {
      id: "old1", what: "old lesson", episode_type: "lesson",
      tags: [], frequency: 1, date: "2025-01-01",
    });
    // Recent episode
    saveEpisode(paths, {
      id: "new1", what: "new lesson", episode_type: "lesson",
      tags: [], frequency: 1, date: new Date().toISOString().slice(0, 10),
    });
    // Old but reinforced
    saveEpisode(paths, {
      id: "old2", what: "reinforced", episode_type: "lesson",
      tags: [], frequency: 3, date: "2025-01-01",
    });

    const result = cleanupBrain(tmpDir);
    expect(result.staleEpisodes).toBe(1);
    expect(result.totalEpisodesBefore).toBe(3);
    expect(result.totalEpisodesAfter).toBe(2);
  });
});

describe("episode surfacing in MEMORY.md", () => {
  it("includes high-frequency episodes", async () => {
    const { saveEpisode } = await import("../cli/brain-store.js");
    const paths = initBrainDir(tmpDir);
    appendToIdentity(paths, "test rule");
    saveEpisode(paths, {
      id: "ep1", what: "always checkpoint before benchmarks", episode_type: "lesson" as const,
      tags: ["benchmark"], frequency: 3, date: "2026-04-18",
    });

    const output = assembleBrainToMemory(tmpDir);
    expect(output).toContain("Lessons Learned");
    expect(output).toContain("always checkpoint before benchmarks");
    expect(output).toContain("3x");
  });
});
