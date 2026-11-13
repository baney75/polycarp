// The weak-model eval's ratchet (evals/weak-model/README.md). CI never calls a model: it checks the committed results.
// A round that counts is listed in baseline.json with the score it recorded; its summary.json must not score lower, the
// best round must hold the floor, and the committed read-size measurement must stay inside its token budget.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "evals", "weak-model");
const baseline = JSON.parse(readFileSync(join(dir, "baseline.json"), "utf8"));
const summary = (label) => JSON.parse(readFileSync(join(dir, "results", label, "summary.json"), "utf8"));

test("every recorded round scores what its baseline says, and its runs are on disk", () => {
	for (const [label, want] of Object.entries(baseline.rounds)) {
		const s = summary(label);
		assert.equal(s.total, want.total, `${label}: ${s.total} runs, baseline has ${want.total}`);
		assert.ok(s.passed >= want.passed, `${label}: ${s.passed}/${s.total} passed, baseline ${want.passed}`);
		// The score is the transcripts' own: recount it from runs.jsonl, one run per line.
		const runs = readFileSync(join(dir, "results", label, "runs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(runs.length, s.total, `${label}: runs.jsonl has ${runs.length} runs`);
		assert.equal(runs.filter((r) => r.pass).length, s.passed, `${label}: summary.json disagrees with its runs`);
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
