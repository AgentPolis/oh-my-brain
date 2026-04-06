#!/usr/bin/env node

import {
  appendProjectRunLog,
  extractTextContent,
  findSessionJsonl,
  main,
  parseSessionEntries,
  processMessages,
  writeDirectivesToMemory,
} from "./compress-core.js";
import { isDirectEntry } from "./is-main.js";

export {
  appendProjectRunLog,
  extractTextContent,
  findSessionJsonl,
  main,
  parseSessionEntries,
  processMessages,
  writeDirectivesToMemory,
};

// Only auto-execute when invoked as the brain-compress binary. Without
// this guard, importing this module from tests (compress.test.ts does)
// would trigger a live hook run on every test file load.
if (isDirectEntry(["compress.js", "brain-compress"])) {
  main().catch((err) => {
    process.stderr.write(`[brain] error: ${err.message}\n`);
    process.exit(0);
  });
}
