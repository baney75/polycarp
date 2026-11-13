// on_dialog at the bridge (src/bridge/native.ts, src/bridge/dialogs.ts, src/browser/dialog-guard.ts, D48), the rules
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
const { deps, dialogAsk, reconcile, resetDialogGuard } = await import("../src/browser/dialog-guard.ts");
installCdpListeners();
// The bridge's long timers (its prune, each request's 90 s limit) must not hold the test process open.
/** Set by a test: the bridge's 90 s handler limit, or its 30 s count of a call's input, runs out after this many ms. */
let handlerLimit;
let countLimit;
globalThis.setTimeout = (fn, ms, ...args) => {
	const short = ms === 90_000 ? handlerLimit : ms === 30_000 ? countLimit : undefined;
	const t = realSetTimeout(fn, short ?? ms, ...args);
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
/** Set by a test: every answer to a box waits for this before it reaches the page. */
let holdAnswer;
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
		await holdAnswer;
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

/** The agent's tabs a test opened: closed after it, under the session's tab limit. */
let opened = [];
/** A fresh tab of the agent's on the site, with a page program; the guard's waits set, its clock mocked. */
async function agentTab(program) {
	const tabId = (await request("tabs.create")).result.tabId;
	opened.push(tabId);
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
		for (const tabId of opened) {
			programs.delete(tabId);
			void request("tabs.close", { tabId }).catch(() => undefined);
		}
		opened = [];
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
	// first-F4 (review of PR 200): the alert is quoted, never taken as the action's success.
	assert.match(r.result.note, /The alert said "Record deleted"\. Do not take it as a sign the action worked/);
	assert.doesNotMatch(r.result.note, /went through|That worked/);
	assert.doesNotMatch(r.result.note, /call (click|press) with/);
	await pastGrace();
	assert.deepEqual(answers.map((a) => [a.message, a.accept]), [
		["Delete the record?", true],
		["Record deleted", false],
	]);
	const said = await notice(tab);
	assert.match(said, /The alert dialog on tab \d+ \("Record deleted"\) was dismissed/);
	assert.match(said, /The alert said "Record deleted"\. Do not take it as a sign the action worked, and do not repeat the action yet/);
	assert.doesNotMatch(said, /went through/);
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
	// c1's click with on_dialog is on its way: its move to the spot is held, so no press has gone out and nothing is armed.
	const held = new Promise((r) => {
		release = r;
	});
	const plain = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (target.tabId === tab && method === "Input.dispatchMouseEvent" && params.type === "mouseMoved") {
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
	// c1 already failed: once the page is free, its click sends no more input, so its own box never opens.
	await wait(100);
	await pastGrace();
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [["A page timer's box", false]]);
	assert.equal(openDialog(tab), undefined);
	// And the other way: while c2 has a call running on the tab, a call with on_dialog there waits for it (PR 230).
	const slow = deliver("c2", "wait", { tabId: tab, ms: 300 });
	await wait(30);
	const c = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.ok((await reply(slow)).result && c.result?.dialog?.answered === "ok", JSON.stringify(c));
});

