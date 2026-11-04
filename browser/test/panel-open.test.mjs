// Opening the side panel on a tab must not get that panel closed by the worker while the
// panel's session is still being written (Donovan saw every open close itself, 2026-10-27).
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const event = () => {
	const listeners = [];
	return { listeners, addListener: (fn) => listeners.push(fn), removeListener() {} };
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** The fake chrome plus what background.ts uses that the session tests don't. */
function setup() {
	const fake = installFakeChrome();
	const setOptions = [];
	chrome.sidePanel = {
		async setOptions(o) {
			setOptions.push(structuredClone(o));
		},
		async open() {},
		async getOptions() {
			return {};
		},
		async setPanelBehavior() {},
	};
	chrome.runtime.onConnect = event();
	chrome.runtime.onInstalled = event();
	chrome.runtime.onStartup = event();
	for (const k of ["onActivated", "onRemoved", "onCreated", "onUpdated", "onReplaced"]) chrome.tabs[k] ??= event();
	chrome.commands = { onCommand: event() };
	chrome.windows.getAll ??= async () => [{ id: 1, type: "normal" }];
	chrome.windows.onFocusChanged ??= event();
	chrome.webNavigation.onCommitted ??= event();
	chrome.debugger = { ...(chrome.debugger ?? {}), onDetach: event(), onEvent: event(), async attach() {}, async detach() {}, async sendCommand() { return {}; } };
	chrome.contextMenus = { create() {}, removeAll(cb) { cb?.(); }, onClicked: event() };
	return { fake, setOptions };
}

test("opening the panel on a tab keeps it open while the panel writes its session", async () => {
	let closed = 0;
	const runs = 20;
	for (let run = 0; run < runs; run++) {
		const { fake, setOptions } = setup();
		const home = fake.addTab({ active: true });
		await import(`../src/background.ts?ctx=worker-${run}-${Math.random()}`);
		await settle(50);
		// The user clicks the toolbar button on the active tab.
		for (const fn of chrome.action.onClicked.listeners) fn({ id: home, windowId: 1 });
		// The panel document starts and connects, then opens its session the way sidepanel.ts does.
		const port = { name: "sidepanel:1", onDisconnect: event(), onMessage: event(), postMessage() {}, disconnect() {} };
		for (const fn of chrome.runtime.onConnect.listeners) fn(port);
		const { BrowserSession } = await import(`../src/browser/session.ts?ctx=panel-${run}-${Math.random()}`);
		const session = await BrowserSession.open(`tab-${home}`, "chat", 1);
		await session.setHomeTab(home);
		await session.adopt(home, true);
		await settle();
		if (setOptions.some((o) => o.tabId === home && o.enabled === false)) closed++;
	}
	assert.equal(closed, 0, `${closed}/${runs} opens had their panel disabled (closed) by the worker`);
});

test("a tab the user switches to that no task owns still gets no panel", async () => {
	const { fake, setOptions } = setup();
	const home = fake.addTab({ active: true });
	const other = fake.addTab({ active: false, url: "https://other.example/" });
	await import(`../src/background.ts?ctx=worker-switch-${Math.random()}`);
	await settle(50);
	for (const fn of chrome.action.onClicked.listeners) fn({ id: home, windowId: 1 });
	const port = { name: "sidepanel:1", onDisconnect: event(), onMessage: event(), postMessage() {}, disconnect() {} };
	for (const fn of chrome.runtime.onConnect.listeners) fn(port);
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=panel-switch-${Math.random()}`);
	const session = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await session.setHomeTab(home);
	await session.adopt(home, true);
	await settle();
	for (const fn of chrome.tabs.onActivated.listeners) fn({ tabId: other, windowId: 1 });
	await settle();
	assert.ok(!setOptions.some((o) => o.tabId === other && o.enabled !== false), "the foreign tab is not given the task's panel");
	assert.ok(!setOptions.some((o) => o.tabId === home && o.enabled === false), "the home tab keeps its panel");
});

test("a tab whose task is gone loses its panel once the open has settled", async () => {
	const { fake, setOptions } = setup();
	const home = fake.addTab({ active: true });
	await import(`../src/background.ts?ctx=worker-gone-${Math.random()}`);
	await settle(50);
	for (const fn of chrome.action.onClicked.listeners) fn({ id: home, windowId: 1 });
	const port = { name: "sidepanel:1", onDisconnect: event(), onMessage: event(), postMessage() {}, disconnect() {} };
	for (const fn of chrome.runtime.onConnect.listeners) fn(port);
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=panel-gone-${Math.random()}`);
	const session = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await session.setHomeTab(home);
	await session.adopt(home, true);
	await settle();
	// The task goes away while its tab stays open and active: the panel must not linger.
	await session.close();
	await settle(300);
	assert.ok(setOptions.some((o) => o.tabId === home && o.enabled === false), "the panel is disabled once no task owns the tab");
});

