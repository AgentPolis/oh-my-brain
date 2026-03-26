# Contributing to squeeze-claw

## Setup

```bash
git clone https://github.com/nicholasgasior/squeeze-claw.git
cd squeeze-claw
pnpm install
pnpm test  # should pass 76 tests
```

## Development

- `pnpm test` — watch mode, re-runs on file changes
- `pnpm test:run` — single run with all tests + eval benchmarks
- `pnpm build` — compile TypeScript to `dist/`
- `pnpm lint` — type check with `tsc --noEmit`

## Project Structure

```
src/
├── index.ts              # Public exports
├── engine.ts             # SqueezeContextEngine (main entry)
├── types.ts              # All type definitions + defaults
├── circuit-breaker.ts    # Degraded mode detection
├── triage/
│   ├── classifier.ts     # L0-L3 classifier (regex + future LLM)
│   ├── patterns.ts       # L0 noise regex patterns
│   └── content-types.ts  # Content type definitions
├── storage/
│   ├── schema.ts         # SQLite schema + migration
│   ├── messages.ts       # Message CRUD with L-level tags
│   └── directives.ts     # L3 directive + L2 preference store
└── assembly/
    ├── task-detector.ts   # Task type inference with EMA
    ├── budget.ts          # Token budget allocation
    └── assembler.ts       # Priority-ordered context builder

test/                      # Unit tests (vitest)
eval/                      # Benchmark tests (token savings, retention)
```

## Adding L0 Patterns

Edit `src/triage/patterns.ts`. Add your regex to the appropriate array (`ACK_PATTERNS`, `EMPTY_RESULT_PATTERNS`, or `STATUS_NOISE_PATTERNS`), then add test samples in `test/classifier.test.ts`.

## Writing Tests

- Unit tests go in `test/`
- Benchmark/eval tests go in `eval/`
- Use real SQLite databases (tmpdir), not mocks
- Clean up DB files in `afterEach`

## Pull Requests

- One feature or fix per PR
- All tests must pass (`pnpm test:run`)
- Include test coverage for new code paths
- Update CHANGELOG.md
