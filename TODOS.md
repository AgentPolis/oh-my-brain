# squeeze-claw / oh-my-brain TODOS

> Project is mid-repositioning from squeeze-claw → oh-my-brain. See
> `docs/why-memory-candidates.md` for the core insight driving the pivot
> and the CEO plan at `~/.gstack/projects/squeeze-claw/ceo-plans/` for
> the full roadmap.

## Recently shipped (2026-04-06)

- [x] **Dedup substring bug fixed** — `writeDirectivesToMemory` now uses
  exact-line comparison via `parseExistingDirectives`, so
  "always use TypeScript" no longer blocks "always use TypeScript strict mode".
- [x] **Memory Candidates review queue** — persistent store at
  `.squeeze/candidates.json`, `squeeze-candidates` CLI with
  list/approve/reject/retire/status commands, soft-signal ingestion
  wired into both Claude Code hook and Codex sync.
- [x] **MEMORY.md write lock** — `cli/lockfile.ts` prevents concurrent
  writers from silently clobbering each other's directives.
- [x] **MEMORY.md supersession** — `squeeze-candidates retire` moves
  stale directives to an explicit archive section; bootstrap-read
  consumers ignore the archive.
- [x] **L2 preference ingestion** — classifier now detects explicit
  preference statements and the engine calls `addPreference`. L2 is
  no longer measured fiction in the README.
- [x] **Partial JSONL last-line handling** — already implemented at
  `cli/compress-core.ts:parseSessionEntries` (try/catch per line).
- [x] **MEMORY.md dedup** — implemented in `writeDirectivesToMemory`,
  fixed for the substring bug above.

## Still open

### Phase 1 (finish credibility pass)

- [ ] **Empirical Stop hook verification (user action)** — The debug
  instrument already exists at `cli/debug-hook.js` (writes stdin, env,
  cwd to `/tmp/squeeze-debug-*`). Remaining step is user action: wire
  it into `~/.claude/settings.json`, run a short Claude Code session,
  inspect the three /tmp files to confirm (a) stdin JSON shape, (b)
  whether `cwd` is set, (c) session path format. Capture findings in
  a follow-up commit to lock in assumptions.

- [ ] **Pre-existing test failures** — 44 tests fail with
  `Cannot read properties of undefined (reading 'close')` across
  `test/directives.test.ts`, `test/assembler.test.ts`,
  `test/integration.test.ts`. These are NOT caused by recent work
  (verified by stash/pop comparison). Looks like a db setup lifecycle
  issue — test beforeEach fails to initialize `db` so afterEach's
  `db.close()` throws. Investigate and fix as a separate change.

- [ ] **Repetition-based L2 promotion** — Current L2 path is
  classification-time only (explicit "I prefer X"). Implicit
  preferences that emerge only through repetition need the
  mention-counting observation loop. Requires schema migration
  (current `mention_counts` is keyed by `msg_id`, needs to be keyed
  by normalized content key).

### Phase 2 (rename + MCP rebuild)

- [ ] **Rename squeeze-claw → oh-my-brain** — npm, GitHub, package.json,
  all imports, all docs, all test fixtures. Publish deprecation
  notice on npm for squeeze-claw. Keep git history.

- [ ] **MCP-native rebuild** — Extract core engine as an MCP server.
  Tools: `brain_remember`, `brain_recall`, `brain_directives`,
  `brain_status`. Existing adapters become MCP clients. Bootstrap
  read becomes a `brain_recall` call on startup. New adapter for
  MCP-compatible tools (Cursor, Windsurf) for free.

- [ ] **Cross-agent handoff demo** — Reproducible script showing
  Claude Code writes a directive → Codex reads it on next session
  and behavior changes. Integration test. This is the single
  highest-leverage credibility artifact.

### Phase 3 (launch prep)

- [ ] **Memory-focused benchmarks** — Directive survival rate,
  cross-agent recall accuracy, preference consistency. Deterministic
  compaction for CI speed. Replaces current "96.5% token savings"
  headline which is from a synthetic eval.

- [ ] **Honest benchmark numbers** — Use real session replay range
  (30-82%) instead of synthetic 96.5%. Explicitly frame as chars/4
  estimation, not provider billing.

- [ ] **README rewrite + FAQ** — New hero ("Your context, everywhere
  you work"), L0-L3 + Memory Candidates explanation, vs-Memorix
  comparison table, "Why not Claude's memory tool?" FAQ, origin
  story from `docs/why-memory-candidates.md`.

## Roadmap (not blocking launch)

- [ ] **LLM-based classifier** — Replace heuristic L0-L3 classifier
  with Haiku for ambiguous cases. Current regex fast path (<1ms) is
  sufficient for MVP; LLM fallback is a Phase 3+ enhancement.

- [ ] **agent-constitution integration** — L3 directives can feed
  agent-constitution as governance rules; agent-constitution verdicts
  can become L3 directives. Premature until production users exist.

- [ ] **PreToolUse hook** — Inject L3 directives at session START.
  Blocked until Stop hook is empirically verified.

- [ ] **ohmybrain.dev landing page** — Trigger at 100 npm installs.

- [ ] **Team collaboration features** — Shared directive store
  across multiple developers on the same project. Requires thinking
  about merge/conflict semantics for MEMORY.md across git branches.

## Known Design Decisions (resolved, don't relitigate)

- **JSONL format**: `{type, cwd, sessionId, message: {role, content}}`.
  Use `extractTextContent()` to normalize. Skip `file-history-snapshot`.
- **Session path**: `~/.claude/projects/$(pwd | tr '/' '-')/`.
- **Stale check**: position-only (index < total - 20) — no substring
  comparison (avoids O(n²)).
- **MEMORY.md in MVP**: L3 directives write to `./MEMORY.md` is MVP
  v1.0, not v1.1. Without this there's no differentiator over native
  compaction.
- **Exit behavior**: always `exit 0`. Log errors to stderr but never
  crash a user's session.
- **ESM**: keep `"type": "module"`. CLI entries are separate tsup
  targets into `dist/cli/`.
- **Dedup strategy**: exact-line comparison via
  `parseExistingDirectives`, NOT substring `includes()` (fixed
  2026-04-06).
- **Archive section heading**: `## oh-my-brain archive (superseded
  directives — do not use)` — exact match matters for
  `parseExistingDirectives` and bootstrap-read consumers to ignore.
- **Lockfile strategy**: O_EXCL create with stale-lock stealing
  (30s age or dead pid). Falls back to unlocked write with stderr
  warning if lock cannot be acquired in 2s.
