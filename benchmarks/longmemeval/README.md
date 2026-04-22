# LongMemEval Artifacts

Public artifacts for the latest full 500-question LongMemEval oracle run.

Contents:

- `longmemeval-oracle-500-latest.jsonl` — raw hypotheses
- `longmemeval-oracle-500-latest.jsonl.eval-results-gpt-4o` — official evaluator output
- `metadata.json` — compact run metadata and checksums

Summary:

- Score: `447/500` (`89.4%`)
- Evaluator: LongMemEval `evaluate_qa.py`
- Judge model: `gpt-4o-2024-08-06`
- Dataset: cleaned `longmemeval_oracle.json`

Main takeaways:

- Biggest gains were in temporal reasoning and multi-session synthesis.
- The main remaining gap is preference-conditioned personalization.
- The most common miss patterns were preference shaping, residual aggregation misses, and occasional stale-state errors.