test("a fresh task's own tab isn't pointed at another task left marked busy", async () => {
	const { fake, setOptions } = setup();
	const otherHome = fake.addTab({ active: false });
	const tab = fake.addTab({ active: true });
	// A previous task's panel closed mid-run and left its busy marker behind.
	await chrome.storage.session.set({ sidepanel_busy_1: otherHome });
	await import(`../src/background.ts?ctx=worker-busy-${Math.random()}`);
	await settle(50);
	for (const fn of chrome.action.onClicked.listeners) fn({ id: tab, windowId: 1 });
	const port = { name: "sidepanel:1", onDisconnect: event(), onMessage: event(), postMessage() {}, disconnect() {} };
	for (const fn of chrome.runtime.onConnect.listeners) fn(port);
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=panel-busy-${Math.random()}`);
	const session = await BrowserSession.open(`tab-${tab}`, "chat", 1);
	await session.setHomeTab(tab);
	await session.adopt(tab, true);
	await settle();
	assert.ok(!setOptions.some((o) => o.tabId === tab && o.path === `sidepanel.html?tabId=${otherHome}`), "not re-pointed at the other task");
	assert.ok(!setOptions.some((o) => o.tabId === tab && o.enabled === false), "and not closed");
});

test("a panel whose task never names its tab is closed after the pending-open window", async () => {
	const { fake, setOptions } = setup();
	const tab = fake.addTab({ active: true });
	globalThis.__TABKYRA_PENDING_OPEN_MS = 200;
	try {
		await import(`../src/background.ts?ctx=worker-timeout-${Math.random()}`);
		await settle(50);
		for (const fn of chrome.action.onClicked.listeners) fn({ id: tab, windowId: 1 });
		// The panel never writes a session naming the tab (it failed to start). A reconcile inside
		// the window (here the tab is re-activated) must leave the panel open.
		await settle(50);
		for (const fn of chrome.tabs.onActivated.listeners) fn({ tabId: tab, windowId: 1 });
		await settle(50);
		assert.ok(!setOptions.some((o) => o.tabId === tab && o.enabled === false), "kept open during the window");
		await settle(400);
		assert.ok(setOptions.some((o) => o.tabId === tab && o.enabled === false), "closed once the window passed");
	} finally {
		delete globalThis.__TABKYRA_PENDING_OPEN_MS;
	}
});

test("a reconcile already reading the busy marker when the user opens a fresh task leaves that panel alone", async () => {
	const { fake, setOptions } = setup();
	const otherHome = fake.addTab({ active: false });
	const tab = fake.addTab({ active: true });
	await chrome.storage.session.set({ sidepanel_busy_1: otherHome });
	// Hold the busy-marker read open so the click lands while a reconcile waits on it.
	const realGet = chrome.storage.session.get.bind(chrome.storage.session);
	let release;
	let holding = false;
	chrome.storage.session.get = async (keys) => {
		if (holding && keys === "sidepanel_busy_1") {
			await new Promise((r) => (release = r));
			holding = false;
		}
		return realGet(keys);
	};
	await import(`../src/background.ts?ctx=worker-race-${Math.random()}`);
	await settle(50);
	// A panel is open in the window, so the busy claim is consulted.
	const port = { name: "sidepanel:1", onDisconnect: event(), onMessage: event(), postMessage() {}, disconnect() {} };
	for (const fn of chrome.runtime.onConnect.listeners) fn(port);
	await settle(50);
	holding = true;
	for (const fn of chrome.tabs.onActivated.listeners) fn({ tabId: tab, windowId: 1 });
	await settle(30); // the reconcile is now waiting on the busy read
	for (const fn of chrome.action.onClicked.listeners) fn({ id: tab, windowId: 1 });
	await settle(10);
	release();
	await settle(100);
	assert.ok(!setOptions.some((o) => o.tabId === tab && o.path === `sidepanel.html?tabId=${otherHome}`), "not re-pointed at the other task");
	assert.ok(!setOptions.some((o) => o.tabId === tab && o.enabled === false), "and not closed");
});

test("the worker turns the user's gestures on an agent's group into hand-overs, an end, or nothing", async () => {
	const { fake } = setup();
	await import(`../src/background.ts?ctx=worker-gestures-${Math.random()}`);
	await settle(50);
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=bridge-${Math.random()}`);
	const notices = async () => (await chrome.storage.local.get("browser_session_notices")).browser_session_notices ?? {};

	// Dragged out of the group: the user's now, and the agent hears it.
	const agent = await BrowserSession.open("bridge-claude-shop", "claude · shop", 1, { agent: "claude", project: "shop" });
	const a = (await agent.createTab("https://example.com/a")).id;
	const b = (await agent.createTab("https://example.com/b")).id;
	fake.userSetGroup(b, -1);
	await settle(300);
	assert.deepEqual(fake.table()["bridge-claude-shop"].tabIds, [a]);
	assert.equal(fake.groupOf(b), -1);
	assert.match((await notices())["bridge-claude-shop"]?.[0]?.text ?? "", /took tab \d+ .*out of your group/);

	// Dragged into the group: the agent's now.
	const user = fake.addTab({ url: "https://example.com/mine" });
	fake.userSetGroup(user, fake.table()["bridge-claude-shop"].groupId);
	await settle(300);
	assert.ok(fake.table()["bridge-claude-shop"].tabIds.includes(user));

	// A window closing is not a gesture: the session stays.
	fake.userCloseTab(user, true);
	await settle(300);
	assert.ok(fake.table()["bridge-claude-shop"], "a closing window ended the session");

	// Closing the group (its last tab) ends the session; its record goes.
	fake.userCloseTab(a);
	await settle(300);
	assert.equal(fake.table()["bridge-claude-shop"], undefined);
	assert.ok((await notices())["bridge-claude-shop"].some((n) => /Your tab group was closed \(its last tab too\), which ended your session/.test(n.text)));

	// A side panel chat is left alone.
	const home = fake.addTab({ active: true });
	const chat = await BrowserSession.open("saved-chat", "chat", 1);
	await chat.adopt(home, true);
	fake.userCloseTab(home);
	await settle(300);
	assert.ok(fake.table()["saved-chat"], "closing a chat's tab ended the chat's session");
});
