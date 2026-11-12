// When the dialog guard cancels a box on an agent's tab (src/browser/dialog-guard.ts, docs/decisions.md D46): only when
// the box freezes the person's own tab of that site, never mid-call, and the agent hears once. Fake timers, no browser.
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
	cancelledDialog,
	consider,
	deps,
	dialogArrive,
	dialogAsk,
	dialogOpened,
	dialogTarget,
	dialogUseBegin,
	dialogUseEnd,
	replaced,
	resetDialogGuard,
	restoreDialogs,
	siteOf,
} from "../src/browser/dialog-guard.ts";

const AGENT = "bridge-claude-shop";
const session = { id: AGENT, tabIds: [1], currentTabId: 1 };
let dialogs;
let tabs;
let owners;
let notices;
let cancels;

const flush = () => new Promise((r) => setImmediate(r));
const tick = async (ms) => {
	for (let i = 0; i < 5; i++) await flush(); // what is already running looks at the clock first
	mock.timers.tick(ms);
	for (let i = 0; i < 5; i++) await flush();
};
const confirmOn = (tabId) => dialogs.set(tabId, { type: "confirm", message: "Delete this record?", url: "https://shop.example.com/admin" });
const personTab = (id, url, active) => tabs.push({ id, url, active });
/** A call that arrives and knows its session at once. */
const dialogUse = (s, method, params) => dialogUseBegin(dialogArrive(s.id), s, method, params);

beforeEach(() => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	resetDialogGuard();
	dialogs = new Map();
	tabs = [{ id: 1, url: "https://shop.example.com/admin", active: false }];
	owners = new Map([[1, AGENT]]);
	notices = [];
	cancels = [];
	Object.assign(deps, {
		openDialog: (id) => dialogs.get(id),
		cancel: async (id) => {
			cancels.push(id);
			dialogs.delete(id);
		},
		tabs: async () => tabs,
		owners: async () => owners,
		restored: async () => [],
		notice: async (owner, text) => void notices.push({ owner, text }),
		unnotice: async (owner, text) => {
			const i = notices.findIndex((n) => n.owner === owner && n.text === text);
			if (i < 0) return false;
			notices.splice(i, 1);
			return true;
		},
		grace: () => 3_000,
		open: () => 60_000,
	});
});
afterEach(() => {
	resetDialogGuard(); // its timers belong to this test's fake clock
	mock.timers.reset();
});

/** The agent clicks Delete: the click opens the box and returns. */
async function clickOpensConfirm() {
	const call = dialogUse(session, "click", { ref: "e4" });
	confirmOn(1);
	dialogOpened(1);
	dialogUseEnd(call);
	await tick(0);
}

test("a box with no tab of the person's on the site stays open, however long the agent thinks", async () => {
	personTab(9, "https://news.other.org/", true);
	await clickOpensConfirm();
	await tick(20_000);
	await tick(10 * 60_000);
	assert.deepEqual(cancels, []);
	assert.ok(dialogs.has(1));
});

test("the person's same-site tab in front: Cancel after the grace, and the agent is told once", async () => {
	personTab(5, "https://www.example.com/cart", true);
	await clickOpensConfirm();
	await tick(2_900);
	assert.deepEqual(cancels, [], "cancelled before the grace");
	await tick(200);
	assert.deepEqual(cancels, [1]);
	assert.equal(notices.length, 1);
	assert.match(notices[0].text, /cancelled, because the person was using a tab on example\.com.*The page saw Cancel\. Do the action again/);
});

test("handle_dialog says it once when tabs_context hasn't, and never again", async () => {
	personTab(5, "https://example.com/", true);
	await clickOpensConfirm();
	await tick(3_100);
	const text = notices[0].text;
	assert.equal(await cancelledDialog([1]), text);
	assert.equal(notices.length, 0, "the notice would tell it a second time");
	assert.equal(await cancelledDialog([1]), undefined);
	// Read by tabs_context first: handle_dialog adds nothing.
	confirmOn(1);
	dialogOpened(1);
	await tick(3_100);
	notices.length = 0;
	assert.equal(await cancelledDialog([1]), undefined);
});

