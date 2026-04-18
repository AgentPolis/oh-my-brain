# oh-my-brain 🧠

**Your AI grows a `.brain/` — a second brain that understands who you are, remembers what you're working on, and gets smarter the more you use it.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

```
.brain/
├── identity.md        ← who you are (stable across everything)
├── goals.md           ← where you're headed
├── domains/work.md    ← your work persona + standards
├── projects/my-app.md ← progress + handoff log
├── skills/            ← auto-generated from corrections & patterns
└── episodes/          ← lessons learned (searchable)
```

Every AI coding tool gives you a fresh agent with amnesia. You explain
your preferences, your project context, your standards — then the session
ends and it all disappears.

oh-my-brain fixes that. It gives your AI a brain that persists.

## What happens when you use it

**Session 1:** You tell Claude "always use Chinese for reviews" and "never
attack competitors in docs." oh-my-brain saves these to `.brain/identity.md`.

**Session 2:** You're working on oh-my-brain. The agent already knows your
preferences, sees yesterday's handoff note, and picks up where you left off.

**Session 5:** You correct the agent: "run tests before committing." It
records the lesson. You correct it again on the same thing. oh-my-brain
generates a permanent skill file. The agent never makes that mistake again.

**Session 20:** Your `.brain/` has your identity, your goals, your work
standards, project history, 12 skills, and 30 lessons learned. Every new
session starts smarter than the last.

## How it works

1. **`.brain/` is the source of truth.** Five layers: identity, goals,
   life domains, projects, episodes. Structured markdown you can read
   and edit.

2. **`MEMORY.md` is working memory.** Auto-assembled each session.
   Stable content (who you are) at the top for KV cache. Dynamic
   content (current project + last handoff) changes per session.

3. **Skills grow from corrections.** Correct once, it records the lesson.
   Correct twice, it generates a skill file. Complete a complex task,
   it captures the procedure. Inspired by
   [Hermes Agent](https://github.com/nousresearch/hermes-agent)'s
   self-evolution, but triggered by corrections, not just completions.

4. **Cross-session handoff.** `brain_handoff` records what happened,
   what was decided, what's next. No more re-explaining context.

5. **You approve what gets kept.** Low-confidence memories go to a
   review queue. Nothing is silently stored.

Works across Claude Code, Codex, Cursor, Windsurf, and anything that speaks MCP.

## Install

```bash
npm install -g oh-my-brain
```

## Quick start

### Claude Code (Stop hook)

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

Add to `~/.claude/settings.json`. After every session, your `.brain/`
grows and `MEMORY.md` updates.

### Cursor / Windsurf / Claude Desktop (MCP)

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

### Codex

```bash
brain-codex-sync --watch
```

## MCP tools

| Tool | What it does |
|------|-------------|
| `brain_remember` | Save a directive (auto-routes to identity/domain/project) |
| `brain_recall` | Read memory + search episodes and skills |
| `brain_handoff` | Record session state for the next session |
| `brain_projects` | List projects with status and last handoff |
| `brain_skills` | List auto-generated skills |
| `brain_candidates` | Review pending memories (approve/reject) |
| `brain_migrate` | Convert existing MEMORY.md into `.brain/` |
| `brain_audit` | Brain health report |
| `brain_export` / `brain_import` | Portable backup |
| `brain_search` | Search archived history by date or keyword |
| `brain_refresh` | Reassemble MEMORY.md from `.brain/` |
| `brain_retire` | Archive a stale directive |
| `brain_status` | Counts and health info |

## Benchmarks

Real numbers on real datasets.

| Benchmark | Score |
|-----------|-------|
| LongMemEval 50q temporal | **92%** (46/50) |
| LongMemEval 500q official | **67.6%** (338/500) |
| Directive retention (100+ turns) | **100%** |
| Cross-agent handoff | **6/6 pass** |
| Context startup cost | **~49 tokens** |

See [benchmark methodology](docs/real-session-replay-eval.md) and
[LongMemEval details](docs/longmemeval-500-oracle.md).

## FAQ

**Why not Claude's built-in memory?**
Single-agent. Switch to Codex, it's gone. oh-my-brain is portable —
`.brain/` lives with your project and every tool reads it.

**Why not Mem0 / Zep / Letta?**
Those are memory stores. oh-my-brain is a brain — it classifies what
matters, grows skills from corrections, and hands off context across
sessions. Different category.

**Privacy?**
Everything local. No cloud, no API keys, no telemetry. `.brain/` is
gitignored by default. You own your data.

## Architecture

oh-my-brain uses PGLite (embedded PostgreSQL) for the knowledge graph.
Zero setup, zero Docker. The `.brain/` directory is plain markdown on
top — human-readable, git-friendly, portable.

```bash
npm test           # watch mode
npm run test:run   # single run (755 tests)
npm run verify     # lint + tests + build + pack
```

## License

Apache-2.0. See [LICENSE](LICENSE).

## Learn more

- [Why Memory Candidates](docs/why-memory-candidates.md) — the origin story
- [Cross-agent handoff demo](docs/cross-agent-demo.md)
- [What oh-my-brain can and can't control](docs/context-structure-and-intervention.md)
