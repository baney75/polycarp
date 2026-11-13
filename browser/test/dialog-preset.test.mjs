// on_dialog at the bridge (src/bridge/native.ts, src/bridge/dialogs.ts, src/browser/dialog-guard.ts, D46), the rules
// of the #193 review: an answer set in advance only ever answers the box its own click or press opened, on its named
// tab, armed for that call alone; the result says the answer that landed; and the guard's notice names a repeat only
// when one is safe. Fake chrome, the real bridge, cdp and guard; the guard's clock mocked.
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
const SITE = "https://shop.example.com/admin";

/** Every answer a box got from Page.handleJavaScriptDialog, in order, with the box it went to. */
let answers = [];
/** The box open on each tab, waiting for its answer, as a page's confirm() waits. */
const waiting = new Map();
/** Fail the next OK sent to a box (a detach mid-send, say): the box stays open. */
let failNextOk = false;
const fire = (tabId, method, params) => {
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, method, params);
};
/** Open a box on the tab, as the page's script does, and wait for its answer. */
const box = (tabId, type, message) =>
	new Promise((resolve) => {
		waiting.set(tabId, { message, resolve });
		fire(tabId, "Page.javascriptDialogOpening", { type, message, url: SITE });
	});
/** What each tab's page does when it is clicked at (x, y) or gets an Enter: it may open boxes, one after another. */
const programs = new Map();
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	const tabId = target.tabId;
	if (method === "Page.handleJavaScriptDialog") {
		const w = waiting.get(tabId);
		if (params.accept && failNextOk) {
			failNextOk = false;
			throw new Error("Detached while handling command.");
		}
		answers.push({ tabId, accept: params.accept, message: w?.message });
		const r = await send.call(chrome.debugger, target, method, params);
		waiting.delete(tabId);
		fire(tabId, "Page.javascriptDialogClosed", { result: params.accept });
		w?.resolve(params.accept);
		return r;
	}
	const program = programs.get(tabId);
	// A box freezes the page: input waits until it is answered.
	if (program && method.startsWith("Input.")) while (waiting.has(tabId)) await wait(5);
	if (program && method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
		await program({ x: params.x, y: params.y }, tabId);
		return {};
	}
	if (program && method === "Input.dispatchKeyEvent" && params.type !== "keyUp" && params.key === "Enter") {
		await program({ key: "Enter" }, tabId);
		return {};
	}
	return send.call(chrome.debugger, target, method, params);
};

let nextId = 1;
const deliver = (client, method, params = {}) => {
	const id = nextId++;
	port.deliver({ type: "request", clientId: client, id, method, params });
	return { client, id };
};
const reply = async ({ client, id }, ms = 8000) => {
	for (const end = Date.now() + ms; Date.now() < end; await wait(5)) {
		const r = port.sent.find((m) => m.type === "response" && m.clientId === client && m.id === id);
		if (r) return r;
	}
	throw new Error(`no reply to request ${id}`);
};
const request = (method, params, client = "c1") => reply(deliver(client, method, params));
const look = async () => {
	for (let i = 0; i < 5; i++) {
		await reconcile();
		await wait(5);
	}
};
/** Let the guard's clock run past the grace, with the person's tab in front: it cancels what is due. */
const pastGrace = async () => {
	await look();
	mock.timers.tick(3_100);
	await look();
};
/** The guard's notice, as the agent hears it: its next handle_dialog on the tab. */
const notice = async (tabId) => (await request("dialog", { accept: true, tabId })).error?.message ?? "";

port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "shop", named: true } });
port.deliver({ type: "client_connected", clientId: "c2", client: { name: "claude", session: "shop", named: true } });
// The person's own tab of the site, in front.
fake.addTab({ url: "https://www.example.com/cart", active: true });

/** A fresh tab of the agent's on the site, with a page program; the guard's waits set, its clock mocked. */
async function agentTab(program) {
	const tabId = (await request("tabs.create")).result.tabId;
	fake.commitNav(tabId, SITE);
	if (program) programs.set(tabId, program);
	return tabId;
}

