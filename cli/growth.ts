#!/usr/bin/env node

import { runGrowthCli } from "./consolidate.js";
import { isDirectEntry } from "./is-main.js";

if (isDirectEntry(["growth.js", "brain-growth"])) {
  runGrowthCli(process.argv, process.cwd()).catch((err) => {
    process.stderr.write(`[brain] growth error: ${err.message}\n`);
    process.exit(1);
  });
}
