# Memory Canonical Path and Structure

## Purpose

This note defines the next hard constraints for `oh-my-brain` memory:

- one canonical `.brain/` per scope
- one canonical `MEMORY.md` projection per scope
- no parallel `memory/` file model going forward
- no standalone `.squeeze/` storage model going forward
- stable top-level working memory sections
- richer `what / why / how-to` structure inside `.brain/`

The goal is not just cleaner storage. The goal is better user-grounded recall:

- remember the latest state, not stale state
- remember derived totals and counts without recomputing from scratch
- remember why a preference or rule exists
- remember how to act next time, not just what conclusion was reached once

## Current Observations

Validated in the current workspace:

- active working memory: [MEMORY.md](/Users/hsing/MySquad/MEMORY.md:1)
- active source of truth: [.brain](/Users/hsing/MySquad/.brain)
- live structured files include:
  - [identity.md](/Users/hsing/MySquad/.brain/identity.md:1)
  - [coding.md](/Users/hsing/MySquad/.brain/coding.md:1)
  - [goals.md](/Users/hsing/MySquad/.brain/goals.md:1)
  - [domains/work.md](/Users/hsing/MySquad/.brain/domains/work.md:1)
  - [projects/oh-my-brain.md](/Users/hsing/MySquad/.brain/projects/oh-my-brain.md:1)

Also validated:

- many code paths resolve memory from `projectRoot/MEMORY.md`
- some paths still resolve from `cwd/MEMORY.md` or `parsed.cwd/MEMORY.md`
- repo-local `memory/` and extra `MEMORY.md` copies can still exist and cause ambiguity
- many subsystems still refer to `.squeeze/` paths or `.brain/.squeeze/` internals

This ambiguity is a product bug, not just cleanup debt.

## Hard Rules

### 1. One scope, one brain, one memory file

For any active scope:

- exactly one canonical `.brain/`
- exactly one canonical `MEMORY.md`
- `MEMORY.md` is always a projection, never an independent source of truth

Anything else is compatibility-only legacy behavior and should be treated as migration input, not ongoing storage.

### What "projection" means

`MEMORY.md` is the working-memory view assembled from `.brain/`.

It is not the place where the full truth lives.

In practice, that means:

- writes should target `.brain/` first
- `MEMORY.md` should be regenerated from `.brain/`
- deleting `MEMORY.md` should not lose durable memory
- hand-editing `MEMORY.md` must be treated as an exception, not the normal path

Useful mental model:

- `.brain/` = durable source, history, rationale, procedures, and machine state
- `MEMORY.md` = current operator console for the agent

So when we say "`MEMORY.md` is always a projection", we mean:

- it is derived
- it is rebuildable
- it is optimized for reading
- it should not become a second competing database

### 2. `memory/` is legacy

Going forward:

- do not create new `memory/*.md` files
- do not treat `memory/` as active storage
- do not let runtime writes choose between `.brain/` and `memory/`

If `memory/` is found, it should be migrated once or ignored with an explicit warning.

### 3. `.squeeze/` is legacy too

Going forward:

- there should be no root-level `.squeeze/`
- there should be no runtime concept of "project state lives in `.squeeze/`"
- hidden operational state should live under `.brain/`

Recommended replacement naming:

- `.brain/system/` for machine-managed state
- `.brain/system/brain.pg/` for the database
- `.brain/system/actions.jsonl`
- `.brain/system/candidates.json`
- `.brain/system/events.jsonl`
- `.brain/system/last-session.json`

The exact internal folder name can still change, but the product model should be:

- users see one brain root: `.brain/`
- not one brain plus one second hidden storage system

### 4. Path resolution must be centralized

All runtime entrypoints must use the same resolver:

- resolve canonical scope root first
- derive canonical `.brain/`
- derive canonical `MEMORY.md`

No command should directly decide "just write to `cwd/MEMORY.md`".

## Canonical Resolution Model

Introduce one shared concept:

- `resolveMemoryScope(startDir) -> { scopeRoot, brainRoot, memoryPath }`

Required behavior:

1. walk upward from the current directory
2. if an onboarding config or scope config exists, respect it
3. if a canonical `.brain/` exists for the scope, use it
4. derive `MEMORY.md` from the same scope root
5. if multiple candidates are found, do not silently choose by proximity alone

Extended return shape:

- `resolveMemoryScope(startDir) -> { scopeRoot, brainRoot, memoryPath, systemRoot, source }`

Where:

