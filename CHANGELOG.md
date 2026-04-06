# Changelog

## [0.2.0] - 2026-04-06

**Project renamed: `squeeze-claw` → `oh-my-brain`.** The compression
still works. The real value turned out to be the part that decides what's
worth keeping. That's the brain.

This release is the result of a full internal CEO review + outside-voice
review by a second AI model. Every scope decision is documented in
[`docs/why-memory-candidates.md`](docs/why-memory-candidates.md).

### Added

- **Memory Candidates review queue**
  ([`cli/candidates.ts`](cli/candidates.ts),
  [`cli/candidates-cli.ts`](cli/candidates-cli.ts)) — the flagship
  feature. Soft signals (corrections, preferences, friction patterns)
  that don't match explicit "always/never" imperatives land in a
  persistent review queue at `.squeeze/candidates.json`. Users curate
  via `brain-candidates list/approve/reject/edit`. Approved candidates
  become first-class L3 directives in `MEMORY.md`. Rejected candidates
  are never resurrected, even if flagged again by a different agent.
- **MCP server** ([`cli/mcp-server.ts`](cli/mcp-server.ts)) —
  minimal stdio JSON-RPC implementation exposing five tools
  (`brain_remember`, `brain_recall`, `brain_candidates`, `brain_retire`,
  `brain_status`) so Cursor, Windsurf, Claude Desktop, or any
  MCP-compatible client can read and write the same project brain.
- **MEMORY.md write lock** ([`cli/lockfile.ts`](cli/lockfile.ts)) —
  cross-process lockfile with stale-lock stealing. Two agents writing
  the same file concurrently no longer silently clobber each other.
- **MEMORY.md supersession** (`brain-candidates retire "<text>"`) —
  stale directives move to an explicit `## oh-my-brain archive` section
  instead of piling up forever. Bootstrap-read consumers ignore the
  archive; re-adding a retired directive works again.
- **L2 preference ingestion** — the classifier now detects explicit
  preference statements ("I prefer X", "我比較喜歡 X") and the engine
  actually calls `addPreference()`. v0.1 had the schema and read path
  but ingest never wrote to them; Codex's outside-voice review flagged
  this as "measured fiction" in the old README.
- **Cross-agent handoff integration test**
  ([`test/cross-agent-handoff.test.ts`](test/cross-agent-handoff.test.ts)) —
  6 scenarios proving Claude → Codex → Cursor all share the same brain.
- **Reproducible handoff demo**
  ([`docs/cross-agent-demo.md`](docs/cross-agent-demo.md)).
- **Preference consistency benchmark**
  ([`eval/preference-consistency.test.ts`](eval/preference-consistency.test.ts)) —
  100% retention of explicit L2 preferences after 50 turns of mixed
  content.
- **Origin story doc**
  ([`docs/why-memory-candidates.md`](docs/why-memory-candidates.md)) —
  the real-use moment that exposed the gap in the v0.1 classifier.
- **Umbrella CLI** (`oh-my-brain` command) that dispatches to all the
  individual binaries: `compress`, `codex-sync`, `audit`, `candidates`,
  `mcp`.

### Changed

- **Rename** — `squeeze-claw` → `oh-my-brain`. Package name, repo URL,
  all binaries. Old class identifiers (`SqueezeContextEngine`,
  `squeezeClawFactory`) are preserved as backward-compatible aliases
  alongside `BrainEngine` and `ohMyBrainFactory`.
- **Bin names** — `squeeze-compress` → `brain-compress`,
  `squeeze-candidates` → `brain-candidates`, etc. New `brain-mcp`
  binary, new `oh-my-brain` umbrella.
- **MEMORY.md heading format** — new writes use
  `## oh-my-brain directives (...)`. The parser accepts both the new
  and legacy `## squeeze-claw directives (...)` prefixes so existing
  files keep working without migration.
- **README rewrite** — new positioning (cross-agent durable memory vs
  token compression), origin story, vs-Memorix comparison, honest
  benchmarks, "Why not Claude's memory tool?" FAQ.
- **Benchmark honesty** — replaced the synthetic 96.5% headline with
  the real session replay range (30.7% – 82.1% char reduction) and
  clearly labelled it as a `chars / 4` heuristic, not provider billing.
- **L2 preferences downgraded to L1 for non-user messages** — the
  "durable levels from user messages only" guard now applies to both
  L3 and L2.

### Fixed

- **Dedup substring bug** (`cli/compress-core.ts`) — the old
  `existing.includes(d)` dedup silently blocked any directive that was
  a substring of one already written. "Always use TypeScript" could
  prevent "Always use TypeScript strict mode" from being written, and
  vice versa. Now uses exact-line comparison via
  `parseExistingDirectives`.
- **L3 classifier false positives** — removed two over-loose regex
  patterns that tagged ordinary questions ("How should I…") and soft
  complaints ("太多提醒了") as L3 directives. The
  `directive-retention` eval test was failing because 20 "How should
  I" questions became 20 false-positive L3 entries. Soft signals now
  correctly flow to Memory Candidates instead.
- **Pre-existing test suite failures** — 44 tests were failing because
  `better-sqlite3` was built under a different Node ABI. Running
  `npm rebuild better-sqlite3` + the classifier fix brought the suite
  from 44 failed / 134 passed to 0 failed / 270+ passed.

### Security

- **MEMORY.md as trust boundary** — documented in the README FAQ. The
  recommendation: treat `MEMORY.md` as code, review it in PRs, use the
  `brain-candidates` review queue for anything uncertain.

## [0.1.0] - 2026-03-25

Initial release as `squeeze-claw`.

### Added

- **Semantic triage**: L0-L3 classification with regex fast-path (<1ms)
- **L0 noise filter**: 30+ patterns for acks, empty tool results, status noise
- **L3 directive store**: "always/never/remember" instructions extracted and never compressed
- **L2 preference store**: Structured KV with confidence scores and conflict resolution
- **Task-aware budget allocation**: Coding, debug, research, planning, chat — each with tuned weights
- **EMA task blending**: Smooth transitions when switching between task types
- **Circuit breaker**: Graceful degradation when classifier or storage fails
- **lossless-claw migration**: adds semantic columns to existing databases
- **SQLite storage**: WAL mode, foreign keys, integrity checks, recovery logic
- **Evaluation suite**: Token savings benchmark, directive retention test, memory degradation check

### Fixed (pre-release)

- `turnIndex` now increments once per turn, not once per message
- CJK token estimation corrected (was underestimating by ~3x)
- `fixupSuperseded()` now scoped by key to prevent cross-key corruption