test("first-F3 (review of PR 200): on_dialog's OK fails: Polycarp cancels the box at once and the call fails, with no wait for the guard", async (t) => {
	setup(t);
	records.deleted = 0;
	const tab = await agentTab(deletePage);
	failNextOk = true;
	const t0 = performance.now();
	// No pastGrace: the guard's clock never moves, so only the failed answer's own Cancel can free the page.
	const r = await reply(deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" }), 2_000);
	assert.ok(performance.now() - t0 < 2_000);
	assert.equal(r.error?.code, "interrupted", JSON.stringify(r));
	assert.match(r.error.message, /on_dialog's OK did not reach it, so Polycarp answered Cancel and the page saw Cancel/);
	assert.doesNotMatch(r.error.message, /That worked|went through/);
	assert.deepEqual(answers.map((a) => [a.message, a.accept]), [["Delete the record?", false]]);
	assert.equal(openDialog(tab), undefined, "the box is still open");
	assert.equal(records.deleted, 0);
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
	assert.ok(said.includes(`call click on its own (not inside actions) with {"tabId":${tab},"x":10,"y":10,"on_dialog":"ok"}`), said);
	assert.doesNotMatch(said, /call actions with/);
	// The step alone, as the notice says: answered at once, and the step before it is not run again.
	const again = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.equal(again.error, undefined, JSON.stringify(again.error));
	assert.deepEqual(answers.map((a) => a.accept), [false, true]);
	assert.equal(rows, 1);
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

test("on_dialog is checked: click and press only, prompt text only with ok", async (t) => {
	setup(t);
	const tab = await agentTab();
	const refuse = async (method, params, re) => {
		const r = await request(method, { tabId: tab, ...params });
		assert.match(r.error?.message ?? "", re, `${method} ${JSON.stringify(params)}: ${JSON.stringify(r)}`);
	};
	await refuse("click", { x: 1, y: 1, on_dialog: "yes" }, /on_dialog must be "ok" or "cancel"/);
	for (const m of ["type", "fill", "scroll"])
		await refuse(m, { text: "x", value: "x", on_dialog: "ok" }, /on_dialog works on a single click or press call, not on/);
	// second-S5: prompt text without "ok" is refused the same way, with or without on_dialog.
	await refuse("click", { x: 1, y: 1, on_dialog: "cancel", on_dialog_text: "x" }, /^on_dialog_text needs on_dialog "ok"$/);
	await refuse("click", { x: 1, y: 1, on_dialog_text: "x" }, /^on_dialog_text needs on_dialog "ok"$/);
	assert.deepEqual(answers, []);
});

// The narrowed rules of the review of PR 200: on_dialog only on a single click or press; a hold covers every input to
// the tab; a timeout aborts for good; armed only while the input is out; failures after the answer say so.

/** Hold the tab's next mousePressed until `release()`; counts the mouse events that reach the tab. */
function holdPress(t, tabId, type = "mousePressed", only = () => true) {
	const seen = { pressed: 0, released: 0, offPage: 0 };
	let release;
	const held = new Promise((r) => {
		release = r;
	});
	const plain = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (target.tabId === tabId && method === "Input.dispatchMouseEvent" && params.type === type && only(params)) {
			seen.pressed++;
			await held;
		}
		// A release at (-1, -1) lets go of the button off the page: the element at the spot gets no click.
		if (target.tabId === tabId && method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
			if (params.x < 0) seen.offPage++;
			else seen.released++;
		}
		return plain(target, method, params);
	};
	t.after(() => {
		chrome.debugger.sendCommand = plain;
		release();
	});
	return { seen, release: () => release() };
}

test("second-S3, sol-F4, sol-F5 (review of PR 200): on_dialog anywhere in actions is refused before any step runs, with the single call to send", async (t) => {
	setup(t);
	let inputs = 0;
	const tab = await agentTab(async () => {
		inputs++;
	});
	const forms = [
		{ steps: [{ press: "Enter", on_dialog: "ok" }] },
		{ steps: [{ key: "Enter", on_dialog: "ok" }] },
		{ steps: [{ click: { x: 10, y: 10 }, on_dialog: "ok" }] },
		{ steps: [{ click: { x: 5, y: 5 } }, { click: { x: 10, y: 10, on_dialog: "ok" } }] },
		{ steps: [{ press: { key: "Enter", on_dialog: "cancel" } }] },
		{ steps: [{ click: { x: 10, y: 10, on_dialog_text: "x" } }] },
		{ on_dialog: "ok", steps: [{ click: { x: 10, y: 10 } }] },
	];
	for (const f of forms) {
		const r = await request("actions", { tabId: tab, settleMs: 0, ...f });
		assert.equal(r.error?.code, "bad_params", `${JSON.stringify(f)}: ${JSON.stringify(r)}`);
		assert.match(r.error.message, /^on_dialog is not allowed (on step \d+ of actions|on an actions call): nothing was run/);
		assert.match(r.error.message, /call (click|press) on its own with \{"tabId":\d+/);
	}
	// The example is the one call to send, on its tab, without the repeat (second-S4).
	const r = await request("actions", { tabId: tab, steps: [{ key: "Enter", repeat: 3, on_dialog: "ok" }] });
	assert.ok(r.error?.message.includes(`call press on its own with {"tabId":${tab},"key":"Enter","on_dialog":"ok"}`), JSON.stringify(r));
	assert.equal(inputs, 0, "a step ran");
	assert.deepEqual(answers, []);
});

test("sol-F1, first-F2, first-F6 (review of PR 200): a hold covers each step's own tab; the refusal says to send it again later", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Mine?");
	});
	const elsewhere = await agentTab(async () => undefined);
	const hold = holdPress(t, tab);
	// c1's click with on_dialog on `tab` is on its way: its last input has not gone out.
	const a = deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	for (let i = 0; i < 100 && !hold.seen.pressed; i++) await wait(5);
	// c2's batch names another tab, but its step clicks the held one: not sent.
	const b = await request("actions", { tabId: elsewhere, settleMs: 0, steps: [{ click: { tabId: tab, x: 20, y: 20 } }] }, "c2");
	assert.equal(b.error?.code, "not_sent", JSON.stringify(b));
	assert.match(b.error.message, new RegExp(`on tab ${tab}, so this call was not sent\\. Send it again once that call has ended`));
	assert.doesNotMatch(b.error.message, /waits/);
	assert.equal(hold.seen.pressed, 1, "c2's step reached the held tab");
	hold.release();
	const r = await reply(a);
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [["Mine?", true]]);
});

