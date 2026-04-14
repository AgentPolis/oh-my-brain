# Changelog

## [0.5.0] - 2026-04-14

**Cognitive memory upgrade: events, viewpoints, habits, and sentiment.**
This release adds structured episodic memory extraction on top of the
archive model from v0.4.0. User messages now produce searchable events
with time precision, people, categories, sentiment, and source
provenance; `brain_search` retrieves those events first; `brain_recall`
surfaces them in summary mode; and recurring patterns become reviewable
habit candidates.

### Added

- Append-only event store at `.squeeze/events.jsonl` with time/category/
  person search and compact timeline rendering.
- Heuristic event extractor for user messages, including relative-date
  resolution, best-effort people/place capture, Chinese patterns,
  viewpoint extraction, and standalone sentiment capture.
- Habit detector with persisted `.squeeze/habits.json` storage and
  `HABIT:` candidate generation from repeated event patterns.
- `brain_search` filters for `who` and `category`, plus event-first
  retrieval output with compact emoji-tagged summaries.

### Changed

- Claude Code compression now extracts events before archival,
  dedupes repeated session reprocessing by source message, and scans
  event history for new habits.
- `brain_recall` summary mode now includes recent events and event
  category breakdowns.
- `brain_status` now reports `events_total`, `events_categories`,
  `habits_detected`, and `viewpoints_captured`.
- CLI / MCP / package version strings bumped to `0.5.0`.

### Docs

- README now documents structured events, viewpoints, habits, and the
  cognitive memory model positioning.

## [0.4.0] - 2026-04-14

**Memory architecture v2: compression is archival, not deletion.**
This release adds a lossless archive for compressed L1 history, a day-level
timeline index, best-effort bitemporal timestamps for durable facts, and a
new `brain_search` retrieval path so agents can look up exact dates and full
conversation details on demand without increasing startup context cost.

### Added

- Append-only archive store at `.squeeze/archive.jsonl` for compressed L1
  observations, including full original text, summaries, timestamps, session
  provenance, and keyword tags.
- Day-level timeline index at `.squeeze/timeline.json` with compact topic
  previews for summary-mode recall.
- `brain_search` MCP tool for archive retrieval by exact date, date range,
  relative date (`last week`, `last month`), or keyword.
- Archive-aware `brain_status` fields: `archive_entries`,
  `archive_date_range`, and `archive_size_kb`.

### Changed

- Directive and preference storage now tracks best-effort `event_time`
  separately from ingest time (`created_at`), with backward-compatible
  migration for existing SQLite data.
- `brain_recall` summary mode now advertises archived history and recent
  timeline topics while staying compact.
- The Claude Code compress hook now archives compressed L1 observations,
  dedupes repeated session retries, and rebuilds the timeline automatically.
- CLI / MCP / package version strings bumped to `0.4.0`.

### Docs

- README now documents the lossless archive model, temporal lookup via
  `brain_search`, and the updated tool surface.

## [0.3.1] - 2026-04-13

**Hermes-style auto-learning, lazy recall, and Decision Replay.**
This release adds confidence-based auto-learning, guarded memory writes,
lazy-loading recall, and a zero-API-key decision benchmark while keeping
the review queue and portable `MEMORY.md` contract intact.

### Added

- `brain_recall` now appends an agent instruction block that points MCP
  clients at `brain_remember` and `brain_candidates`.
- Heuristic injection / exfiltration guard for directive writes and
  candidate ingestion, with append-only blocked-event audit log at
  `.squeeze/guard-blocked.jsonl`.
- Auto-consolidation proposals: mergeable directives are suggested as
  `MERGE:` Memory Candidates once the active rule set grows past 15.
- `brain_status` now surfaces guard totals, pending merge proposals,
  last ontology scan timestamp, health state, and token-budget stats.
- Directive evidence / provenance tracking in SQLite with optional
  `brain_recall` evidence output.
- `brain_recall` lazy-loading modes: `summary` (default), `all`, and
  `type`, plus contradiction warnings from approved `brain_links`.
- Decision Replay eval (`oh-my-brain eval`) with editable scenario pool
  under `eval/decision-replay/scenarios/`.
- `brain_quiz` MCP tool for in-conversation self-tests using the same
  Decision Replay scenarios.
