// The side panel transcript: site-skill domain matching and the log layout (src/transcript/group.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesDomainPatterns, siteOf } from "../src/storage/stores/domain-match.ts";
import { defaultSkills, SUPERSEDED_DEFAULTS, shouldReplaceDefault } from "../src/tools/default-skills.ts";
import { FULL_CARD_TOOLS, groupTranscript, NEAR_EMPTY_THINKING, stepLabel, usageText, stepRows, callInFlight, currentRunAssistant } from "../src/transcript/group.ts";

const calendar = defaultSkills.find((s) => s.name === "google-calendar-events");

test("google-calendar-events does not match Gmail, and still matches Calendar", () => {
	for (const url of [
		"https://mail.google.com/mail/u/0/#inbox",
		"https://mail.google.com/mail/u/0/#search/older_than%3A1y",
	]) {
		assert.equal(matchesDomainPatterns(url, calendar.domainPatterns), false, url);
	}
	assert.equal(matchesDomainPatterns("https://calendar.google.com/calendar/r", calendar.domainPatterns), true);
});

test("no shipped site skill matches mail.google.com", () => {
	const matching = defaultSkills.filter((s) => matchesDomainPatterns("https://mail.google.com/mail/u/0/", s.domainPatterns));
	assert.deepEqual(
		matching.map((s) => s.name),
		[],
	);
});

test("the host must match whole: no suffix, prefix or look-alike host matches", () => {
	const p = ["calendar.google.com"];
	for (const url of [
		"https://calendar.google.com.evil.test/",
		"https://evilcalendar.google.com/",
		"https://google.com/",
		"https://mail.google.com/calendar.google.com",
	]) {
		assert.equal(matchesDomainPatterns(url, p), false, url);
	}
	assert.equal(matchesDomainPatterns("https://www.calendar.google.com/", p), true, "www. is ignored");
});

test("host and path globs, and only web pages", () => {
	assert.equal(matchesDomainPatterns("https://www.google.com/search?q=x", ["google.*/search*"]), true);
	assert.equal(matchesDomainPatterns("https://www.google.com/maps", ["google.*/search*"]), false);
	assert.equal(matchesDomainPatterns("https://docs.google.com/spreadsheets/d/1/edit", ["docs.google.com/spreadsheets/**"]), true);
	assert.equal(matchesDomainPatterns("https://docs.google.com/document/d/1", ["docs.google.com/spreadsheets/**"]), false);
	assert.equal(matchesDomainPatterns("https://mail.google.com/", ["*.google.com"]), true, "an explicit wildcard still works");
	assert.equal(matchesDomainPatterns("chrome://settings", ["settings"]), false);
	assert.equal(matchesDomainPatterns("not a url", ["*"]), false);
	assert.equal(matchesDomainPatterns("https://example.com/", ["", "  "]), false);
});

test("an unedited stored copy of the old calendar skill is replaced; an edited one is kept", () => {
	const old = { name: "google-calendar-events", lastUpdated: SUPERSEDED_DEFAULTS["google-calendar-events"][0] };
	assert.equal(shouldReplaceDefault(old, calendar), true);
	assert.equal(shouldReplaceDefault({ ...old, lastUpdated: "2026-01-02T00:00:00.000Z" }, calendar), false, "user edit");
	assert.equal(shouldReplaceDefault({ ...old, lastUpdated: calendar.lastUpdated }, calendar), false, "already current");
	assert.equal(shouldReplaceDefault({ name: "google", lastUpdated: old.lastUpdated }, defaultSkills.find((s) => s.name === "google")), false);
});

// --- transcript layout