function setup(t) {
	answers = [];
	failNextOk = false;
	deps.grace = () => 3_000;
	deps.open = () => 60_000;
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	t.after(() => {
		// A test that failed midway leaves no box behind for the next one.
		for (const [tabId, w] of waiting) {
			fire(tabId, "Page.javascriptDialogClosed", { result: false });
			w.resolve(false);
		}
		waiting.clear();
		mock.timers.reset();
		resetDialogGuard();
	});
}

/** The delete page: a confirm, and when it is OK, the record goes and an alert says so. */
const records = { deleted: 0 };
const deletePage = async (_input, tabId) => {
	if (await box(tabId, "confirm", "Delete the record?")) {
		records.deleted++;
		await box(tabId, "alert", "Record deleted");
	}
};

test("first-F1, first-F5: cancelled at 3 s, the agent repeats the one click with on_dialog ok on its tab: answered at once", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Delete this record?");
	});
	const first = await request("click", { tabId: tab, x: 10, y: 10 });
	assert.equal(first.error, undefined, JSON.stringify(first.error));
	// first-F5: the call's own note says a handle_dialog can't arrive in time, and names the call that works.
	assert.match(first.result.note, /cancels this box in about 3 s, before a handle_dialog can arrive: do not call handle_dialog/);
	const repeat = `call click with {"tabId":${tab},"x":10,"y":10,"on_dialog":"ok"}`;
	assert.ok(first.result.note.includes(repeat), first.result.note);
	await pastGrace();
	assert.deepEqual(answers.map((a) => a.accept), [false]);
	const said = await notice(tab);
	assert.match(said, /"Delete this record\?"/);
	assert.ok(said.includes(repeat), `the notice does not name the one step: ${said}`);
	const t0 = performance.now();
	const again = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.ok(performance.now() - t0 < 3_000);
	assert.equal(again.error, undefined, JSON.stringify(again.error));
	assert.equal(again.result.dialog?.answered, "ok");
	assert.match(again.result.note, /answered OK at once, as on_dialog asked/);
	assert.deepEqual(answers.map((a) => a.accept), [false, true]);
	assert.equal(openDialog(tab), undefined, "the page is still frozen");
	mock.timers.tick(120_000);
	await look();
	assert.equal(answers.length, 2, "a second Cancel fired");
});

test("second-S1: confirm OK by on_dialog, then the alert: dismissed, the notice names no repeat, nothing more is deleted", async (t) => {
	setup(t);
	records.deleted = 0;
	const tab = await agentTab(deletePage);
	const call = deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	const r = await reply(call);
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.equal(records.deleted, 1);
	// The confirm's answer, as it landed; the alert is open, and the note says it needs nothing.
	assert.equal(r.result.answered?.answered, "ok");
	assert.equal(r.result.dialog?.type, "alert");
	assert.match(r.result.note, /answered OK at once, as on_dialog asked/);
	assert.match(r.result.note, /An alert has only one answer[^.]*\. Do not repeat it/);
	assert.doesNotMatch(r.result.note, /call (click|press) with/);
	await pastGrace();
	assert.deepEqual(answers.map((a) => [a.message, a.accept]), [
		["Delete the record?", true],
		["Record deleted", false],
	]);
	const said = await notice(tab);
	assert.match(said, /The alert dialog on tab \d+ \("Record deleted"\) was dismissed/);
	assert.match(said, /the action that opened it went through\. Do not repeat it/);
	assert.doesNotMatch(said, /call (click|press) with|To do that one step again/, said);
	// A model that follows the notice does nothing more: no call is named, and the page is free.
	assert.equal(openDialog(tab), undefined);
	assert.equal(records.deleted, 1);
});

test("second-S1: a confirm after the box on_dialog answered keeps that answer: no repeat named", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		if (await box(id, "confirm", "Delete the record?")) await box(id, "confirm", "Also delete its history?");
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.equal(r.result.dialog?.message, "Also delete its history?");
	await pastGrace();
	const said = await notice(tab);
	assert.match(said, /after the confirm \("Delete the record\?"\) that your call's on_dialog answered\. That answer stands/);
	assert.doesNotMatch(said, /call (click|press) with/);
});

