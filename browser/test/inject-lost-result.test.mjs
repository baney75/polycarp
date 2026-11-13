// injectScript when userScripts.execute comes back with no result (src/browser/inject.ts): the code runs on the
// debugger path only when the page shows it never ran, and is never run twice. Fake chrome: one page whose DOM both
// worlds share, a userScripts.execute that can lose its result, and a debugger that evaluates in the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const attrs = new Map();
const documentElement = {
	setAttribute: (k, v) => void attrs.set(k, String(v)),
	getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
	removeAttribute: (k) => void attrs.delete(k),
};
/** The page: what the code touches. `runs` counts each time the code under test ran. */
const page = { runs: 0 };
const run = (code) =>
	new Function("window", "document", "setTimeout", "__code", "return eval(__code)")(page, { documentElement }, () => 0, code);
/** How execute behaves: "keep" returns the result, "lose" runs the code and returns [], "skip" returns [] unrun. */
let mode = "keep";
let docs = ["doc-1"];
chrome.userScripts = {
	configureWorld: async () => {},
	getScripts: async () => [],
	execute: async ({ js }) => {
		if (mode === "skip") return [];
		const result = await run(js[0].code);
		return mode === "lose" ? [] : [{ frameId: 0, result: JSON.parse(JSON.stringify(result)) }];
	},
};
chrome.webNavigation.getFrame = async () => ({ documentId: docs.length > 1 ? docs.shift() : docs[0] });
const plain = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Runtime.evaluate") return { result: { value: await run(params.expression) } };
	if (method === "Runtime.enable" || method === "Runtime.addBinding") return {};
	return plain.call(chrome.debugger, target, method, params);
};
const { injectScript } = await import("../src/browser/inject.ts");
const tabId = (await chrome.tabs.create({ url: "https://shop.example.com/" })).id;
const counted = (value) => `(window.runs++, ${value})`;
const reset = (m) => {
	mode = m;
	page.runs = 0;
	docs = ["doc-1"];
};

test("a result userScripts kept comes back as before, the code run once", async () => {
	reset("keep");
	assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	assert.equal(page.runs, 1);
});

test("userScripts lost the run before it started: the debugger path runs it once and returns its value", async () => {
	reset("skip");
	assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	assert.equal(page.runs, 1);
});

test("userScripts ran the code and lost its result: the kept result comes back, and the code is not run again", async () => {
	reset("lose");
	assert.deepEqual(await injectScript(tabId, counted("({ title: 'Cart', n: 3 })")), { title: "Cart", n: 3 });
	assert.equal(page.runs, 1, "the code ran twice: a click or a post would repeat");
});

test("userScripts ran the code, kept no result, and lost it: the call fails, and the code is not run again", async () => {
	reset("lose");
	// A BigInt can't be kept as JSON, so the page holds only the mark.
	await assert.rejects(injectScript(tabId, counted("10n")), /result was lost, so it was not run again.*read_page/);
	assert.equal(page.runs, 1, "the code ran twice: a click or a post would repeat");
});

test("the run's document is gone (the code navigated): the call fails, and the code is not run again", async () => {
	reset("skip");
	docs = ["doc-1", "doc-2"];
	await assert.rejects(injectScript(tabId, counted("1 + 1")), /result was lost, so it was not run again/);
	assert.equal(page.runs, 0);
});
