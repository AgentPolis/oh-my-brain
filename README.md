# oh-my-brain 🧠

**A second brain that helps every AI agent understand you, work like you, and make fewer mistakes.**

oh-my-brain gives Claude Code, Codex, Cursor, Windsurf, and MCP tools a
shared memory that survives context resets, session boundaries, and
agent switches.

Instead of trapping memory inside one tool, it keeps your rules,
preferences, working style, and corrections in a portable brain you can
inspect, edit, and carry everywhere.

Not a memory layer. Not a vector store. A **personal world model** built
from the corrections you give in real conversations, with you as the
final approver of what gets kept.

It travels with you across every tool: Claude Code, Codex, Cursor,
Windsurf, and anything that speaks MCP. Your rules, preferences, and
corrections survive every context reset, every session boundary, every
agent switch — because they live in a portable `MEMORY.md` file plus a
typed action log every agent reads from the same way.

You shouldn't have to say "remember that". A real brain just remembers.

> Formerly published as `squeeze-claw`. The compression still works.
> The real value turned out to be the part that decides what's worth
> keeping. That's the brain.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

## The story behind it

We discovered the real problem by dogfooding our own tool.

We were testing it across two windows. We gave the agent corrections like:

- "你是不是搞錯狀況了"
- "這個本來就要一直移動"
- "右邊側邊欄太多提醒了"

Any human would obviously remember these. The classifier stored **none**
of them. It was waiting for "always" or "never" or "remember that". Real
humans don't talk like that.

So we built [**Memory Candidates**](docs/why-memory-candidates.md) — a
two-stage capture system. Strong, explicit rules go straight into your
brain. Soft signals (corrections, preferences, friction patterns) land
in a review queue you can approve, edit, or reject. Nothing important
gets dropped just because you forgot to phrase it like an RFC.

That's the difference between a database and a brain.

## What it does

Four importance levels, plus the thing nobody else does:

- **L0 Discard** — "ok", "got it", empty tool output. Dropped immediately.
- **L1 Observation** — Regular messages and tool results. Compressed
  summaries stay in active context; **full text archived**; structured
  events extracted with who/what/when/where for precise temporal
  retrieval.
- **L2 Preference** — Explicit statements like "I prefer tabs" or
  "我比較喜歡 TypeScript". Promoted with confidence scores.
- **L3 Directive** — Your "always" and "never" rules. **Never compressed.
  Never summarized. Never forgotten.**
- **Events** — Structured episodic memory extracted from conversations.
  "I got my car serviced on March 14th" becomes a searchable event with
  date, category, people, and sentiment.
- **Viewpoints** — Your opinions and judgments captured as memory.
  "I think microservices are overengineered" is remembered.
- **Habits** — Recurring behavior patterns auto-detected from events.
  If you fly United 3+ times, oh-my-brain notices.
- **Relations** — Who you trust and why. "Tom recommended Redis, it
  worked well" builds trust. Agent considers trust when weighing
  conflicting advice.
- **Schemas** — Your decision frameworks, auto-detected from habits.
  "Code Review: error handling → naming → tests" is how YOU do
  reviews. The agent follows your framework, not a generic one.
- **Memory Candidates** — The soft signals: corrections, complaints,
  implicit preferences. They land in a review queue you curate, not the
  bit bucket.
