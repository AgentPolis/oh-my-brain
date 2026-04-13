# Real Hook Demo

This demo exists to prove the current Claude Code adapter path, not just simulated engine benchmarks.

It uses a sanitized Claude Code-style session fixture derived from a real stop-hook workflow:

- session fixture: `test/fixtures/claude-hook-session-demo.jsonl`
- command surface: `dist/cli/compress.js`
- output artifact: `MEMORY.md`

## Reproduce

From the repo root:

```bash
npm run build
tmpdir="$(mktemp -d)"
cd "$tmpdir"
SQUEEZE_SESSION_FILE="/absolute/path/to/squeeze-claw/test/fixtures/claude-hook-session-demo.jsonl" \
  node "/absolute/path/to/squeeze-claw/dist/cli/compress.js"
cat MEMORY.md
```

## Expected Behavior

- the command exits `0`
- stale L1 implementation notes are compressed
- the fresh tail remains intact
- L3 directives are appended to `MEMORY.md`

## Reproducible Fixture Result

With the included sanitized fixture, the command produced:

```text
[squeeze] 28 msgs → 24 after compression. Saved ~122 tokens (14.0% chars)
[squeeze] 2 L3 directives → MEMORY.md
```

## Observed Result During Release Hardening

Using a real Claude Code-shaped session during launch hardening, `squeeze-compress` produced:

```text
[squeeze] 44 msgs → 38 after compression. Saved ~2702 tokens (74.0% chars)
[squeeze] 2 L3 directives → MEMORY.md
```

And wrote:

```markdown
## squeeze-claw directives (2026-04-05)

- Always preserve API backward compatibility.
- Never remove audit logs from production systems.
```

## Why This Matters

The eval suite is still useful, but this demo proves one real adapter can run end to end on Claude Code-style session data and produce the artifact users actually care about: preserved directives in `MEMORY.md`.
