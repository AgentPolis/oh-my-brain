# squeeze-claw TODOS

## MVP Blockers (must do before shipping cli/compress.ts)

- [ ] **Empirical Stop hook verification** — Write a Stop hook that dumps stdin + all env vars to stderr. Confirm: (a) what JSON arrives on stdin, (b) whether `cwd` is set, (c) what the session path looks like. This is THE gate for the entire CLI. Do not write compress.ts until this passes.
  - Test: add to `~/.claude/settings.json`, run a short session, inspect stderr output

- [ ] **Handle partial JSONL last line** — The last line of a session `.jsonl` may be partially written if Claude Code is still running. Use try-parse per line: `try { JSON.parse(line) } catch { skip }`. Never crash on malformed JSONL.

- [ ] **MEMORY.md dedup** — Before appending any L3 directive, grep `./MEMORY.md` for the exact line. Skip if already present. Prevents duplicate entries across multiple sessions.

## v1.1 (after MVP is working)

- [ ] **Session ID anchor** — Replace "most recently modified `.jsonl`" heuristic with: read `sessionId` from Stop hook stdin, find the matching file in `~/.claude/projects/$(cwd | tr '/' '-')/`. Eliminates stale-file race condition.

- [ ] **@squeeze-claw/core npm package** — Extract `src/triage/classifier.ts` + `src/compact/compactor.ts` with zero OpenClaw deps. Separate tsconfig entry point. Trigger: 100 installs of CLI.

- [ ] **npm publish CI** — GitHub Actions workflow: `npm publish` on semver tag push. Separate jobs for `squeeze-claw` (CLI) and `@squeeze-claw/core`.

## Roadmap (deferred until buzz validated)

- [ ] **agent-constitution integration** — Relationship unconfirmed. Revisit after researching what agent-constitution actually does and whether L3 directives map to its concept of "constitution".

- [ ] **PreToolUse hook** — Inject L3 directives at session START (not just end). BLOCKED until Stop hook is verified and compress.ts is running in real sessions.

- [ ] **LLM-based classifier** — Replace heuristic L0-L3 classifier with Haiku call for ambiguous cases. Phase 3 roadmap item. Current regex fast path (<1ms) is sufficient for MVP.

- [ ] **squeeze-claw.dev landing page** — Trigger: 100 installs. GitHub README + generated banner sufficient for now.

## Known Design Decisions (already resolved)

- **JSONL format**: `{type, cwd, sessionId, message: {role, content: string | ContentBlock[]}}` — NOT `{role, content, ts}`. Use `extractTextContent()` to normalize. Skip `file-history-snapshot` entries.
- **Session path**: `~/.claude/projects/$(pwd | tr '/' '-')/` — NOT `$CLAUDE_PROJECT_DIR`.
- **Stale check**: position-only (index < total - 20) — NO substring comparison (avoids O(n²)).
- **MEMORY.md in MVP**: L3 directives write to `./MEMORY.md` IS part of MVP v1.0 (not v1.1). Without this, MVP has no differentiator over native compaction.
- **Token % in output**: always use `63.9%` (benchmark number from README). Not 60%, not 61%.
- **Exit behavior**: always `exit 0`. Log errors to stderr but never let the hook crash a user's session.
- **ESM**: keep `"type": "module"` in package.json. CLI is a separate tsup entry point: `cli/compress.ts → dist/cli/compress.js`.
