// Reads a round's transcripts and prints what a person classifying failures needs: per run the outcome, every
// tool error with its text, repeated calls, and setup calls before the first real action.
//   node evals/weak-model/report.mjs <label> [--task id]
import { loadRuns } from "./summarize.mjs";

const [label, ...rest] = process.argv.slice(2);
if (!label || label.startsWith("--")) {
	console.error("usage: node evals/weak-model/report.mjs <label> [--task id]");
	process.exit(2);
}
const onlyTask = rest.includes("--task") ? rest[rest.indexOf("--task") + 1] : undefined;
const runs = loadRuns(label).filter((r) => !onlyTask || r.task === onlyTask);

const SETUP = new Set(["skill_match", "skill_read", "tabs_context", "status", "session_info", "computer_status", "computer_windows", "computer_workspaces"]);
let errors = 0;
let calls = 0;
let chars = 0;
for (const r of runs) {
	calls += r.calls.length;
	const errs = r.calls.filter((c) => c.error);
	errors += errs.length;
	chars += r.calls.reduce((n, c) => n + (c.chars ?? 0), 0);
	const setup = r.calls.findIndex((c) => !SETUP.has(c.tool));
	const seen = new Map();
	for (const c of r.calls) {
		const key = `${c.tool} ${JSON.stringify(c.args)}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	const repeats = [...seen].filter(([, n]) => n > 1);
	console.log(`${r.pass ? "pass" : "FAIL"} ${r.task} t${r.trial}: ${r.calls.length} calls, ${errs.length} errors, ${setup < 0 ? r.calls.length : setup} setup, ${r.stop}${r.pass ? "" : ` | ${r.why.join("; ")}`}`);
	console.log(`   tools: ${r.calls.map((c) => c.tool + (c.error ? "!" : "")).join(" ")}`);
	for (const c of errs) console.log(`   ERR ${c.tool} ${JSON.stringify(c.args).slice(0, 160)}\n       -> ${(c.result ?? "").replace(/\n/g, " | ").slice(0, 300)}`);
	for (const [key, n] of repeats) console.log(`   x${n} ${key.slice(0, 160)}`);
	if (!r.pass) console.log(`   final: ${(r.final ?? "").replace(/\n/g, " ").slice(0, 400)}`);
}
console.log(`\n${runs.filter((r) => r.pass).length}/${runs.length} passed, ${calls} calls, ${errors} tool errors, ${Math.round(chars / 1000)}k result chars`);