test("sol-F2, first-F1 (review of PR 200), second-S3 (review of PR 216): a call that timed out mid-click takes its answer back, lets go of the button off the page and clicks nothing at its spot", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Mine?");
	});
	const hold = holdPress(t, tab);
	handlerLimit = 300;
	t.after(() => {
		handlerLimit = undefined;
	});
	const r = await reply(deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" }));
	handlerLimit = undefined;
	assert.equal(r.error?.code, "timeout", JSON.stringify(r));
	// The handler goes on once Chrome answers: it must not send its last event at the spot, and must not leave the
	// button held down either, so it releases it at (-1, -1), off the page.
	hold.release();
	await wait(100);
	assert.equal(hold.seen.released, 0, "the timed-out call sent its click");
	assert.equal(hold.seen.offPage, 1, "the timed-out call left the button held down");
	// A confirm the page opens later on that tab is not answered with the ended call's OK.
	void box(tab, "confirm", "A later box");
	await wait(30);
	assert.deepEqual(answers, [], "a box took the ended call's OK");
	assert.equal(openDialog(tab)?.message, "A later box");
});

test("second-S2 (review of PR 200): on_dialog is taken back once the click returns: a box during its settle goes to the guard", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		realSetTimeout(() => void box(id, "confirm", "From a page timer"), 50);
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.equal(r.result?.dialog?.message, "From a page timer", JSON.stringify(r));
	assert.deepEqual(answers, [], "the settle's box took the click's OK");
	assert.ok(openDialog(tab));
});

test("second-S1 (review of PR 200): a call that fails after its on_dialog OK landed says so, and not to do it again", async (t) => {
	setup(t);
	records.deleted = 0;
	const other = await agentTab();
	// (a) a box on another of the session's tabs while the click settles.
	const tab = await agentTab(async (_i, id) => {
		if (await box(id, "confirm", "Delete the record?")) {
			records.deleted++;
			void box(other, "confirm", "Another tab's box");
		}
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.equal(r.error?.code, "dialog_open", JSON.stringify(r));
	assert.match(r.error.message, /Before that, a confirm dialog opened on tab \d+ \("Delete the record\?"\) and was answered OK at once, as on_dialog asked\. Do not repeat the action: read_page first/);
	assert.equal(records.deleted, 1);
	await pastGrace();
	// (b) the click itself fails after the OK: the page went away under it.
	const gone = await agentTab(async (_i, id) => {
		if (await box(id, "confirm", "Delete the record?")) {
			records.deleted++;
			throw new Error("Inspected target navigated or closed");
		}
	});
	const r2 = await request("click", { tabId: gone, x: 10, y: 10, on_dialog: "ok" });
	assert.ok(r2.error, JSON.stringify(r2));
	assert.match(r2.error.message, /Before that, a confirm dialog opened on tab \d+ \("Delete the record\?"\) and was answered OK at once/);
	assert.equal(records.deleted, 2);
});

test("second-S4, sol-F5 (review of PR 200): only the last press of a repeat opened the box: the notice names one press, never the repeat", async (t) => {
	setup(t);
	let enters = 0;
	const tab = await agentTab(async ({ key }, id) => {
		if (key === "Enter" && ++enters === 3) await box(id, "confirm", "Choose this item?");
	});
	const r = await request("press", { tabId: tab, key: "Enter", repeat: 3 });
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	await pastGrace();
	const said = await notice(tab);
	assert.match(said, /The first 2 of the 3 presses ran before it: do not press them again/);
	assert.ok(said.includes(`call press with {"tabId":${tab},"key":"Enter","on_dialog":"ok"}`), said);
	assert.doesNotMatch(said, /"repeat"/);
});

test("first-F4 (review of PR 200): an alert with no known cause is quoted and never called a success", async (t) => {
	setup(t);
	const tab = await agentTab();
	void box(tab, "alert", "Could not delete: server error");
	await pastGrace();
	const said = await notice(tab);
	assert.match(said, /The alert said "Could not delete: server error"\. Do not take it as a sign the action worked/);
	assert.doesNotMatch(said, /went through|nothing was lost/);
});

test("first-F5 (review of PR 200): with an ask_user pending, the call's note never says the box is cancelled before handle_dialog", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Delete this record?");
	});
	dialogAsk("bridge-claude-shop", true);
	t.after(() => dialogAsk("bridge-claude-shop", false));
	const r = await request("click", { tabId: tab, x: 10, y: 10 });
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.doesNotMatch(r.result.note, /do not call handle_dialog|cancels this box in about/);
	assert.match(r.result.note, /call handle_dialog with tabId/);
	// The grace rule is off while the question waits: the box stays for handle_dialog.
	await pastGrace();
	assert.deepEqual(answers, []);
	assert.ok(openDialog(tab));
});

