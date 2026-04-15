#!/usr/bin/env node

import {
  defaultCodexLogPath,
  defaultCodexSessionsRoot,
  defaultCodexStatePath,
  syncCodexSessions,
} from "./codex-session.js";
import { isDirectEntry } from "./is-main.js";

const HELP_TEXT = `brain-codex-sync

Sync recent Codex session transcripts into project MEMORY.md files.

Usage:
  brain-codex-sync
  brain-codex-sync --watch
  brain-codex-sync --sessions-root /path/to/.codex/sessions
  brain-codex-sync --state-path /path/to/state.json
  brain-codex-sync --log-path /path/to/runs.jsonl
  brain-codex-sync --stable-ms 30000
`;

function parseArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

async function runOnce(args: string[]): Promise<void> {
  const result = await syncCodexSessions({
    sessionsRoot: parseArgValue(args, "--sessions-root") ?? defaultCodexSessionsRoot(),
    statePath: parseArgValue(args, "--state-path") ?? defaultCodexStatePath(),
    logPath: parseArgValue(args, "--log-path") ?? defaultCodexLogPath(),
    stableMs: Number(parseArgValue(args, "--stable-ms") ?? 30000),
  });

  if (result.processed.length === 0) {
    process.stderr.write("[squeeze-codex] scanned sessions, nothing new to sync.\n");
    return;
  }

  for (const item of result.processed) {
    process.stderr.write(
      `[squeeze-codex] synced ${item.sessionId} → ${item.cwd} (${item.totalMessages} msgs, ${item.compressedCount} compressed, ~${item.savedTokens} est. tokens saved, ${item.directivesWritten} directives)\n`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return;
  }

  if (!args.includes("--watch")) {
    await runOnce(args);
    return;
  }

  const intervalMs = Number(parseArgValue(args, "--interval-ms") ?? 15000);
  process.stderr.write(`[brain-codex] watch mode started (interval ${intervalMs}ms)\n`);
  await runOnce(args);
  setInterval(() => { void runOnce(args); }, intervalMs);
}

// Only auto-execute when run directly as a binary. Without this guard,
// importing from brain.ts or tests would kick off the watcher.
if (isDirectEntry(["codex-sync.js", "brain-codex-sync"])) {
  main().catch((err) => {
    process.stderr.write(`[brain-codex] error: ${err.message}\n`);
    process.exit(1);
  });
}
