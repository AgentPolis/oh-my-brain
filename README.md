# squeeze-claw

**Cut context token cost by 30-60% without losing what matters.**

squeeze-claw is a [ContextEngine](https://docs.openclaw.ai/concepts/context-engine) plugin for [OpenClaw](https://github.com/openclaw/openclaw) that replaces the default context management with semantic-aware compression. It classifies every message by importance, discards noise, and preserves the directives and code your agent actually needs.

```
100-turn coding session
─────────────────────────────────────
Before (keep everything):  4,812 tokens/call
After  (squeeze-claw):     1,740 tokens/call
                           ────────────────
                           saved 63.9%  💰
```

## Why

Every token in the context window costs money. In a typical multi-turn agent session:

- **~40% is noise** — "ok", "got it", "thanks", empty tool outputs, status messages
- **~25% is stale** — tool results from 30 turns ago that will never be referenced again
- **~5% is critical** — user directives ("always use TDD", "never push to main") that must survive forever

OpenClaw packs everything into every API call. squeeze-claw is selective:

| Level | What | Policy |
|-------|------|--------|
| **L0** — Noise | "ok", "got it", empty results | Discard immediately |
| **L1** — Observation | Regular messages, tool output | Store, compress over time |
| **L2** — Preference | Confirmed user preferences | Extract as structured KV |
| **L3** — Directive | "always", "never", "remember" | **Never compressed. Never lost.** |

## Quick Start

### Install

```bash
# requires OpenClaw >= 2026.3.7
cd your-openclaw-project
pnpm add squeeze-claw
```

### Enable

Add to your OpenClaw config (`settings.json` or `openclaw.config.json`):

```json
{
  "plugins": {
    "entries": {
      "squeeze-claw": {
        "enabled": true
      }
    }
  }
}
```

That's it. squeeze-claw registers itself as the active ContextEngine.

### Verify

After a few turns, check the status:

```
/squeeze status
```

You'll see something like:

```
squeeze-claw status
  Turn: 47
  Messages: L0: 0 (discarded) | L1: 89 | L2: 3 | L3: 5
  Task type: coding (weights: tool 55% | history 20% | directives 15%)
  Memory: enabled (12% of budget)
  Mode: normal
```

## How It Works

```
Message in
    │
    ▼
┌─────────────┐     ┌──────────┐
│  L0 Regex   │────▶│ Discard  │  "ok", "thanks", empty output
│  (<1ms)     │     └──────────┘
└──────┬──────┘
       │ not noise
       ▼
┌─────────────┐     ┌──────────────────────────┐
│  Classify   │────▶│ L3 → Directive Store     │  never compressed
│  L1/L2/L3   │     │ L2 → Preference Store    │  structured KV
└──────┬──────┘     │ L1 → Messages DB         │  standard storage
       │            └──────────────────────────┘
       ▼
┌─────────────┐
│  Assemble   │  On each API call:
│  (budget-   │  1. System prompt (fixed)
│   aware)    │  2. L3 directives (always)
│             │  3. Fresh tail (last 20 msgs)
│             │  4. Task-weighted history
└─────────────┘
```

### Task-Aware Budget

squeeze-claw detects what you're doing and adjusts what goes into the context:

| Task | Tool Results | History | Directives |
|------|-------------|---------|------------|
| Coding | 55% | 20% | 15% |
| Debug | 60% | 15% | 15% |
| Research | 45% | 30% | 15% |
| Planning | 15% | 45% | 30% |
| Chat | 10% | 50% | 20% |

### Circuit Breaker

If something goes wrong (classifier fails, latency spikes), squeeze-claw degrades gracefully to lossless-claw-equivalent behavior. Check with `/squeeze health`.

## Commands

| Command | Description |
|---------|------------|
| `/squeeze status` | Token composition, task type, budget allocation |
| `/squeeze directives list` | All stored L3 directives |
| `/squeeze directives add "..."` | Manually add a directive |
| `/squeeze directives remove <id>` | Remove a directive |
| `/squeeze budget` | Show/adjust context budget weights |
| `/squeeze task` | Show/override detected task type |
| `/squeeze health` | Diagnostics: integrity, latency, circuit breaker |
| `/squeeze memory off` | Disable memory injection for current session |
| `/squeeze memory on` | Re-enable memory injection |
| `/squeeze migrate` | Migrate from lossless-claw database |

## Configuration

All settings are optional. Defaults work well for most sessions.

```json
{
  "plugins": {
    "entries": {
      "squeeze-claw": {
        "enabled": true,
        "config": {
          "freshTailCount": 20,
          "memoryInjectionCapPercent": 15,
          "taskDetection": true,
          "prefetch": true
        }
      }
    }
  }
}
```

<details>
<summary>Full configuration reference</summary>

| Key | Default | Description |
|-----|---------|-------------|
| `freshTailCount` | 20 | Number of recent messages always included |
| `contextThreshold` | 0.75 | Context usage ratio that triggers compression |
| `triageMode` | "hybrid" | Classification mode: "hybrid", "regex", or "llm" |
| `triageConfidenceThreshold` | 0.7 | Below this → default to L1 (safe fallback) |
| `taskDetection` | true | Auto-detect task type for budget allocation |
| `prefetch` | true | Predictive memory prefetch |
| `prefetchTopK` | 5 | Number of summaries to prefetch |
| `memoryInjectionCapPercent` | 15 | Max % of budget for memory (directives + preferences) |
| `preferenceConfidenceThreshold` | 0.5 | Min confidence for L2 preferences to be injected |
| `dagSummaryLOD` | true | Enable multi-tier summary detail levels |

</details>

## Migrating from lossless-claw

squeeze-claw extends the lossless-claw database schema. Existing databases work as-is:

```
/squeeze migrate
```

This adds the new columns (`level`, `content_type`, `confidence`) to your existing messages. All existing messages default to L1. If you disable squeeze-claw later, lossless-claw can still read the database (it ignores the extra columns).

## Benchmarks

Tested on simulated multi-turn sessions (50 turns coding, 80% noise):

| Metric | lossless-claw | squeeze-claw | Improvement |
|--------|--------------|-------------|-------------|
| Tokens per call (coding, 50 turns) | ~4,800 | ~1,700 | **-64%** |
| Tokens per call (noisy, 80% noise) | ~800 | ~290 | **-64%** |
| Directive retention (100+ turns) | N/A | **100%** | 10/10 directives recalled |
| Memory degradation | N/A | **<10%** | Fresh tail not crowded out |
| Classification latency | N/A | **<1ms** | Regex fast-path, no API calls |

Run benchmarks yourself:

```bash
pnpm test:run
```

## Development

```bash
git clone https://github.com/nicholasgasior/squeeze-claw.git
cd squeeze-claw
pnpm install
pnpm test        # watch mode
pnpm test:run    # single run (76 tests)
pnpm build       # compile to dist/
pnpm lint        # type check
```

## Roadmap

- [x] L0 regex noise filter (30 patterns)
- [x] L3 directive store with conflict resolution
- [x] Task-aware budget allocation with EMA blending
- [x] Circuit breaker with graceful degradation
- [x] lossless-claw migration tool
- [ ] LLM-based classifier (Haiku) for L1/L2/L3 distinction
- [ ] DAG compression (`compact()`)
- [ ] L1 → L2 preference promotion
- [ ] Predictive memory prefetch
- [ ] Agent tools (`squeeze_search`, `squeeze_expand`)
- [ ] Tool output truncation (highest ROI pending feature)

## License

AGPL-3.0 with non-commercial restriction. See [LICENSE](LICENSE).

Commercial licensing available — contact the maintainers.
