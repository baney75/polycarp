// The side panel's ref tools: the same bridge handlers MCP runs, routed, gated and printed for the panel's model.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const noEvent = () => ({ addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= noEvent();
chrome.webNavigation ??= {};
chrome.webNavigation.onCommitted ??= noEvent();
const { installCdpListeners } = await import("../src/browser/cdp.ts");
const { isDialogSafe } = await import("../src/bridge/dialogs.ts");
const { ACT_ACTIONS, PAGE_TOOL_METHODS, PAGE_TOOL_NAMES, PAGE_TOOLS, PAGE_TOOLS_PROMPT, formatPageResult, pageRange, routePageTool } =
	await import("../src/bridge/page-tools.ts");
const { panelError, runPanelCall, startPanelPageTools } = await import("../src/bridge/panel-calls.ts");
const { createPageTools, sendToWorker } = await import("../src/tools/page-tools.ts");
const { setCurrentBrowserSession } = await import("../src/browser/current.ts");
const { handlers } = await import("../src/bridge/tools.ts");
const { BridgeError } = await import("../src/bridge/errors.ts");
const { stepLabel } = await import("../src/transcript/group.ts");
const { SYSTEM_PROMPT } = await import("../src/prompts/prompts.ts");
installCdpListeners();

const openDialogOn = (tabId, message) => {
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, "Page.javascriptDialogOpening", { type: "confirm", message });
};
const closeDialogOn = (tabId) => {
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, "Page.javascriptDialogClosed", { result: false });
};

/** A panel session with one tab on `url`, and handlers that record what they were called with. */
function fakeDeps({ url = "https://shop.test/", tabIds = [7], dialogs = new Map() } = {}) {
	const calls = [];
	const record = (method, result) => async (ctx, params) => {
		calls.push({ method, params, ctx });
		return typeof result === "function" ? result(ctx, params) : result;
	};
	const fakeHandlers = Object.fromEntries([...PAGE_TOOL_METHODS].map((m) => [m, record(m, { ok: m })]));
	fakeHandlers.run_js = record("run_js", { ok: "run_js" });
	fakeHandlers.navigate = record("navigate", { ok: "navigate" });
	const session = {
		id: "s1",
		groupName: "Polycarp",
		tabIds,
		currentTabId: tabIds[0],
		currentTab: async () => ({ id: tabIds[0], url }),
		setCurrent() {},
		requireCurrentTab: async () => ({ id: tabIds[0], url }),
		attachedCurrentTab: async () => ({ id: tabIds[0], url }),
	};
	return { deps: { session, handlers: fakeHandlers, openDialog: (id) => dialogs.get(id) }, calls };
}

test("the panel gets read_page, find, get_page_text, act and handle_dialog, and act covers the core input loop", () => {
	assert.deepEqual([...PAGE_TOOL_NAMES], ["read_page", "find", "get_page_text", "act", "handle_dialog"]);
	assert.deepEqual([...ACT_ACTIONS], ["click", "type", "fill", "press", "hover", "scroll", "drag", "wait", "screenshot", "steps"]);
	for (const m of ["snapshot", "find", "text", "click", "type", "fill", "press", "hover", "scroll", "drag", "wait", "screenshot", "actions", "dialog"])
		assert.ok(PAGE_TOOL_METHODS.has(m), m);
	// Debugging, script, file and site-opening handlers stay out of the panel's reach.
	for (const m of ["run_js", "html", "navigate", "tabs_create", "files", "console", "network", "capture", "site_edit"])
		assert.ok(!PAGE_TOOL_METHODS.has(m), m);
	// Every handler the panel routes to exists in the bridge: one implementation, no copy.
	for (const m of PAGE_TOOL_METHODS) assert.equal(typeof handlers[m], "function", m);
	for (const spec of PAGE_TOOLS) assert.ok(spec.description.length < 1200, `${spec.name} description stays short`);
});

