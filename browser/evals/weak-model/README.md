# Weak-model eval

Can a small model finish real tasks with Polycarp's browser and computer tools, from a plain prompt, with no skill
named and no tool hints? This harness answers that with numbers, so a tool change is kept only when it measurably
helps.

## What it runs

Tasks come from `tasks/*.mjs`: each file exports arrays of tasks, `{ id, kind: "browser" | "computer", prompt, ... }`.
A browser task serves its own fixture pages, and each page posts its own `window.__state` to the harness, so the run is
scored from what the page recorded, even after the model closed its tab. A computer task works on fixture files in a
folder of our own inside Polycarp's agent handoff folder, and is scored by reading the agent workspace back through the
helper in connector mode (`hands.mjs`). With no task files, the runner says so and exits.

- `tasks/browser.mjs`: 15 browser tasks on local fixtures: signup validation, a contact form, a wizard, table filter,
  modal confirm, native dialogs, select and date, a form in an iframe, a long article, PDF search, pagination, a new
  tab, a late element, a list that re-renders, autocomplete.
- `tasks/computer.mjs`: 8 Mac tasks in Calculator, TextEdit and Preview, scored from the window and, for a save task,
  the saved file.

Each run is `claude -p` on the owner's sign-in. The runner refuses to start while `ANTHROPIC_API_KEY` or another key
variable (`lib.mjs` KEY_VARS) is set, and removes them from the child's environment. Each run has only the `polycarp` MCP server, a fresh throwaway headless
Chromium (`cli/test/e2e-harness.mjs`), a turn cap (30) and a wall-clock cap (240 s browser, 300 s computer).
Only a computer task's server lists the computer tools; a browser run never gets them, even with computer runs on.
The computer tools go through `polycarp-spaces mcp --connector`, which holds the model to the agent workspace and
lent apps. The runner backs up and restores the apps' preferences and closes only the app copies its own
`computer_open` calls started (`reused: false`), read from each answer as it streams in (`transcript.mjs`).

## How a run ends

Everything a run must undo registers in one registry (`cleanup.mjs`) the moment it exists: the scratch folder, the
headless Chromium, the socket folder, the handoff folder, the preferences backup, each `claude -p` and each app copy
it started. One cleanup runs the registry in reverse, exactly once, from every way out: a normal end, a thrown error,
Ctrl-C (SIGINT), SIGTERM, SIGHUP, an uncaught error, or a `claude` that is not on the PATH (one clear line, exit 1).
Each `claude -p` runs in its own process group, and cleanup kills the group (SIGTERM, up to 3 s, then SIGKILL), so
its MCP server goes with it. A computer run cut off mid-call also closes any new window of the task's app that its
answers never reported. A run cut off by a stop, before or during scoring, and a run that hit the sign-in's usage
limit, write no record, so neither replaces a committed run; a signal also writes no summary. When a preferences
restore fails, the backups are copied to `~/.local/state/polycarp-weak-model/prefs-<time>/` and the path is
printed; scratch, which holds them, is kept unless every restore worked. A computer run refuses to start when it
can't back up an app's preferences that exist.

Bad options exit 2 with the reason before anything is written: a number that isn't a whole number above 0, an
unknown `--kind`, an `--only` and `--kind` that match no task, an option with no value, a `--label` that isn't
lower-case letters, digits, `_` and `-`, or two task ids that share a page path.

## Commands

From `browser/`, after `npm run build` in `cli/` and an extension build with `TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=$PWD/dist-chrome`:

```sh
node evals/weak-model/run.mjs --list                              # the tasks a run would do; starts nothing
node evals/weak-model/run.mjs --label r2-haiku                    # all tasks, 2 trials, claude-haiku-5-5
node evals/weak-model/run.mjs --label s-sonnet --model claude-sonnet-5-5 --trials 1 --only wizard,pagination
node evals/weak-model/report.mjs r2-haiku                         # per run: calls, errors, repeats, failures
node evals/weak-model/rescore.mjs r1-haiku                        # rescore saved signup runs under the signup-v2 rule
```

Results go to `results/<label>/`: one record per run (`<task>-t<n>.json`, every call with its arguments, error flag,
size and a clipped result), kept locally, and what is committed: `runs.jsonl` (the same records, one per line) and
`summary.json` (`node evals/weak-model/summarize.mjs <label>` rebuilds both, laying local records over the committed
runs by task and trial). The stop mark is kept per kind (`stoppedKinds`): a partial rerun (`--only`, or one stopped
early) replaces only its own runs and keeps it, and a run that made every job of its kinds clears only those kinds,
so a finished browser half never clears the computer half's stop. `results/r1-haiku/classes.json` classifies every
round 1 failure.

## The ratchet

`baseline.json` holds the recorded score of each round that counts. `test/weak-model-baseline.test.mjs` fails if a
committed round scores below its baseline (recounted from `runs.jsonl`) or if the latest round drops below the floor.
CI never calls a model: it checks the committed numbers, `test/weak-model-harness.test.mjs` holds the runner's own
logic, and the cheap deterministic tests in `cli/test` hold each fix.

## Platforms

The browser half runs wherever the e2e harness runs (Chromium on Mac, Linux, Windows). The computer half needs the Mac
helper; on Linux and Windows the runner refuses computer tasks, and `computer_status` tells the model to use the
browser tools instead.