test("handle_dialog in flight wins, also when it starts while the guard is reading the tabs", async () => {
	personTab(5, "https://example.com/", true);
	await clickOpensConfirm();
	// The agent answers at the deadline: its call is running, so nothing is cancelled.
	await tick(2_000);
	const answer = dialogUse(session, "dialog", { accept: true });
	await tick(5_000);
	assert.deepEqual(cancels, []);
	dialogs.delete(1);
	dialogUseEnd(answer);
	await tick(5_000);
	assert.deepEqual(cancels, []);

	// A new box; this time handle_dialog begins during the guard's own await.
	confirmOn(1);
	dialogOpened(1);
	await tick(0);
	let release;
	deps.tabs = () => new Promise((r) => (release = () => r(tabs)));
	mock.timers.tick(3_100);
	await flush();
	const late = dialogUse(session, "dialog", { accept: true });
	release();
	await tick(0);
	assert.deepEqual(cancels, [], "the guard cancelled a box the agent was answering");
	dialogUseEnd(late);
});

test("a box a page opens while tabs_create or the first navigate is still loading it stays open until the call ends", async () => {
	personTab(5, "https://example.com/", true);
	const fresh = { id: AGENT, tabIds: [], currentTabId: undefined };
	const call = dialogUse(fresh, "tabs.create", { url: "https://shop.example.com/admin" });
	tabs.push({ id: 7, url: "https://shop.example.com/admin", active: false });
	confirmOn(7);
	dialogOpened(7); // not owned yet
	await tick(0);
	owners.set(7, AGENT);
	await consider(7);
	await tick(10_000);
	assert.deepEqual(cancels, []);
	dialogUseEnd(call);
	await tick(100);
	assert.deepEqual(cancels, [7], "after the call it is an ordinary box");
	const nav = dialogUse(fresh, "navigate", { url: "https://shop.example.com/" });
	assert.equal(nav.holds, "session");
	dialogUseEnd(nav);
});

test("a pending ask_user holds the box under the one-minute rule, not the grace", async () => {
	personTab(5, "https://example.com/", true);
	dialogAsk(AGENT, true);
	await clickOpensConfirm();
	await tick(30_000);
	assert.deepEqual(cancels, []);
	await tick(30_100);
	assert.deepEqual(cancels, [1]);
	assert.match(notices[0].text, /the person has a tab open on example\.com/);
	dialogAsk(AGENT, false);
});

test("the person's same-site tab not in front: Cancel only after the box has been open a minute", async () => {
	personTab(5, "https://example.com/", false);
	await clickOpensConfirm();
	await tick(59_000);
	assert.deepEqual(cancels, []);
	// They bring it to the front: the grace starts now.
	tabs[1].active = true;
	await consider(1);
	await tick(2_000);
	assert.deepEqual(cancels, []);
	await tick(1_100);
	assert.deepEqual(cancels, [1]);
});

test("another agent's tab on the site is not the person's, and the agent's own active tab is no exemption", async () => {
	tabs.push({ id: 6, url: "https://example.com/", active: true });
	owners.set(6, "bridge-codex-other");
	tabs[0].active = true;
	await clickOpensConfirm();
	await tick(5 * 60_000);
	assert.deepEqual(cancels, []);
	// The side panel's tab is the person's.
	owners.set(6, "sidepanel-1");
	await consider(1);
	await tick(3_100);
	assert.deepEqual(cancels, [1]);
});

test("a call that ends on another tab never ends a call still running there", async () => {
	personTab(5, "https://example.com/", true);
	const two = { ...session, tabIds: [1, 2] };
	const first = dialogUse(two, "click", { tabId: 1 });
	const second = dialogUse(two, "actions", { tabId: 1 });
	confirmOn(1);
	dialogOpened(1);
	await tick(0);
	two.currentTabId = 2;
	dialogUseEnd(second);
	await tick(10_000);
	assert.deepEqual(cancels, [], "one end cleared both calls");
	dialogUseEnd(first);
	await tick(0);
	assert.deepEqual(cancels, [1]);
});

test("handle_dialog with no tabId holds and answers the one open box, also on a tab that isn't the current one", async () => {
	personTab(5, "https://example.com/", true);
	const two = { ...session, tabIds: [1, 2], currentTabId: 1 };
	tabs.push({ id: 2, url: "https://shop.example.com/b", active: false });
	owners.set(2, AGENT);
	confirmOn(2);
	dialogOpened(2);
	await tick(2_000);
	const answer = dialogUse(two, "dialog", { accept: true });
	assert.deepEqual(answer.dialog, { tabId: 2 });
	await tick(5_000);
	assert.deepEqual(cancels, [], "the guard cancelled the box handle_dialog was answering");
	dialogUseEnd(answer);
});