test("act routes each action to its bridge handler with only the fields it set", () => {
	assert.deepEqual(routePageTool("act", { action: "click", ref: "e5", text: undefined, x: null }), {
		method: "click",
		params: { ref: "e5" },
		action: "click",
	});
	assert.deepEqual(routePageTool("act", { action: "type", text: "hi", ref: "e2", submit: true }).params, { text: "hi", ref: "e2", submit: true });
	assert.equal(routePageTool("act", { action: "steps", steps: [{ click: { ref: "e1" } }] }).method, "actions");
	// scroll's edge becomes the handler's `to`; a stray drag point never reaches scroll.
	assert.deepEqual(routePageTool("act", { action: "scroll", edge: "bottom" }).params, { to: "bottom" });
	assert.deepEqual(routePageTool("act", { action: "scroll", dy: 400, to: { x: 1, y: 2 } }).params, { dy: 400 });
	assert.deepEqual(routePageTool("act", { action: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }).params, {
		from: { x: 1, y: 2 },
		to: { x: 3, y: 4 },
	});
	assert.throws(() => routePageTool("act", { action: "run_js" }), /act needs action/);
	assert.throws(() => routePageTool("act", {}), /act needs action/);
	assert.throws(() => routePageTool("tabs_create", {}), /Unknown page tool/);
});

test("the panel works in its current tab: a tabId is dropped everywhere but a dialog answer", () => {
	assert.deepEqual(routePageTool("act", { action: "click", ref: "e1", tabId: 99 }).params, { ref: "e1" });
	assert.deepEqual(routePageTool("find", { query: "x", tabId: 99 }).params, { query: "x" });
	assert.deepEqual(
		routePageTool("act", { action: "steps", tabId: 99, steps: [{ click: { ref: "e1", tabId: 99 } }, { press: "Enter", tabId: 99 }] }).params,
		{ steps: [{ click: { ref: "e1" } }, { press: "Enter" }] },
	);
	assert.deepEqual(routePageTool("handle_dialog", { accept: false, tabId: 7 }).params, { accept: false, tabId: 7 });
});

test("read_page caps its text for small windows and get_page_text takes a page range", () => {
	assert.equal(routePageTool("read_page", {}).params.maxTextChars, 3000);
	assert.equal(routePageTool("read_page", { maxTextChars: 500 }).params.maxTextChars, 500);
	assert.deepEqual(routePageTool("get_page_text", { pages: "3-7" }).params, { firstPage: 3, lastPage: 7 });
	assert.deepEqual(pageRange("pp. 4"), { firstPage: 4, lastPage: 4 });
	assert.deepEqual(pageRange("2\u20135"), { firstPage: 2, lastPage: 5 });
	assert.equal(pageRange("all"), undefined);
	assert.throws(() => routePageTool("get_page_text", { pages: "all" }), /pages takes one page or a range/);
});

test("runPanelCall runs only the page tools' handlers, on the panel's session", async () => {
	const { deps, calls } = fakeDeps();
	assert.deepEqual(await runPanelCall(deps, "click", { ref: "e1" }), { ok: "click" });
	assert.equal(calls[0].ctx.session, deps.session);
	assert.equal(calls[0].ctx.clientId, "sidepanel");
	await assert.rejects(runPanelCall(deps, "run_js", { code: "1" }), (err) => err.code === "not_found");
	await assert.rejects(runPanelCall(deps, "navigate", { url: "https://x.test/" }), (err) => err.code === "not_found");
	assert.equal(calls.length, 1);
});

test("the page tools open no site and send no file", async () => {
	const { deps, calls } = fakeDeps();
	deps.handlers.click = async (ctx) => {
		calls.push("click");
		await ctx.checkUrl("https://elsewhere.test/");
	};
	await assert.rejects(runPanelCall(deps, "click", {}), (err) => err.code === "permission_denied" && /use navigate/.test(err.message));
	deps.handlers.type = async (ctx) => ctx.askUpload({});
	assert.equal(await runPanelCall(deps, "type", { text: "x" }), false);
});

