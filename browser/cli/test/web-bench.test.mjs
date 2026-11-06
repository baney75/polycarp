// The benchmark's own logic, with no browser or model: the same seed picks the same tasks, the grader sees the end of a
// run, a run that hits a usage message stops, and a missing verdict can't count as a pass.
import assert from "node:assert/strict";
import test from "node:test";
import { graderPrompt, isQuotaStop, parseVerdict, stratifiedSample, summarize, transcriptOf } from "../eval/web-bench.mjs";

const tasks = Array.from({ length: 300 }, (_, i) => ({ task_id: `t${i}`, task: `task ${i}`, level: i < 80 ? "easy" : i < 223 ? "medium" : "hard" }));

test("a sample is repeatable and keeps the set's mix of difficulty", () => {
	const a = stratifiedSample(tasks, 30, 1);
	assert.deepEqual(a.map((t) => t.task_id), stratifiedSample(tasks, 30, 1).map((t) => t.task_id));
	assert.notDeepEqual(a.map((t) => t.task_id), stratifiedSample(tasks, 30, 2).map((t) => t.task_id));
	assert.equal(a.length, 30);
	const count = (level) => a.filter((t) => t.level === level).length;
	assert.equal(count("easy"), 8);
	assert.equal(count("medium"), 14);
	assert.equal(count("hard"), 8);
	assert.equal(new Set(a.map((t) => t.task_id)).size, 30);
});

test("the grader's transcript keeps the end of a long run", () => {
	const steps = Array.from({ length: 200 }, (_, i) => ({ tool: "click", input: { ref: i }, output: "x".repeat(2000) + `END${i}` }));
	const text = transcriptOf(steps, 20000);
	assert.ok(text.length <= 21000);
	assert.match(text, /"ref":199/);
	assert.doesNotMatch(text, /"ref":0\}/);
	assert.match(text, /earlier steps left out/);
});

test("the grader is told a confident answer with no evidence fails", () => {
	assert.match(graderPrompt({ task: "t", website: "w" }, "a", "x"), /no supporting evidence in the transcript fails/);
});

test("only a real verdict counts", () => {
	assert.equal(parseVerdict('here: {"verdict":"pass","blocked":false,"reason":"r"}').verdict, "pass");
	assert.equal(parseVerdict('{"verdict":"maybe"}'), null);
	assert.equal(parseVerdict("no json"), null);
});

test("usage and billing messages stop the run; ordinary failures don't", () => {
	assert.ok(isQuotaStop("Claude usage limit reached"));
	assert.ok(isQuotaStop("Your credit balance is too low"));
	assert.ok(!isQuotaStop("The page says the item is out of stock"));
});

test("the summary separates impossible tasks and compares the same tasks", () => {
	const s = summarize([
		{ verdict: "pass", level: "easy", ms: 1000, toolCalls: 4, reference: "pass", referenceMs: 2000 },
		{ verdict: "fail", level: "hard", ms: 3000, toolCalls: 9, blocked: true, reference: "pass", referenceMs: 4000 },
		{ verdict: "impossible", level: "hard", ms: 2000, toolCalls: 6, reference: "impossible", referenceMs: 3000 },
	]);
	assert.equal(s.passRate, 33.3);
	assert.equal(s.passRateExclImpossible, 50);
	assert.equal(s.blocked, 1);
	assert.deepEqual(s.byLevel.hard, { pass: 0, total: 2 });
	assert.equal(s.referenceOnSameTasks.passed, 2);
});
