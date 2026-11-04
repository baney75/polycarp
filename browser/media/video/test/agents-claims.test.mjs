// Every caption and label the Agents video shows must come from the recording. These tests run
// the render's own checks on the real capture and on doctored copies of it: a doctored copy that
// contradicts a caption must make the check throw, so the render fails instead of lying.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkAgents, checkAsk, checkCli, checkComposer, checkHandoff, checkReload, checkResume } from "../src/agents/claims.ts";

const real = JSON.parse(readFileSync(new URL("../public/capture/agents/agents.json", import.meta.url), "utf8"));
const copy = () => structuredClone(real);
const titles = (c) => checkAgents(c).agents.map((a) => a.title);
const all = (c) => {
	const t = titles(c);
	checkResume(c, t[0]);
	checkHandoff(c, t[0]);
	checkAsk(c);
	checkComposer(c, t);
	checkCli(c, t, "teapot");
	checkReload(c);
};

test("the real capture passes every check", () => {
	all(real);
	const team = checkAgents(real);
	assert.deepEqual(
		team.agents.map((a) => a.title),
		["Tabkyra · claude · shop", "Tabkyra · claude · shop 2", "Tabkyra · claude · shop 3"],
	);
	assert.equal(new Set(team.agents.map((a) => a.color)).size, 3);
	assert.match(team.refusal.text, /not owned by this session/);
	assert.match(checkHandoff(real, titles(real)[0]).news, /^The user took tab \d+ .* it's theirs now/);
	assert.equal(checkReload(real).runs, 1);
});

test("two agents in one group fail the hook", () => {
	const c = copy();
	c.agents.agent2.group = c.agents.agent1.group;
	c.groups.find((g) => g.tabs.some((t) => t.id === c.agents.agent2.tabId)).title = c.agents.agent1.group.title;
	assert.throws(() => checkAgents(c), /group/);
});

test("an agent that sees another's tab fails 'Each one sees only its own'", () => {
	const c = copy();
	c.agents.agent3.context += `\n  ${c.agents.agent1.tabId} "Copper Kettle" ${c.site}/product/kettle`;
	assert.throws(() => checkAgents(c));
});

test("a cross-talk call that succeeded fails NOT YOURS", () => {
	const c = copy();
	c.crossTalk.isError = false;
	c.crossTalk.text = '{"selected":true}';
	assert.throws(() => checkAgents(c), /wasn't refused/);
});

test("a restart that lost a tab fails 'Its tabs come back'", () => {
	const c = copy();
	c.resume.after = c.resume.after.split("\n").slice(0, 2).join("\n");
	assert.throws(() => checkResume(c, titles(c)[0]), /restarted agent/);
});

test("a hand-off the agent wasn't told about fails 'Now it's yours'", () => {
	const c = copy();
	c.handoff.context = c.handoff.context
		.split("\n")
		.filter((l) => !l.startsWith("News:"))
		.join("\n");
	assert.throws(() => checkHandoff(c, titles(c)[0]), /News/);
	const d = copy();
	d.handoff.tabAfter.groupId = 7;
	assert.throws(() => checkHandoff(d, titles(d)[0]), /still in a group/);
});

test("an answer the agent didn't get, or didn't use, fails 'It gets your answer'", () => {
	const c = copy();
	c.ask.result = "No answer: the user skipped the question.";
	assert.throws(() => checkAsk(c), /didn't get/);
	const d = copy();
	d.ask.after.fills[1].args.value = "PayPal sandbox";
	assert.throws(() => checkAsk(d), /didn't use the answer/);
});

/** A copy whose recorded chat ends with `reply` as the agent's last message. */
const withFinalReply = (c, reply) => {
	const at = c.threadShown.lastIndexOf("] assistant: ");
	c.threadShown = `${c.threadShown.slice(0, at)}] assistant: ${reply}`;
	return c;
};

test("a side panel run that never read the tab fails the composer beat", () => {
	const c = copy();
	c.composer.transcript = `${c.composer.task}\nI don't have access to the page.`;
	c.threadShown = c.threadShown.replace(/\[\d+\] toolResult: [^\n]*steel infuser[^\n]*\n/g, "");
	assert.throws(() => checkComposer(c, titles(c)), /never read/);
	const d = copy();
	d.composer.atAll = d.composer.atAll.map((r) => r.replace(/ used by agent .*? 127/, " 127"));
	assert.throws(() => checkComposer(d, titles(d)), /in use/);
});

test("a failed CLI command or a search with no hit fails the terminal beat", () => {
	const c = copy();
	c.cli.sessions.code = 1;
	assert.throws(() => checkCli(c, titles(c), "teapot"), /exited 1/);
	const d = copy();
	d.cli.threads.out = 'No threads mention "teapot".';
	assert.throws(() => checkCli(d, titles(d), "teapot"), /didn't find/);
});

test("a click that ran twice, or a cut-off call with no advice, fails the reload beat", () => {
	const c = copy();
	c.reload.ordersAfter = c.reload.ordersBefore + 2;
	assert.throws(() => checkReload(c), /ran 2 times/);
	const d = copy();
	d.reload.call.text = "interrupted: the connection dropped.";
	assert.throws(() => checkReload(d), /check the page/);
});

test("review F1: the @ chip's tab title can't stand in for reading the page", () => {
	// The chip line ("Stoneware Teapot · Fernhill Goods", 127.0.0.1) stays; the reply says nothing from the page.
	const c = withFinalReply(copy(), "I can't access that page.");
	c.composer.transcript = `${c.composer.task}\n\nStoneware Teapot · Fernhill Goods\n127.0.0.1\n\nI can't access that page.`;
	assert.throws(() => checkComposer(c, titles(c)), /never read/);
	// A reply that only repeats the title is no better.
	const d = withFinalReply(copy(), "Stoneware Teapot from Fernhill Goods: a stoneware teapot.");
	assert.throws(() => checkComposer(d, titles(d)), /never read/);
	// Nor is a run that read some other page.
	const e = copy();
	e.threadShown = e.threadShown.replace(/-> navigate\(\{"url":"[^"]*"/, '-> navigate({"url":"http://127.0.0.1:1/product/kettle"');
	assert.throws(() => checkComposer(e, titles(e)), /referenced tab/);
});

test("review F7: agent 1's title can't be matched inside 'shop 2' or 'shop 3'", () => {
	const c = copy();
	c.composer.atAll = c.composer.atAll.map((r) => (r.startsWith("Copper Kettle") ? r.replace(/ used by agent .*? 127/, " 127") : r));
	assert.throws(() => checkComposer(c, titles(c)), /claude · shop's tab/);
	for (const key of ["sessions", "tabs"]) {
		const d = copy();
		const t = titles(d)[0];
		// Drop every line naming agent 1's group exactly; "… shop 2" and "… shop 3" stay.
		d.cli[key].out = d.cli[key].out
			.split("\n")
			.filter((l) => !new RegExp(`${t}(?! \\d)`).test(l))
			.join("\n");
		assert.throws(() => checkCli(d, titles(d), "teapot"), /doesn't show Tabkyra · claude · shop$/);
	}
});

test("review F8: the hand-off must be agent 1's", () => {
	const c = copy();
	c.handoff.context = c.handoff.context.replace(/^Session \S+ \| group "[^"]*"/, 'Session shop-x-2 | group "Tabkyra · claude · shop 2"');
	assert.throws(() => checkHandoff(c, titles(c)[0]), /another agent's session/);
	const d = copy();
	d.handoff.groupBefore = { ...d.groups.find((g) => g.title.endsWith("shop 3")), tabs: [...d.handoff.groupBefore.tabs] };
	assert.throws(() => checkHandoff(d, titles(d)[0]), /not agent 1's/);
	const e = copy();
	e.handoff.tabAfter.id = e.handoff.tabId + 1;
	assert.throws(() => checkHandoff(e, titles(e)[0]), /isn't the one handed off/);
});

test("review F6: 'Its tabs stay put' compares the tab ids kept while agent 1 was closed", () => {
	const c = copy();
	const g = c.resume.groupsWhileClosed.find((x) => x.title === titles(c)[0]);
	g.tabs = g.tabs.map((t, i) => (i === 1 ? { ...t, id: t.id + 1000 } : t));
	assert.throws(() => checkResume(c, titles(c)[0]), /held .* while it was closed/);
});
