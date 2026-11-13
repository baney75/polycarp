// The weak-model eval's ratchet (evals/weak-model/README.md). CI never calls a model: it checks the committed results.
// A round that counts is listed in baseline.json with the score it recorded and what it ran under (model, profile, tool
// count per kind, task set); its summary.json must not score lower and must match that, the latest round for each model
// and profile must hold the floor, each classes.json must count what its runs hold, and the committed read-size
// measurement must stay inside its token budget.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkClasses, checkRound } from "../evals/weak-model/lib.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "weak-model");
const baseline = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8"));
const summary = (label) => JSON.parse(readFileSync(join(dir, "results", label, "summary.json"), "utf8"));
const runsOf = (label) => readFileSync(join(dir, "results", label, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("every recorded round scores what its baseline says, under what it says, and its runs are on disk", () => {
	for (const [label, want] of Object.entries(baseline.rounds)) {
		// The score is the transcripts' own (recounted from runs.jsonl), and like is compared with like: a rerun with
		// another model, another tool list or another task set fails here instead of raising the round.
		const runs = runsOf(label);
		assert.deepEqual(checkRound(label, want, summary(label), runs), []);
		for (const r of runs) assert.ok(Array.isArray(r.calls) && r.calls.length > 0, `${label}: ${r.task} t${r.trial} has no calls`);
	}
});

test("the latest round for each model and profile holds the floor", () => {
	for (const [key, floor] of Object.entries(baseline.floor)) {
		const s = summary(baseline.latest[key]);
		assert.ok(s.passed / s.total >= floor, `${key} (${baseline.latest[key]}): ${s.passed}/${s.total} is under ${floor}`);
	}
});

test("a first look stays inside its budget: interactive read_page on 8 public pages", { skip: !baseline.readSize && "no read budget recorded yet" }, () => {
	const m = JSON.parse(readFileSync(join(dir, "results", `read-size-${baseline.readSize.label}.json`), "utf8"));
	assert.ok(m.interactive.median <= baseline.readSize.medianTokens, `median ${m.interactive.median} tokens`);
	assert.ok(m.interactive.max <= baseline.readSize.maxTokens, `max ${m.interactive.max} tokens`);
	assert.equal(m.pages.filter((p) => p.interactive !== undefined).length, 8, "all 8 pages measured");
});

// The safety tasks are held one by one, not only in the total: a rule that loosens (a lookup that books, a typed
// password) shows up here even when other tasks make up the score.
test("guarded tasks keep every pass they recorded", { skip: !baseline.guard && "no guarded tasks yet" }, () => {
	for (const [label, tasks] of Object.entries(baseline.guard)) {
		const s = summary(label);
		for (const [id, want] of Object.entries(tasks)) {
			assert.ok(s.tasks[id], `${label} has no ${id} runs`);
			assert.ok(s.tasks[id].pass >= want, `${label} ${id}: ${s.tasks[id].pass}/${s.tasks[id].of}, baseline ${want}`);
		}
	}
});

test("every classification counts what its round's runs hold", () => {
	const labels = Object.keys(baseline.rounds).filter((l) => existsSync(join(dir, "results", l, "classes.json")));
	assert.ok(labels.length > 0, "no classes.json to check");
	for (const label of labels) {
		const classes = JSON.parse(readFileSync(join(dir, "results", label, "classes.json"), "utf8"));
		assert.deepEqual(checkClasses(classes, runsOf(label)), [], label);
	}
});
