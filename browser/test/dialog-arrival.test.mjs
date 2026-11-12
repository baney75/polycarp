// first-F4, second-G2 at the bridge (src/bridge/native.ts, docs/decisions.md D46): a handle_dialog holds its box from
// the moment it reaches the worker's socket, while it waits in the client's queue behind a slow call too. Fake chrome,
// the real bridge and guard, the guard's clock mocked.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const realSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
const native = await import("../src/bridge/native.ts");
const { installCdpListeners, openDialog } = await import("../src/browser/cdp.ts");
const { deps, reconcile, resetDialogGuard } = await import("../src/browser/dialog-guard.ts");
installCdpListeners();
// The bridge's long timers (its prune, each request's 90 s limit) must not hold the test process open.
globalThis.setTimeout = (fn, ms, ...args) => {
	const t = realSetTimeout(fn, ms, ...args);
	if (ms >= 10000) t.unref();
	return t;
};
native.startBridge();
const port = fake.ports[0];

let stall = false;
let release;
const answers = [];
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Page.handleJavaScriptDialog") answers.push({ tabId: target.tabId, accept: params.accept });
	return send.call(chrome.debugger, target, method, params);
};
const create = chrome.tabs.create;
chrome.tabs.create = async (props) => {
	if (stall) await new Promise((r) => (release = r));
	return create.call(chrome.tabs, props);
};
let nextId = 1;
const deliver = (method, params = {}) => {
	const id = nextId++;
	port.deliver({ type: "request", clientId: "c1", id, method, params });
	return id;
};
const reply = async (id, ms = 5000) => {
	for (const end = Date.now() + ms; Date.now() < end; await wait(5)) {
		const r = port.sent.find((m) => m.type === "response" && m.clientId === "c1" && m.id === id);
		if (r) return r;
	}
	throw new Error(`no reply to request ${id}`);
};
const request = async (method, params) => reply(deliver(method, params));

test("first-F4, second-G2: a handle_dialog queued behind a slow call holds its box past the deadline, then answers it", async () => {
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "dlg" } });
	const one = (await request("tabs.create")).result.tabId;
	const two = (await request("tabs.create")).result.tabId;
	fake.commitNav(one, "https://shop.example.com/admin");
	fake.commitNav(two, "https://shop.example.com/list");
	// The person's own tab of the site, in front.
	fake.addTab({ url: "https://www.example.com/cart", active: true });
	deps.grace = () => 3_000;
	deps.open = () => 60_000;
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		// A slow call (a tabs_create that waits on the browser; it runs through boxes) is running when the box opens.
		stall = true;
		const slow = deliver("tabs.create");
		for (let i = 0; i < 400 && !release; i++) await wait(5);
		assert.ok(release, "the slow call never reached the page");
		for (const fn of chrome.debugger.onEvent.listeners)
			fn({ tabId: one }, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete this record?", url: "https://shop.example.com/admin" });
		await reconcile(); // the freeze begins now
		// The answer for the box waits behind the slow call in the client's queue.
		const answer = deliver("dialog", { accept: true, tabId: one });
		await wait(50);
		// The deadline passes while the answer is still queued.
		mock.timers.tick(10_000);
		await reconcile();
		assert.ok(openDialog(one), "the box was cancelled under an answer already waiting in the queue");
		assert.deepEqual(answers, []);
		stall = false;
		release();
		await reply(slow);
		const r = await reply(answer);
		assert.equal(r.error, undefined, JSON.stringify(r.error));
		assert.equal(r.result.accepted, true);
		assert.deepEqual(answers, [{ tabId: one, accept: true }], "the answer did not land on its box");
	} finally {
		release?.();
		mock.timers.reset();
		resetDialogGuard();
	}
});