- `systemRoot` is inside `.brain/`, never outside it
- `source` explains how the scope was chosen:
  - `explicit-config`
  - `existing-brain`
  - `single-project-default`
  - `workspace-choice`
  - `migration-result`

For the current workspace, the resolved result should be:

- `scopeRoot = /Users/hsing/MySquad`
- `brainRoot = /Users/hsing/MySquad/.brain`
- `memoryPath = /Users/hsing/MySquad/MEMORY.md`

## Top-Level Working Memory Shape

The top-level shape of `MEMORY.md` should remain stable and human-readable:

- `## Identity`
- `## Coding`
- `## Goals`

Why keep these at the top:

- they are stable across sessions
- they are easy for humans to inspect and edit
- they are good KV-cache material
- they match how users think about durable collaboration preferences

The richer operational structure should not replace these headings. It should live under the dynamic projection and inside domain/project files.

## Onboarding and User Confirmation

This is where current behavior is still too loose.

The desired behavior is:

### Case 1: User has one obvious project

If the current directory is a single project and there is no competing parent scope:

- default to a local brain for that project
- show the resolved path clearly
- let the user continue with one confirmation or with `--yes`

Expected wording:

- "Create this project's brain at `<project>/.brain/` and working memory at `<project>/MEMORY.md`"

This case should be nearly zero-friction.

### Case 2: User is in a workspace with multiple projects

If the current directory looks like a workspace:

- do not silently create shared memory
- explain the tradeoff explicitly
- ask the user to choose one of two models:
  - shared workspace brain
  - separate brain per project

Expected wording:

- "This directory looks like a workspace with multiple projects. Do you want one shared brain for the workspace, or separate brains per project?"

If the user chooses separate brains:

- store a scope preference that marks the workspace as "do not create workspace memory here"
- prompt again when they enter a child project for first-time setup there

### Case 3: Multiple candidate memories or brains are found

If the resolver detects multiple candidates:

- do not keep writing
- enter disambiguation mode
- show the candidates
- ask which one is canonical
- optionally offer migration

Expected wording:

- "I found more than one possible memory location. Choose the canonical brain before continuing."

### Case 4: Non-interactive environments

In non-interactive runs:

- only auto-select when resolution is unambiguous
- if the situation is ambiguous, write nothing and emit a clear warning
- never silently create a second active brain

## Dynamic Projection Principle

`MEMORY.md` should stay concise at the top level, but the dynamic section cannot remain an empty placeholder.

Instead of promoting many operational headings to top-level sections, use the dynamic section as a projection of structured project/domain knowledge such as:

- current state
- latest overrides
- open loops
- derived facts
- active personalization anchors

This gives the model better recall without making the main file noisy or harder for humans to read.

## Projection Contract

The projection layer should obey a simple contract:

### What goes into `MEMORY.md`

- stable collaboration defaults
- stable coding standards
- long-term goals
- current domain context
- current project state
- the most relevant active loops
- a small number of action-shaping procedures

### What stays in `.brain/`

- full decision history
- full handoff logs
- prior states that were superseded
- machine-managed state
- candidate queues
- audit trails
- event logs
- richer procedural detail than the agent needs every turn

### What happens on rebuild

If the projection is refreshed:

- no durable knowledge should disappear if it still exists in `.brain/`
- stale details should drop out automatically when superseded
- the same scope should always rebuild to the same `MEMORY.md` shape

### What should never happen

- a runtime path writes only to `MEMORY.md` and skips `.brain/`
- `.brain/` says one thing while `MEMORY.md` says another
- multiple commands rebuild different `MEMORY.md` files for the same scope

## `.brain/` Should Store `what / why / how-to`

This is the key structural upgrade.

Current `.brain/` content already stores a fair amount of `what`:

- user preferences
- coding rules
- project status
- decisions

It stores some `why`, but mostly inline and inconsistently.

It stores very little explicit `how-to`.

That is the main gap.

### Definitions

- `what`
  - the stable fact, preference, rule, current state, decision, or update
- `why`
  - the rationale, trigger, or user need behind that item
- `how-to`
  - the reusable procedure, operating pattern, or next-time playbook

### Why this matters

Human memory is not just stored conclusions. It is usually one of:

- something happened
- something was learned
- therefore a future behavior changed
- but the exact solution may still vary by context

That maps well to:

- event
- lesson
- rationale
- reusable operating guidance

## Recommended File Semantics

### `identity.md`

Primary role:

- durable user collaboration defaults

Typical content:

- `what`: communicate in Chinese, do not keep asking for confirmation
- `why`: user prefers fast autonomous execution
- `how-to`: when ambiguity is low, act first and report assumptions after