test("the page tools never act on a Polycarp page", async () => {
	const { deps, calls } = fakeDeps({ url: `chrome-extension://${chrome.runtime.id}/sidepanel.html` });
	await assert.rejects(runPanelCall(deps, "click", { ref: "e1" }), (err) => err.code === "permission_denied" && /Polycarp page/.test(err.message));
	await assert.rejects(runPanelCall(deps, "snapshot", {}), (err) => err.code === "permission_denied");
	assert.equal(calls.length, 0);
});

test("an open dialog fails input with dialog_open, and handle_dialog still runs", async () => {
	const dialogs = new Map([[7, { type: "confirm", message: "Delete all?", url: "https://shop.test/" }]]);
	const { deps, calls } = fakeDeps({ dialogs });
	await assert.rejects(runPanelCall(deps, "click", { ref: "e1" }), (err) => err.code === "dialog_open" && /Delete all\?/.test(err.message));
	assert.deepEqual(await runPanelCall(deps, "dialog", { accept: false }), { ok: "dialog" });
	assert.deepEqual(calls.map((c) => c.method), ["dialog"]);
	assert.equal(isDialogSafe("click", {}), false);
	assert.equal(isDialogSafe("dialog", {}), true);
	assert.equal(isDialogSafe("snapshot", {}), false);
});

test("a dialog the click opened is the click's success, as for bridge clients", async () => {
	const { deps } = fakeDeps();
	deps.handlers.click = (ctx) => {
		ctx.delivered({ clicked: { x: 1, y: 2 } }, 7);
		// CDP events arrive on a later task, after the race listens, as in the browser.
		setTimeout(() => openDialogOn(7, "Leave the page?"), 0);
		return new Promise(() => {});
	};
	const result = await runPanelCall(deps, "click", { ref: "e1" });
	closeDialogOn(7);
	assert.deepEqual(result.clicked, { x: 1, y: 2 });
	assert.match(result.note, /handle_dialog/);
});

test("stopping the chat aborts the handler between steps", async () => {
	const { deps } = fakeDeps();
	const ac = new AbortController();
	let seen;
	deps.handlers.wait = async (ctx) => {
		ac.abort();
		seen = ctx.aborted();
		return {};
	};
	await runPanelCall(deps, "wait", { ms: 10 }, ac.signal);
	assert.equal(seen, true);
});

test("errors keep the bridge's code and use the panel's words", () => {
	const err = panelError(new BridgeError("not_found", "That tab is not in your session; tabs_context lists them."), "click");
	assert.match(err.message, /^not_found: /);
	assert.match(err.message, /navigate \{listTabs:true\} lists them/);
	assert.doesNotMatch(err.message, /tabs_context/);
});

test("an act tool call reaches the bridge handler and the model reads the result", async () => {
	const { deps, calls } = fakeDeps();
	const act = createPageTools((method, params, signal) => runPanelCall(deps, method, params, signal)).find((t) => t.name === "act");
	const out = await act.execute("c1", { action: "fill", ref: "e3", value: "42" });
	assert.equal(calls[0].method, "fill");
	assert.deepEqual(calls[0].params, { ref: "e3", value: "42" });
	assert.equal(out.content[0].type, "text");
	await assert.rejects(act.execute("c2", { action: "eval" }), /^Error: bad_params: act needs action/);
});

