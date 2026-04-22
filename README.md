# oh-my-brain 🧠

**Your AI stops starting from zero.**

oh-my-brain gives Claude, Codex, Cursor, and other MCP tools a shared
`.brain/` that preserves your preferences, project state, handoffs, and
lessons learned.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

```text
.brain/
├── identity.md
├── coding.md
├── goals.md
├── domains/work.md
├── projects/my-app.md
├── skills/
└── episodes/
```

## The problem

Every AI coding tool gives you a fresh agent with amnesia.

You explain your standards, preferences, and project context.
The session ends.
The next agent starts from zero.

oh-my-brain fixes that by giving your tools a portable brain that lives
with your project.

## What happens when you use it

**Session 1:** You tell Claude "default to actionable review feedback,
not theory" and "write product docs with honest claims and clear
tradeoffs." oh-my-brain saves these to your brain.

**Session 2:** You're working on the same project in Codex. The agent
already knows your preferences, reads yesterday's handoff, and keeps
going without you re-explaining the project.

**Session 5:** You correct the agent: "run tests before committing." It
records the lesson. Repeated corrections can later be promoted into a
more reusable skill or procedure.

**Session 20:** Your `.brain/` contains your identity, coding rules,
goals, concrete work/life context, project history, skills, and lessons
learned. New sessions start smarter than the last one.

## Why it's different

1. **Shared brain across tools.** Claude, Codex, Cursor, Windsurf, and
   MCP clients can all read the same memory.
2. **Importance-aware memory.** Not everything is remembered equally.
   L0 noise is discarded, L1 observations are compressible, L2
   preferences are promoted with confidence, and L3 directives are
   protected from forgetting. Low-confidence memories go into a review
   queue instead of being silently stored.
3. **Cross-session handoff.** `brain_handoff` records what happened,
   what was decided, and what comes next, so the next agent can continue
   instead of restarting from zero.
4. **Correction-driven skill growth.** Repeated corrections can be
   promoted into reusable skills and procedures.

## How it works

1. **`.brain/` is the source of truth.** Identity, coding rules, goals,
   concrete context files like work or life, projects, skills, and
   episodes live in structured markdown files you can inspect and edit.
2. **`MEMORY.md` is working memory.** It is auto-assembled each session.
   Stable content stays near the top; dynamic content changes with the
   current project and last handoff.
3. **Handoffs preserve continuity.** Session state is recorded so the
   next session can resume from decisions and next steps, not from a
   blank slate.
4. **Importance controls memory quality.** L0-L3 classification decides
   what gets dropped, compressed, promoted, or protected.
5. **Skills grow from corrections.** Correct once, it records the
   lesson. Correct repeatedly, it can promote that lesson into a more
   reusable skill or procedure.
6. **Review keeps memory trustworthy.** Low-confidence memories go into
   the candidate queue for approval.

Today, `.brain/` is the durable structure and `MEMORY.md` remains the
flat compatibility layer for tools that still expect a single file.

Core categories are intentionally concrete: `identity`, `coding`,
`goals`, `project`, and explicit context files like `work` or `life`.
If a new category is needed, prefer a specific name like `investing` or
`learning`, not an abstract bucket like `domain` or `context`.

## Install

```bash
npm install -g oh-my-brain
```

## Quick start

### Claude Code

Add this Stop hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "brain-compress"
      }]
    }]
  }
}
```

After each session, your brain grows and `MEMORY.md` updates.

To verify it worked, finish one Claude Code session, then check that
`MEMORY.md` changed or a new handoff / directive appeared in `.brain/`.

### Cursor / Windsurf / Claude Desktop

Point your MCP client at `brain-mcp`:

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

To verify it worked, connect the MCP server and call `brain_status` or
`brain_recall`. If they respond, the brain is live.

### Codex

```bash
brain-codex-sync --watch
```

To verify it worked, let Codex finish a session and confirm that
`MEMORY.md` or `.brain/` changed afterward.

## Benchmarks

Real numbers on real datasets.

Primary public benchmark: **89.4% (447/500)** on the full LongMemEval
oracle suite, evaluated with LongMemEval's official `evaluate_qa.py`
judge (`gpt-4o`).

Per-type breakdown:

- `single-session-assistant`: **100.0%** (`56/56`)
- `single-session-user`: **98.6%** (`69/70`)
- `knowledge-update`: **89.7%** (`70/78`)
- `temporal-reasoning`: **89.5%** (`119/133`)
- `multi-session`: **83.5%** (`111/133`)
- `single-session-preference`: **73.3%** (`22/30`)

Other checks:

- Directive retention (100+ turns): **100%**
- Cross-agent handoff: **6/6 pass**
- Context startup cost: **~49 tokens**

See [benchmark methodology](docs/real-session-replay-eval.md) and
[LongMemEval details](docs/longmemeval-500-oracle.md).

## FAQ

**Why not Claude's built-in memory?**  
Claude's memory is single-agent. Switch to Codex and it is gone.
oh-my-brain is portable: the brain lives with your project and can be
read by multiple tools.

**Why not Mem0 / Zep / Letta?**  
Those are memory stores. oh-my-brain is opinionated about importance,
handoff, review, and skill growth. Different category.

**Why not just commit `AGENTS.md`, `CLAUDE.md`, or `MEMORY.md` to the repo?**  
Many teams already have `AGENTS.md` or `CLAUDE.md`. That is a good start.
Those files tell an agent how to begin. oh-my-brain helps it not restart
from zero by adding dynamic memory, cross-session handoff, and updated
working context.

**Privacy?**  
Everything is local. No cloud, no API keys, no telemetry. You own your
data.

## MCP tools

### Core

| Tool | What it does |
|------|-------------|
| `brain_remember` | Save a directive or memory |
| `brain_recall` | Read current memory, episodes, and skills |
| `brain_handoff` | Record session state for the next session |
| `brain_candidates` | Review pending memories |

### Maintenance

| Tool | What it does |
|------|-------------|
| `brain_status` | Counts and health info |
| `brain_audit` | Brain health report |
| `brain_refresh` | Reassemble `MEMORY.md` from `.brain/` |
| `brain_retire` | Archive a stale directive |
| `brain_search` | Search archived history by date or keyword |

### Portability

| Tool | What it does |
|------|-------------|
| `brain_migrate` | Convert existing `MEMORY.md` into `.brain/` |
| `brain_export` / `brain_import` | Portable backup and restore |
| `brain_projects` | List projects with status and last handoff |
| `brain_skills` | List auto-generated skills |

## Storage model

oh-my-brain uses PGLite (embedded PostgreSQL) for the knowledge graph.
Zero setup, zero Docker. The `.brain/` directory is plain markdown on
top: human-readable, git-friendly, and portable.

## Development

```bash
npm test           # watch mode
npm run test:run   # single run
npm run verify     # lint + tests + build + pack
```

## Learn more

- [Why Memory Candidates](docs/why-memory-candidates.md)
- [Cross-agent handoff demo](docs/cross-agent-demo.md)
- [What oh-my-brain can and can't control](docs/context-structure-and-intervention.md)
- [Why personal world models matter](docs/why-personal-world-model.md)

## License

Apache-2.0. See [LICENSE](LICENSE).

For commercial licensing inquiries, contact: hs.ze.lab@gmail.com
