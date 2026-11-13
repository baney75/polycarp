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
import { checkClasses, checkGuard, checkRound, checkSteps } from "../evals/weak-model/lib.mjs";

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
// The count is the transcripts' own: a summary.json edited to say 2 while runs.jsonl holds a lookup that booked fails.
// A guard's floors hold for the newest round run like the one it was set on (same model, profile and tasks): a later
// round of the same tasks is the current proof, and it must meet every floor.
const newest = (label) => {
	const like = (a, b) => a.model === b.model && a.profile === b.profile && JSON.stringify(a.tasks) === JSON.stringify(b.tasks);
	const want = baseline.rounds[label];
	assert.ok(want, `guard ${label} is not a recorded round`);
	return Object.entries(baseline.rounds)
		.filter(([, r]) => like(r, want))
		.map(([l]) => l)
		.sort((a, b) => Date.parse(summary(a).date) - Date.parse(summary(b).date))
		.at(-1);
};

test("guarded tasks keep every pass they recorded, in the newest round of those tasks", { skip: !baseline.guard && "no guarded tasks yet" }, () => {
	for (const [label, tasks] of Object.entries(baseline.guard)) {
		const now = newest(label);
		assert.deepEqual(checkGuard(now, tasks, summary(now), runsOf(now)), []);
	}
});

test("the guard recounts from runs.jsonl: an edited summary.json can't hide a failed run (PR 201 second-F7)", () => {
	const runs = [
		{ task: "booking-lookup", trial: 1, pass: true },
		{ task: "booking-lookup", trial: 2, pass: false },
	];
	const edited = { tasks: { "booking-lookup": { pass: 2, of: 2 } } };
	const wrong = checkGuard("rX", { "booking-lookup": 2 }, edited, runs);
	assert.ok(wrong.some((w) => /summary\.json says 2\/2, runs\.jsonl holds 1\/2/.test(w)), wrong.join("; "));
	assert.ok(wrong.some((w) => /1\/2 in runs\.jsonl, baseline 2/.test(w)), wrong.join("; "));
	assert.deepEqual(checkGuard("rX", { "booking-lookup": 1 }, { tasks: { "booking-lookup": { pass: 1, of: 2 } } }, runs), []);
});

// The newest guarded round is the proof for the code it ships with: its runs must show what this commit's tools say. skill_match's
// no-skill answer is the check: a run made on another build shows another one (PR 201 first-F3).
test("guarded rounds ran this build's skill_match", { skip: !baseline.guard && "no guarded tasks yet" }, () => {
	const mcp = readFileSync(join(dir, "..", "..", "cli", "src", "mcp.ts"), "utf8");
	const none = mcp.match(/return 'none: ([^.']*\.)/)?.[1];
	assert.ok(none, "skill_match's no-skill answer is found in cli/src/mcp.ts");
	for (const label of Object.keys(baseline.guard).map(newest))
		for (const r of runsOf(label))
			for (const c of r.calls.filter((c) => c.tool === "skill_match" && typeof c.result === "string" && c.result.startsWith("none")))
				assert.ok(c.result.startsWith(`none: ${none}`), `${label} ${r.task} t${r.trial}: skill_match said ${JSON.stringify(c.result.slice(0, 90))}, this build says "none: ${none}"`);
});

// Steps are held too: the System Settings tasks took 4.3 and 7.3 calls on Haiku before click by text, 3.3 and 6.3
// after. The newest round run like the one a ceiling was set on must stay under it (spaces/bench/ratchet.py holds the
// live bench the same way once System Settings can run there).
test("step ceilings hold in the newest round of those tasks", { skip: !baseline.steps && "no step ceilings yet" }, () => {
	for (const [label, tasks] of Object.entries(baseline.steps)) {
		const now = newest(label);
		assert.deepEqual(checkSteps(now, tasks, runsOf(now)), []);
	}
});

test("a step ceiling counts calls from runs.jsonl, and the rounds before click by text break it", () => {
	const runs = (n) => n.map((k, i) => ({ task: "t", trial: i + 1, calls: Array(k).fill({ tool: "click" }) }));
	assert.deepEqual(checkSteps("rX", { t: 3.4 }, runs([3, 3, 4])), []);
	assert.match(checkSteps("rX", { t: 3.4 }, runs([5, 4, 4])).join(";"), /4\.33 calls a run, ceiling 3\.4/);
	assert.match(checkSteps("rX", { t: 3 }, []).join(";"), /no t runs/);
	if (!baseline.steps) return;
	for (const [label, tasks] of Object.entries(baseline.steps)) {
		const before = label.replace(/^s\d+-/, "s0-");
		if (before !== label && baseline.rounds[before]) assert.notDeepEqual(checkSteps(before, tasks, runsOf(before)), [], `${before} ran before the gain and must break ${label}'s ceilings`);
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
