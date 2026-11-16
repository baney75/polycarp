# Compaction eval

Does a browser task survive Claude Code compacting the chat in the middle of it? This runs the weak-model harness
(`../weak-model/run.mjs`) on long tasks with auto-compact moved early, so every run compacts several times before it
is done, and scores it with checkers only.

```sh
cd browser
env -u ANTHROPIC_API_KEY node evals/compaction/run.mjs --label c1-haiku --model haiku --trials 3 --kind browser --turns 60 --wall 600
```

Each round writes `results/<label>/runs.jsonl` and `summary.json`, which are committed.

`run.mjs` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (`--window`, 100000) and `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (`--pct`,
30). The first turn is about 19k tokens (instructions and Polycarp's tools); with these values compaction fires near
24k, every four to ten calls. Run on Donovan's sign-in only: `env -u ANTHROPIC_API_KEY`, never an API key.

## Checks (`checks.mjs`)

A run passes when the task's page reached its finished state and:

- a compaction ran (else the run measured nothing);
- no done step was done again (each page counts a second submit or an unflagged flag in `repeats`);
- no call after the first compaction failed with `stale_ref` or `no_tab`: what the model needed from before survived;
- the chat ended with a reply: a `success` stop, text, and no "Autocompact is thrashing" or context-limit message.

`test/compaction-eval.test.mjs` holds the checkers and the transcript fields they read, without a model.