test("the service worker answers only the side panel page, and the panel's stop aborts the call there", async () => {
	const seen = [];
	let release;
	startPanelPageTools({
		wait: async (ctx) => {
			await new Promise((r) => {
				release = r;
			});
			seen.push(ctx.aborted());
			return { waited: true };
		},
	});
	const listener = chrome.runtime.onMessage.listeners.at(-1);
	const send = (message, sender) =>
		new Promise((resolve) => {
			const async = listener(message, sender, resolve);
			if (async !== true) resolve(undefined);
		});
	const panel = { id: chrome.runtime.id, url: chrome.runtime.getURL("sidepanel.html") };
	const call = { type: "polycarp-page-tool", callId: "c1", sessionId: "none", method: "wait", params: {} };
	// A content script (its url is the web page's), another Polycarp page or another extension is refused first.
	assert.deepEqual(await send(call, { id: chrome.runtime.id, url: "https://evil.test/", tab: { id: 7 } }), {
		ok: false,
		message: "permission_denied: Refused",
	});
	assert.deepEqual(await send(call, { id: chrome.runtime.id, url: chrome.runtime.getURL("options.html") }), {
		ok: false,
		message: "permission_denied: Refused",
	});
	assert.deepEqual(await send(call, { id: "other-extension", url: chrome.runtime.getURL("sidepanel.html") }), {
		ok: false,
		message: "permission_denied: Refused",
	});
	assert.deepEqual(await send({ type: "other" }, panel), undefined, "other messages are left to their own listeners");
	// A session the worker can't find ends with a message the model can act on.
	const ended = await send(call, panel);
	assert.equal(ended.ok, false);
	assert.match(ended.message, /^no_tab: Your browser session has ended/);
	assert.equal(seen.length, 0);
	// A real session: the call runs on it, and the panel's abort message reaches the running handler.
	const { BrowserSession } = await import("../src/browser/session.ts");
	const session = await BrowserSession.open("panel-sw", "chat", 1);
	const running = send({ ...call, callId: "c2", sessionId: session.id }, panel);
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(typeof release, "function", "the handler started");
	await send({ type: "polycarp-page-tool-abort", callId: "c2" }, panel);
	release();
	assert.deepEqual(await running, { ok: true, result: { waited: true } });
	assert.deepEqual(seen, [true]);
});

test("the panel sends each call to the worker on its session, and the stop button aborts it there", async () => {
	const sent = [];
	const original = chrome.runtime.sendMessage;
	let answer;
	chrome.runtime.sendMessage = (m) => {
		sent.push(m);
		return m.type === "polycarp-page-tool" ? new Promise((r) => (answer = r)) : Promise.resolve();
	};
	setCurrentBrowserSession({ id: "s9" });
	try {
		const ac = new AbortController();
		const pending = sendToWorker("click", { ref: "e1" }, ac.signal);
		assert.equal(sent[0].type, "polycarp-page-tool");
		assert.equal(sent[0].sessionId, "s9");
		assert.deepEqual([sent[0].method, sent[0].params], ["click", { ref: "e1" }]);
		ac.abort();
		assert.deepEqual(sent[1], { type: "polycarp-page-tool-abort", callId: sent[0].callId });
		answer({ ok: false, message: "stale_ref: e1 is gone. read_page again." });
		await assert.rejects(pending, /^Error: stale_ref: e1 is gone/);
		// Each call has its own id, and a call made after the stop never leaves the panel.
		const next = sendToWorker("snapshot", {});
		assert.notEqual(sent[2].callId, sent[0].callId);
		answer({ ok: true, result: { url: "https://shop.test/" } });
		assert.deepEqual(await next, { url: "https://shop.test/" });
		await assert.rejects(sendToWorker("click", {}, ac.signal), /^Error: interrupted: /);
		assert.equal(sent.length, 3);
	} finally {
		chrome.runtime.sendMessage = original;
		setCurrentBrowserSession(undefined);
	}
});

