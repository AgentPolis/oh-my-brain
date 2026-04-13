# Real Session Replay Evaluation

This document is the public-safe version of a local `MySquad` trial.

It is intentionally narrower than a full live-study claim:

- it uses real Claude Code session transcripts
- it replays them through the current Claude Code adapter logic
- it removes local file paths, workspace structure, and private identifiers
- it does **not** claim billed provider token savings yet

## Why This Exists

The core hypothesis behind `squeeze-claw` is not just "short prompts get shorter."

It is:

> expensive agent sessions often stay expensive because they keep carrying old tool output, search results, file reads, and stale context forward into later turns

These replay runs were chosen to test that exact problem shape.

## Method

Three real long-running Claude Code sessions were replayed locally with:

```bash
SQUEEZE_SESSION_FILE=/path/to/session.jsonl node dist/cli/compress.js
```

For each session, the replay pipeline:

1. parsed real Claude block content
2. included visible `text`
3. included `tool_result` payloads
4. included compact `tool_use` descriptors
5. excluded `thinking`
6. compared pre-compression vs post-compression visible context length

Estimated token savings use the current CLI heuristic:

```text
estimated_tokens ~= chars / 4
```

So the numbers below are useful for relative comparison, not billing claims.

## Session A: Research-Heavy Tool Session

Representative tool calls:

- `Read(plan.md)`
- `ToolSearch("WebSearch")`
- `WebSearch("Agent Hermes AI agent framework 2026")`
- `WebSearch("NousResearch Agent Hermes function calling tool use")`
- `WebSearch("NousResearch hermes-agent GitHub architecture skills memory system 2026")`

Representative tool outputs:

- large file-read results
- web search result bundles
- follow-up excerpts from the same research thread

Why this session matters:

- the visible user/assistant turns are not individually huge
- the carried context becomes expensive because multiple search and read results accumulate

Observed replay result:

```text
805 msgs → 635 after compression
82.1% char reduction
~160,502 estimated token reduction
```

Interpretation:

- this is the clearest confirmation of the "fat carried context" hypothesis
- the majority of savings came from compressing stale research/tool output, not from changing the current user turn

## Session B: Release-Planning + Subagent + Bash Session

Representative tool calls:

- `Agent(Explore skills and projects)`
- `Agent(Check docs language in projects)`
- `Bash(git author/committer checks)`
- `Bash(identity / docs grep checks)`
- `Skill(open-source-ready)`

Representative tool outputs:

- long exploration reports
- language review summaries
- git identity audit output
- skill-launch status output

Why this session matters:

- it mixes exploration, subagent handoff, bash output, and reporting
- this is closer to real project-maintenance work than a single narrow benchmark

Observed replay result:

```text
698 msgs → 584 after compression
74.1% char reduction
~84,072 estimated token reduction
```

Interpretation:

- `squeeze-claw` still helps strongly outside pure search-heavy workflows
- dense tool/report output remains one of the biggest carried-cost drivers

## Session C: Workspace-Scan / File-Listing Session

Representative tool calls:

- `Bash(ls -la workspace)`
- `Bash(find workspace tree ...))`
- `Bash(list folders and compare repos)`
- `Read(short markdown excerpt)`

Representative tool outputs:

- directory listings
- long path lists
- short file lists
- small markdown excerpts

Why this session matters:

- this is a more mixed, less obviously compressible session
- it tests whether the project only looks good on ideal cases

Observed replay result:

```text
269 msgs → 232 after compression
30.7% char reduction
~15,786 estimated token reduction
```

Interpretation:

- the effect is still positive, but materially smaller
- this supports a more honest claim: savings are session-shape dependent

## Cross-Session Takeaway

Across these three real session replays:

- heavy research/tool sessions showed the largest savings: `74.1%` to `82.1%`
- mixed workspace-scan sessions still improved, but less dramatically: `30.7%`

This supports a narrow but important product claim:

> `squeeze-claw` is most valuable when a session becomes expensive because old tool output and stale visible context keep getting carried forward.

It also supports a product-shape claim:

> the right abstraction is a shared compression/memory layer with adapters, not a one-off single-agent hook.

## Important Caveats

This document does **not** prove:

- real billed Claude or Codex token savings over a week of work
- universal improvement across all session types
- automatic improvement in handoff quality between agents

It does support:

- real-session replay evidence, not just synthetic fixtures
- a clearer explanation of where savings come from
- a more honest product claim than generic "token reduction"

## What Would Strengthen This Further

The next step is a live study that records:

- actual hook invocations over several days
- observed `MEMORY.md` writes
- provider-side token telemetry where available
- whether Claude/Codex handoff quality improves in real work
