# DecisionEval — Does your AI agent think like you?

Every memory benchmark measures retrieval: "did the agent remember what you said?" DecisionEval measures something harder: "does the agent make the same decisions you would?"

## Quick start
```bash
npx decision-eval --dry-run          # preview scenarios
npx decision-eval                    # run with claude
npx decision-eval --tool codex       # run with codex
```

## Scores (2026-04-14)
| System        | Decision Match | Note |
|---------------|----------------|------|
| oh-my-brain   | 85%            | with L3 directives loaded |
| Raw context   | 40%            | no memory system, just guessing |
| (your system) | ?%             | implement MemoryAdapter to test |

## Add your own scenarios
Put YAML files in `scenarios/custom/`. Schema: [schema.json](schema.json)
