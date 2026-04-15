import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectEnvironment,
  formatOnboardingMessage,
  getOnboardingOptions,
  saveOnboardingConfig,
  isOnboarded,
  getCompressHookHint,
} from "../cli/onboarding.js";

describe("detectEnvironment", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omb-onboard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("detects project root with package.json", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    const env = detectEnvironment(tmp);
    expect(env.isProjectRoot).toBe(true);
    expect(env.isWorkspace).toBe(false);
    expect(env.projectMarkers).toContain("package.json");
  });

  it("detects project root with .git", () => {
    mkdirSync(join(tmp, ".git"));
    const env = detectEnvironment(tmp);
    expect(env.isProjectRoot).toBe(true);
    expect(env.isWorkspace).toBe(false);
  });

  it("detects workspace with 2+ sub-repos and no root .git", () => {
    mkdirSync(join(tmp, "project-a", ".git"), { recursive: true });
    mkdirSync(join(tmp, "project-b", ".git"), { recursive: true });
    const env = detectEnvironment(tmp);
    expect(env.isWorkspace).toBe(true);
    expect(env.subProjects).toContain("project-a");
    expect(env.subProjects).toContain("project-b");
    expect(env.isProjectRoot).toBe(false);
  });

  it("is NOT workspace if root has .git (monorepo)", () => {
    mkdirSync(join(tmp, ".git"));
    mkdirSync(join(tmp, "packages", "a", ".git"), { recursive: true });
    mkdirSync(join(tmp, "packages", "b", ".git"), { recursive: true });
    const env = detectEnvironment(tmp);
    expect(env.isWorkspace).toBe(false);
    expect(env.isProjectRoot).toBe(true);
  });

  it("detects existing MEMORY.md", () => {
    writeFileSync(join(tmp, "MEMORY.md"), "- [claude x] rule one\n");
    const env = detectEnvironment(tmp);
    expect(env.hasExistingMemory).toBe(true);
    expect(env.existingMemoryPath).toBe(join(tmp, "MEMORY.md"));
  });

  it("detects no MEMORY.md", () => {
    const env = detectEnvironment(tmp);
    expect(env.hasExistingMemory).toBe(false);
    expect(env.existingMemoryPath).toBeNull();
  });

  it("bare directory — no project, no workspace", () => {
    const env = detectEnvironment(tmp);
    expect(env.isProjectRoot).toBe(false);
    expect(env.isWorkspace).toBe(false);
  });
});

describe("getOnboardingOptions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omb-onboard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("workspace with existing memory → offers continue or skip", () => {
    mkdirSync(join(tmp, "a", ".git"), { recursive: true });
    mkdirSync(join(tmp, "b", ".git"), { recursive: true });
    writeFileSync(join(tmp, "MEMORY.md"), "- [claude x] test\n");
    const env = detectEnvironment(tmp);
    const options = getOnboardingOptions(env);
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.some((o) => o.choice.action === "use-existing")).toBe(true);
    expect(options.some((o) => o.choice.action === "skip-workspace")).toBe(true);
  });

  it("workspace without memory → offers skip or create shared", () => {
    mkdirSync(join(tmp, "a", ".git"), { recursive: true });
    mkdirSync(join(tmp, "b", ".git"), { recursive: true });
    const env = detectEnvironment(tmp);
    const options = getOnboardingOptions(env);
    expect(options.some((o) => o.choice.action === "skip-workspace")).toBe(true);
    expect(options.some((o) => o.choice.action === "use-current")).toBe(true);
  });

  it("project root without memory → offers create (recommended)", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    const env = detectEnvironment(tmp);
    const options = getOnboardingOptions(env);
    expect(options).toHaveLength(1);
    expect(options[0].choice.action).toBe("use-current");
    expect(options[0].label).toContain("推薦");
  });

  it("project root with existing memory → offers continue or restart", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    writeFileSync(join(tmp, "MEMORY.md"), "- [claude x] rule\n");
    const env = detectEnvironment(tmp);
    const options = getOnboardingOptions(env);
    expect(options).toHaveLength(2);
    expect(options[0].choice.action).toBe("use-existing");
    expect(options[1].choice.action).toBe("use-current");
  });
});

describe("onboarding config", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omb-onboard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isOnboarded returns false before config", () => {
    expect(isOnboarded(tmp)).toBe(false);
  });

  it("isOnboarded returns true after saveOnboardingConfig", () => {
    saveOnboardingConfig(tmp, {
      brainPath: join(tmp, "MEMORY.md"),
      onboardedAt: new Date().toISOString(),
      environment: "project",
    });
    expect(isOnboarded(tmp)).toBe(true);
  });
});

describe("getCompressHookHint", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omb-onboard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null after onboarding", () => {
    saveOnboardingConfig(tmp, {
      brainPath: join(tmp, "MEMORY.md"),
      onboardedAt: new Date().toISOString(),
      environment: "project",
    });
    expect(getCompressHookHint(tmp)).toBeNull();
  });

  it("returns warning for workspace", () => {
    mkdirSync(join(tmp, "a", ".git"), { recursive: true });
    mkdirSync(join(tmp, "b", ".git"), { recursive: true });
    const hint = getCompressHookHint(tmp);
    expect(hint).toContain("workspace");
    expect(hint).toContain("oh-my-brain init");
  });

  it("returns brain location for new directory", () => {
    const hint = getCompressHookHint(tmp);
    expect(hint).toContain("MEMORY.md");
  });
});

describe("formatOnboardingMessage", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omb-onboard-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("shows workspace info", () => {
    mkdirSync(join(tmp, "a", ".git"), { recursive: true });
    mkdirSync(join(tmp, "b", ".git"), { recursive: true });
    const env = detectEnvironment(tmp);
    const msg = formatOnboardingMessage(env);
    expect(msg).toContain("workspace");
    expect(msg).toContain("混在一起");
  });

  it("shows project info", () => {
    writeFileSync(join(tmp, "package.json"), "{}");
    const env = detectEnvironment(tmp);
    const msg = formatOnboardingMessage(env);
    expect(msg).toContain("專案");
    expect(msg).toContain("package.json");
  });
});