test("read_page prints refs to act on; find, text, screenshots and steps read cleanly", () => {
	const snap = {
		url: "https://shop.test/cart",
		title: "Cart",
		viewport: { width: 800, height: 600, scrollY: 0, pageHeight: 1200 },
		nodes: [{ ref: "e1", role: "button", name: "Check out", visible: true, href: "https://shop.test/pay" }],
		text: "Two items",
	};
	const read = formatPageResult("read_page", snap);
	assert.match(read.content[0].text, /use the ref with act/);
	assert.match(read.content[0].text, /e1 button "Check out" -> \/pay/);
	assert.deepEqual(read.details, { url: "https://shop.test/cart", title: "Cart", count: 1 });
	assert.match(formatPageResult("find", { matches: [] }).content[0].text, /No elements match/);
	const page = formatPageResult("get_page_text", { url: "https://a.test/d.pdf", title: "D", text: "body", pdf: { pages: 9, truncated: true } });
	assert.match(page.content[0].text, /^Page: D \| https:\/\/a\.test\/d\.pdf\nPDF, 9 pages \(cut short\)\./);
	const shot = { data: "AAAA", mimeType: "image/jpeg", width: 640, height: 400 };
	const img = formatPageResult("act", shot, "screenshot");
	assert.deepEqual(img.content[0], { type: "image", data: "AAAA", mimeType: "image/jpeg" });
	assert.match(img.content[1].text, /640x400 screenshot/);
	const steps = formatPageResult("act", { steps: 3, screenshot: shot }, "steps");
	assert.equal(steps.content[0].text, "3 steps done.");
	assert.equal(steps.content[1].type, "image");
	assert.equal(formatPageResult("act", { clicked: { x: 1, y: 2 } }, "click").content[0].text, '{"clicked":{"x":1,"y":2}}');
});

test("each page tool call gets a clean step label", () => {
	const label = (name, args, details) =>
		stepLabel({ type: "toolCall", id: "x", name, arguments: args }, details ? { role: "toolResult", details } : undefined).label;
	assert.equal(label("read_page", {}, { url: "https://shop.test/" }), "Read page");
	assert.equal(label("find", { query: "sign in" }), 'Find "sign in"');
	assert.equal(label("get_page_text", {}), "Read text");
	assert.equal(label("act", { action: "click", ref: "e5" }), "Click e5");
	assert.equal(label("act", { action: "click", ref: "e5", clickCount: 2 }), "Double-click e5");
	assert.equal(label("act", { action: "click", x: 10.4, y: 20 }), "Click at 10, 20");
	assert.equal(label("act", { action: "type", text: "hello", ref: "e2" }), 'Type "hello" in e2');
	assert.equal(label("act", { action: "fill", ref: "e3", value: "42" }), 'Fill e3 with "42"');
	assert.equal(label("act", { action: "press", key: "Tab", repeat: 3 }), "Press Tab 3 times");
	assert.equal(label("act", { action: "scroll", edge: "bottom" }), "Scroll to bottom");
	assert.equal(label("act", { action: "scroll", dy: -300 }), "Scroll up");
	assert.equal(label("act", { action: "hover", selector: "#menu" }), 'Hover "#menu"');
	assert.equal(label("act", { action: "drag" }), "Drag");
	assert.equal(label("act", { action: "wait", text: "Saved" }), 'Wait for "Saved"');
	assert.equal(label("act", { action: "wait", ms: 500 }), "Wait 500 ms");
	assert.equal(label("act", { action: "screenshot" }), "Screenshot");
	assert.equal(label("act", { action: "steps", steps: [{}, {}] }), "Run 2 input steps");
	assert.equal(label("act", {}), "Act on the page");
	assert.equal(label("handle_dialog", { accept: false }), "Answer the dialog: Cancel");
	assert.equal(label("act", { action: "type", text: "x".repeat(80) }).length < 50, true);
});

test("the system prompt teaches the loop and keeps the REPL off clicking", () => {
	assert.ok(SYSTEM_PROMPT.includes(PAGE_TOOLS_PROMPT));
	assert.match(PAGE_TOOLS_PROMPT, /read_page[^\n]*act[^\n]*read_page again/);
	assert.match(PAGE_TOOLS_PROMPT, /Refs expire when the page changes/);
	assert.match(PAGE_TOOLS_PROMPT, /handle_dialog, never click again/);
	assert.match(PAGE_TOOLS_PROMPT, /repl for data work and page scripts, not to click or type/);
	// Page text stays untrusted for the new readers too.
	assert.match(SYSTEM_PROMPT, /read_page, get_page_text, find, browserjs\(\)/);
});
