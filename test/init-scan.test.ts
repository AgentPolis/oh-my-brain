import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runInitCli } from "../cli/init-scan.js";

describe("init scan", () => {
  let tmpDir: string;
  let stdout = "";
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ohmybrain-init-"));
    stdout = "";
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scans project config and AI rules in non-interactive mode", async () => {
    writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      type: "module",
      devDependencies: { vitest: "^3.0.0" },
    }));
    writeFileSync(
      join(tmpDir, ".cursorrules"),
      ["Always use TypeScript strict mode", "I prefer tabs over spaces"].join("\n")
    );
    writeFileSync(
      join(tmpDir, "MEMORY.md"),
      "## oh-my-brain directives (2026-04-13) [source:test]\n\n- [test] Always review before merging\n"
    );

    const code = await runInitCli(["node", "init", "--yes"], tmpDir);
    expect(code).toBe(0);

    const memory = readFileSync(join(tmpDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("Always review before merging");
    expect(memory).toContain("Always use TypeScript strict mode");
    expect(memory).toContain("This project uses ESM (import/export), not CommonJS (require)");
    expect(memory).toContain("This project uses Vitest for tests");

    const candidates = readFileSync(join(tmpDir, ".squeeze", "candidates.json"), "utf8");
    expect(candidates).toContain("I prefer tabs over spaces");
    expect(stdout).toContain("[brain] Final report:");
  });
});
