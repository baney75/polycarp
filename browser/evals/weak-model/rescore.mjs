// Rescores the signup task in rounds recorded before its rule changed (signup-rule.mjs), from the saved transcripts,
// and rewrites runs.jsonl and summary.json. A rescored run keeps its old verdict in `before`.
//   node evals/weak-model/rescore.mjs r1-haiku r2-haiku r2-small s-sonnet
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rescoreSignup } from "./signup-rule.mjs";
import { loadRuns, summarize } from "./summarize.mjs";

const here = dirname(fileURLToPath(import.meta.url));

for (const label of process.argv.slice(2)) {
	const runs = loadRuns(label);
	for (const run of runs) {
		if (run.task !== "signup-validation" || run.rule === "signup-v2") continue;
		const why = rescoreSignup(run);
		run.before = { pass: run.pass, why: run.why };
		run.pass = why.length === 0;
		run.why = why;
		run.rule = "signup-v2";
		const file = join(here, "results", label, `${run.task}-t${run.trial}.json`);
		if (existsSync(file)) writeFileSync(file, JSON.stringify(run, null, "\t"));
		console.log(`${label} t${run.trial}: ${run.before.pass ? "pass" : "FAIL"} -> ${run.pass ? "pass" : "FAIL"}${why.length ? ` (${why.join("; ")})` : ""}`);
	}
	const s = summarize(label, {}, runs);
	console.log(`${label}: ${s.passed}/${s.total}`);
}
