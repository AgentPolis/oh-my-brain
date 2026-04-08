# Why oh-my-brain is a personal world model, not a memory layer

> The positioning essay. Read this if you want to know what oh-my-brain
> actually is, why "memory layer" is the wrong frame, and how a single
> insight from Palantir + Jack Dorsey rewrote the whole project.

## Three things that happened in early 2026

**Thing one — Palantir's ontology became the way enterprise AI is grounded.**
Palantir Foundry's ontology stopped being a niche enterprise data
modeling tool and became the canonical answer to "how do you stop LLMs
from hallucinating in production?" The pitch is simple: don't give the
model raw rows or vector chunks; give it typed objects with declared
relationships and a list of sanctioned actions it's allowed to invoke.
The model can't reference an entity that doesn't exist, can't perform a
mutation that isn't a declared Action, can't bypass the audit trail.
Hallucinations get cheap. Trust gets expensive in a good way.

Akshay Krishnaswamy's framing: the ontology is how you give the LLM
**meaning, not just text**.

**Thing two — Jack Dorsey laid off 4,000 people and explained why.**
In March 2026, Jack Dorsey and Roelof Botha published
[*From Hierarchy to Intelligence*](https://block.xyz/inside/from-hierarchy-to-intelligence)
to back Block's restructuring. The argument: corporate hierarchy exists
to *route information and precompute decisions*. AI now does that
better. Middle management is a 2,000-year-old caching layer that
becomes obsolete when the cache is real-time and free.

Block replaced the hierarchy with two things:

1. A **Company World Model** — a continuously updated picture of what's
   being built, where it's blocked, where resources sit. Replaces what
   managers used to carry in their heads.
2. A **Customer World Model** — a per-customer unified view that every
   internal AI agent grounds itself in.

Dorsey's claim: every company is becoming a "mini-AGI" built around a
world model. Humans move to the **edge** — novel decisions, taste,
ethics, culture. AI handles the interior.

**Thing three — every major AI lab started talking about world models.**
Yann LeCun's JEPA, the Sora 2 announcements, Genie 3, the whole "we
need world models, not just better language models" line. Different
technical content, but the term *world model* stopped being academic
jargon and became a product noun. People searching for "AI world model"
went from researchers to founders.

These three things rhyme. They are all the same observation from
different vantage points: **the missing layer between an AI agent and
useful action is a typed, queryable, mutable model of the relevant
piece of reality**. Palantir built that layer for enterprises. Dorsey
made it the new org chart. LeCun made it the next ML paradigm.

Nobody built it for individual humans yet. That's oh-my-brain.

## The personal version

You are a tiny org of one. You have:

- preferences (how you like code formatted, which tools you ban, which
  patterns you reach for)
- domain knowledge (your project structure, your business model, the
  people you collaborate with)
- decisions you've made and don't want to relitigate
- corrections you've given that you don't want to give again

Today, every AI agent you use has none of this. You retype it on every
new session. You re-explain it to every new tool. You watch agents
break the same rule you broke yesterday. The "memory layer" tools on
the market — Memorix, Mem0, Memori, Claude's built-in memory — store
strings and retrieve them with embeddings. They are RAG with extra
steps. They cannot tell an agent "this is a `CodingPreference` of type
`Indentation`, scoped to TypeScript projects, superseding the previous
preference from 2025-12-04, with the action `RetireDirective` available
if the user changes their mind."

oh-my-brain can.

## The four primitives, mapped from Palantir

| Palantir Foundry      | oh-my-brain                  | What it gives you                            |
| --------------------- | ---------------------------- | -------------------------------------------- |
| Object Type           | **Directive Type**           | typed memory: `CodingPreference`, `ToolBan`, `ProjectFact`, `CommunicationStyle`, `PersonContact` |
| Property              | **Directive Field**          | each type has its own schema, validation, expiration policy |
| Link Type             | **Directive Relation**       | typed edges: `supersedes`, `refines`, `contradicts`, `scopedTo` |
| Action Type           | **Memory Action**            | only sanctioned way to mutate: `PromoteCandidate`, `SupersedeDirective`, `RetireDirective`, `MergeDirectives` — every mutation logged with full provenance |
| Function (read-only)  | **MCP read tool**            | `brain_recall`, `brain_why(id)`, `brain_search(type=...)` |
| AIP Logic             | **Memory Candidates queue**  | the soft-signal review path you already have |
| Audit log             | **Action log**               | append-only `actions.jsonl`, undo-able, replay-able, "why do you remember this about me" becomes a first-class question |

The split that does the heavy lifting is the **semantic vs kinetic
split**. Reading is cheap and safe; any agent can read your world model
without confirmation. Writing goes through Actions. Actions are typed,
validated, audited, reversible. An agent can propose a mutation. Only
the user (or a confirmed automated rule) approves it. This is Palantir's
kinetic-vs-logical split, sized for one human.

## The thing nobody else does: self-growing ontology

A static schema is a dead schema. The ontology you write on day one is
already wrong by day thirty, because you've started using your tools
differently and noticed patterns you didn't have language for. Real
ontologies in real Palantir deployments are living things, curated by
data engineers, growing as the business changes.

oh-my-brain self-grows on three levels, all using the same Memory
Candidates pattern (observe → propose → human approves → land):

**Level 1 — Instance growth (already shipped).**
The classifier observes natural-language corrections like "這個本來就要
一直移動" and proposes them as Memory Candidates. You approve, edit, or
reject. Approved candidates become L3 directives.

**Level 2 — Type growth (new in v0.3).**
When 5+ accumulated directives don't fit any existing Directive Type,
the system proposes a new type with an auto-derived schema:

> "I notice you have 6 rules about API design that don't fit any
> current type. Want to create a new `ApiDesignPreference` type with
> these fields: `endpoint_style`, `error_format`, `auth_method`?"

You approve the type, edit the schema, or reject. Approved types
immediately get the same first-class treatment as built-in types.

**Level 3 — Link growth (new in v0.3).**
When two directives are semantically related, the system proposes a
typed Link:

> "Your new directive 'Always use Vitest' contradicts your 2025-11-12
> directive 'Always use Jest'. Want to record `supersedes` between them
> and retire the old one?"

You approve, the old directive moves to the archive section, the new
one carries a `supersedes:directive#47` link, and `brain_why` can trace
the lineage.

**Why self-growth matters:** without it, "ontology" is a fancy word
for "schema you wrote once and now you're stuck with." With it, the
ontology is alive — it observes how you actually work and proposes its
own evolution. This is what makes oh-my-brain a *brain* and not a
typed database. It's the same thing Dorsey says a Company World Model
must be: continuously updated, never frozen.

## Where this lands in 2026

The "personal AI memory" market is crowded with commodity vector stores
calling themselves "second brains." The differentiation noise is high
and the actual differentiation is low. oh-my-brain enters that market
with a different shape:

- **Memorix, Mem0, Memori** — RAG with extra steps. Strings and
  similarity search. No types, no actions, no provenance.
- **Notion AI / Mem.ai / Reflect** — note-taking apps with AI bolted
  on. Built for human reading, not agent grounding.
- **Claude / GPT memory tools** — single-vendor, single-agent, opaque,
  not portable across tools.
- **oh-my-brain** — typed personal world model, MCP-native so any
  agent can ground in it, plain-text MEMORY.md so you own and can
  audit every byte, self-growing ontology so it stays useful as you
  change.

If the bet is right, three things happen:

1. Searching for "personal world model AI" leads to oh-my-brain
2. Anyone who read Dorsey's essay and asked "what's the personal
   version?" finds the answer here
3. The "memory layer" framing dies because it was always too small a
   container for the actual job

## What you should do next

If you just want to try it: `npm install -g oh-my-brain`, then read the
[main README](../README.md).

If you're an AI agent reading this to ground yourself: your job is to
*propose*, not *mutate*. Use the MCP `brain_*` read tools freely. When
you observe a pattern that looks like a candidate, call
`brain_candidates` with `action=add`. When the user explicitly says
"yes always do that", call `brain_remember` directly. Never bypass
Actions to edit MEMORY.md by hand.

If you're a builder or investor wondering whether the framing is real:
read [Palantir's ontology blog post](https://blog.palantir.com/connecting-ai-to-decisions-with-the-palantir-ontology-c73f7b0a1a72)
and [Dorsey's essay](https://block.xyz/inside/from-hierarchy-to-intelligence)
back to back. Then ask yourself what the personal version looks like.
oh-my-brain is one answer. We think it's the right shape but we'll find
out. Open an issue, tell us what's wrong.

## Sources

- [Palantir: Connecting AI to Decisions with the Ontology](https://blog.palantir.com/connecting-ai-to-decisions-with-the-palantir-ontology-c73f7b0a1a72)
- [Palantir Foundry Ontology Overview](https://www.palantir.com/docs/foundry/ontology/overview)
- [Block: From Hierarchy to Intelligence (Dorsey + Botha)](https://block.xyz/inside/from-hierarchy-to-intelligence)
- [Sequoia: Every Company Can Now Be a Mini-AGI (Dorsey podcast)](https://sequoiacap.com/podcast/jack-dorsey-every-company-can-now-be-a-mini-agi/)
- [`docs/why-memory-candidates.md`](./why-memory-candidates.md) — the prior origin story for the Memory Candidates queue, which is the L1 self-growth path

---

*This document is the load-bearing positioning. Every product decision
should be checked against it. If a feature makes oh-my-brain more like
a Palantir-shaped personal world model, it's the right direction. If a
feature makes it more like another vector-store memory bag, it's the
wrong direction. When in doubt, re-read this file and the why-memory-
candidates origin story.*
