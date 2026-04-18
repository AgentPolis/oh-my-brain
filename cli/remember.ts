#!/usr/bin/env node

import { applyRememberDirective } from "./actions.js";
import { isDirectEntry } from "./is-main.js";

const HELP_TEXT = `brain-remember

Write a durable directive through the typed Action pipeline.

Usage:
  brain-remember --source codex --text "Always checkpoint each completed item"
  brain-remember --source claude --domain work "Use Chinese for product strategy"
  oh-my-brain remember --source codex --session-id sess-123 "Never edit MEMORY.md by hand"

Options:
  --source <agent>       Required provenance (codex, claude, cursor, etc.)
  --session-id <id>      Optional session id for provenance tracking
  --domain <name>        Optional target domain (omit for auto-routing)
  --text <directive>     Directive text (or pass as positional args)
  --help                 Show this message
`;

function parseArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index >= args.length - 1) return undefined;
  return args[index + 1];
}

function consumeOption(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index === -1) return args.slice();
  const next = args.slice();
  next.splice(index, 2);
  return next;
}

export async function runRememberCli(argv: string[], cwd: string): Promise<number> {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const source = parseArgValue(args, "--source")?.trim();
  const sessionId = parseArgValue(args, "--session-id")?.trim();
  const domain = parseArgValue(args, "--domain")?.trim();
  const textFlag = parseArgValue(args, "--text")?.trim();

  let remaining = consumeOption(args, "--source");
  remaining = consumeOption(remaining, "--session-id");
  remaining = consumeOption(remaining, "--domain");
  remaining = consumeOption(remaining, "--text");
  const positional = remaining.filter((a) => !a.startsWith("--"));
  const text = (textFlag ?? positional.join(" ")).trim();

  if (!source) {
    process.stderr.write("[brain] error: --source is required (e.g., codex, claude, cursor)\n");
    return 1;
  }
  if (!text) {
    process.stderr.write("[brain] error: directive text is required\n");
    return 1;
  }

  const action = await applyRememberDirective(
    { projectRoot: cwd, source, sessionId, domain },
    { text, domain }
  );

  if (action.payload.written) {
    process.stdout.write(`remembered: "${action.payload.finalText}" (${source})\n`);
  } else {
    process.stdout.write(`already remembered: "${action.payload.finalText}" (${source})\n`);
  }
  return 0;
}

if (isDirectEntry(["remember.js", "brain-remember"])) {
  runRememberCli(process.argv, process.cwd()).then((code) => process.exit(code));
}