test("handle_dialog never answers a box it wasn't told about: after a Cancel it refuses and lists what is open", async () => {
	personTab(5, "https://example.com/", true);
	const two = { ...session, tabIds: [1, 2] };
	owners.set(2, AGENT);
	tabs.push({ id: 2, url: "https://other.net/", active: false });
	await clickOpensConfirm();
	dialogs.set(2, { type: "confirm", message: "Send?", url: "https://other.net/" });
	dialogOpened(2);
	await tick(3_100);
	assert.deepEqual(cancels, [1]);
	assert.deepEqual(dialogTarget(two.tabIds, undefined), { refuse: "cancelled", tabId: 1, open: [2] });
	assert.deepEqual(dialogTarget(two.tabIds, 1), { refuse: "cancelled", tabId: 1, open: [2] });
	assert.deepEqual(dialogTarget(two.tabIds, 2), { tabId: 2 });
	dialogs.set(1, { type: "alert", message: "x" });
	assert.deepEqual(dialogTarget([1, 2, 3], undefined).refuse, "cancelled");
	await cancelledDialog([1]);
	assert.deepEqual(dialogTarget([1, 2], undefined), { refuse: "several", open: [1, 2] });
});

test("a call holds the session's boxes from the moment it arrives, before it knows its session", async () => {
	personTab(5, "https://example.com/", true);
	await clickOpensConfirm();
	await tick(2_000);
	const use = dialogArrive(AGENT); // gateReady, isBridgeEnabled and getSession still to come
	await tick(10_000);
	assert.deepEqual(cancels, [], "Cancel raced a call that was already on its way");
	dialogUseEnd(use);
	await tick(3_200);
	assert.deepEqual(cancels, [1]);
});

test("a tab replaced during a call: the call ends on the new tab, which is not left busy", async () => {
	personTab(5, "https://example.com/", true);
	const ten = { ...session, tabIds: [10], currentTabId: 10 };
	owners.set(11, AGENT);
	tabs.push({ id: 11, url: "https://shop.example.com/admin", active: false });
	const call = dialogUse(ten, "navigate", { url: "https://shop.example.com/admin" });
	replaced(10, 11);
	confirmOn(11);
	dialogOpened(11);
	await tick(5_000);
	assert.deepEqual(cancels, [], "the call moved to the new tab");
	dialogUseEnd(call);
	await tick(3_200);
	assert.deepEqual(cancels, [11]);
});

test("a box an earlier worker kept gets the same rules after a restart", async () => {
	personTab(5, "https://example.com/", true);
	confirmOn(1); // no dialogOpened: this worker never saw it open
	deps.restored = async () => [1];
	await restoreDialogs();
	await tick(100);
	await tick(3_100);
	assert.deepEqual(cancels, [1]);
});

test("site is the registrable domain by the Public Suffix List", () => {
	assert.equal(siteOf("https://mail.google.com/x"), "google.com");
	assert.equal(siteOf("https://www.web.de/"), "web.de");
	assert.equal(siteOf("https://mail.web.de/"), "web.de");
	assert.equal(siteOf("https://web.de/"), "web.de");
	assert.equal(siteOf("https://shop.abc.de/"), siteOf("https://www.abc.de/"));
	assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
	assert.equal(siteOf("https://co.uk/"), "co.uk");
	assert.equal(siteOf("https://alice.github.io/"), "alice.github.io");
	assert.notEqual(siteOf("https://alice.github.io/"), siteOf("https://bob.github.io/"));
	assert.equal(siteOf("https://docs.alice.github.io/"), "alice.github.io");
	assert.equal(siteOf("https://WWW.Example.COM./"), "example.com");
	assert.equal(siteOf("http://localhost:3000/"), "localhost");
	assert.equal(siteOf("http://127.0.0.1:8080/"), "127.0.0.1");
	assert.equal(siteOf("http://[::1]:8080/"), "[::1]");
	assert.equal(siteOf("chrome://settings"), undefined);
	assert.equal(siteOf(undefined), undefined);
});
