# Changelog

## [0.1.0] - 2026-03-25

Initial release.

### Added

- **Semantic triage**: L0-L3 classification with regex fast-path (<1ms)
- **L0 noise filter**: 30+ patterns for acks, empty tool results, status noise
- **L3 directive store**: "always/never/remember" instructions extracted and never compressed
- **L2 preference store**: Structured KV with confidence scores and conflict resolution
- **Task-aware budget allocation**: Coding, debug, research, planning, chat — each with tuned weights
- **EMA task blending**: Smooth transitions when switching between task types
- **Circuit breaker**: Graceful degradation when classifier or storage fails
- **lossless-claw migration**: `/squeeze migrate` adds semantic columns to existing databases
- **SQLite storage**: WAL mode, foreign keys, integrity checks, recovery logic
- **Evaluation suite**: Token savings benchmark, directive retention test, memory degradation check

### Fixed (pre-release)

- `turnIndex` now increments once per turn, not once per message
- CJK token estimation corrected (was underestimating by ~3x)
- `fixupSuperseded()` now scoped by key to prevent cross-key corruption
