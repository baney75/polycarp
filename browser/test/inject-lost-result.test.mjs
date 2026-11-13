// injectScript when userScripts.execute comes back with no result (src/browser/inject.ts): the code runs on the
// debugger path only when the extension never heard it start, is never run twice, and leaves nothing in the page.
// Fake chrome: one page, a userScripts world whose messages reach the extension, an execute that can lose its result,
// and a debugger that evaluates in the page.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
/** Every DOM write a run makes: there must be none (first-F1 of the review of PR 260). */
const domWrites = [];
const documentElement = new Proxy({}, { get: (_t, k) => (...a) => void domWrites.push([k, ...a]) });
const listeners = [];
chrome.runtime.onUserScriptMessage = { addListener: (fn) => listeners.push(fn) };
/** The userScripts world's chrome: its messages go to the extension's onUserScriptMessage listeners. */
const worldChrome = {
	runtime: {
		sendMessage: (message) =>
			new Promise((resolve) => {
				for (const fn of listeners) fn(message, {}, resolve);
				setTimeout(() => resolve(undefined), 0);
			}),
	},
};
/** The page: what the code touches. `runs` counts each time the code under test ran. */
const page = { runs: 0 };
const run = (code, world) =>
	new Function("window", "document", "chrome", "__code", "return eval(__code)")(page, { documentElement }, world, code);
/** How execute behaves: "keep" returns the result, "lose" runs the code and returns [], "skip" returns [] unrun. */
let mode = "keep";
let evaluated = 0;
chrome.userScripts = {
	configureWorld: async () => {},
	getScripts: async () => [],
	terminate: async () => {},
	execute: async ({ js }) => {
		if (mode === "skip") return [];
		const result = await run(js[0].code, worldChrome);
		return mode === "lose" ? [] : [{ frameId: 0, result: JSON.parse(JSON.stringify(result)) }];
	},
};
const plain = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Runtime.evaluate") {
		evaluated++;
		return { result: { value: await run(params.expression, undefined) } };
	}
	if (method === "Runtime.enable" || method === "Runtime.addBinding") return {};
	return plain.call(chrome.debugger, target, method, params);
};
const { injectScript, terminateInjection } = await import("../src/browser/inject.ts");
const tabId = (await chrome.tabs.create({ url: "https://shop.example.com/" })).id;
const counted = (value) => `(window.runs++, ${value})`;
const reset = (m) => {
	mode = m;
	page.runs = 0;
	evaluated = 0;
	domWrites.length = 0;
};

test("a result userScripts kept comes back as before, the code run once, and nothing is written to the page", async () => {
	reset("keep");
	assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	assert.equal(page.runs, 1);
	assert.deepEqual(domWrites, [], "the run left a trace in the page's DOM");
});

test("userScripts lost the run before it started: the debugger path runs it once and returns its value", async () => {
	reset("skip");
	assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	assert.equal(page.runs, 1);
});

test("userScripts ran the code and lost its result: the kept result comes back, the code is not run again, the page untouched", async () => {
	reset("lose");
	assert.deepEqual(await injectScript(tabId, counted("({ title: 'Cart', n: 3 })")), { title: "Cart", n: 3 });
	assert.equal(page.runs, 1, "the code ran twice: a click or a post would repeat");
	assert.equal(evaluated, 0, "the debugger ran something");
	assert.deepEqual(domWrites, [], "the run left a trace in the page's DOM");
});

test("userScripts ran the code, kept no result, and lost it: the call fails, and the code is not run again", async () => {
	reset("lose");
	// A BigInt can't be kept as JSON; nor can a result over the cap.
	for (const value of ["10n", "'x'.repeat(300000)"]) {
		await assert.rejects(injectScript(tabId, counted(value)), /result was lost, so it was not run again.*read_page/);
	}
	assert.equal(page.runs, 2, "the code ran twice: a click or a post would repeat");
	assert.equal(evaluated, 0);
});

test("second-F4 (review of PR 260): a run stopped before it started never goes to the debugger path", async () => {
	reset("skip");
	const original = chrome.userScripts.execute;
	chrome.userScripts.execute = async (args) => {
		await terminateInjection(tabId, args.executionId);
		return original(args);
	};
	try {
		await assert.rejects(injectScript(tabId, counted("1 + 1"), { executionId: "e1" }), /stopped before it ran/);
	} finally {
		chrome.userScripts.execute = original;
	}
	assert.equal(page.runs, 0);
	assert.equal(evaluated, 0);
});

test("second-F5 (review of PR 260): the debugger can't run a run that never started: a clear not-run error", async () => {
	reset("skip");
	const original = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async () => {
		throw new Error("Another debugger is already attached to the tab with id: 1.");
	};
	try {
		await assert.rejects(injectScript(tabId, counted("1 + 1")), /Not run: .*Another debugger/);
	} finally {
		chrome.debugger.sendCommand = original;
	}
	assert.equal(page.runs, 0);
});
