# Contributing to oh-my-brain

> Formerly `squeeze-claw`. The rename happened in v0.2 — see
> [CHANGELOG.md](CHANGELOG.md) for what changed and why.

## Contributor License Agreement (CLA)

By submitting a pull request, you agree to the terms of our [CLA](CLA.md). Please sign off your commits:

```bash
git commit --signoff -m "your commit message"
```

## Setup

```bash
git clone https://github.com/AgentPolis/oh-my-brain.git
cd oh-my-brain
npm install
npm run test:run  # full suite should pass
```

oh-my-brain v0.7 uses PGLite, so there are no native database bindings
to rebuild. If setup fails, first verify you're on Node 20-25 and try:

```bash
npm run verify
```

## Development

- `npm test` — watch mode, re-runs on file changes
- `npm run test:run` — single run with all tests + eval benchmarks
- `npm run build` — compile TypeScript to `dist/`
- `npm run lint` — type check with `tsc --noEmit`
- `npm run verify` — release check: lint + tests + build + `npm pack --dry-run`

## Project Structure

```
src/
├── index.ts              # Public exports and factory entrypoints
├── engine.ts             # Main engine implementation
├── types.ts              # All type definitions + defaults
├── circuit-breaker.ts    # Degraded mode detection
├── triage/
│   ├── classifier.ts     # L0-L3 classifier (regex + future LLM)
│   ├── patterns.ts       # L0 noise regex patterns
│   └── content-types.ts  # Content type definitions
├── storage/
│   ├── db.ts             # BrainDB interface + shared query helpers
│   ├── pglite-db.ts      # Embedded PostgreSQL implementation
│   ├── pg-schema.ts      # PostgreSQL schema + bootstrap
│   ├── graph.ts          # GraphStore for nodes, edges, traversal
│   ├── messages.ts       # Message CRUD with L-level tags
│   └── directives.ts     # L3 directive + L2 preference store
├── assembly/
│   ├── task-detector.ts  # Task type inference with EMA
│   ├── budget.ts         # Token budget allocation
│   └── assembler.ts      # Priority-ordered context builder
└── compact/
    ├── compactor.ts      # Old L1 → DAG summaries
    └── summarizer.ts     # Heuristic summarizer (no LLM)

cli/
├── brain.ts              # Umbrella `oh-my-brain` command
├── compress.ts           # brain-compress entry (Claude Code hook)
├── compress-core.ts      # Hook internals + MEMORY.md writer
├── codex-sync.ts         # brain-codex-sync entry
├── codex-session.ts      # Codex session parser
├── audit.ts              # brain-audit (human-readable report)
├── candidates.ts         # Memory Candidates store primitives
├── candidates-cli.ts     # brain-candidates entry
├── mcp-server.ts         # brain-mcp (MCP JSON-RPC over stdio)
└── lockfile.ts           # MEMORY.md cross-process write lock

test/                      # Unit + integration tests (vitest)
eval/                      # Benchmark tests (retention, preferences, replay)
docs/                      # Origin story, demos, methodology notes
```

## Adding L0 Patterns

Edit `src/triage/patterns.ts`. Add your regex to the appropriate array (`ACK_PATTERNS`, `EMPTY_RESULT_PATTERNS`, or `STATUS_NOISE_PATTERNS`), then add test samples in `test/classifier.test.ts`.

## Writing Tests

- Unit tests go in `test/`
- Benchmark/eval tests go in `eval/`
- Use real PGLite databases (tmpdir), not mocks
- Clean up DB files in `afterEach`

## Pull Requests

- One feature or fix per PR
- All tests must pass (`npm run test:run`)
- Include test coverage for new code paths
- Update CHANGELOG.md
