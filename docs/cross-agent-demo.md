# Cross-Agent Handoff Demo

This is the credibility artifact for oh-my-brain's core promise:
**your context, everywhere you work**. It proves end-to-end that a
directive written by one agent is visible to every other agent that
reads the same project brain.

## What this demo shows

1. Claude Code writes a rule via `brain-compress` → lands in `MEMORY.md`
2. Codex sync sees the same `MEMORY.md` → writes its own rules without
   clobbering Claude's
3. A third agent (Cursor, Windsurf, or anything MCP-compatible) connects
   via the oh-my-brain MCP server and recalls everything both agents wrote
4. The same agent adds a rule through MCP — the other two agents see it on
   their next run

No magic. No cloud. Just a shared `MEMORY.md` file plus a write lock plus
importance-aware classification.

## Prerequisites

```bash
git clone https://github.com/AgentPolis/oh-my-brain.git
cd oh-my-brain
npm install
npm run build
```

## Automated version (runs in CI)

The same flow is exercised by
[`test/cross-agent-handoff.test.ts`](../test/cross-agent-handoff.test.ts).
Run it with:

```bash
npm run test:run -- cross-agent-handoff
```

Expected output: 6 tests pass, 0 failures. Every test verifies one step
of the cross-agent story.

## Manual walkthrough

You can run each step by hand to see the MEMORY.md file grow between
agents. Use a scratch directory so you don't pollute a real project.

```bash
export BRAIN_DEMO=$(mktemp -d)
cd "$BRAIN_DEMO"
```

### Step 1 — Claude writes two directives

The compress hook normally runs from `~/.claude/settings.json` at session
end. We simulate it here by calling the core function directly:

```bash
node -e "
  import('$(pwd)/../dist/cli/compress-core.js').then(m => {
    m.appendDirectivesToMemory(
      ['Always use TypeScript strict mode', 'Never commit generated files'],
      '$BRAIN_DEMO/MEMORY.md',
      { source: 'claude', sessionId: 'demo-claude-1' }
    );
  });
"
cat MEMORY.md
```

You should see:

```markdown
## oh-my-brain directives (2026-04-06) [source:claude session:demo-claude-1]

- [claude demo-claude-1] Always use TypeScript strict mode
- [claude demo-claude-1] Never commit generated files
```

### Step 2 — Codex adds two more rules to the SAME file

```bash
node -e "
  import('$(pwd)/../dist/cli/compress-core.js').then(m => {
    m.appendDirectivesToMemory(
      ['Always parameterize SQL queries', 'Never expose internal errors'],
      '$BRAIN_DEMO/MEMORY.md',
      { source: 'codex', sessionId: 'demo-codex-1' }
    );
  });
"
cat MEMORY.md
```

Now there are two heading sections in `MEMORY.md` — one per source — and
four directives total. Neither writer clobbered the other.

### Step 3 — A third agent recalls everything via MCP

Simulate a Cursor / Windsurf connection by speaking JSON-RPC over stdio:

```bash
OH_MY_BRAIN_PROJECT_ROOT=$BRAIN_DEMO \
  node $(pwd)/../dist/cli/mcp-server.js <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"brain_recall","arguments":{}}}
RPC
```

The second response will contain all four directives. That's the proof
that the MCP server sees the same brain the compress hooks wrote to.

### Step 4 — The third agent adds its own directive

```bash
OH_MY_BRAIN_PROJECT_ROOT=$BRAIN_DEMO \
  node $(pwd)/../dist/cli/mcp-server.js <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"brain_remember","arguments":{"text":"Always keep functions under 30 lines","source":"cursor","session_id":"demo-cursor-1"}}}
RPC
cat MEMORY.md
```

Now all three agents have contributed. The next time Claude's compress
hook runs it will read the same `MEMORY.md` and see the Cursor entry.

### Step 5 — Dedup across sources

If Claude and Codex both independently write "Always use HTTPS", only the
first writer's version lands. The second write is a no-op:

```bash
# First writer — Claude
node -e "
  import('$(pwd)/../dist/cli/compress-core.js').then(m =>
    m.appendDirectivesToMemory(['Always use HTTPS'], '$BRAIN_DEMO/MEMORY.md', { source: 'claude' })
  );
"

# Second writer — Codex (same directive)
node -e "
  import('$(pwd)/../dist/cli/compress-core.js').then(m =>
    m.appendDirectivesToMemory(['Always use HTTPS'], '$BRAIN_DEMO/MEMORY.md', { source: 'codex' })
  );
"

grep -c "Always use HTTPS" MEMORY.md
# → 1 (present exactly once; Claude's provenance is preserved)
```

## What this demo does NOT prove

- **Live billing savings** — token-savings numbers in this repo come from
  session replays, not from provider billing telemetry.
- **Every MCP client works** — we test the JSON-RPC protocol shape. Any
  client that speaks MCP over stdio should work, but we haven't run
  end-to-end integration with every tool listed as "supported".

These are real caveats. The point of this demo is narrower and more
honest: **the brain survives across agents**. Everything else is details.

## Clean up

```bash
rm -rf "$BRAIN_DEMO"
unset BRAIN_DEMO
```

## See also

- [`test/cross-agent-handoff.test.ts`](../test/cross-agent-handoff.test.ts) — the CI version
- [`docs/why-memory-candidates.md`](./why-memory-candidates.md) — the origin story for the core insight
- [`docs/context-structure-and-intervention.md`](./context-structure-and-intervention.md) — honest scope of what oh-my-brain controls