### `coding.md`

Primary role:

- engineering and delivery standards

Typical content:

- `what`: separate generation from validation
- `why`: raw LLM output is not trusted
- `how-to`: generate, then validate, then verify end-to-end usability

### `goals.md`

Primary role:

- long-horizon direction

Typical content:

- mostly `what` and `why`
- very little `how-to`

### `domains/*.md`

Primary role:

- domain-specific worldview and judgment standards

Good fit for:

- domain-specific preferences
- evaluation standards
- recurring operating patterns
- links to active projects

### `projects/*.md`

Primary role:

- live operational memory

This is where the system should become much richer.

Recommended standard subsections:

- `## Current State`
- `## Recent Changes`
- `## Open Loops`
- `## Derived Facts`
- `## Decisions`
- `## Procedures`
- `## Handoff Log`

These are not replacements for `Identity / Coding / Goals`.
They are structured internals for dynamic recall.

## Suggested `.brain/projects/*.md` Template

Recommended default template:

```md
# <project-name>
domain: <domain-name>

## Current State
- What:
  Why:
  How-to:
  Updated:

## Recent Changes
- What changed:
  Why it matters:
  Updated:

## Open Loops
- What is unresolved:
  Why it matters:
  Next move:
  Status:

## Derived Facts
- What:
  Derived from:
  Updated:

## Decisions
- What was decided:
  Why:
  Updated:

## Procedures
- What:
  Why:
  How-to:
  Updated:

## Handoff Log
- YYYY-MM-DD AM/PM:
```

This template is intentionally repetitive.
The repetition is a feature: it nudges the system to capture rationale and reusable action, not just conclusions.

## Entry Format Guidance

Not every file needs rigid JSON-like syntax, but entries should consistently support these fields conceptually:

- `what`
- `why`
- `how-to`
- `updated_at`
- `status`

Example:

```md
## Procedures

- What: when the user asks for benchmark progress, continue the benchmark automatically and report status.
  Why: the user treats progress checks as implicit permission to resume work.
  How-to: restart from saved outputs, report current completed count, and keep running unless explicitly stopped.
  Updated: 2026-04-21
```

Another example:

```md
## Current State

- What: LongMemEval oracle full run scored 89.4% (447/500) with the official evaluator.
  Why: this is the public benchmark baseline currently used in README and analysis.
  How-to: when citing benchmark performance, use the full official score first and per-type breakdown second.
  Updated: 2026-04-21
```

## Projection Rules for `MEMORY.md`

The projection should prefer:

- stable `what` for `Identity / Coding / Goals`
- current `what` plus compact `why` for dynamic project/domain context
- only the most useful `how-to` items when they affect likely next actions

The projection should avoid:

- dumping full handoff logs
- including stale superseded state
- mixing every historical note into the live working set

## Benchmark-Informed Rationale

The LongMemEval error profile suggests the next gains will come from better memory shape, not just more memory:

- `knowledge-update` misses imply weak latest-state overwrite semantics
- `multi-session` misses imply weak derived totals and cross-event accumulation
- `temporal-reasoning` misses imply weak event relationship composition
- `single-session-preference` misses imply weak personalization anchors

So the next memory design should better represent:

- current value vs previous value
- derived totals and counts
- event ordering and dependency
- personalized resources, tools, and successful prior patterns

## CLI Resolution Cleanup Targets

The following areas should be unified around a shared resolver rather than direct path joining:

- onboarding
- codex session ingestion
- import
- audit
- consolidate
- diff
- eval
- any command that reads or writes `MEMORY.md`
- any command that reads or writes audit, candidate, event, or procedure state

In particular, any use of:

- `join(cwd, "MEMORY.md")`
- `join(parsed.cwd, "MEMORY.md")`

should be treated as suspect until replaced by canonical scope resolution.

Likewise, any use of:

- `join(projectRoot, ".squeeze", ...)`
- `join(root, ".brain", ".squeeze", ...)`

should be treated as transitional only.

## Product Behavior Plan

This is the desired user-facing behavior after cleanup.

### Single-project user

Expected experience:

1. user runs `oh-my-brain init` inside a normal project
2. tool resolves that this is an unambiguous project scope
3. tool says where `.brain/` and `MEMORY.md` will live
4. user confirms once, or `--yes` skips confirmation
5. all future commands reuse that scope automatically

Desired UX:

- almost no friction
- no workspace lecture if not needed
- no extra path choices if there is only one sensible answer

### Multi-project workspace user

Expected experience:

