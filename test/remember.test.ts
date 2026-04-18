import { describe, it, expect, beforeEach } from "vitest";
import { runRememberCli } from "../cli/remember.js";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("runRememberCli", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "brain-remember-"));
    mkdirSync(join(tmp, ".squeeze"), { recursive: true });
  });

  it("writes directive with source provenance", async () => {
    const code = await runRememberCli(
      ["node", "remember", "--source", "codex", "--text", "always checkpoint"],
      tmp
    );
    expect(code).toBe(0);
    const content = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(content).toContain("always checkpoint");
    expect(content).toContain("[source:codex");
  });

  it("requires --source flag", async () => {
    const code = await runRememberCli(
      ["node", "remember", "--text", "some rule"],
      tmp
    );
    expect(code).toBe(1);
  });

  it("requires text", async () => {
    const code = await runRememberCli(
      ["node", "remember", "--source", "codex"],
      tmp
    );
    expect(code).toBe(1);
  });

  it("routes to domain when --domain specified", async () => {
    mkdirSync(join(tmp, "memory"));
    writeFileSync(join(tmp, "memory", "work.md"), "## work\n");

    const code = await runRememberCli(
      ["node", "remember", "--source", "codex", "--domain", "work", "--text", "use TDD"],
      tmp
    );
    expect(code).toBe(0);
    const workContent = readFileSync(join(tmp, "memory", "work.md"), "utf8");
    expect(workContent).toContain("use TDD");
  });

  it("accepts positional text without --text flag", async () => {
    const code = await runRememberCli(
      ["node", "remember", "--source", "cursor", "never skip tests"],
      tmp
    );
    expect(code).toBe(0);
    const content = readFileSync(join(tmp, "MEMORY.md"), "utf8");
    expect(content).toContain("never skip tests");
    expect(content).toContain("[source:cursor");
  });
});
