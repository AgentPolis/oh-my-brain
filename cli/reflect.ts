#!/usr/bin/env node

import { runReflectCli } from "./consolidate.js";
import { isDirectEntry } from "./is-main.js";

if (isDirectEntry(["reflect.js", "brain-reflect"])) {
  runReflectCli(process.argv, process.cwd()).catch((err) => {
    process.stderr.write(`[brain] reflect error: ${err.message}\n`);
    process.exit(1);
  });
}