1. user runs init at a workspace root
2. tool detects multiple child projects
3. tool clearly explains the two models:
   - one shared workspace brain
   - one brain per project
4. user chooses once
5. that choice becomes the canonical routing policy for that scope

Desired UX:

- clear tradeoff explanation
- no silent default to shared memory
- no accidental mixed-project memory unless explicitly chosen

### User with existing duplicate memories

Expected experience:

1. tool detects multiple candidate `MEMORY.md` files, `.brain/` roots, or legacy stores
2. tool pauses normal writes
3. tool asks the user to pick the canonical scope
4. tool offers migration
5. tool writes only to the canonical location after that

Desired UX:

- explicit disambiguation
- one-time cleanup
- no ongoing split-brain behavior

## Migration Direction

Recommended migration policy:

1. canonicalize active scope
2. detect duplicate `MEMORY.md`, legacy `memory/`, and legacy `.squeeze/`
3. warn clearly
4. offer one-time migration into canonical `.brain/`
5. regenerate the canonical `MEMORY.md`
6. move hidden state under `.brain/system/`
7. stop writing to legacy paths

Do not keep multiple active stores alive for convenience.
That convenience turns into ambiguity very quickly.

## Implementation Plan

Recommended order of work:

### Phase 1: Resolver first

Build one shared resolver and make it the only supported path API:

- `resolveMemoryScope(startDir)`
- `resolveBrainRoot(startDir)`
- `resolveMemoryPath(startDir)`
- `resolveSystemRoot(startDir)`

Success condition:

- every command can ask one place for scope resolution
- no command needs to guess local paths on its own

### Phase 2: Onboarding and scope choice

Update onboarding to:

- write scope configuration into `.brain/scope.json`
- support explicit shared-vs-per-project decisions
- support duplicate-memory disambiguation
- stop storing canonical routing in legacy `.squeeze/onboarding.json`

Success condition:

- onboarding becomes the front door to canonical scope choice
- routing decisions live under `.brain/`, not outside it

### Phase 3: Runtime path cleanup

Move all commands from ad hoc path joins to the shared resolver:

- compress
- codex session sync
- import
- audit
- consolidate
- diff
- eval
- MCP tools

Success condition:

- no runtime path still writes to arbitrary `cwd/MEMORY.md`

### Phase 4: Hidden state relocation

Move hidden operational files under `.brain/system/`.

This includes:

- action logs
- candidates
- events
- archive
- habits
- procedures
- graph / database state

Success condition:

- no new writes to root-level `.squeeze/`
- no new writes to `.brain/.squeeze/`
- all durable system state is under one `.brain/` tree

### Phase 5: Projection upgrade

Improve the assembler so the dynamic section reflects:

- current state
- current overrides
- open loops
- derived facts
- selected procedures

Success condition:

- `MEMORY.md` stays readable
- benchmark-relevant signals surface reliably

### Phase 6: Migration and guardrails

Add migration plus prevention:

- detect legacy `memory/`
- detect legacy `.squeeze/`
- detect duplicate `MEMORY.md`
- migrate once
- warn on future ambiguity

Success condition:

- users cannot unknowingly create split memory again

## Success Criteria

This plan is successful when:

- a user can point to one clear `.brain/`
- a user can point to one clear `MEMORY.md`
- `.brain/` fully explains durable state
- `MEMORY.md` can be rebuilt at any time
- single-project onboarding is nearly frictionless
- multi-project onboarding is explicit and understandable
- no runtime path silently creates a second memory location

## Recommended Internal Layout

Recommended end state:

```text
<scope-root>/
├── .brain/
│   ├── scope.json
│   ├── identity.md
│   ├── coding.md
│   ├── goals.md
│   ├── domains/
│   ├── projects/
│   └── system/
│       ├── brain.pg/
│       ├── actions.jsonl
│       ├── archive.jsonl
│       ├── candidates.json
│       ├── events.jsonl
│       ├── habits.json
│       ├── last-session.json
│       └── ...
└── MEMORY.md
```

This layout makes the user-facing story much cleaner:

- one visible brain root
- one visible working memory file
- no second hidden storage brand to explain

## Practical Design Decision

Going forward, the intended model is:

- top-level `MEMORY.md` stays simple:
  - `Identity`
  - `Coding`
  - `Goals`
- dynamic recall gets richer through structured `.brain` internals
- `.brain` entries become more useful by storing `what / why / how-to`
- every runtime path must resolve the same canonical brain scope
- all hidden operational state lives under `.brain/`, not `.squeeze/`

This preserves readability while making the memory system more aligned with actual user needs and with the error profile seen in LongMemEval.
