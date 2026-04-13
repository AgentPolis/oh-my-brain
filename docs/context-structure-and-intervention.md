# OpenClaw Context Structure and `squeeze-claw` Intervention Boundaries

Verified on 2026-04-06 against OpenClaw public docs.

Primary references:

- <https://docs.openclaw.ai/context/>
- <https://docs.openclaw.ai/reference/token-use>
- <https://docs.openclaw.ai/concepts/context-engine>
- <https://docs.openclaw.ai/concepts/compaction>

## Why This Note Exists

The core product question is not "can we compress text?"

It is:

- what OpenClaw actually sends to the model every run
- which parts of that cost `squeeze-claw` can really reduce
- which parts remain outside the plugin's control

This note separates verified facts from product inferences.

## Verified: What OpenClaw Counts as Context

OpenClaw docs define context as the full package sent to the model for a run.

That includes:

- system prompt
- conversation history
- tool calls and tool results
- attachments / transcripts / file content
- compressed summaries and pruning artifacts
- provider wrappers or safety headers that are not visible in chat but still count toward token limits

The docs also say OpenClaw rebuilds its system prompt on every run.

## Verified: Main Context Components

OpenClaw describes the context stack as four main components:

- system prompt
- conversation history
- tool data
- project context

Project context can include injected workspace files such as:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`
- `MEMORY.md` when present

This matters because cost can rise even when the user's visible turn is short.

## Verified: The Hidden Cost of Tools

OpenClaw docs explicitly call out two tool-related costs:

- tool descriptions in the system prompt
- tool schemas (JSON) that are not visible in the chat transcript but still consume context space

So a session can be expensive even when current user input and assistant output are both short.

## Verified: What the Context Engine Controls

OpenClaw's context engine lifecycle includes:

- `ingest`
- `assemble`
- `compact`
- `afterTurn`
- optional subagent hooks

The docs state that `assemble` is called before each model run and returns:

- ordered `messages`
- `estimatedTokens`
- optional `systemPromptAddition`

The built-in `legacy` engine is pass-through for assembly, using OpenClaw's existing sanitize -> validate -> limit path.

When a plugin context engine is active, OpenClaw delegates context assembly and compaction behavior to that engine.

## Verified: What `squeeze-claw` Currently Controls

From the current implementation, `squeeze-claw` can directly control:

- how new messages are classified at ingest time
- which messages are discarded as L0
- which messages become directives or preferences
- how old L1 history is compacted into DAG summaries
- which messages are assembled into model context
- how subagent context is reduced

Current assembly order is:

1. system prompt additions supplied by the engine
2. L3 directives
3. L2 preferences
4. DAG summaries
5. fresh tail

## Verified: What `squeeze-claw` Does Not Fully Control

Based on the OpenClaw docs and the current engine interface, `squeeze-claw` does not fully control:

- the base OpenClaw system prompt
- tool schema size
- provider-side invisible wrappers / safety headers
- workspace file injection rules outside the engine's returned message set

So `squeeze-claw` cannot eliminate the full OpenClaw context tax by itself.

## Product Inference: Where `squeeze-claw` Is Most Likely To Help

The strongest fit is the "fat carried context" problem:

- current turn is short
- visible output is short
- historical context, tool results, and durable instructions are what make the run expensive

That is exactly the part `squeeze-claw` is designed to improve:

- drop obvious noise
- preserve durable directives
- keep only the fresh tail verbatim
- compress stale observations into summaries

## Product Inference: Why Live Trials Still Matter

Replay evidence can show that `squeeze-claw` reduces assembled conversation payload.

It cannot, by itself, prove:

- total OpenClaw run cost reduction across real work
- stable improvement in Claude/Codex handoff quality
- no quality regressions in long-running live sessions

That is why live trials are still necessary.

## Recommended Measurement Plan

For real-world validation, use OpenClaw's own observability tools together with `squeeze-claw` artifacts:

- `/context detail`
  Use this to see system prompt size, workspace file injection, top tool schema sizes, and where fixed cost dominates.
- `/usage tokens`
  Use this to add per-reply token usage in normal work.
- `MEMORY.md`
  Use this to inspect what durable memory is actually being written.
- `docs/fixed-replay-eval.md`
  Use this as baseline replay evidence, not as a replacement for live proof.

## Honest Conclusion

The current evidence supports a narrower claim:

`squeeze-claw` can reduce the carried conversation portion of context and can preserve durable directives as a separate artifact.

The current evidence does not yet support the strongest launch claim:

`squeeze-claw` reliably reduces total OpenClaw session cost in live work without harming quality.

That stronger claim still needs controlled live evaluation.
