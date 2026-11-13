// first-F1 (review of #188) at the bridge (src/bridge/native.ts, src/browser/dialog-guard.ts, docs/decisions.md D46):
// with the person's tab of the site in front, the guard cancels an agent's box at 3 s, sooner than a model turn can
// send handle_dialog. Its notice names the call to repeat with on_dialog, and that repeat is answered as the box
// opens: the page never stays frozen past the deadline, and no second Cancel. Fake chrome, the real bridge, cdp and
// guard, the guard's clock mocked.
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

/** Every answer a box got, in order. */
const answers = [];
/** The page's click handler: a confirm that freezes the page until it is answered. */
let confirmMessage = "Delete this record?";
let frozen;
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Page.handleJavaScriptDialog") {
		answers.push({ tabId: target.tabId, accept: params.accept });
		const thaw = frozen;
		frozen = undefined;
		const r = await send.call(chrome.debugger, target, method, params);
		for (const fn of chrome.debugger.onEvent.listeners)
			fn({ tabId: target.tabId }, "Page.javascriptDialogClosed", { result: params.accept });
		thaw?.();
		return r;
	}
	if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
		// The page's onclick runs confirm(): the release's reply waits until the box is answered.
		const thawed = new Promise((r) => (frozen = r));
		for (const fn of chrome.debugger.onEvent.listeners)
			fn({ tabId: target.tabId }, "Page.javascriptDialogOpening", {
				type: "confirm",
				message: confirmMessage,
				url: "https://shop.example.com/admin",
			});
		await thawed;
		return {};
	}
	return send.call(chrome.debugger, target, method, params);
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
const look = async () => {
	for (let i = 0; i < 5; i++) {
		await reconcile();
		await wait(5);
	}
};

test("first-F1: cancelled at 3 s, the agent repeats the click with on_dialog ok: answered at once, no second Cancel", async () => {
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "pre" } });
	const tab = (await request("tabs.create")).result.tabId;
	fake.commitNav(tab, "https://shop.example.com/admin");
	// The person's own tab of the site, in front.
	fake.addTab({ url: "https://www.example.com/cart", active: true });
	deps.grace = () => 3_000;
	deps.open = () => 60_000;
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		// The agent clicks Delete: the click worked and the box is open.
		const first = await request("click", { tabId: tab, x: 10, y: 10 });
		assert.equal(first.error, undefined, JSON.stringify(first.error));
		assert.match(first.result.note ?? "", /confirm dialog is now open/);
		assert.ok(openDialog(tab));
		await look(); // the freeze begins now
		// The model's turn takes longer than the grace: the guard cancels the box at 3 s.
		mock.timers.tick(3_100);
		await look();
		assert.deepEqual(answers, [{ tabId: tab, accept: false }]);
		assert.equal(openDialog(tab), undefined);
		// Its handle_dialog, too late, hears the notice: it names the exact call to repeat and the box's text.
		const late = await request("dialog", { accept: true, tabId: tab });
		const said = late.error?.message ?? "";
		assert.match(said, /"Delete this record\?"/);
		assert.ok(
			said.includes(`call click with {"tabId":${tab},"x":10,"y":10,"on_dialog":"ok"}`),
			`the notice does not name the repeat: ${said}`,
		);
		assert.match(said, /only if the box confirms exactly what the user asked for/);
		// The repeat: the box is answered OK as it opens, with no clock passing at all.
		const t0 = performance.now();
		const again = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
		assert.ok(performance.now() - t0 < 3_000, "the repeat took as long as the grace");
		assert.equal(again.error, undefined, JSON.stringify(again.error));
		assert.equal(again.result.dialog?.answered, "ok");
		assert.match(again.result.note ?? "", /answered OK at once, as on_dialog asked/);
		assert.deepEqual(answers, [
			{ tabId: tab, accept: false },
			{ tabId: tab, accept: true },
		]);
		assert.equal(openDialog(tab), undefined, "the page is still frozen");
		// Past every deadline: nothing more is cancelled.
		mock.timers.tick(120_000);
		await look();
		assert.equal(answers.length, 2, "a second Cancel fired");
		// The answer was for that call only: the next box on the tab waits for handle_dialog as before.
		confirmMessage = "Really?";
		const plain = await request("click", { tabId: tab, x: 10, y: 10 });
		assert.match(plain.result.note ?? "", /confirm dialog is now open/);
		assert.equal(openDialog(tab)?.message, "Really?");
		const ok = await request("dialog", { accept: false, tabId: tab });
		assert.equal(ok.error, undefined, JSON.stringify(ok.error));
	} finally {
		frozen?.();
		mock.timers.reset();
		resetDialogGuard();
	}
});

test("on_dialog is checked: a bad value, or a tool that opens no box, is refused before anything runs", async () => {
	const tab = (await request("tabs.create")).result.tabId;
	const bad = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "yes" });
	assert.match(bad.error?.message ?? "", /on_dialog must be "ok" or "cancel"/);
	const other = await request("scroll", { tabId: tab, dy: 100, on_dialog: "ok" });
	assert.match(other.error?.message ?? "", /on_dialog works with click, press, type, fill, actions/);
	assert.equal(answers.filter((a) => a.tabId === tab).length, 0);
});
