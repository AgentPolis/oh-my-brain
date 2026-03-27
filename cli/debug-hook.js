#!/usr/bin/env node
/**
 * squeeze-claw debug hook — empirical Stop hook verification
 *
 * Install in ~/.claude/settings.json:
 *   "Stop": [{"hooks": [{"type": "command", "command": "node /path/to/debug-hook.js"}]}]
 *
 * After running a session, inspect:
 *   cat /tmp/squeeze-debug-stdin.json     # what Claude Code sends on stdin
 *   cat /tmp/squeeze-debug-env.json       # env vars available in hook context
 *   cat /tmp/squeeze-debug-cwd.txt        # working directory
 */

import { readFileSync, writeFileSync } from "fs";

const LOG_STDIN = "/tmp/squeeze-debug-stdin.json";
const LOG_ENV = "/tmp/squeeze-debug-env.json";
const LOG_CWD = "/tmp/squeeze-debug-cwd.txt";

let stdinData = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinData += chunk;
});

process.stdin.on("end", () => {
  // Parse stdin if possible, else store raw
  let parsed;
  try {
    parsed = JSON.parse(stdinData);
  } catch {
    parsed = { raw: stdinData, parseError: true };
  }

  writeFileSync(LOG_STDIN, JSON.stringify(parsed, null, 2));
  writeFileSync(LOG_ENV, JSON.stringify(process.env, null, 2));
  writeFileSync(LOG_CWD, process.cwd() + "\n");

  process.stderr.write(
    `[squeeze-debug] stdin=${stdinData.length} bytes, cwd=${process.cwd()}\n` +
    `  → inspect: ${LOG_STDIN}\n`
  );
  process.exit(0);
});
