import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { parseCodexSession, syncCodexSessions } from "../cli/codex-session.js";

describe("parseCodexSession", () => {
  it("extracts user, assistant, function calls, and token usage from Codex JSONL", () => {
    const fixturePath = new URL("./fixtures/codex-session-demo.jsonl", import.meta.url);
    const parsed = parseCodexSession(fixturePath);

    expect(parsed.sessionId).toBe("codex-demo-session");
    expect(parsed.cwd).toBe("/tmp/codex-demo-project");
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries[0].message.content).toBe("Always preserve backward compatibility.");
    expect(parsed.entries[1].message.content).toEqual([
      {
        type: "tool_use",
        name: "exec_command",
        input: {
          cmd: "cat README.md",
          workdir: "/tmp/codex-demo-project",
        },
      },
    ]);
    expect(parsed.entries[2].message.content).toEqual([
      {
        type: "tool_result",
        content: expect.stringContaining("README excerpt"),
      },
    ]);
    expect(parsed.lastTokenUsage?.totalTokens).toBe(1340);
  });
});

describe("syncCodexSessions", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes MEMORY.md for stable Codex sessions and records state", () => {
    tempDir = mkdtempSync(join(tmpdir(), "squeeze-codex-"));
    const projectDir = join(tempDir, "project");
    const sessionsRoot = join(tempDir, "sessions");
    const sessionDir = join(sessionsRoot, "2026", "04", "06");
    const sessionFile = join(sessionDir, "demo.jsonl");
    const statePath = join(tempDir, "state.json");
    const logPath = join(tempDir, "runs.jsonl");

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "sync-demo", cwd: projectDir } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Never remove audit logs from production systems." }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "function_call_output",
            output:
              "Long tool output. ".repeat(40),
          },
        }),
      ].join("\n")
    );

    const oldTime = new Date(Date.now() - 120000);
    utimesSync(sessionFile, oldTime, oldTime);

    const result = syncCodexSessions({
      sessionsRoot,
      statePath,
      logPath,
      stableMs: 0,
    });

    const memoryPath = join(projectDir, "MEMORY.md");
    const projectLogPath = join(projectDir, ".squeeze", "runs.jsonl");
    expect(result.processed).toHaveLength(1);
    expect(readFileSync(memoryPath, "utf8")).toContain("Never remove audit logs from production systems.");
    expect(readFileSync(memoryPath, "utf8")).toContain("[source:codex session:sync-demo]");
    expect(readFileSync(logPath, "utf8")).toContain("\"kind\":\"codex_sync\"");
    expect(readFileSync(projectLogPath, "utf8")).toContain("\"source\":\"codex\"");
    expect(readFileSync(statePath, "utf8")).toContain("demo.jsonl");
  });
});
