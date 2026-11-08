// One side panel per window: the toolbar icon and the keyboard command open the global panel
// (no tab binding), and nothing the worker does on a tab switch sets tab options or disables it.
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
	const opens = [];
	chrome.sidePanel = {
		async setOptions(o) {
			setOptions.push(structuredClone(o));
		},
		async open(o) {
			opens.push(structuredClone(o));
		},
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
	return { fake, setOptions, opens };
}

const connect = (windowId = 1) => {
	const port = { name: `sidepanel:${windowId}`, onDisconnect: event(), onMessage: event(), postMessage() {}, disconnect() {} };
	for (const fn of chrome.runtime.onConnect.listeners) fn(port);
	return port;
};
const bad = (o) => o.tabId !== undefined || o.enabled === false;

test("the global panel is set once when the worker starts", async () => {
	const { setOptions } = setup();
	await import(`../src/background.ts?ctx=worker-start-${Math.random()}`);
	await settle(50);
	assert.deepEqual(setOptions, [{ path: "sidepanel.html", enabled: true }]);
});

test("an icon click on any tab opens the window's global panel, not a tab-bound one", async () => {
	const { fake, setOptions, opens } = setup();
	const plain = fake.addTab({ active: true });
	await import(`../src/background.ts?ctx=worker-click-${Math.random()}`);
	await settle(50);
	setOptions.length = 0;
	// A tab the user is on, then a tab an agent session owns.
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=agent-${Math.random()}`);
	const agent = await BrowserSession.open("bridge-claude-shop", "claude · shop", 1, { agent: "claude", project: "shop" });
	const owned = (await agent.createTab("https://example.com/a")).id;
	for (const tab of [plain, owned]) {
		for (const fn of chrome.action.onClicked.listeners) fn({ id: tab, windowId: 1 });
		await settle(20);
	}
	assert.deepEqual(opens, [{ windowId: 1 }, { windowId: 1 }]);
	assert.ok(setOptions.length >= 2);
	for (const o of setOptions) assert.deepEqual(o, { path: "sidepanel.html", enabled: true });
});

test("the keyboard command does what the icon click does", async () => {
	const { fake, setOptions, opens } = setup();
	const tab = fake.addTab({ active: true });
	await import(`../src/background.ts?ctx=worker-command-${Math.random()}`);
	await settle(50);
	setOptions.length = 0;
	for (const fn of chrome.commands.onCommand.listeners) fn("toggle-sidepanel", { id: tab, windowId: 1 });
	for (const fn of chrome.commands.onCommand.listeners) fn("some-other-command", { id: tab, windowId: 1 });
	await settle(20);
	assert.deepEqual(opens, [{ windowId: 1 }]);
	assert.deepEqual(setOptions, [{ path: "sidepanel.html", enabled: true }]);
});

test("switching tabs, with or without a task, never sets tab options or disables the panel", async () => {
	const { fake, setOptions, opens } = setup();
	const home = fake.addTab({ active: true });
	const other = fake.addTab({ active: false, url: "https://other.example/" });
	// A run is going in this window's panel.
	await chrome.storage.session.set({ sidepanel_busy_1: home, sidepanel_busy_beat_1: Date.now() });
	await import(`../src/background.ts?ctx=worker-switch-${Math.random()}`);
	await settle(50);
	for (const fn of chrome.action.onClicked.listeners) fn({ id: home, windowId: 1 });
	connect();
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=panel-switch-${Math.random()}`);
	const session = await BrowserSession.open("saved-chat", "chat", 1);
	await session.adopt(home, true);
	await settle();
	for (const tab of [other, home, other]) {
		for (const fn of chrome.tabs.onActivated.listeners) fn({ tabId: tab, windowId: 1 });
		await settle(60);
	}
	await session.close();
	await settle(100);
	assert.deepEqual(opens, [{ windowId: 1 }], "only the click opened anything");
	assert.ok(!setOptions.some(bad), `unexpected setOptions: ${JSON.stringify(setOptions.filter(bad))}`);
});

test("the update worker sees a panel that is opening until it connects", async () => {
	const { fake } = setup();
	const tab = fake.addTab({ active: true });
	// background.ts registers its counter with the same module instance the update worker reads.
	const worker = await import("../src/update/worker.ts");
	await import(`../src/background.ts?ctx=worker-opening-${Math.random()}`);
	await settle(50);
	for (const fn of chrome.action.onClicked.listeners) fn({ id: tab, windowId: 1 });
	assert.equal(worker.panelsOpeningNow(), 1, "a click marks the window as opening");
	connect();
	assert.equal(worker.panelsOpeningNow(), 0, "the panel connecting ends it");
});

test("a panel that never connects stops counting as opening after a few seconds", async () => {
	const { fake } = setup();
	const tab = fake.addTab({ active: true });
	globalThis.__TABKYRA_OPENING_MS = 100;
	try {
		const worker = await import("../src/update/worker.ts");
		await import(`../src/background.ts?ctx=worker-opening-timeout-${Math.random()}`);
		await settle(50);
		for (const fn of chrome.action.onClicked.listeners) fn({ id: tab, windowId: 1 });
		assert.equal(worker.panelsOpeningNow(), 1);
		await settle(250);
		assert.equal(worker.panelsOpeningNow(), 0);
	} finally {
		delete globalThis.__TABKYRA_OPENING_MS;
	}
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