- `oh-my-brain import` to bootstrap rules from `.cursorrules`,
  `.clinerules`, `CLAUDE.md`, `.github/copilot-instructions.md`, and
  `.windsurfrules`.
- `oh-my-brain init` onboarding scan for AI rule files plus project
  config (`package.json`, `tsconfig.json`) with non-interactive `--yes`.

### Changed

- `brain_recall` now defaults to summary mode instead of returning the
  full directive list; use `mode=all` for the v0.3.0 behavior.
- Ontology scans now stamp `.squeeze/last-scan.json` on each run.
- Directive metadata now tracks `evidence_text`, `evidence_turn`, and
  `last_referenced_at` in SQLite.
- CLI / MCP version strings bumped to `0.3.1`.

### Docs

- README updated with auto-learning, Decision Replay, lazy-startup
  positioning, and the injection-guard FAQ note.
- `TODOS.md` now marks Hermes-style auto-learning + Decision Replay as
  shipped.

## [0.3.0] - 2026-04-08

**Repositioning to a personal world model + the L1/L2/L3 self-growing
ontology that makes it real.** This release reframes oh-my-brain as
the personal version of what Palantir Foundry is for enterprises (a
typed, queryable, mutable model that AI agents ground themselves in)
and ships the three load-bearing primitives that turn the description
into a working product:

1. **Typed Actions** with full provenance + undo
2. **Self-growing Directive Types** (L2 ontology growth)
3. **Self-growing Directive Links** (L3 ontology growth — typed
   relations between directives)

