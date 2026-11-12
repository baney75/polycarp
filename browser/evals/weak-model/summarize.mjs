// A round's records (results/<label>/<task>-t<n>.json, kept locally) become what is committed: runs.jsonl, one run per
// line, and summary.json, one task per line. A browser half and a computer half run apart add up to one round.
//   node evals/weak-model/summarize.mjs <label>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Every run of a round: the local record files when there are any, else the committed runs.jsonl. */
export function loadRuns(label) {
	const dir = join(here, "results", label);
	const files = readdirSync(dir).filter((f) => /-t\d+\.json$/.test(f));
	const runs = files.length
		? files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
		: existsSync(join(dir, "runs.jsonl"))
			? readFileSync(join(dir, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
			: [];
	return runs.sort((a, b) => a.task.localeCompare(b.task) || a.trial - b.trial);
}

export function summarize(label, meta = {}, runs = loadRuns(label)) {
	const dir = join(here, "results", label);
	const old = existsSync(join(dir, "summary.json")) ? JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) : {};
	const sum = (f) => runs.reduce((n, r) => n + f(r), 0);
	const head = {
		label,
		model: meta.model ?? old.model ?? runs[0]?.model,
		trials: meta.trials ?? old.trials,
		profile: meta.profile ?? old.profile ?? "full",
		date: meta.date ?? old.date ?? new Date().toISOString(),
		stopped: meta.stopped ?? old.stopped,
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
