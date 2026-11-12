// A round's records (results/<label>/<task>-t<n>.json, kept locally) become what is committed: runs.jsonl, one run per
// line, and summary.json, one task per line. A browser half and a computer half run apart add up to one round.
//   node evals/weak-model/summarize.mjs <label>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Every run of a round: the committed runs.jsonl, with each local record file laid over it by task and trial, so a
 * partial rerun replaces only the runs it made.
 */
export function loadRuns(label, root = join(here, "results")) {
	const dir = join(root, label);
	const byRun = new Map();
	const key = (r) => `${r.task}\t${r.trial}`;
	if (existsSync(join(dir, "runs.jsonl")))
		for (const l of readFileSync(join(dir, "runs.jsonl"), "utf8").split("\n").filter(Boolean)) byRun.set(key(JSON.parse(l)), JSON.parse(l));
	for (const f of readdirSync(dir).filter((n) => /-t\d+\.json$/.test(n))) {
		const r = JSON.parse(readFileSync(join(dir, f), "utf8"));
		byRun.set(key(r), r);
	}
	return [...byRun.values()].sort((a, b) => a.task.localeCompare(b.task) || a.trial - b.trial);
}

/**
 * Writes summary.json and runs.jsonl. The model and trials come from the merged runs, never from one rerun. `stopped`
 * is set by a run that stopped (meta.stopped true), cleared only by a run that made every job of the round
 * (meta.complete true), and otherwise kept: a partial rerun never clears it.
 */
export function summarize(label, meta = {}, runs = loadRuns(label, meta.root), root = meta.root ?? join(here, "results")) {
	const dir = join(root, label);
	const old = existsSync(join(dir, "summary.json")) ? JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) : {};
	const sum = (f) => runs.reduce((n, r) => n + f(r), 0);
	const head = {
		label,
		model: [...new Set(runs.map((r) => r.model).filter(Boolean))].sort().join(",") || old.model,
		trials: runs.length ? Math.max(...runs.map((r) => r.trial)) : old.trials,
		profile: meta.profile ?? old.profile ?? "full",
		date: meta.date ?? old.date ?? new Date().toISOString(),
		stopped: meta.stopped === true || (meta.complete !== true && old.stopped === true) || undefined,
		passed: runs.filter((r) => r.pass).length,
		total: runs.length,
		calls: sum((r) => r.calls.length),
		toolErrors: sum((r) => r.calls.filter((c) => c.error).length),
		resultChars: sum((r) => r.calls.reduce((n, c) => n + (c.chars ?? 0), 0)),
	};
	const tasks = [...new Set(runs.map((r) => r.task))].sort().map((id) => {
		const rs = runs.filter((r) => r.task === id);
		return [id, { pass: rs.filter((r) => r.pass).length, of: rs.length, calls: rs.map((r) => r.calls.length), errors: rs.map((r) => r.calls.filter((c) => c.error).length) }];
	});
	const lines = Object.entries(head)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`);
	const body = tasks.map(([id, t], i) => `\t\t${JSON.stringify(id)}: ${JSON.stringify(t)}${i < tasks.length - 1 ? "," : ""}`);
	writeFileSync(join(dir, "summary.json"), `{\n${lines.join("\n")}\n\t"tasks": {\n${body.join("\n")}\n\t}\n}\n`);
	writeFileSync(join(dir, "runs.jsonl"), `${runs.map((r) => JSON.stringify(r)).join("\n")}\n`);
	return { ...head, tasks: Object.fromEntries(tasks) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const label = process.argv[2];
	if (!label) {
		console.error("usage: node evals/weak-model/summarize.mjs <label>");
		process.exit(2);
	}
	const s = summarize(label);
	console.log(`${label}: ${s.passed}/${s.total}, ${s.calls} calls, ${s.toolErrors} tool errors, ${Math.round(s.resultChars / 1000)}k result chars`);
}
