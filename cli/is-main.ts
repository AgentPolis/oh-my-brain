/**
 * Cross-platform "am I the direct entry point?" check.
 *
 * Why basename-based instead of import.meta.url comparison:
 * tsup aggressively hoists shared code into chunk files. If two entry
 * points import the same function, the function's source module gets
 * moved to a chunk, and any `if (import.meta.url === ...)` guard in
 * that source module ends up inside the chunk. When the chunk runs,
 * its import.meta.url is the chunk's URL, not the entry file's URL,
 * so the guard never fires and the CLI silently does nothing.
 *
 * Basename matching is bundler-safe: process.argv[1] is always the
 * actual entry file the user ran (e.g. dist/cli/candidates-cli.js),
 * regardless of what tsup did to the source layout.
 *
 * The tradeoff is that this check only knows the filename, not the
 * full path, so two modules with the same basename in different
 * directories would both think they are the entry. Within this repo
 * every CLI basename is unique so that isn't a concern.
 */

import { basename } from "path";

export function isDirectEntry(entryBasenames: readonly string[]): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const name = basename(argv1);
  return entryBasenames.some((candidate) => name === candidate);
}
