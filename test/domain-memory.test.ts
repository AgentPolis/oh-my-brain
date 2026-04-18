import { describe, it, expect } from "vitest";
import { resolveMemoryPaths, generateMemoryShim, parseExistingDirectives, appendDirectivesToMemory, retireDirective } from "../cli/compress-core.js";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "brain-mem-"));
}

describe("resolveMemoryPaths", () => {
  it("returns memory/*.md paths when memory/ exists", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n- rule 1\n");
    writeFileSync(join(dir, "memory", "life.md"), "## life\n- rule 2\n");
    const paths = resolveMemoryPaths(dir);
    expect(paths.length).toBe(2);
    expect(paths.map((p) => p.domain).sort()).toEqual(["life", "work"]);
  });

  it("falls back to MEMORY.md when memory/ does not exist", () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, "MEMORY.md"), "## directives\n- rule 1\n");
    const paths = resolveMemoryPaths(dir);
    expect(paths.length).toBe(1);
    expect(paths[0].domain).toBe("_flat");
    expect(paths[0].path).toBe(join(dir, "MEMORY.md"));
  });

  it("ignores non-.md files in memory/", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n");
    writeFileSync(join(dir, "memory", "notes.txt"), "not a domain\n");
    const paths = resolveMemoryPaths(dir);
    expect(paths.length).toBe(1);
  });

  it("returns paths sorted alphabetically by domain", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "zebra.md"), "## z\n");
    writeFileSync(join(dir, "memory", "alpha.md"), "## a\n");
    const paths = resolveMemoryPaths(dir);
    expect(paths[0].domain).toBe("alpha");
    expect(paths[1].domain).toBe("zebra");
  });
});

describe("generateMemoryShim", () => {
  it("generates MEMORY.md from domain files in alphabetical order", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work directives\n\n- [claude] use TDD\n");
    writeFileSync(join(dir, "memory", "life.md"), "## life directives\n\n- [claude] sleep 8 hours\n");
    generateMemoryShim(dir);
    const shim = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(shim).toContain("<!-- Auto-generated from memory/*.md");
    expect(shim).toContain("## life");
    expect(shim).toContain("## work");
    expect(shim.indexOf("## life")).toBeLessThan(shim.indexOf("## work"));
  });
});

describe("parseExistingDirectives with domain files", () => {
  it("parses directives from a domain file (same format)", () => {
    const content = [
      "## work directives",
      "",
      "- [claude session:abc] always use TDD",
      "- [claude session:abc] commit messages: neutral",
    ].join("\n");
    const set = parseExistingDirectives(content);
    expect(set.has("always use TDD")).toBe(true);
    expect(set.has("commit messages: neutral")).toBe(true);
  });
});

describe("appendDirectivesToMemory with domains", () => {
  it("routes directive to matching domain file", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude] always use TDD\n");
    writeFileSync(join(dir, "memory", "investing.md"), "## investing\n\n- [claude] track portfolio and ETF performance\n");
    const written = appendDirectivesToMemory(
      ["rebalance portfolio quarterly"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "test" }
    );
    expect(written).toBe(1);
    const investContent = readFileSync(join(dir, "memory", "investing.md"), "utf8");
    expect(investContent).toContain("rebalance portfolio quarterly");
    const workContent = readFileSync(join(dir, "memory", "work.md"), "utf8");
    expect(workContent).not.toContain("rebalance");
  });

  it("writes to general.md when no domain matches", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude] use TDD\n");
    const written = appendDirectivesToMemory(
      ["completely unrelated xyz gibberish"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "test" }
    );
    expect(written).toBe(1);
    const generalContent = readFileSync(join(dir, "memory", "general.md"), "utf8");
    expect(generalContent).toContain("completely unrelated xyz gibberish");
  });

  it("writes to targetDomain directly when specified, bypassing routing", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude] use TDD\n");
    writeFileSync(join(dir, "memory", "investing.md"), "## investing\n");
    const written = appendDirectivesToMemory(
      ["portfolio rebalancing tip"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "test", targetDomain: "work" }
    );
    expect(written).toBe(1);
    const workContent = readFileSync(join(dir, "memory", "work.md"), "utf8");
    expect(workContent).toContain("portfolio rebalancing tip");
    const investContent = readFileSync(join(dir, "memory", "investing.md"), "utf8");
    expect(investContent).not.toContain("portfolio rebalancing tip");
  });

  it("falls back to flat MEMORY.md when no memory/ dir exists", () => {
    const dir = makeTmpDir();
    const written = appendDirectivesToMemory(
      ["always use TypeScript"],
      join(dir, "MEMORY.md"),
      { source: "claude", sessionId: "test" }
    );
    expect(written).toBe(1);
    const content = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(content).toContain("always use TypeScript");
    expect(existsSync(join(dir, "memory"))).toBe(false);
  });
});

describe("retireDirective with domains", () => {
  it("retires from domain files and regenerates shim", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude abc] always use TDD\n- [claude abc] commit often\n");
    writeFileSync(join(dir, "memory", "life.md"), "## life\n\n- [claude abc] sleep 8 hours\n");

    // Generate initial shim
    generateMemoryShim(dir);

    const retired = retireDirective(join(dir, "MEMORY.md"), "always use TDD");
    expect(retired).toBe(1);

    // Should be moved to archive in domain file, not in active section
    const workContent = readFileSync(join(dir, "memory", "work.md"), "utf8");
    // "commit often" should remain in the active section
    expect(workContent).toContain("commit often");
    // The retired directive moves to the archive section
    expect(workContent).toContain("oh-my-brain archive");
    expect(workContent).toContain("always use TDD");

    // Active section of the shim should still contain "commit often"
    const shim = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(shim).toContain("commit often");
    // Shim is regenerated (auto-generated comment present)
    expect(shim).toContain("Auto-generated from memory/*.md");
  });

  it("retires across multiple domain files", () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, "memory"));
    writeFileSync(join(dir, "memory", "work.md"), "## work\n\n- [claude abc] shared rule\n");
    writeFileSync(join(dir, "memory", "life.md"), "## life\n\n- [claude abc] shared rule\n");

    const retired = retireDirective(join(dir, "MEMORY.md"), "shared rule");
    expect(retired).toBe(2);
  });
});
