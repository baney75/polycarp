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
const documentElement = new Proxy(
	{},
	{
		get: (_t, k) => (...a) => void domWrites.push([k, ...a]),
		set: (_t, k, v) => (domWrites.push(["set", k, v]), true),
	},
);
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
/** How execute behaves: "keep" returns the result, "lose" runs the code and returns [], "skip" returns [] unrun,
 * "late" returns [] at once and starts the run only once the debugger path is under way. */
let mode = "keep";
let evaluated = 0;
let late;
/** Every debugger command sent, by method. */
const sent = [];
chrome.userScripts = {
	configureWorld: async () => {},
	getScripts: async () => [],
	terminate: async () => {},
	execute: async ({ js }) => {
		if (mode === "skip") return [];
		if (mode === "late") {
			late = () => run(js[0].code, worldChrome).catch(() => undefined);
			return [];
		}
		const result = await run(js[0].code, worldChrome);
		return mode === "lose" ? [] : [{ frameId: 0, result: JSON.parse(JSON.stringify(result)) }];
	},
};
const plain = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	sent.push(method);
	if (method === "Runtime.evaluate") {
		evaluated++;
		// The userScripts run's start reaches the extension only now, as the fallback runs.
		if (late) await late();
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
	late = undefined;
	sent.length = 0;
	domWrites.length = 0;
};
/** Nothing a run leaves on the page's window but the test's own count (second-F7 of the review of PR 265). */
const windowKeys = () => Object.keys(page).filter((k) => k !== "runs" && !k.startsWith("__tabkyra"));

test("a result userScripts kept comes back as before, the code run once, and nothing is written to the page", async () => {
	reset("keep");
	assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	assert.equal(page.runs, 1);
	assert.deepEqual(domWrites, [], "the run left a trace in the page's DOM");
	assert.deepEqual(windowKeys(), [], "the run left a trace on the page's window");
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
	// A tab the debugger never attached to: the attach is what fails.
	const fresh = (await chrome.tabs.create({ url: "https://shop.example.com/b" })).id;
	const original = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async () => {
		throw new Error("Another debugger is already attached to the tab with id: 1.");
	};
	try {
		await assert.rejects(injectScript(fresh, counted("1 + 1")), /Not run: .*Another debugger/);
	} finally {
		chrome.debugger.sendCommand = original;
	}
	assert.equal(page.runs, 0);
});

test("first-F1 (review of PR 265): a start that arrives after execute gave up gets no answer: the code runs once", async () => {
	reset("late");
	assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	assert.equal(page.runs, 1, "the code ran on both paths: a click or a post would repeat");
});

test("first-F2 (review of PR 265): the debugger path cut off after it sent the code: may have acted, never not run", async () => {
	reset("skip");
	const original = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Runtime.evaluate") throw new Error("Execution context was destroyed.");
		return original(target, method, params);
	};
	try {
		const failed = injectScript(tabId, counted("1 + 1"));
		await assert.rejects(failed, /sent to the page, then cut off.*may have acted on the page.*read_page/);
		await failed.catch((err) => assert.doesNotMatch(err.message, /Not run|Try again/));
	} finally {
		chrome.debugger.sendCommand = original;
	}
});

test("first-F3 (review of PR 265): Stop during the debugger fallback ends that run there", async () => {
	reset("skip");
	const original = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Runtime.evaluate") await terminateInjection(tabId, "e3");
		return original(target, method, params);
	};
	try {
		await injectScript(tabId, counted("1 + 1"), { executionId: "e3" });
	} finally {
		chrome.debugger.sendCommand = original;
	}
	assert.ok(sent.includes("Runtime.terminateExecution"), sent.join(", "));
});

test("second-F6 (review of PR 265): with no way to hear a run start, the code runs once on the debugger path", async () => {
	reset("keep");
	const events = chrome.runtime.onUserScriptMessage;
	const execute = chrome.userScripts.execute;
	chrome.runtime.onUserScriptMessage = undefined;
	chrome.userScripts.execute = async () => assert.fail("userScripts ran with no listener for its start");
	try {
		assert.equal(await injectScript(tabId, counted("1 + 1")), 2);
	} finally {
		chrome.runtime.onUserScriptMessage = events;
		chrome.userScripts.execute = execute;
	}
	assert.equal(page.runs, 1);
});