Inspired by Palantir Foundry's Object/Action/Link model and Jack
Dorsey's "[From Hierarchy to Intelligence](https://block.xyz/inside/from-hierarchy-to-intelligence)"
essay (March 2026, used to back Block's 4,000-person restructuring).
Both made "world model" the new operational vocabulary; this release
makes it real for individuals.

See [`docs/why-personal-world-model.md`](docs/why-personal-world-model.md)
for the full positioning essay.

### Added

#### Phase 4a/4b — Repositioning

- **README rewrite** with new hero ("Your personal world model that
  every AI agent grounds itself in") and new comparison table that
  highlights what's actually load-bearing: typed mental model, soft
  signal capture, self-growing schema, typed mutations with provenance.
- **`docs/why-personal-world-model.md`** — the launch essay. Three
  things that happened in early 2026 (Palantir ontology, Dorsey
  hierarchy essay, world model wave). Mapping from Palantir primitives
  to oh-my-brain primitives. Self-growing ontology on three levels.
  Where this lands vs Memorix/Mem0/Notion AI/Claude memory.

#### Phase 4c — Typed Actions + provenance + undo

- **`cli/actions.ts`** (~700 lines) — the load-bearing primitive that
  turns oh-my-brain from a "memory layer" into an ontology in the
  Palantir sense. Every mutation to MEMORY.md now goes through a typed
  Action with full provenance and is logged at `.squeeze/actions.jsonl`.
- **Action kinds** (v0.3 baseline): RememberDirective, PromoteCandidate,
  RejectCandidate, RetireDirective, plus UndoAction (which logs reversals
  so future undos skip already-undone actions).
- **`undoLastAction(ctx)`** — walks the action log backward to find
  the latest non-undone mutation, applies its inverse, and logs the
  undo itself for traceability.
- **`whyDirective(projectRoot, text)`** — substring search across the
  action log; returns the chain of actions that produced (or affected)
  a given directive in chronological order. The "why do you remember
  this about me" query is now first-class.
- **CLI**: `brain-candidates undo`, `brain-candidates why "<text>"`,
  `brain-candidates log [--limit N]`. All of approve/reject/retire
  now route through Action constructors so they're logged automatically
  with no behavioral change for users.
- **MCP**: two new tools — `brain_undo_last` and `brain_why`. Bumped
  protocol server version to 0.3.0.
- **Tests**: 20 new in `test/actions.test.ts` covering every action
  kind, the undo flow, the "skip already-undone" guarantee, the
  why-directive search, and corrupted-log tolerance.

#### Phase 4d — Self-growing Directive Types (L2 ontology growth)

- **`cli/types-store.ts`** (~430 lines) — typed memory categories with
  a self-growth mechanism. The user noted in the v0.3 design discussion
  that they had previously defined "memory by topic domain" — this is
  exactly that idea, with a self-growth path so the schema is never
  frozen.
- **Five built-in seed types**: `CodingPreference`, `ToolBan`,
  `CommunicationStyle`, `ProjectFact`, `PersonContact`. Each has its
  own regex pattern set for classification.
- **`detectEmergingClusters(directives, threshold=3)`** — bag-of-words
  cluster detection over uncategorized directives. English + Chinese
  stopword filtering. Requires 3+ directives sharing a non-trivial
  keyword before proposing a new type.
- **`scanForTypeCandidates(projectRoot, directiveBodies)`** — the L2
  self-growth tick called from the compress hook AND from every
  directive write via `runOntologyScan` in actions.ts (so MCP-driven
  writes from Cursor / Windsurf get the same evolution as Claude Code
  hook writes).
- **Action kinds**: ApproveType, RejectType. Both reversible via undo
  (Approve restores the prior user-types file AND brings the candidate
  back to pending).
- **CLI**: `brain-candidates types`, `list-types`, `approve-type`,
  `reject-type`. New types append to `.squeeze/types.json` and start
  classifying directives immediately.
- **MCP**: new `brain_types` tool with sub-actions list / classify /
  list_candidates / approve / reject.
- **Tests**: 19 new in `test/types-store.test.ts` covering classifier
  hits for all five built-ins, cluster detection threshold + stopword
  filtering, ingest dedup, end-to-end scan, action wrappers, and
  approve+undo restoring both files.

#### Phase 4e — Self-growing Directive Links (L3 ontology growth)

- **`cli/links-store.ts`** (~470 lines) — typed relations between
  directives, with a self-growth mechanism. Real personal rules form
  a graph: one directive supersedes another, refines it, contradicts
  it, or scopes to a project context.
- **Four link kinds**: `supersedes` (A replaces B), `refines` (A adds
  detail to B), `contradicts` (A and B in tension; agent should flag
  on read), `scopedTo` (A only applies inside B's context).
- **`detectLinkProposals(directives, similarityThreshold=0.25)`** —
  pairwise heuristic over the directive list. Combines Jaccard
  token similarity with negation/scope marker detection. Order-aware
  (newer directives can supersede older ones, never vice versa).
- **`scanForLinkCandidates(projectRoot, directiveBodies)`** — the L3
  self-growth tick called from the compress hook AND from action
  writes.
- **Action kinds**: ApproveLink, RejectLink. Both reversible via undo
  (Approve restores the prior links file AND brings the candidate
  back to pending).
- **CLI**: `brain-candidates links`, `list-links`, `approve-link`,
  `reject-link`. Approving via `--as supersedes|refines|contradicts|scopedTo`
  overrides the proposed kind.
- **MCP**: new `brain_links` tool with sub-actions list /
  list_candidates / approve / reject.
- **Tests**: 16 new in `test/links-store.test.ts` covering each
  link kind detection, threshold suppression, ingest dedup, end-to-end
  scan, action wrappers, and approve+undo restoring both files.

### Changed

- **`brain_status`** now reports `actions_total` and an
  `actions_by_kind` breakdown so the action log is observable from
  any agent.
- **MCP server version** bumped from 0.2.0 → 0.3.0.
- **Hook integration** (`cli/compress-core.ts`) — every Claude Code
  Stop run now scans for both type candidates AND link candidates
  in addition to directive candidates. The same scan runs after every
  MCP-driven directive write via `runOntologyScan` in actions.ts.
- **Scope marker list** in links-store tightened: removed "for" and
  "when" because they were producing false-positive `scopedTo`
  proposals on common directive phrasings. Markers must now be
  longer phrases like "in typescript projects", "only when",
  "scoped to", "in the context of".

### Tests

- **307 / 307 passing** across 26 test files (up from 252 / 252 in v0.2).
- New test files: `test/actions.test.ts`, `test/types-store.test.ts`,
  `test/links-store.test.ts`. 55 new tests total.
- All Phase 4 work was test-first or test-coupled — every action kind,
  every candidate flow, every undo path, every false-positive guard
  has explicit coverage.

### Files added in Phase 4

```
cli/actions.ts              700 lines
cli/types-store.ts          430 lines
cli/links-store.ts          470 lines
docs/why-personal-world-model.md
test/actions.test.ts         20 tests
test/types-store.test.ts     19 tests
test/links-store.test.ts     16 tests
```

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