test("sol-F3, first-F4: on_dialog needs a named tab of the session's own, refused before anything is armed or sent", async (t) => {
	setup(t);
	const tab = await agentTab(deletePage);
	records.deleted = 0;
	const unnamed = await request("click", { x: 10, y: 10, on_dialog: "ok" });
	assert.match(unnamed.error?.message ?? "", /on_dialog needs tabId/);
	// Another's tab: the call is refused, and a box that opens there now is not answered with this agent's OK.
	const theirs = fake.addTab({ url: SITE });
	const other = await request("click", { tabId: theirs, x: 10, y: 10, on_dialog: "ok" });
	assert.match(other.error?.message ?? "", /Tab \d+ is not one of your tabs/);
	void box(theirs, "confirm", "Theirs?");
	await wait(20);
	assert.deepEqual(answers, [], "a box was answered by a refused call's on_dialog");
	assert.equal(records.deleted, 0, "a refused call clicked");
});

test("sol-F2, first-F2: one armed answer per tab across the session's clients; a box no call opened never takes it", async (t) => {
	setup(t);
	let release;
	let pressed = 0;
	const tab = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Mine?");
	});
	// c1's click with on_dialog is on its way: its press is held, so its last input has not gone out.
	const held = new Promise((r) => {
		release = r;
	});
	const plain = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (target.tabId === tab && method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
			pressed++;
			await held;
		}
		return plain(target, method, params);
	};
	t.after(() => {
		chrome.debugger.sendCommand = plain;
	});
	const a = deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	for (let i = 0; i < 100 && !pressed; i++) await wait(5);
	// c2, the same session, on the same tab: not sent while c1's on_dialog call runs.
	const b = await request("click", { tabId: tab, x: 20, y: 20 }, "c2");
	assert.equal(b.error?.code, "not_sent", JSON.stringify(b));
	// A box the page opens on its own before c1's input is out: no call opened it, so c1's OK does not answer it.
	const timer = box(tab, "confirm", "A page timer's box");
	await wait(20);
	assert.deepEqual(answers, [], "the page's own box took c1's OK");
	assert.ok(openDialog(tab));
	release();
	const r = await reply(a);
	assert.equal(r.error?.code, "dialog_open", JSON.stringify(r));
	await pastGrace();
	await timer;
	// c1's click lands once the page is free and opens its own box; c1 already failed, so its OK is not armed.
	for (let i = 0; i < 100 && !openDialog(tab); i++) await wait(5);
	await pastGrace();
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [
		["A page timer's box", false],
		["Mine?", false],
	]);
	// And the other way: while c2 has a call running on the tab, a call with on_dialog there is not sent.
	const slow = deliver("c2", "wait", { tabId: tab, ms: 300 });
	await wait(30);
	const c = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.equal(c.error?.code, "not_sent", JSON.stringify(c));
	await reply(slow);
});