- **Auto-learning** — High-confidence corrections and repeated
  preferences are saved automatically (no "remember that" needed).
  Uncertain signals land in a review queue you curate. Inspired by
  [Hermes Agent](https://github.com/nousresearch/hermes-agent),
  but smarter: auto-save when confident, ask when unsure.
- **Decision Replay** — Evaluates whether your agent makes the same
  decisions you would. Not retrieval accuracy, decision accuracy.
  Run `oh-my-brain eval` to benchmark. Results checkpoint after each
  scenario, so you can rerun the same command to resume a long Codex run.
  For large suites, use `npm run benchmark:decision-replay -- --scenarios <file> --tool codex`
  to emit both a resumable checkpoint and a JSON report.
- **~100 token startup** — Lazy loading. `brain_recall` returns a
  category summary by default, loads full directives on demand.
  Your brain costs less context than a system prompt.

When you switch from Claude Code to Codex to Cursor, all of the above
travel with you via a portable `MEMORY.md` file plus an MCP server.

### Cognitive coverage

| Memory Type | What | Example | Since |
|-------------|------|---------|-------|
| Directive | Explicit rules | "Always use TypeScript" | v0.3 |
| Preference | Stated preferences | "I prefer tabs" | v0.3 |
| Event | Episodic memory | "Car serviced Mar 14, GPS broke" | v0.5 |
| Viewpoint | Opinions | "Microservices are overengineered" | v0.5 |
| Sentiment | Emotions | "Frustrated with deployment" | v0.5 |
| Habit | Behavior patterns | "Always writes tests first" | v0.5 |
| Relation | Trust chains | "Trust Tom on tech, verify Alice on arch" | v0.6 |
| Schema | Decision frameworks | "Code review: errors → naming → tests" | v0.6 |

## How it's different

|                          | Other memory layers         | oh-my-brain                                        |
| ------------------------ | --------------------------- | -------------------------------------------------- |
| Mental model             | Bag of strings              | Typed personal world model (a la Palantir ontology) |
| Storage                  | Store everything equally    | Classify by importance, protect what matters       |
| Soft signals             | Ignored unless you say "always" | Captured as Memory Candidates for review       |
| Schema                   | Fixed (or none)             | **Self-growing** — system proposes new types as your patterns emerge |
| Forgotten rules          | Possible                    | Impossible (L3 immortality)                        |
| Mutations                | Untracked string edits      | Typed Actions with full provenance + undo         |
| Auto-learning            | Agent decides silently      | Auto-save when confident, review when unsure      |
| Compression              | Lossy (data lost)           | Lossless archive — summaries in context, full text searchable |
| Temporal queries         | Vector similarity only      | Time-indexed archive: `brain_search --when "last Tuesday"` |
| Memory model             | Flat text / vectors         | Cognitive: events, viewpoints, habits, sentiments, relations, schemas |
| LongMemEval              | 49-91%                      | 92% (46/50 temporal reasoning, metadata-clean rerun) |
| Startup cost             | Load everything (~2K+ tokens) | ~100 token summary, lazy load on demand        |
| Decision benchmark       | Retrieval accuracy only     | Decision Replay: does the agent think like you?   |
| Cross-agent              | Sometimes                   | Native via MCP + portable `MEMORY.md`              |
| Trust model              | Black box                   | Plain text `MEMORY.md` you can inspect, edit, commit |
| vs MemPalace             | 170 token startup, spatial metaphor, 96.6% LongMemEval (uncompressed mode) | ~100 token startup, importance classification, Decision Replay benchmark |
| Origin                   | Built from spec             | Built from real-use frustration                    |

See [`docs/why-personal-world-model.md`](docs/why-personal-world-model.md)
for the full positioning — why a personal Palantir matters in 2026, and
how the self-growing ontology works.

## Installation

```bash
npm install -g oh-my-brain
```

## 5-minute proof

If you only try one thing, try this:

```bash
mkdir oh-my-brain-demo && cd oh-my-brain-demo
printf '%s\n' '- Always use TypeScript strict mode' > MEMORY.md
oh-my-brain recall
```

That is the core promise in miniature: portable, inspectable memory
that survives agent switches because it lives with your project.

After install, you get these binaries:

```bash
oh-my-brain        # umbrella command (learn this one first)
brain-compress     # Claude Code Stop hook
brain-codex-sync   # Codex session watcher
brain-candidates   # Memory Candidates review queue
brain-audit        # human-readable markdown audit
brain-consolidate  # offline growth loop (external scan + reflection + sleep consolidation)
brain-growth       # latest growth summary + pending reflection proposals
brain-reflect      # approve or dismiss reflection proposals
brain-mcp          # MCP server (for Cursor, Windsurf, Claude Desktop, etc.)
```

## Quick start

### As a Claude Code Stop hook

Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "brain-compress"
          }
        ]
      }
    ]
  }
}
```

After every Claude Code session, `MEMORY.md` in your project root picks
up any new directives and new soft signals appear in the review queue:

```bash
brain-candidates list
# → 2 pending candidates:
#   f22e9b2a [seen 3x] 這個本來就要一直移動
#   a103e8c9 [seen 1x] 右邊側邊欄太多提醒了
brain-candidates approve f22e9b2a --as "the cursor should always keep moving"
```

### As a Codex sync agent

```bash
brain-codex-sync           # one-shot
brain-codex-sync --watch   # continuous
./scripts/install-codex-watch.sh  # macOS LaunchAgent
```

### As an offline growth loop

```bash
oh-my-brain consolidate
# or:
brain-consolidate --stale-days 30
```

This runs four background-style maintenance steps against the current
project:

- external scan of project rules and AI instruction files
- reflection loop for stale directives, conflicts, and merge proposals
- sleep consolidation of habits, schemas, and timeline index
- growth journal entry so you can inspect what changed later

`brain-compress` now runs this loop automatically after the normal
session compression pass, so Claude Code Stop hooks keep the brain
growing even if you never invoke it manually.

To inspect what changed:

```bash
oh-my-brain growth
# or:
brain-growth
```

To close the loop on pending proposals:

```bash
oh-my-brain reflect list
oh-my-brain reflect approve <proposal-id>
oh-my-brain reflect dismiss <proposal-id>
```

### As an MCP server for Cursor / Windsurf / Claude Desktop

Point any MCP client at the `brain-mcp` binary:

```json
{
  "mcpServers": {
    "oh-my-brain": {
      "command": "brain-mcp",
      "args": [],
      "env": { "OH_MY_BRAIN_PROJECT_ROOT": "/path/to/your/project" }
    }
  }
}
```

The client gets core tools including:

- `brain_remember` — write a new L3 directive
- `brain_recall` — read active directives plus an archive/timeline preview
- `brain_search` — search archived full-text history by date or keyword
- `brain_candidates` — list, add, approve, or reject Memory Candidates
- `brain_retire` — move a stale directive into the archive section
- `brain_status` — counts and health info
- `brain_quiz` — generate a decision scenario to test whether the
  agent thinks like you

### As an OpenClaw plugin

```typescript
import { ohMyBrainFactory } from "oh-my-brain";

