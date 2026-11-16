#!/usr/bin/env node
// The compaction eval: the weak-model runner on compaction/tasks with Claude Code's auto-compact moved early, so each
// long task passes the compaction point mid-task. Same flags as weak-model/run.mjs; results go to compaction/results.
//   node evals/compaction/run.mjs --label c1-haiku --model haiku --trials 3 --kind browser [--window 100000 --pct 30]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
/** Takes `--name value` out of argv, or the default. */
const take = (name, def) => {
	const i = argv.indexOf(`--${name}`);
	if (i < 0) return def;
	const [, v] = argv.splice(i, 2);
	return v;
};
// Compaction fires when the context passes pct% of the window: 30% of 100k is 30k, past the first turn's ~20k of
// instructions and tools, so a task's page reads fill the rest and compaction runs a few pages in.
const window_ = take("window", "100000");
const pct = take("pct", "30");
const env = {
	...process.env,
	CLAUDE_CODE_AUTO_COMPACT_WINDOW: window_,
	CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: pct,
	WM_TASKS_DIR: join(here, "tasks"),
	WM_RESULTS_DIR: join(here, "results"),
};
const child = spawn(process.execPath, [join(here, "../weak-model/run.mjs"), ...argv], { env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
