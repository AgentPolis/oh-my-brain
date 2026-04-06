# Why Memory Candidates Exist

> The origin story behind the most important feature in oh-my-brain.

## The moment we found the real problem

We were dogfooding our own tool across two windows. Claude Code in one, Codex in another, both feeding into the same `MEMORY.md` via the squeeze-claw Stop hook.

In the middle of working, we gave the agent corrections. Real ones, the kind any human would obviously want remembered:

- "你是不是搞錯狀況了"  ("are you sure you understood the situation?")
- "這個本來就要一直移動"  ("this is supposed to move continuously")
- "右邊側邊欄太多提醒了"  ("there are too many reminders in the right sidebar")

Then we checked `MEMORY.md` to see what got captured.

**Nothing.**

Not one of those corrections made it in. The classifier was waiting for "always X", "never Y", "remember that Z", or some other RFC-shaped imperative. Real human language doesn't look like that. Real users push back, reframe, complain, hint, correct — and our tool was deaf to all of it.

That was the moment we realized we had been solving the wrong problem.

## Why this matters more than compression

The original pitch for this project was about token compression. Save tokens, save money, fit more context in the window. That was technically true, but it was the small problem.

The big problem is this: **users already tell you what's important. They just don't tell you in the syntax your classifier was built for.**

Compression matters. Cross-agent sync matters. L3 directive protection matters. But if the system can only catch the things you explicitly mark as rules, it's not a brain. It's a database that requires a query language.

A real brain notices when you keep correcting the same thing. A real brain notices when you push back. A real brain doesn't need you to phrase everything as a directive — it watches what you actually do and meant.

## What Memory Candidates does

Two-stage capture.

**Stage 1: Strong signals → MEMORY.md (automatic)**
Explicit imperatives still go straight in. "Always use TypeScript strict mode" still becomes an L3 directive immediately. Nothing changes here for users who already know how to talk to their tools.

**Stage 2: Soft signals → Memory Candidates queue (human review)**
Corrections, preferences, friction patterns, aesthetic complaints — anything that *looks like* an important signal but isn't phrased as a rule — lands in a review queue. You see it, you decide:

- **Approve** → it becomes a directive in `MEMORY.md`
- **Edit** → you reshape it into a better directive, then approve
- **Reject** → it gets dropped, and the system learns what kind of soft signal you don't care about
- **Ignore** → after some time, low-confidence candidates expire automatically

The result: nothing important slips through silently, and nothing unimportant pollutes your brain.

## Why this is the actual differentiator

Every other "AI memory" tool we looked at — Memorix, Mem0, Memori, Claude's memory tool — assumes one of two things:

1. **You will explicitly tell it what to remember** (commands like "remember this", structured save calls, etc.)
2. **It should remember everything and retrieve via embedding similarity** (the "store all, search later" model)

Both miss the middle case, which is **most of real human work**: you don't always know in the moment what's worth remembering, but you do know it when something gets re-broken because nobody learned from your last correction.

Memory Candidates is built for that middle case. It catches the soft signals, surfaces them when you have a moment to look, and lets you curate your own brain instead of fighting with an over-eager auto-recorder or a too-quiet manual one.

## What users feel

> "Wait, it noticed I was annoyed about this and asked if I want to remember it?"

That's the emotional moment. It's the difference between a tool that takes orders and a tool that pays attention.

We want every user to have that moment within their first hour of using oh-my-brain. If they don't, Memory Candidates is not doing its job and we should rebuild it.

## What this is not

Memory Candidates is **not** an attempt to be clever with NLP. The first version uses simple heuristics:

- Negation markers ("不對", "wrong", "actually")
- Implicit preference statements ("我比較喜歡", "I prefer", "should be")
- Friction repetition (same pattern corrected 3+ times — uses the existing `mention_counts` table)
- Aesthetic complaints ("太多", "太少", "too cluttered")
- Question-shaped reframes ("是不是", "wait")

These are dumb patterns, and that's the point. Dumb patterns + a human-in-the-loop review queue beats a smart classifier with no review every time, because the smart classifier still gets confidently wrong on edge cases and the user has no recourse.

Later versions can use Haiku or a small classifier to score candidates, but the **two-stage architecture** is the load-bearing part, not the classifier.

## The deeper principle

> **A real brain trusts its owner enough to ask, instead of guessing or ignoring.**

That's the line we're building toward. Every product decision in oh-my-brain should be checked against it.

If a feature lets the brain notice something the user already meant — even if they didn't phrase it formally — it's the right direction.

If a feature requires the user to learn a new syntax to make their tool listen — it's the wrong direction.

Memory Candidates is the first feature that takes this principle seriously. It will not be the last.

---

*This document describes a real moment of discovery, not a marketing narrative. The corrections quoted at the top happened during a real session on 2026-04-06.*
