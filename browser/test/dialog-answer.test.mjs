// handle_dialog answers the box it was called for, by identity (docs/decisions.md D46): fake chrome, real cdp events.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { installCdpListeners, openDialog } = await import("../src/browser/cdp.ts");
const { answerDialog } = await import("../src/browser/cdp.ts");
const { deps, dialogAnswerArrive, reconcile, resetDialogGuard } = await import("../src/browser/dialog-guard.ts");
const { handlers } = await import("../src/bridge/tools.ts");
installCdpListeners();

const event = (tabId, method, params) => {
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, method, params);
};
const sent = [];
/** Runs as the page gets an answer, before its reply comes back. */
let onAnswer;
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Page.handleJavaScriptDialog") {
		sent.push({ tabId: target.tabId, ...params });
		await onAnswer?.(target.tabId, params);
	}
	return send.call(chrome.debugger, target, method, params);
};
const saved = { ...deps };
afterEach(() => {
	Object.assign(deps, saved);
	resetDialogGuard();
	onAnswer = undefined;
	sent.length = 0;
});
const confirmOn = (tabId, message = "Delete this record?") =>
	event(tabId, "Page.javascriptDialogOpening", { type: "confirm", message, url: "https://shop.example.com/" });
/** The guard sees these tabs and owners, the person's www.example.com tab in front, and cancels at once when due. */
const guardSees = (owned, grace = 0) => {
	const notices = [];
	Object.assign(deps, {
		tabs: async () => [
			...[...owned.keys()].map((id) => ({ id, url: "https://shop.example.com/", active: false })),
			{ id: 99, url: "https://www.example.com/cart", active: true },
		],
		owners: async () => owned,
		notice: async (owner, text) => void notices.push({ owner, text }),
		unnotice: async (owner, text) => {
			const i = notices.findIndex((n) => n.owner === owner && n.text === text);
			if (i >= 0) notices.splice(i, 1);
			return i >= 0;
		},
		grace: () => grace,
	});
	return notices;
};
const settled = async () => {
	for (let i = 0; i < 20; i++) {
		await reconcile();
		await new Promise((r) => setImmediate(r));
	}
};
const session = { id: "bridge-claude-shop", tabIds: [7], currentTabId: 7 };