test("sol-F1, first-F3: on_dialog's OK fails and the guard cancels: the call reports Cancel, as the page got it", async (t) => {
	setup(t);
	records.deleted = 0;
	const tab = await agentTab(deletePage);
	failNextOk = true;
	const call = deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	await wait(50);
	assert.ok(openDialog(tab), "the box closed although its OK failed");
	await pastGrace();
	const r = await reply(call);
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.equal(r.result.dialog?.answered, "cancel");
	assert.match(r.result.note, /on_dialog's OK did not reach the page: it was answered Cancel, and the page saw Cancel/);
	assert.equal(records.deleted, 0);
	// The guard's notice still names the one step: the box was this click's.
	assert.ok((await notice(tab)).includes(`call click with {"tabId":${tab},"x":10,"y":10,"on_dialog":"ok"}`));
});

test("sol-F4, first-F1: a box from a step of actions: the notice says which steps ran and names only the step that opened it", async (t) => {
	setup(t);
	let rows = 0;
	const tab = await agentTab(async ({ x }, id) => {
		if (x === 5) rows++;
		else await box(id, "confirm", "Delete the row?");
	});
	const r = await request("actions", {
		tabId: tab,
		settleMs: 0,
		steps: [{ click: { x: 5, y: 5 } }, { click: { x: 10, y: 10 } }, { press: "Tab" }],
	});
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.equal(rows, 1);
	await pastGrace();
	const said = await notice(tab);
	assert.match(said, /The first 1 step of your actions call ran before it: do not run them again\. Step 2 \(click\) opened it, and the 1 after it did not run/);
	assert.ok(said.includes(`call click with {"tabId":${tab},"x":10,"y":10,"on_dialog":"ok"}`), said);
	assert.doesNotMatch(said, /call actions with/);
	// The step itself, set inside actions: answered at once, and the step before it ran once.
	const again = await request("actions", {
		tabId: tab,
		settleMs: 0,
		steps: [{ click: { x: 5, y: 5 } }, { click: { x: 10, y: 10, on_dialog: "ok" } }],
	});
	assert.equal(again.error, undefined, JSON.stringify(again.error));
	assert.deepEqual(answers.map((a) => a.accept), [false, true]);
	assert.equal(rows, 2);
});

test("press takes on_dialog: Enter that opens a confirm is answered as it opens", async (t) => {
	setup(t);
	const tab = await agentTab(async ({ key }, id) => {
		if (key === "Enter") await box(id, "confirm", "Send the form?");
	});
	const r = await request("press", { tabId: tab, key: "Enter", on_dialog: "ok" });
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.equal(r.result.dialog?.answered, "ok");
	assert.deepEqual(answers.map((a) => a.accept), [true]);
});

test("second-S2: a box no click or press opened (a page timer, a hover): the notice says so and names no call", async (t) => {
	setup(t);
	const tab = await agentTab();
	void box(tab, "confirm", "Leave this page?");
	await pastGrace();
	const said = await notice(tab);
	assert.match(said, /Polycarp does not know which action opened it/);
	assert.match(said, /Read the page \(read_page\)/);
	assert.doesNotMatch(said, /call \w+ with|on_dialog": "ok"/);
	// A hover is no cause either.
	const hovered = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Hovered?");
	});
	programs.set(hovered, undefined);
	const plain = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (target.tabId === hovered && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
			await box(hovered, "confirm", "Hovered?");
			return {};
		}
		return plain(target, method, params);
	};
	t.after(() => {
		chrome.debugger.sendCommand = plain;
	});
	await request("hover", { tabId: hovered, x: 10, y: 10 });
	await pastGrace();
	assert.match(await notice(hovered), /does not know which action opened it/);
});

test("second-S3: a box on another of the session's tabs during a click is not that click's", async (t) => {
	setup(t);
	const other = await agentTab();
	const tab = await agentTab(async () => {
		await box(other, "confirm", "From a timer on the other tab");
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10 });
	assert.equal(r.error?.code, "dialog_open");
	await pastGrace();
	const said = await notice(other);
	assert.match(said, /does not know which action opened it/);
	assert.ok(!said.includes(`"tabId":${tab}`), said);
});

test("on_dialog is checked: click and press only, one step of actions, prompt text only with ok", async (t) => {
	setup(t);
	const tab = await agentTab();
	const refuse = async (method, params, re) => {
		const r = await request(method, { tabId: tab, ...params });
		assert.match(r.error?.message ?? "", re, `${method} ${JSON.stringify(params)}: ${JSON.stringify(r)}`);
	};
	await refuse("click", { x: 1, y: 1, on_dialog: "yes" }, /on_dialog must be "ok" or "cancel"/);
	for (const m of ["type", "fill", "scroll"])
		await refuse(m, { text: "x", value: "x", on_dialog: "ok" }, /on_dialog works on click and press, or on one click or press step inside actions, not on/);
	await refuse("actions", { on_dialog: "ok", steps: [{ click: { x: 1, y: 1 } }] }, /on_dialog goes on the one click or press step/);
	await refuse("actions", { steps: [{ type: { text: "x", on_dialog: "ok" } }] }, /not on type/);
	await refuse("actions", { steps: [{ click: { x: 1, y: 1, on_dialog: "ok" } }, { press: { key: "Enter", on_dialog: "ok" } }] }, /one step only/);
	// second-S5: prompt text without "ok" is refused the same way, with or without on_dialog.
	await refuse("click", { x: 1, y: 1, on_dialog: "cancel", on_dialog_text: "x" }, /^on_dialog_text needs on_dialog "ok"$/);
	await refuse("click", { x: 1, y: 1, on_dialog_text: "x" }, /^on_dialog_text needs on_dialog "ok"$/);
	assert.deepEqual(answers, []);
});