// The review of PR 216, round 1.

test("sol-F1 (review of PR 216): a box a page timer opens after the click returned is not blamed on the click", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		realSetTimeout(() => void box(id, "confirm", "From a page timer"), 50);
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	assert.equal(r.result?.dialog?.message, "From a page timer", JSON.stringify(r));
	assert.deepEqual(answers, []);
	await pastGrace();
	// The click's input had all gone out: nothing says the click opened it, or that it may be repeated.
	const said = await notice(tab);
	assert.match(said, /Polycarp does not know which action opened it/);
	assert.doesNotMatch(said, /call \w+ with|on_dialog": "ok"|click/);
});

test("sol-F2, second-S2 (review of PR 216): a call that runs out of time after its on_dialog OK landed says so, and not to repeat it", async (t) => {
	setup(t);
	records.deleted = 0;
	let unhang;
	const hang = new Promise((r) => {
		unhang = r;
	});
	const tab = await agentTab(async (_i, id) => {
		if (await box(id, "confirm", "Delete the record?")) {
			records.deleted++;
			// The page goes on working after the box: the click's release never returns.
			await hang;
		}
	});
	handlerLimit = 300;
	t.after(() => {
		handlerLimit = undefined;
		unhang();
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	handlerLimit = undefined;
	assert.equal(r.error?.code, "timeout", JSON.stringify(r));
	assert.match(r.error.message, /click did not finish within \d+ ms/);
	assert.match(
		r.error.message,
		/Before that, a confirm dialog opened on tab \d+ \("Delete the record\?"\) and was answered OK at once, as on_dialog asked\. Do not repeat the action: read_page first/,
	);
	assert.equal(records.deleted, 1);
});

test("sol-F3, first-F2 (review of PR 216): a step that resolves the current tab after it became held is not sent", async (t) => {
	setup(t);
	const a = await agentTab(async () => undefined);
	const held = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Mine?");
	});
	await request("tabs.select", { tabId: a }, "c2");
	// c2's batch starts with tab `a` current, so the check at its start passes; its click names no tab.
	const batch = deliver("c2", "actions", { settleMs: 0, steps: [{ wait: 150 }, { click: { x: 20, y: 20 } }] });
	await wait(20);
	// Meanwhile c1 makes `held` current and starts a click with on_dialog on it, held at its press.
	await request("tabs.select", { tabId: held }, "c1");
	const hold = holdPress(t, held);
	const c1 = deliver("c1", "click", { tabId: held, x: 10, y: 10, on_dialog: "ok" });
	for (let i = 0; i < 100 && !hold.seen.pressed; i++) await wait(5);
	// c2's click step now resolves to `held`: refused there, and since its wait step ran, as interrupted.
	const b = await reply(batch);
	assert.equal(b.error?.code, "interrupted", JSON.stringify(b));
	assert.match(b.error.message, new RegExp(`step 1 \\(click\\) failed after 1 steps succeeded: A call with on_dialog is still running on tab ${held}`));
	assert.equal(hold.seen.pressed, 1, "c2's step reached the held tab");
	hold.release();
	const r = await reply(c1);
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [["Mine?", true]]);
});

