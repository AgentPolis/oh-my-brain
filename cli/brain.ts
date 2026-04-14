#!/usr/bin/env node
/**
 * oh-my-brain — umbrella CLI.
 *
 * This is the single command users learn first. It dispatches to the
 * same entry points as the standalone binaries:
 *
 *   oh-my-brain compress         → brain-compress (Claude Code hook)
 *   oh-my-brain codex-sync       → brain-codex-sync (Codex watcher)
 *   oh-my-brain audit            → brain-audit (markdown audit)
 *   oh-my-brain candidates ...   → brain-candidates (review queue)
 *   oh-my-brain mcp              → brain-mcp (MCP server)
 *   oh-my-brain --help           → this message
 *   oh-my-brain --version        → version
 *
 * The individual binaries still exist for backward compatibility with
 * existing hook installations.
 */

import { runCandidatesCli } from "./candidates-cli.js";
import { runImportCli } from "./import.js";

const VERSION = "0.4.0";

const HELP_TEXT = `oh-my-brain ${VERSION} — the second brain for AI agents

Usage:
  oh-my-brain <command> [args]

Commands:
  compress         Run the Claude Code compress hook (alias: brain-compress)
  codex-sync       Sync Codex sessions (alias: brain-codex-sync)
  audit            Print the markdown audit for this project (alias: brain-audit)
  candidates       Review queue for Memory Candidates (alias: brain-candidates)
  eval             Run Decision Replay evaluation
  diff             Show what the brain learned recently
  init             Scan the project and bootstrap initial memory
  import           Import directives from existing AI rule files
  mcp              Start the MCP server over stdio (alias: brain-mcp)
  quiz             Run a 5-scenario Decision Match quiz
  help             Show this message
  version          Show the version number

Key concepts:
  L0 discard       noise that gets dropped immediately
  L1 observation   regular messages, compressed as they age
  L2 preference    explicit preferences you've stated
  L3 directive     rules that never get forgotten
  Memory Candidate a soft signal waiting for your approval

The differentiator: other memory layers treat all data equally.
oh-my-brain knows which things matter, protects them from being
forgotten, and asks you about the fuzzy cases.

See https://github.com/AgentPolis/oh-my-brain for docs.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    process.stdout.write(`oh-my-brain ${VERSION}\n`);
    return 0;
  }

  // Dispatch to the corresponding module's main. Each module either exports
  // an async main() or a sync CLI runner function. Dynamic imports keep the
  // cold-start cost low for simple commands like `version`.

  if (cmd === "compress") {
    const mod = await import("./compress-core.js");
    await mod.main();
    return 0;
  }

  if (cmd === "codex-sync") {
    // Shift argv so the delegated CLI sees a clean command-line.
    process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
    const mod = await import("./codex-sync.js");
    // codex-sync auto-runs on import, nothing else to do.
    void mod;
    return 0;
  }

  if (cmd === "audit") {
    process.argv = [process.argv[0], process.argv[1], ...args.slice(1)];
    await import("./audit.js");
    return 0;
  }

  if (cmd === "candidates") {
    // Reconstruct argv so the candidates CLI parses its own subcommand.
    const delegated = [process.argv[0], "candidates", ...args.slice(1)];
    return runCandidatesCli(delegated, process.cwd());
  }

  if (cmd === "mcp") {
    const mod = await import("./mcp-server.js");
    if (typeof mod.startMcpServer === "function") {
      await mod.startMcpServer();
    }
    return 0;
  }

  if (cmd === "import") {
    const delegated = [process.argv[0], "import", ...args.slice(1)];
    return runImportCli(delegated, process.cwd());
  }

  if (cmd === "eval") {
    const delegated = [process.argv[0], "eval", ...args.slice(1)];
    const mod = await import("./eval.js");
    return await mod.runDecisionReplayCli(delegated, process.cwd());
  }

  if (cmd === "init") {
    const delegated = [process.argv[0], "init", ...args.slice(1)];
    const mod = await import("./init-scan.js");
    return mod.runInitCli(delegated, process.cwd());
  }

  if (cmd === "quiz") {
    const delegated = [process.argv[0], "quiz", ...args.slice(1)];
    const mod = await import("./quiz.js");
    return await mod.runQuizCli(delegated, process.cwd());
  }

  if (cmd === "diff") {
    const delegated = [process.argv[0], "diff", ...args.slice(1)];
    const mod = await import("./diff.js");
    return await mod.runDiffCli(delegated, process.cwd());
  }

  process.stderr.write(`Unknown command: ${cmd}\n\n${HELP_TEXT}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`[brain] error: ${err.message}\n`);
    process.exit(1);
  });
