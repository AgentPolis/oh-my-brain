#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const allowlistPath = resolve(repoRoot, ".repo-allowlist");

function loadPatterns() {
  return readFileSync(allowlistPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function listTrackedFiles() {
  return execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const patterns = loadPatterns();
const matchers = patterns.map((pattern) => ({
  pattern,
  regex: globToRegExp(pattern),
}));

const tracked = listTrackedFiles();
const unexpected = tracked.filter(
  (file) => !matchers.some((matcher) => matcher.regex.test(file))
);

if (unexpected.length > 0) {
  process.stderr.write(
    [
      "[repo-allowlist] Found tracked files outside the allowlist:",
      ...unexpected.map((file) => `- ${file}`),
      "",
      "Add them to .repo-allowlist only if they are safe and intended to be public.",
    ].join("\n") + "\n"
  );
  process.exit(1);
}

process.stdout.write(
  `[repo-allowlist] OK — ${tracked.length} tracked files match the allowlist.\n`
);