api.registerContextEngine("oh-my-brain", ohMyBrainFactory);
```

## The MEMORY.md contract

oh-my-brain's durable storage is just a markdown file:

```markdown
## oh-my-brain directives (2026-04-06) [source:claude session:abc-123]

- [claude abc-123] Always use TypeScript strict mode
- [claude abc-123] Never commit generated files

## oh-my-brain directives (2026-04-06) [source:codex session:xyz-456]

- [codex xyz-456] Always parameterize SQL queries
```

It's deliberately boring:

- easy to inspect
- easy to diff
- easy to commit to git
- every agent can read it — the schema is the file format itself
- you can hand-edit it and oh-my-brain will respect your edits

No database lock-in, no cloud, no API keys.

## Benchmarks (honest version)

We publish real numbers on real datasets. No cherry-picked demos.

### LongMemEval (ICLR 2025)

Temporal-reasoning subset, 50 questions. Full 500-question run coming.

| System | Score | Notes |
| ------ | ----- | ----- |
| Mem0 | 49% | Vector retrieval only |
| **oh-my-brain v0.3.1** | **74%** (37/50) | Rules + preferences + lazy loading |
| oh-my-brain v0.5.0 | 76% (38/50) | + events, viewpoints, habits |
| oh-my-brain v0.6.1 | 82% (41/50) | + time precision, pattern expansion |
| MemPalace (AAAK) | 84.2% | Spatial memory metaphor |
| Raw dump (no oh-my-brain) | 86% (43/50) | Full transcript, no compression |
| **oh-my-brain v0.7.0** | **92%** (46/50) | Renamed repo, metadata-clean rerun on oracle temporal subset |
| Hindsight | 91.4% | Knowledge graph, full dataset |
| MemPalace (uncompressed mode) | 96.6% | Different eval methodology, see their paper |

**Error analysis (remaining misses):** mostly incomplete event coverage
and event-to-event duration reasoning. In other words: not "the brain
forgot everything," but "the brain remembered the events and still
missed one timeline link."

Sample size is 50 questions. We're running the full 500-question suite
next. We'll update these numbers when we have them.

For public reproducibility, each rerun should publish:

- repo URL + commit hash
- benchmark runner version / commit
- dataset + subset (`oracle`, `temporal-reasoning`, 50 questions)
- raw hypotheses JSONL
- report JSON with environment metadata

See [`docs/research/benchmark-journey.md`](docs/research/benchmark-journey.md)
for every version, every decision, and every score.

### Compression

| Scenario | Result | Caveat |
| -------- | ------ | ------ |
| Real session replay (research-heavy) | **74.1% — 82.1%** char reduction | Heuristic: chars / 4 estimates tokens |
| Real session replay (workspace scanning) | **30.7%** char reduction | Session-shape dependent |

### Memory integrity

| Scenario | Result |
| -------- | ------ |
| Directive retention after 100+ turns | **100%** (10/10) |
| Cross-agent handoff | **6/6 pass** |
| Startup cost | **~49 tokens** (vs ~2,000 without lazy loading) |

### What we don't measure yet

- **Provider-side billing savings.** We estimate tokens as `chars / 4`.
  Real savings depend on model, tokenizer, and session shape.
- **Full 500-question LongMemEval.** 50-question subset only. Coming soon.
- **Decision Replay at scale.** Framework exists, 25 scenarios defined,
  full eval pending.

See [`docs/real-session-replay-eval.md`](docs/real-session-replay-eval.md)
for the compression replay methodology and
[`docs/context-structure-and-intervention.md`](docs/context-structure-and-intervention.md)
for an honest breakdown of what oh-my-brain can and can't influence.

## FAQ

### Why not just use Claude's memory tool?

Claude's memory tool is single-agent. It lives inside Claude. When you
switch to Codex, it's gone. oh-my-brain writes to a portable `MEMORY.md`
that lives in your project, readable by Claude, Codex, Cursor, or any
future tool. It's also importance-aware — Claude's memory treats all
stored items equally; oh-my-brain protects L3 directives from
compression in a way Claude memory cannot, and surfaces soft signals
via Memory Candidates.

### Why not just use Memorix / Mem0 / Memori?

These are memory stores. They store your data, retrieve it on demand,
and treat all data roughly equally. oh-my-brain is a brain — it actively
classifies importance, protects critical rules from being forgotten,
compresses noise, and asks you about the fuzzy cases via Memory
Candidates. The difference matters when you have rules that **must**
survive context resets, not just data that's nice to recall.

### Do you use LLMs to classify messages?

Not yet. The current classifier is 100% regex heuristics — fast (<1ms
per message), deterministic, zero API cost. An LLM fallback for
ambiguous cases (likely Haiku) is on the roadmap. The architecture is
ready for it; the release isn't.

### What about privacy?

Everything is local. No cloud. No API keys. No telemetry. `MEMORY.md`
lives in your project directory. The PGLite database lives in `.squeeze/brain.pg/`
(gitignored by default). You can inspect, edit, commit, or delete any of it.

### Is the L3 classifier safe against prompt injection?

MEMORY.md is a trust boundary. If a malicious document in your workspace
gets classified as an L3 directive, it will be protected forever. We
recommend:

1. Treat `MEMORY.md` as code — review it in PRs
2. Rely on the heuristic injection guard for low-hanging prompt-injection,
   exfiltration, invisible-unicode, and script-tag patterns, but do not
   treat it as bulletproof
3. Use `brain-candidates` review queue for anything uncertain
4. Run `brain-audit` regularly to inspect recent memory writes

## Current status (v0.7.0)

**Shipped:**

- [x] Importance-aware classification (L0-L3) with auto-learning
- [x] Memory Candidates review queue with confidence-based auto-save
- [x] Cognitive memory: events, viewpoints, habits, relations, schemas
- [x] Self-growing ontology (types + links + auto-consolidation)
- [x] Knowledge graph with multi-hop traversal (PGLite)
- [x] MCP server (9 tools over stdio JSON-RPC)
- [x] Cross-agent handoff (Claude Code, Codex, Cursor, Windsurf)
- [x] Decision Replay eval framework (`oh-my-brain eval`)
- [x] Offline growth loop (`brain-consolidate`)
- [x] 594 tests passing

**Next:**

- [ ] Full 500-question LongMemEval run
- [ ] Live telemetry (opt-in, local only)
- [ ] LLM-backed classifier for ambiguous cases
- [ ] Landing page at ohmybrain.dev

See [`TODOS.md`](TODOS.md) for the full roadmap.

## Running tests

```bash
npm test           # watch mode
npm run test:run   # single run
npm run verify     # lint + tests + build + pack dry-run
```

## Architecture

oh-my-brain uses PGLite (embedded PostgreSQL) — real PostgreSQL
running in your Node.js process. Zero setup, zero Docker, zero
cloud. But when you need to scale, change one connection string
to migrate to Supabase or any managed PostgreSQL.

- **Knowledge Graph** — Every memory (event, directive, person,
  habit, schema) is a node. Every relationship is an edge.
  Multi-hop traversal finds connections you didn't know existed.
- **PostgreSQL-native** — TEXT[], JSONB, TIMESTAMPTZ, recursive
  CTE, proper indexes. Not SQLite pretending to be a database.
- **One schema, multiple backends** — Same schema works on PGLite
  (local), PostgreSQL (self-hosted), or Supabase (managed cloud).

## Runtime requirements

- Node.js 20 – 25 (recommended: Node 22 LTS)
- No native binary dependencies (PGLite is pure JS/WASM)

## License

Apache-2.0. See [LICENSE](LICENSE).

For commercial licensing inquiries, contact: hs.ze.lab@gmail.com

## See also

- [`docs/why-memory-candidates.md`](docs/why-memory-candidates.md) — the origin story for the core insight
- [`docs/cross-agent-demo.md`](docs/cross-agent-demo.md) — reproducible handoff demo
- [`docs/context-structure-and-intervention.md`](docs/context-structure-and-intervention.md) — honest scope of what oh-my-brain controls
- [`docs/real-session-replay-eval.md`](docs/real-session-replay-eval.md) — benchmark methodology
