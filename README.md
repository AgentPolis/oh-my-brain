# oh-my-brain 🧠

**Your personal world model that every AI agent grounds itself in.**

oh-my-brain is the personal version of what Palantir Foundry is for
enterprises: a typed, living model of how you work — your rules, your
preferences, your domain knowledge — that AI agents read from and write
back to. Not a memory layer. Not a vector store. A **world model** built
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
- **L1 Observation** — Regular messages and tool results. Compressed as
  they age out of the fresh tail.
- **L2 Preference** — Explicit statements like "I prefer tabs" or
  "我比較喜歡 TypeScript". Promoted with confidence scores.
- **L3 Directive** — Your "always" and "never" rules. **Never compressed.
  Never summarized. Never forgotten.**
- **Memory Candidates** — The soft signals: corrections, complaints,
  implicit preferences. They land in a review queue you curate, not the
  bit bucket.

When you switch from Claude Code to Codex to Cursor, all of the above
travel with you via a portable `MEMORY.md` file plus an MCP server.

## How it's different

|                          | Other memory layers         | oh-my-brain                                        |
| ------------------------ | --------------------------- | -------------------------------------------------- |
| Mental model             | Bag of strings              | Typed personal world model (a la Palantir ontology) |
| Storage                  | Store everything equally    | Classify by importance, protect what matters       |
| Soft signals             | Ignored unless you say "always" | Captured as Memory Candidates for review       |
| Schema                   | Fixed (or none)             | **Self-growing** — system proposes new types as your patterns emerge |
| Forgotten rules          | Possible                    | Impossible (L3 immortality)                        |
| Mutations                | Untracked string edits      | Typed Actions with full provenance + undo         |
| Cross-agent              | Sometimes                   | Native via MCP + portable `MEMORY.md`              |
| Trust model              | Black box                   | Plain text `MEMORY.md` you can inspect, edit, commit |
| Origin                   | Built from spec             | Built from real-use frustration                    |

See [`docs/why-personal-world-model.md`](docs/why-personal-world-model.md)
for the full positioning — why a personal Palantir matters in 2026, and
how the self-growing ontology works.

## Installation

```bash
npm install -g oh-my-brain
```

After install, you get these binaries:

```bash
oh-my-brain        # umbrella command (learn this one first)
brain-compress     # Claude Code Stop hook
brain-codex-sync   # Codex session watcher
brain-candidates   # Memory Candidates review queue
brain-audit        # human-readable markdown audit
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

The client gets five tools:

- `brain_remember` — write a new L3 directive
- `brain_recall` — read all active directives
- `brain_candidates` — list, add, approve, or reject Memory Candidates
- `brain_retire` — move a stale directive into the archive section
- `brain_status` — counts and health info

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

We're making this section deliberately narrow because our previous
numbers were over-confident.

### What we measure

| Scenario                                              | Result               | Caveat                  |
| ----------------------------------------------------- | -------------------- | ----------------------- |
| Real Claude Code session replay (research-heavy)      | **74.1% — 82.1%** char reduction | Heuristic: chars ÷ 4 estimates tokens; not provider billing |
| Real Claude Code session replay (workspace scanning)  | **30.7%** char reduction | Session-shape dependent |
| Directive retention after 100+ turns of mixed content | **100%** (10 of 10)  | Deterministic eval; in-memory classifier |
| Cross-agent handoff (6-scenario integration test)     | **6 of 6 pass**      | See [cross-agent-handoff.test.ts](test/cross-agent-handoff.test.ts) |

Reproduce these locally with:

```bash
npm run test:run -- eval/
npm run test:run -- cross-agent-handoff
npm run test:run -- directive-retention
```

### What we don't measure yet

- **Provider-side billing savings.** We estimate tokens as `chars ÷ 4`.
  Real savings depend on model, tokenizer, and session shape.
- **Quality impact in live work.** We have no live telemetry yet, only
  eval suites and replays. If you want to help run a trial, open an issue.

See [`docs/real-session-replay-eval.md`](docs/real-session-replay-eval.md)
for the full replay methodology and
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
lives in your project directory. The SQLite store lives in `.squeeze/`
(gitignored by default; kept at that path for backward compatibility).
You can inspect, edit, commit, or delete any of it.

### Is the L3 classifier safe against prompt injection?

MEMORY.md is a trust boundary. If a malicious document in your workspace
gets classified as an L3 directive, it will be protected forever. We
recommend:

1. Treat `MEMORY.md` as code — review it in PRs
2. Use `brain-candidates` review queue for anything uncertain
3. Run `brain-audit` regularly to inspect recent memory writes

## v0.2 status

**Phase 1: credibility pass — shipped**

- [x] Importance-aware classification (L0–L3)
- [x] Memory Candidates review queue (`brain-candidates`)
- [x] MEMORY.md write lock (cross-process safe)
- [x] `brain-candidates retire` for superseding stale directives
- [x] L2 preferences wired into ingest
- [x] Cross-agent handoff integration test
- [x] MCP server (`brain-mcp`)
- [x] Full rename from `squeeze-claw` to `oh-my-brain`

**Phase 2: launch prep — in progress**

- [ ] Live trial telemetry
- [ ] LLM-backed classifier for ambiguous cases
- [ ] Repetition-based L2 promotion
- [ ] Landing page at ohmybrain.dev

See [`TODOS.md`](TODOS.md) for the full roadmap.

## Running tests

```bash
npm test           # watch mode
npm run test:run   # single run
npm run verify     # lint + tests + build + pack dry-run
```

## Runtime requirements

- Node.js 20 – 25 (recommended: Node 22 LTS)
- If `better-sqlite3` was built under a different Node version:

```bash
npm rebuild better-sqlite3
```

## License

Apache-2.0. See [LICENSE](LICENSE).

For commercial licensing inquiries, contact: hs.ze.lab@gmail.com

## See also

- [`docs/why-memory-candidates.md`](docs/why-memory-candidates.md) — the origin story for the core insight
- [`docs/cross-agent-demo.md`](docs/cross-agent-demo.md) — reproducible handoff demo
- [`docs/context-structure-and-intervention.md`](docs/context-structure-and-intervention.md) — honest scope of what oh-my-brain controls
- [`docs/real-session-replay-eval.md`](docs/real-session-replay-eval.md) — benchmark methodology