test("sol-F3, first-F2 (review of PR 216): a step that resolved the current tab late holds it against a later on_dialog call", async (t) => {
	setup(t);
	const a = await agentTab(async () => undefined);
	let clicks = 0;
	const late = await agentTab(async () => {
		clicks++;
	});
	await request("tabs.select", { tabId: a }, "c2");
	// c2's batch starts on `a`; by its click step `late` is current, and its last wait keeps it running there.
	const batch = deliver("c2", "actions", { settleMs: 0, steps: [{ wait: 100 }, { click: { x: 20, y: 20 } }, { wait: 300 }] });
	await wait(20);
	await request("tabs.select", { tabId: late }, "c1");
	for (let i = 0; i < 100 && !clicks; i++) await wait(5);
	assert.equal(clicks, 1, "c2's click step did not run");
	// c2 is still running on `late`: a click with on_dialog there waits until it has ended (PR 230).
	const c = await request("click", { tabId: late, x: 10, y: 10, on_dialog: "ok" }, "c1");
	assert.equal(c.error, undefined, JSON.stringify(c));
	const b = await reply(batch);
	assert.equal(b.error, undefined, JSON.stringify(b.error));
});

test("first-F1 (review of PR 216): a confirm the page opens on mousedown is answered by the click's on_dialog", async (t) => {
	setup(t);
	records.deleted = 0;
	const tab = await agentTab(async () => undefined);
	const plain = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (target.tabId === tab && method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
			if (await box(tab, "confirm", "Delete the record?")) records.deleted++;
		}
		return plain(target, method, params);
	};
	// Long enough for the click's settle (the frozen clock runs it to its cap), short enough to fail fast without the fix.
	handlerLimit = 6000;
	t.after(() => {
		chrome.debugger.sendCommand = plain;
		handlerLimit = undefined;
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	handlerLimit = undefined;
	assert.equal(r.error, undefined, JSON.stringify(r.error));
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [["Delete the record?", true]]);
	assert.equal(records.deleted, 1);
	assert.equal(openDialog(tab), undefined);
});

// first-F3 (a doubled /** opener above watchPresetFailures in cdp.ts) is a comment fix: biome and tsc pass either way, so
// it has no test.

// The review of PR 227 (PR 216's commits), round 1.

test("F1 (review of PR 227): a double click that timed out at its first press clicks nothing at its spot and presses no more", async (t) => {
	setup(t);
	const tab = await agentTab(async () => undefined);
	const hold = holdPress(t, tab);
	handlerLimit = 300;
	t.after(() => {
		handlerLimit = undefined;
	});
	const r = await reply(deliver("c1", "click", { tabId: tab, x: 10, y: 10, clickCount: 2 }));
	handlerLimit = undefined;
	assert.equal(r.error?.code, "timeout", JSON.stringify(r));
	hold.release();
	await wait(100);
	assert.equal(hold.seen.released, 0, "the timed-out double click released at its target");
	assert.equal(hold.seen.pressed, 1, "the timed-out double click pressed again");
	assert.equal(hold.seen.offPage, 1, "the timed-out double click left the button held down");
	assert.deepEqual(answers, []);
});

test("F3 (review of PR 227): a call that ended before it resolved a new current tab leaves no hold on that tab", async (t) => {
	setup(t);
	const a = await agentTab(async () => undefined);
	const b = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Mine?");
	});
	await request("tabs.select", { tabId: a }, "c2");
	// c2's batch is counted on `a`; by its click step `b` is current, and the click's own read of the current tab is slow.
	let slow = false;
	const tabsGet = chrome.tabs.get;
	chrome.tabs.get = async (id, ...rest) => {
		if (slow && id === b && new Error().stack?.includes("requireCurrentTab")) await wait(600);
		return tabsGet.call(chrome.tabs, id, ...rest);
	};
	t.after(() => {
		chrome.tabs.get = tabsGet;
		handlerLimit = undefined;
	});
	handlerLimit = 300;
	const batch = deliver("c2", "actions", { settleMs: 0, steps: [{ wait: 100 }, { click: { x: 20, y: 20 } }] });
	await wait(20);
	await request("tabs.select", { tabId: b }, "c1");
	slow = true;
	const r = await reply(batch);
	handlerLimit = undefined;
	assert.equal(r.error?.code, "timeout", JSON.stringify(r));
	// The read of `b` returns after c2's call ended: c2 must not be counted on `b` for good.
	await wait(700);
	slow = false;
	const c = await request("click", { tabId: b, x: 10, y: 10, on_dialog: "ok" }, "c1");
	assert.equal(c.error, undefined, JSON.stringify(c.error));
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [["Mine?", true]]);
});