test("sol-F2: a call for a box that closed while it waited never answers the next box on that tab", async () => {
	event(7, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete this record?", url: "https://shop.example.com/" });
	const answer = dialogAnswerArrive(session.id, session.tabIds, 7);
	assert.ok(answer.target, "the call found its box on arrival");
	// While the call waits its turn, the person answers the first box and the page opens another.
	event(7, "Page.javascriptDialogClosed", { result: true });
	event(7, "Page.javascriptDialogOpening", { type: "confirm", message: "Also delete the backups?", url: "https://shop.example.com/" });
	await assert.rejects(
		handlers.dialog({ session, dialogAnswer: answer }, { accept: true, tabId: 7 }),
		(err) => /^No box to answer: the dialog this call was for on tab 7 is gone; read_page/.test(err.message),
	);
	assert.deepEqual(sent, [], "OK went to a box the agent never saw");
	assert.equal(openDialog(7)?.message, "Also delete the backups?");
	// A fresh call for the box that is open now answers it.
	const again = await handlers.dialog({ session }, { accept: false, tabId: 7 });
	assert.equal(again.message, "Also delete the backups?");
	assert.deepEqual(sent, [{ tabId: 7, accept: false }]);
});

test("second-S1: a box the page opens while the answer to the one before is on its way stays known", async () => {
	confirmOn(8, "Delete this record?");
	// The page reacts to Cancel by asking again before Chrome's reply to the Cancel comes back.
	onAnswer = (tabId) => {
		onAnswer = undefined;
		event(tabId, "Page.javascriptDialogClosed", { result: false });
		event(tabId, "Page.javascriptDialogOpening", { type: "alert", message: "Cancelled", url: "https://shop.example.com/" });
	};
	await answerDialog(8, false);
	assert.equal(openDialog(8)?.message, "Cancelled", "the second box was forgotten while the page shows it");
	await answerDialog(8, true);
});

test("sol-F4: a queued handle_dialog whose tab another session took meanwhile presses nothing", async () => {
	const mine = { id: "bridge-claude-shop", tabIds: [9], currentTabId: 9 };
	confirmOn(9);
	const answer = dialogAnswerArrive(mine.id, mine.tabIds, 9);
	assert.ok(answer.target);
	// While the call waits in its queue, another session adopts the tab (BrowserSession.adopt), box and all.
	mine.tabIds = [];
	await assert.rejects(
		handlers.dialog({ session: mine, dialogAnswer: answer }, { accept: true, tabId: 9 }),
		(err) => /not one of your tabs|no longer one of your tabs/.test(err.message),
	);
	assert.deepEqual(sent, [], "OK was pressed on another session's tab");
	await answerDialog(9, false);
});

test("sol-F3: a session asking about another session's tab neither hears nor clears that session's notice", async () => {
	const a = { id: "bridge-claude-shop", tabIds: [10], currentTabId: 10 };
	const b = { id: "bridge-codex-other", tabIds: [11], currentTabId: 11 };
	const notices = guardSees(new Map([[10, a.id], [11, b.id]]));
	confirmOn(10);
	await settled();
	assert.equal(notices.length, 1, "the guard did not cancel A's box");
	await assert.rejects(
		handlers.dialog({ session: b }, { accept: true, tabId: 10 }),
		(err) => /not one of your tabs/.test(err.message) && !/was cancelled/.test(err.message),
	);
	assert.equal(notices.length, 1, "B cleared A's notice");
	await assert.rejects(handlers.dialog({ session: a }, { accept: true, tabId: 10 }), (err) => /was cancelled/.test(err.message));
});

test("first-F3: an unheard Cancel on one tab does not refuse the answer for the box still open on another", async () => {
	const s = { id: "bridge-claude-shop", tabIds: [12, 13], currentTabId: 12 };
	guardSees(new Map([[12, s.id], [13, s.id]]));
	confirmOn(12);
	await settled();
	assert.equal(openDialog(12), undefined, "the guard did not cancel box A");
	deps.grace = () => 60_000;
	confirmOn(13, "Send the invoice?");
	await settled();
	sent.length = 0;
	const r = await handlers.dialog({ session: s }, { accept: true });
	assert.equal(r.message, "Send the invoice?");
	assert.deepEqual(sent, [{ tabId: 13, accept: true }]);
});

test("sol-F5: an answer that arrives while its box's Cancel is on its way answers that box when the Cancel fails", async () => {
	const s = { id: "bridge-claude-shop", tabIds: [14], currentTabId: 14 };
	guardSees(new Map([[14, s.id]]));
	let fail;
	deps.cancel = () => new Promise((_, reject) => (fail = () => reject(new Error("detached mid-send"))));
	confirmOn(14);
	for (let i = 0; i < 50 && !fail; i++) {
		void reconcile();
		await new Promise((r) => setImmediate(r));
	}
	assert.ok(fail, "the guard sent no Cancel");
	const answer = dialogAnswerArrive(s.id, s.tabIds, undefined);
	const call = handlers.dialog({ session: s, dialogAnswer: answer }, { accept: true });
	fail();
	const r = await call;
	assert.equal(r.accepted, true);
	assert.deepEqual(sent, [{ tabId: 14, accept: true }]);
});

test("sol-F3 (review of PR 200): an answer that found no box on arrival never answers a box that opened since", async () => {
	const s = { id: "bridge-claude-shop", tabIds: [15], currentTabId: 15 };
	// The box the agent reviewed has closed: nothing is fixed on arrival.
	const answer = dialogAnswerArrive(s.id, s.tabIds, 15);
	assert.equal(answer.target, undefined);
	// Before the handler runs, another client's click opens a different confirm on that tab.
	confirmOn(15);
	await assert.rejects(
		handlers.dialog({ session: s, dialogAnswer: answer }, { accept: true, tabId: 15 }),
		(err) => /^No box to answer on tab 15; read_page/.test(err.message),
	);
	assert.deepEqual(sent, [], "OK went to a box the agent never saw");
	assert.equal(openDialog(15)?.message, "Delete this record?");
});

test("sol-F1, first-F2: a Cancel the page has not answered in 5 s is never sent again, and no OK goes out meanwhile", async () => {
	const s = { id: "bridge-claude-shop", tabIds: [16], currentTabId: 16 };
	const notices = guardSees(new Map([[16, s.id]]));
	let land;
	onAnswer = (_tabId, params) => (params.accept ? undefined : new Promise((r) => (land = r)));
	confirmOn(16);
	await settled();
	assert.equal(sent.length, 1, "the guard sent no Cancel");
	// handle_dialog while it is out: told so after 5 s, and its OK is never sent.
	const call = handlers.dialog({ session: s }, { accept: true });
	await assert.rejects(call, (err) => /has not come back from the page in 5 s/.test(err.message));
	// Past the old 5 s limit and its 1 s retry.
	for (let i = 0; i < 4; i++) {
		await new Promise((r) => setTimeout(r, 500));
		await settled();
	}
	assert.deepEqual(sent, [{ tabId: 16, accept: false }], "a second answer went to the box while the Cancel was out");
	// The Cancel lands late: the box is gone, and the agent is told once.
	land();
	event(16, "Page.javascriptDialogClosed", { result: false });
	await settled();
	assert.equal(openDialog(16), undefined);
	assert.equal(notices.length, 1, "a late Cancel was never told");
});
