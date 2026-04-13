# squeeze-claw Release Plan

This is the minimum launch checklist for the current `0.1.x` line.

## Release Goal

Ship `squeeze-claw` as:

- a cross-agent context compression and durable memory layer
- with a working Claude Code session adapter
- with a working Codex session adapter
- with a working OpenClaw-style runtime adapter

Not as a fully universal memory platform yet.

## Preflight

- confirm `README.md`, CLI help, and package metadata describe the same product surface
- confirm license text and source headers are aligned
- confirm install and first-run commands work on a clean checkout
- confirm no personal or local-only files need to ship

## Verification Command

Run this before publish:

```bash
npm run verify
```

That should cover:

- typecheck
- full test suite and evals
- build output generation
- npm package dry-run

## Manual Spot Checks

- run `npx squeeze-compress --help`
- run `npx squeeze-compress --version`
- inspect `npm pack --dry-run` output and confirm only intended files ship
- scan `README.md` for stale claims about runtime support or benchmarks
- verify `CONTRIBUTING.md` clone URL and commands match the actual repo

## Publish Sequence

1. Run `npm run verify`
2. Review `git status` for unintended files
3. Update `CHANGELOG.md` if release contents changed materially
4. Tag and publish the package
5. Smoke test the published package with `npx squeeze-compress --help`

## First Follow-Ups After Launch

- collect real-world token savings examples beyond eval scenarios
- validate the TypeScript engine against the exact upstream runtime target
- add at least one more adapter path beyond the current Claude Code / Codex / OpenClaw set
- decide when `MEMORY.md` should graduate into a richer structured shared-memory contract