test("first-F1 (review of PR 227): an actions batch whose screenshot finds the current tab held says its steps ran, never not_sent", async (t) => {
	setup(t);
	const a = await agentTab(async () => undefined);
	const held = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Mine?");
	});
	await request("tabs.select", { tabId: a }, "c2");
	const batch = deliver("c2", "actions", { settleMs: 0, steps: [{ wait: 150 }], screenshot: true });
	await wait(20);
	await request("tabs.select", { tabId: held }, "c1");
	const hold = holdPress(t, held);
	const c1 = deliver("c1", "click", { tabId: held, x: 10, y: 10, on_dialog: "ok" });
	for (let i = 0; i < 100 && !hold.seen.pressed; i++) await wait(5);
	const r = await reply(batch);
	assert.equal(r.error?.code, "interrupted", JSON.stringify(r));
	assert.match(r.error.message, /all 1 steps ran, but the screenshot after them was not taken/);
	assert.match(r.error.message, /Do not send the steps again/);
	hold.release();
	assert.equal((await reply(c1)).error, undefined);
});

test("second-S1 (review of PR 227): on_dialog on a double click is refused before anything is armed or sent", async (t) => {
	setup(t);
	let presses = 0;
	const tab = await agentTab(async (_i, id) => {
		presses++;
		await box(id, "confirm", "Delete the record?");
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, clickCount: 2, on_dialog: "ok" });
	assert.equal(r.error?.code, "bad_params", JSON.stringify(r));
	assert.match(r.error.message, /^on_dialog works on a single click; double-click first, then answer with handle_dialog\. Nothing was done/);
	assert.equal(presses, 0);
	assert.deepEqual(answers, []);
	// A single click, with clickCount 1 said outright, still takes it.
	const ok = await request("click", { tabId: tab, x: 10, y: 10, clickCount: 1, on_dialog: "ok" });
	assert.equal(ok.error, undefined, JSON.stringify(ok.error));
	assert.deepEqual(answers.map((x) => [x.message, x.accept]), [["Delete the record?", true]]);
});