const usage = (n) => ({ input: n, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (content, extra = {}) => ({ role: "assistant", content, usage: usage(100), stopReason: "toolUse", ...extra });
const result = (id, toolName, details, isError = false) => ({ role: "toolResult", toolCallId: id, toolName, details, isError, content: [] });
const nav = (url) => ({ role: "navigation", url, title: url });
const kinds = (blocks) => blocks.map((b) => (b.kind === "steps" ? `steps(${b.steps.map((s) => s.kind).join(",")})` : b.kind));

test("consecutive tool calls across model calls fold into one step list; text and user messages split it", () => {
	const messages = [
		{ role: "user", content: "clean up" },
		assistant([{ type: "thinking", thinking: "." }, call("a", "navigate", { url: "https://mail.google.com/" })]),
		result("a", "navigate", { finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox" }),
		assistant([{ type: "thinking", thinking: "" }, call("b", "repl", { title: "Find banner", code: "1" })]),
		result("b", "repl", {}),
		nav("https://mail.google.com/mail/u/0/#search"),
		assistant([{ type: "text", text: "Found the issue." }, call("c", "repl", { title: "Robust test", code: "1" })]),
		result("c", "repl", {}),
		assistant([call("d", "repl", { title: "Archive", code: "1" })]),
		result("d", "repl", {}),
		assistant([{ type: "text", text: "Done." }], { stopReason: "stop" }),
	];
	const { blocks } = groupTranscript(messages);
	assert.deepEqual(kinds(blocks), ["message", "steps(tool,tool,nav)", "text", "steps(tool,tool)", "text"]);
});

test("near-empty reasoning gets no row; real reasoning joins the step it led to", () => {
	const long = "The banner only appears after the page checkbox is ticked, so re-query first.";
	assert.ok(long.length >= NEAR_EMPTY_THINKING);
	const { blocks } = groupTranscript([
		assistant([{ type: "thinking", thinking: "  ok  " }, call("a", "repl", { title: "x", code: "" })]),
		assistant([{ type: "thinking", thinking: long }, call("b", "repl", { title: "y", code: "" })]),
		assistant([{ type: "thinking", thinking: long }], { stopReason: "stop" }),
	]);
	assert.deepEqual(kinds(blocks), ["steps(tool,tool,thought)"]);
	const [a, b, thought] = blocks[0].steps;
	assert.equal(a.thinking, "ok", "kept for the expanded row, no row of its own");
	assert.equal(b.thinking, long);
	assert.equal(thought.thinking, long, "reasoning with nothing after it is a row");
});

test("per-step usage rides on the step's last row, not its own block", () => {
	const { blocks } = groupTranscript([
		assistant([call("a", "repl", { title: "x", code: "" }), call("b", "repl", { title: "y", code: "" })]),
		assistant([{ type: "text", text: "hi" }], { stopReason: "stop" }),
	]);
	assert.equal(blocks[0].steps[0].usage, undefined);
	assert.equal(blocks[0].steps[1].usage.input, 100);
	assert.equal(blocks[1].kind, "text");
	assert.equal(blocks[1].usage.input, 100);
	assert.equal(usageText(usage(669)), "↑669 ↓10 $0.0010");
	assert.equal(usageText({ input: 1500, output: 1012, cacheRead: 48000, cacheWrite: 0 }), "↑1.5k ↓1.0k R48k");
});

test("a site's skills show on the first page change to it, not on every page within it", () => {
	const go = (id, url) => [
		assistant([call(id, "navigate", { url })]),
		result(id, "navigate", { finalUrl: url, title: url }),
	];
	const { blocks } = groupTranscript([
		...go("a", "https://mail.google.com/mail/u/0/#inbox"),
		...go("b", "https://mail.google.com/mail/u/0/#search/x"),
		nav("https://mail.google.com/mail/u/0/#search/y"),
		...go("c", "https://calendar.google.com/r"),
		...go("d", "https://mail.google.com/mail/u/0/"),
	]);
	assert.deepEqual(
		blocks[0].steps.map((s) => s.showSkills),
		[true, false, false, true, true],
	);
});

test("errors and stops stay visible as their own blocks", () => {
	const { blocks } = groupTranscript([
		assistant([call("a", "repl", { title: "x", code: "" })], { stopReason: "error", errorMessage: "rate limited" }),
		assistant([call("b", "repl", { title: "y", code: "" })], { stopReason: "aborted" }),
	]);
	assert.deepEqual(kinds(blocks), ["steps(tool)", "status", "steps(tool)", "status"]);
	assert.equal(blocks[1].text, "rate limited");
	assert.equal(blocks[3].status, "aborted");
});

test("artifact and tool result messages never render on their own; keys are stable as the log grows", () => {
	const base = [{ role: "user", content: "x" }, assistant([call("a", "repl", { title: "x", code: "" })]), result("a", "repl", {})];
	const first = groupTranscript(base).blocks.map((b) => b.key);
	const grown = groupTranscript([
		...base,
		{ role: "artifact", action: "create", filename: "a.md" },
		assistant([call("b", "repl", { title: "y", code: "" })]),
	]).blocks.map((b) => b.key);
	assert.deepEqual(grown, first);
});

test("row labels: the REPL title, the page title, the artifact file", () => {
	assert.equal(stepLabel(call("a", "repl", { title: "Find select-all-matching banner", code: "" })).label, "Find select-all-matching banner");
	const n = stepLabel(call("b", "navigate", { url: "https://mail.google.com/" }), result("b", "navigate", { finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox - Gmail" }));
	assert.deepEqual(n, { label: "Inbox - Gmail", detail: "mail.google.com" });
	assert.equal(stepLabel(call("c", "navigate", { url: "https://a.test/" })).label, "Open https://a.test/");
	assert.equal(stepLabel(call("d", "artifacts", { command: "create", filename: "r.md" })).label, "create r.md");
	assert.equal(siteOf("https://www.example.com/x"), "example.com");
});

test("text between tool calls in one message never repeats a block key", () => {
	const long = "A long enough piece of reasoning to get a row of its own here.";
	const { blocks } = groupTranscript([
		assistant([{ type: "thinking", thinking: long }, { type: "text", text: "Let me check." }, call("a", "repl", { title: "x", code: "" })]),
		assistant([call("b", "repl", { title: "y", code: "" }), { type: "text", text: "Now this." }, call("c", "repl", { title: "z", code: "" })]),
	]);
	const keys = blocks.map((b) => b.key);
	assert.equal(new Set(keys).size, keys.length, JSON.stringify(keys));
	assert.deepEqual(kinds(blocks), ["steps(thought)", "text", "steps(tool,tool)", "text", "steps(tool)"]);
});

test("the live message continues the site count from the stable list", () => {
	const live = [assistant([call("z", "navigate", { url: "https://mail.google.com/x" })]), result("z", "navigate", { finalUrl: "https://mail.google.com/x" })];
	assert.equal(groupTranscript(live, { lastSite: "mail.google.com" }).blocks[0].steps[0].showSkills, false);
	assert.equal(groupTranscript(live, { lastSite: "calendar.google.com" }).blocks[0].steps[0].showSkills, true);
});

test("cards the user acts on never fold into a row: artifacts and ask_user", () => {
	assert.ok(FULL_CARD_TOOLS.has("artifacts"));
	assert.ok(FULL_CARD_TOOLS.has("ask_user"), "an ask_user question folded into a row could not be answered");
});

test("a long list shows its last 5 rows; an early artifact card keeps its place in time", () => {
	const msgs = [
		assistant([call("r0", "repl", { title: "before", code: "" })]),
		assistant([call("art", "artifacts", { command: "create", filename: "r.md" })]),
	];
	for (let i = 1; i < 10; i++) msgs.push(assistant([call(`r${i}`, "repl", { title: `step ${i}`, code: "" })]));
	const { blocks } = groupTranscript(msgs);
	const rows = stepRows(blocks[0].steps, false);
	assert.deepEqual(
		rows.map((r) => (r.kind === "step" ? r.step.call.id : `+${r.count}`)),
		["+1", "art", "+4", "r5", "r6", "r7", "r8", "r9"],
	);
	assert.equal(new Set(rows.map((r) => (r.kind === "step" ? r.step.key : r.key))).size, rows.length, "keys unique");
	assert.equal(stepRows(blocks[0].steps, true).length, 11);
	assert.ok(stepRows(blocks[0].steps.slice(0, 8), false).every((r) => r.kind === "step"), "8 rows or fewer all show");
});

test("a call is in flight only in the current run", () => {
	const old = assistant([call("q1", "ask_user", { questions: [] })], { stopReason: "toolUse" });
	const cur = assistant([call("q2", "ask_user", { questions: [] })], { stopReason: "toolUse" });
	const { blocks } = groupTranscript([old, { role: "user", content: "next" }, cur]);
	const oldStep = blocks[0].steps[0];
	const curStep = blocks[2].steps[0];
	const base = { live: false, running: true, pending: false, lastAssistant: cur };
	assert.equal(callInFlight(curStep, base), true, "last message, before its tool starts");
	assert.equal(callInFlight(oldStep, base), false, "an earlier turn's call stays cut off while a new run goes");
	assert.equal(callInFlight(curStep, { ...base, pending: true }), false, "running: the tool shows its own state");
	assert.equal(callInFlight(curStep, { ...base, running: false }), false, "nothing runs: cut off");
	assert.equal(callInFlight(oldStep, { ...base, live: true, lastAssistant: undefined }), true, "the live message's calls are arriving");
	const done = { ...curStep, result: { role: "toolResult", toolCallId: "q2" } };
	assert.equal(callInFlight(done, { ...base, live: true }), false, "a call with a result is done");
	const aborted = { ...curStep, message: { ...cur, stopReason: "aborted" } };
	assert.equal(callInFlight(aborted, { ...base, lastAssistant: aborted.message }), false, "a stopped call is not in flight");
});

test("once the user speaks again, no earlier assistant message counts as the current run", () => {
	const old = assistant([call("q1", "ask_user", { questions: [] })]);
	const next = { role: "user", content: "next" };
	assert.equal(currentRunAssistant([old]), old);
	assert.equal(currentRunAssistant([old, result("q1", "ask_user", {}), nav("https://a.test/")]), old, "tool results and page notes stay in the run");
	assert.equal(currentRunAssistant([old, next]), undefined, "a new turn: the old call is cut off");
	const { blocks } = groupTranscript([old, next]);
	assert.equal(callInFlight(blocks[0].steps[0], { live: false, running: true, pending: false, lastAssistant: currentRunAssistant([old, next]) }), false);
});
