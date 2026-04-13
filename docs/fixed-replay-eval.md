# Fixed Replay Evaluation

This evaluation is intentionally simple and reproducible.

It does **not** claim live production proof yet.

What it does provide:

- same-task replay instead of day-to-day subjective impressions
- clear baseline vs `squeeze-claw` comparisons
- visible memory artifacts (`MEMORY.md`) rather than abstract claims

## How It Was Run

Command:

```bash
npx vitest run eval/fixed-replay.test.ts
```

This was run locally in the current development environment.

## What This Is

- local replay of sanitized fixtures and simulated sessions
- one current Claude Code adapter replay
- two controlled comparison scenarios

## What This Is Not

- not a week-long live production study
- not a claim about real Claude or Codex billing totals
- not proof that every project will benefit equally

## Scenarios

### 1. Current Adapter Replay

Method:

- replay a sanitized Claude Code-style JSONL fixture
- compare baseline behavior (no compression, no `MEMORY.md`) vs `squeeze-claw`

Result:

```text
Baseline: 28 messages, no MEMORY artifact, no compression
With squeeze: 24/28 messages left uncompressed in-window
Compression: 4 stale messages compressed, 14.0% chars saved
Memory artifact: 2 directives written to MEMORY.md
```

Observed `MEMORY.md` output:

```markdown
## squeeze-claw directives (2026-04-05)

- Always preserve API backward compatibility.
- Never remove audit logs from production systems.
```

### 2. Noisy Session Replay

Method:

- replay the existing simulated 80% noise session through the engine
- compare keep-everything token estimate vs assembled context with `squeeze-claw`

Result:

```text
Baseline tokens: 815
With squeeze tokens: 294
Savings: 63.9%
Active directives kept: 3
Stored counts: {"L0":0,"L1":34,"L2":0,"L3":3}
```

### 3. Memory Precision Replay

Method:

- replay a sanitized session containing both user directives and assistant directive-like phrasing
- verify that only the user-authored durable instructions are written to `MEMORY.md`

Result:

```markdown
## squeeze-claw directives (2026-04-05)

- Remember that staging uses a separate Stripe account.
- For this repo, always ask before changing billing-related environment variables.
```

Expected non-writes:

- `Always use Redis here if we hit scaling limits.`
- `Never deploy on Friday night unless we have rollback coverage.`

Those assistant-authored lines were **not** written to memory.

## Honest Takeaway

This is good evidence for three narrow claims:

1. the current Claude Code adapter can produce a real `MEMORY.md` artifact from session data
2. the engine reduces token load materially in noisy replay scenarios
3. the current directive logic avoids at least some obvious bad writes

This is **not yet** enough evidence for the stronger claim that `squeeze-claw` improves real team handoff quality across a week of daily work. That still needs a live repo trial.