test("first-F1, sol-F3 (review of PR 230): a double click's box names no on_dialog call, which would be refused", async (t) => {
	setup(t);
	let releases = 0;
	const tab = await agentTab(async (_i, id) => {
		if (++releases === 2) await box(id, "confirm", "Open the record?");
	});
	const r = await request("click", { tabId: tab, x: 10, y: 10, clickCount: 2 });
	await pastGrace();
	for (const said of [r.result.note, await notice(tab)]) {
		assert.match(said, /opened on a double click, which can't take on_dialog/, said);
		assert.doesNotMatch(said, /clickCount|call click with/, said);
	}
	const batch = await request("actions", { tabId: tab, steps: [{ doubleClick: { x: 10, y: 10 }, on_dialog: "ok" }] });
	assert.match(batch.error?.message, /A double click can't take it: double-click first, then answer with handle_dialog\.$/);
});

test("sol-F2, sol-F1 (review of PR 230): a press that outlived its call keeps the tab: a box then names no one to repeat, and on_dialog waits", async (t) => {
	setup(t);
	const tab = await agentTab(async ({ x }, id) => {
		if (x !== 10) await box(id, "confirm", x === 20 ? "Mine?" : "Delete the record?");
	});
	const hold = holdPress(t, tab, "mousePressed", (p) => p.x === 10);
	handlerLimit = 300;
	t.after(() => {
		handlerLimit = undefined;
	});
	assert.equal((await request("click", { tabId: tab, x: 10, y: 10 })).error?.code, "timeout");
	handlerLimit = undefined;
	assert.equal((await request("click", { tabId: tab, x: 20, y: 20 }, "c2")).error, undefined);
	await pastGrace();
	const said = await notice(tab);
	assert.match(said, /does not know which action opened it/, said);
	assert.doesNotMatch(said, /on_dialog/, said);
	let ran = false;
	const two = request("click", { tabId: tab, x: 20, y: 20, on_dialog: "ok" }, "c2").then((r) => ((ran = true), r));
	await wait(200);
	assert.equal(ran, false, "on_dialog ran while another call's press was out");
	hold.release();
	await wait(50);
	await pastGrace();
	assert.equal((await two).error, undefined);
	assert.deepEqual(answers.map((x) => `${x.message} ${x.accept}`), ["Mine? false", "Delete the record? false", "Mine? true"]);
});

test("second-S1 (review of PR 230): another call's on_dialog box on another tab never stops a call on its own tab", async (t) => {
	setup(t);
	const a = await agentTab(async () => undefined);
	const b = await agentTab(async (_i, id) => {
		await box(id, "confirm", "Delete the record?");
	});
	const hold = holdPress(t, a);
	const one = deliver("c1", "click", { tabId: a, x: 10, y: 10 });
	for (let i = 0; i < 100 && !hold.seen.pressed; i++) await wait(5);
	const two = await request("click", { tabId: b, x: 10, y: 10, on_dialog: "ok" }, "c2");
	assert.equal(two.result?.dialog?.answered, "ok", JSON.stringify(two));
	hold.release();
	const r = await reply(one);
	assert.equal(r.error, undefined, `c1 was stopped by c2's box: ${JSON.stringify(r.error)}`);
});

test("sol-sol-F2 (round 2 of the review of PR 230): input out past the 30 s count: no cause, and on_dialog refused until it returns", async (t) => {
	setup(t);
	const tab = await agentTab(async ({ x }, id) => {
		if (x === 20) await box(id, "confirm", "Mine?");
	});
	const hold = holdPress(t, tab, "mousePressed", (p) => p.x === 10);
	[handlerLimit, countLimit] = [300, 100];
	t.after(() => {
		[handlerLimit, countLimit] = [undefined, undefined];
	});
	assert.equal((await request("click", { tabId: tab, x: 10, y: 10 })).error?.code, "timeout");
	await wait(200);
	[handlerLimit, countLimit] = [undefined, undefined];
	assert.equal((await request("click", { tabId: tab, x: 20, y: 20 }, "c2")).error, undefined);
	await pastGrace();
	assert.match(await notice(tab), /does not know which action opened it/);
	const refused = await request("click", { tabId: tab, x: 20, y: 20, on_dialog: "ok" }, "c2");
	assert.equal(refused.error?.code, "not_sent", JSON.stringify(refused));
	hold.release();
	await wait(50);
	const ok = await request("click", { tabId: tab, x: 20, y: 20, on_dialog: "ok" }, "c2");
	assert.equal(ok.result?.dialog?.answered, "ok", JSON.stringify(ok));
});

test("sol-F1 (round 2 of the review of PR 230): handle_dialog for a box on_dialog is answering is refused: one answer per box", async (t) => {
	setup(t);
	const tab = await agentTab(async (_i, id) => {
		if (await box(id, "confirm", "Delete A?")) await box(id, "confirm", "Delete B?");
	});
	let open;
	holdAnswer = new Promise((r) => {
		open = r;
	});
	t.after(() => {
		holdAnswer = undefined;
		open();
	});
	const one = deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	for (let i = 0; i < 200 && !openDialog(tab); i++) await wait(5);
	const two = request("dialog", { accept: true, tabId: tab }, "c2");
	await wait(50);
	holdAnswer = undefined;
	open();
	const r = await two;
	assert.match(r.error?.message ?? "", /already answered/, JSON.stringify(r));
	await reply(one);
	await pastGrace();
	assert.deepEqual(answers.map((x) => `${x.message} ${x.accept}`), ["Delete A? true", "Delete B? false"]);
});

// Last: it takes the native host away, and nothing after it could reach the bridge.
test("F2 (review of PR 227): the host going away while a click's answer is armed takes the answer back at once", async (t) => {
	setup(t);
	const tab = await agentTab(async () => undefined);
	const hold = holdPress(t, tab);
	const a = deliver("c1", "click", { tabId: tab, x: 10, y: 10, on_dialog: "ok" });
	// The press is on its way, so the answer is armed. Then the host goes.
	for (let i = 0; i < 100 && !hold.seen.pressed; i++) await wait(5);
	for (const fn of port.onDisconnect.listeners) fn();
	// A box the page opens before the press returns: the ended call's OK must not answer it.
	void box(tab, "confirm", "Delete the record?");
	await wait(30);
	assert.deepEqual(answers, [], "a box took the OK of a call whose host had gone");
	assert.equal(openDialog(tab)?.message, "Delete the record?");
	hold.release();
	void a;
});
