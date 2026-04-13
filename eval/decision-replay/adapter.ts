import { existsSync, readFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { parseActiveDirectives } from "../../cli/import-memory.js";

/**
 * Any memory system can implement this interface to be benchmarked.
 * oh-my-brain ships a built-in adapter. Others can write their own.
 */
export interface MemoryAdapter {
  /** Name of the system being tested */
  name: string;

  /** Load directives/rules from the memory system */
  loadContext(): Promise<string>;

  /** Ask a question with the loaded context. Returns the answer. */
  ask(prompt: string): Promise<string>;
}

export class OhMyBrainAdapter implements MemoryAdapter {
  name = "oh-my-brain";

  constructor(
    private readonly projectRoot: string,
    private readonly tool: "claude" | "codex" = "claude"
  ) {}

  async loadContext(): Promise<string> {
    const memoryPath = join(this.projectRoot, "MEMORY.md");
    if (!existsSync(memoryPath)) return "";
    return parseActiveDirectives(memoryPath).map((directive) => `- ${directive}`).join("\n");
  }

  async ask(prompt: string): Promise<string> {
    return runScenarioWithTool(this.tool, prompt) ?? "";
  }
}

export class RawContextAdapter implements MemoryAdapter {
  name = "raw-context";

  constructor(
    private readonly projectRoot: string,
    private readonly tool: "claude" | "codex" = "claude"
  ) {}

  async loadContext(): Promise<string> {
    const memoryPath = join(this.projectRoot, "MEMORY.md");
    if (!existsSync(memoryPath)) return "";
    return readFileSync(memoryPath, "utf8");
  }

  async ask(prompt: string): Promise<string> {
    return runScenarioWithTool(this.tool, prompt) ?? "";
  }
}

function runScenarioWithTool(tool: "claude" | "codex", prompt: string): string | null {
  const command = tool === "claude" ? "claude" : "codex";
  const args = tool === "claude" ? ["-p", prompt] : ["exec", prompt];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}
