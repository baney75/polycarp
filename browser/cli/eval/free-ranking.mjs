#!/usr/bin/env node
// Merge free-models.mjs result files into src/models/free-ranking.json, the order Free mode ships.
// Best first: tasks passed / runs, then fewer tool calls, then fewer seconds. The free router is
// left out: it always runs last. test/free-mode.test.mjs holds the file to this order.
//
//   node cli/eval/free-ranking.mjs results-a.json [results-b.json ...] [--dry-run]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
// A run still rate-limited measured availability, not ability: when a later run measured the same
// model, task and rep, that row replaces it. A pair that was never measured stays a failure.
const rows = [];
for (const row of runs.flatMap((r) => r.rows)) {
	const i = rows.findIndex((r) => r.model === row.model && r.task === row.task && r.rep === row.rep);
	if (i === -1) rows.push(row);
	else if (rows[i].limited && !row.limited) rows[i] = row;
}
const tasks = [...new Set(runs.flatMap((r) => r.tasks ?? []))];
const date = runs.map((r) => r.date).sort().at(-1).slice(0, 10);
for (const r of runs)
	if (r.usageBefore !== r.usageAfter) throw new Error(`a run's key usage moved (${r.usageBefore} -> ${r.usageAfter}); not writing`);

const repsOf = (id) => Math.max(...rows.filter((r) => r.model === id).map((r) => r.rep));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ids = [...new Set(rows.map((r) => r.model))].filter((id) => id !== "openrouter/free");
const scored = ids
	.map((id) => {
		const own = rows.filter((r) => r.model === id);
		const passed = own.filter((r) => r.success).length;
		return {
			id,
			score: Number((passed / own.length).toFixed(3)),
			passed,
			runs: own.length,
			meanToolCalls: Number(mean(own.map((r) => r.calls.length)).toFixed(1)),
			meanSeconds: Number(mean(own.map((r) => r.seconds)).toFixed(1)),
			rateLimited: own.filter((r) => r.limited).length,
		};
	})
	.sort((a, b) => b.score - a.score || a.meanToolCalls - b.meanToolCalls || a.meanSeconds - b.meanSeconds);
// A model rate-limited on every run was never measured: it is left out, so at run time it ranks
// with the unmeasured models instead of being dropped as a model that passed nothing.
const unmeasured = scored.filter((m) => m.rateLimited === m.runs).map((m) => m.id);
const models = scored.filter((m) => m.rateLimited < m.runs);

const repsLine = () => {
	const more = models.filter((m) => repsOf(m.id) > 1);
	return more.length
		? `1 rep per task, ${Math.max(...more.map((m) => repsOf(m.id)))} for ${more.map((m) => m.id).join(", ")}`
		: "1 rep per task";
};
const ranking = {
	measuredAt: date,
	method: `cli/eval/free-models.mjs: tasks ${tasks.join(", ")} on the fixture site through Tabkyra's MCP tools in a headless Chromium, ${repsLine()}; score = tasks passed / runs, ties by fewer tool calls then fewer seconds. A run still rate-limited after three retries was rerun (--retry-limited); one never measured counts as a failure. Merged by cli/eval/free-ranking.mjs.`,
	models,
	unmeasured,
};
console.log("| Rank | Model | Passed | Score | Mean tool calls | Mean seconds | Rate-limited runs |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
models.forEach((m, i) => console.log(`| ${i + 1} | ${m.id} | ${m.passed}/${m.runs} | ${m.score} | ${m.meanToolCalls} | ${m.meanSeconds} | ${m.rateLimited} |`));
const router = rows.filter((r) => r.model === "openrouter/free");
if (unmeasured.length) console.log(`\nRate-limited on every run, left unmeasured: ${unmeasured.join(", ")}`);
if (router.length) console.log(`\nopenrouter/free (not ranked, always last): ${router.filter((r) => r.success).length}/${router.length}`);
if (!process.argv.includes("--dry-run")) {
	writeFileSync(join(repo, "src", "models", "free-ranking.json"), `${JSON.stringify(ranking, null, "\t")}\n`);
	console.log("\nWrote src/models/free-ranking.json");
}
