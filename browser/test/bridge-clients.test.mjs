// The bridge in the service worker keeps one BrowserSession per harness session key. When Claude
// Code restarts its MCP server, the new process connects with the same session id before the old
// socket closes; the old client's disconnect must not suspend or forget the session the new
// client is using.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

async function startBridge() {
	const fake = installFakeChrome();
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	// startBridge schedules a prune 20 s out; don't let that timer hold the test process open.
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	try {
		native.startBridge();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	const port = fake.ports[0];
	let nextId = 1;
	const request = async (clientId, method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId, id, method, params });
		for (let i = 0; i < 500; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === clientId && m.id === id);
			if (reply) return reply;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	const settle = () => new Promise((r) => realSetTimeout(r, 100));
	const connect = (clientId, session, extra = {}) =>
		port.deliver({ type: "client_connected", clientId, client: { name: "claude", session, ...extra } });
	/** Events the extension sent one client. */
	const events = (clientId, name) => port.sent.filter((m) => m.type === "event" && m.clientId === clientId && m.event === name).map((m) => m.data);
	const disconnect = (clientId) => port.deliver({ type: "client_disconnected", clientId });
	return { fake, port, request, settle, connect, disconnect, events, native };
}

test("an old client hanging up leaves the session its successor shares untouched", async () => {
	const { fake, request, settle, connect, disconnect } = await startBridge();
	connect("c1", "abc");
	const created = await request("c1", "tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	const tabId = created.result.tabId;
	// The restarted MCP server connects first; the old socket closes after.
	connect("c2", "abc");
	await request("c2", "tabs.context");
	fake.detachCalls.length = 0;
	disconnect("c1");
	await settle();
	assert.deepEqual(fake.detachCalls, [], "the shared session's tabs were suspended under the live client");
	// The last client leaving still suspends.
	disconnect("c2");
	await settle();
	assert.ok(fake.detachCalls.includes(tabId), "the session is suspended once nobody uses it");
	assert.ok(fake.table()["bridge-claude-abc"], "a suspended session keeps its record");
});

test("an old client hanging up does not forget a tabless session its successor shares", async () => {
	const { fake, request, settle, connect, disconnect } = await startBridge();
	connect("c1", "xyz");
	await request("c1", "tabs.context");
	connect("c2", "xyz");
	disconnect("c1");
	await settle();
	assert.ok(fake.table()["bridge-claude-xyz"], "the shared session was closed under the live client");
	disconnect("c2");
	await settle();
	assert.equal(fake.table()["bridge-claude-xyz"], undefined, "a tabless session is dropped once nobody uses it");
});

test("a result too big for the native port fails that request with a clear error", async () => {
	const { request, connect } = await startBridge();
	connect("c1", "big");
	const created = await request("c1", "tabs.create");
	await chrome.tabs.update(created.result.tabId, { title: "x".repeat(61 * 1024 * 1024) });
	const reply = await request("c1", "tabs.context");
	assert.equal(reply.result, undefined, "the oversized result was sent anyway");
	assert.match(reply.error?.message ?? "", /too large|exceeds/i);
});

test("a host that exits before saying anything is retried with growing backoff", async () => {
	const { fake } = await startBridge();
	const portCount = async (n) => {
		for (let i = 0; i < 400 && fake.ports.length < n; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(fake.ports.length, n, `port ${n} opened`);
		return Date.now();
	};
	const drop = (port) => {
		for (const fn of port.onDisconnect.listeners) fn();
	};
	drop(fake.ports[0]);
	const t1 = await portCount(2);
	drop(fake.ports[1]);
	const t2 = await portCount(3);
	assert.ok(t2 - t1 >= 1800, `second retry came after ${t2 - t1} ms; the backoff was reset by a silent host`);
	// A host that answers resets it.
	fake.ports[2].deliver({ type: "ping" });
	drop(fake.ports[2]);
	const t3 = Date.now();
	const t4 = await portCount(4);
	assert.ok(t4 - t3 < 1500, `retry after a talking host took ${t4 - t3} ms`);
	drop(fake.ports[3]);
});

test("when the native host goes away mid-request, the running handler sends no more input", async () => {
	const { fake, port, request, connect } = await startBridge();
	// The CDP input path listens for navigations; the shared fake leaves that event out.
	chrome.webNavigation.onCommitted ??= { listeners: [], addListener() {}, removeListener() {} };
	connect("c1", "abort");
	const created = await request("c1", "tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	// A real page: browser-internal ones (about:blank) refuse input before any key.
	await chrome.tabs.update(created.result.tabId, { url: "https://example.com/" });
	const keys = [];
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Input.dispatchKeyEvent" && params?.type !== "keyUp") keys.push(params?.key);
		return send(target, method, params);
	};
	// With the host there, the batch does press its key (so the test can see one).
	await request("c1", "actions", { steps: [{ wait: 50 }, { press: "b" }] });
	assert.deepEqual(keys, ["b"]);
	keys.length = 0;
	// An input batch: a pause, then a keypress the agent may repeat after the host answered
	// "interrupted: it may have run".
	port.deliver({ type: "request", clientId: "c1", id: 900, method: "actions", params: { steps: [{ wait: 300 }, { press: "a" }] } });
	await new Promise((r) => setTimeout(r, 100));
	for (const fn of port.onDisconnect.listeners) fn();
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual(keys, [], "the cut-off request kept typing after its host was gone");
	assert.ok(fake.ports.length >= 1);
});

/** Count key-downs the CDP input path sends from now on. */
function watchKeys() {
	// The CDP input path listens for navigations; the shared fake leaves that event out.
	chrome.webNavigation.onCommitted ??= { listeners: [], addListener() {}, removeListener() {} };
	const keys = [];
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		if (method === "Input.dispatchKeyEvent" && params?.type !== "keyUp") keys.push(params?.key);
		return send(target, method, params);
	};
	return keys;
}

async function pageTab(request, clientId) {
	const created = await request(clientId, "tabs.create");
	await chrome.tabs.update(created.result.tabId, { url: "https://example.com/" });
}

test("requests queued behind the one the host's loss cut off never start", async () => {
	const { port, request, connect } = await startBridge();
	connect("c1", "queued");
	await pageTab(request, "c1");
	const keys = watchKeys();
	port.deliver({ type: "request", clientId: "c1", id: 901, method: "actions", params: { steps: [{ wait: 300 }, { press: "a" }] } });
	port.deliver({ type: "request", clientId: "c1", id: 902, method: "press", params: { key: "b" } });
	await new Promise((r) => setTimeout(r, 100));
	for (const fn of port.onDisconnect.listeners) fn();
	await new Promise((r) => setTimeout(r, 700));
	assert.deepEqual(keys, [], "a request the host already answered as interrupted ran anyway");
});

test("a request whose host goes away before its handler starts never starts", async () => {
	const { port, request, connect, native } = await startBridge();
	connect("c1", "preamble");
	await pageTab(request, "c1");
	const before = (await chrome.tabs.query({})).length;
	// Hold a tabs.create (a handler with no abort checks of its own) in its preamble, the update
	// gate; drop the host; then let it go on.
	let open;
	native.setGateReady(new Promise((r) => (open = r)));
	port.deliver({ type: "request", clientId: "c1", id: 903, method: "tabs.create", params: {} });
	await new Promise((r) => setTimeout(r, 50));
	for (const fn of port.onDisconnect.listeners) fn();
	open();
	await new Promise((r) => setTimeout(r, 300));
	assert.equal((await chrome.tabs.query({})).length, before, "the cut-off tabs.create opened a tab");
	native.setGateReady(Promise.resolve());
});

test("a request refused during an update install is not_sent, so the client resends it later", async () => {
	const { request, connect, native } = await startBridge();
	connect("c1", "install");
	native.setInstallGate(() => true);
	try {
		const r = await request("c1", "tabs.context");
		assert.equal(r.error?.code, "not_sent");
		assert.match(r.error.message, /did not run/);
	} finally {
		native.setInstallGate(() => false);
	}
});

test("two agents in one project at once get separate sessions, titled with the agent and the project", async () => {
	const { fake, request, settle, connect, events } = await startBridge();
	connect("c1", "shop-1a2b", { auto: true, project: "shop" });
	connect("c2", "shop-1a2b", { auto: true, project: "shop" });
	const one = await request("c1", "tabs.create", {});
	const two = await request("c2", "tabs.create", {});
	await settle();
	const t = fake.table();
	assert.ok(t["bridge-claude-shop-1a2b"]?.tabIds.includes(one.result.tabId));
	assert.ok(t["bridge-claude-shop-1a2b-2"]?.tabIds.includes(two.result.tabId), JSON.stringify(Object.keys(t)));
	assert.equal(t["bridge-claude-shop-1a2b"].label, "claude · shop");
	assert.equal(t["bridge-claude-shop-1a2b-2"].label, "claude · shop 2");
	assert.notEqual(t["bridge-claude-shop-1a2b"].color, t["bridge-claude-shop-1a2b-2"].color);
	// The second is told its name, so a reconnect after a reload can't land on the first one's tabs.
	assert.deepEqual(events("c2", "session_assigned"), [{ session: "shop-1a2b-2" }]);
	assert.deepEqual(events("c1", "session_assigned"), []);
	const ctx = await request("c2", "tabs.context");
	assert.deepEqual(ctx.result.tabs.map((x) => x.tabId), [two.result.tabId], "an agent saw another agent's tab");
	assert.equal(ctx.result.session.name, "shop-1a2b-2");
	assert.equal(ctx.result.session.group.title, "Tabkyra · claude · shop 2");
});

test("a name the user chose is shared, not split", async () => {
	const { fake, request, settle, connect } = await startBridge();
	connect("c1", "research", { named: true });
	connect("c2", "research", { named: true });
	await request("c1", "tabs.create", {});
	await request("c2", "tabs.create", {});
	await settle();
	assert.deepEqual(Object.keys(fake.table()), ["bridge-claude-research"]);
	assert.equal(fake.table()["bridge-claude-research"].label, "claude · research");
});

test("a restarted harness that connected before its old process hung up gets its project session back", async () => {
	const { fake, request, settle, connect, disconnect, events } = await startBridge();
	connect("old", "shop-1a2b", { auto: true, project: "shop" });
	const tab = (await request("old", "tabs.create", {})).result.tabId;
	connect("new", "shop-1a2b", { auto: true, project: "shop" });
	assert.deepEqual(events("new", "session_assigned"), [{ session: "shop-1a2b-2" }]);
	disconnect("old");
	await settle();
	assert.deepEqual(events("new", "session_assigned").at(-1), { session: "shop-1a2b" });
	const ctx = await request("new", "tabs.context");
	assert.deepEqual(ctx.result.tabs.map((x) => x.tabId), [tab]);
	assert.equal(fake.table()["bridge-claude-shop-1a2b-2"], undefined, "an empty -2 session was left behind");
});

test("a restarted harness whose first call (status) opened its empty -2 session still gets its project session back", async () => {
	const { fake, request, settle, connect, disconnect, events } = await startBridge();
	connect("old", "shop-1a2b", { auto: true, project: "shop" });
	const tab = (await request("old", "tabs.create", {})).result.tabId;
	connect("new", "shop-1a2b", { auto: true, project: "shop" });
	// The instructions say to call status first; it opens the -2 session, which has no tabs.
	await request("new", "status");
	await settle();
	disconnect("old");
	await settle();
	assert.deepEqual(events("new", "session_assigned").at(-1), { session: "shop-1a2b" });
	const ctx = await request("new", "tabs.context");
	assert.deepEqual(ctx.result.tabs.map((x) => x.tabId), [tab]);
	assert.equal(fake.table()["bridge-claude-shop-1a2b-2"], undefined, "the empty -2 session was left behind");
});

test("a second agent that already has tabs of its own keeps its -2 session when the first one leaves", async () => {
	const { fake, request, settle, connect, disconnect, events } = await startBridge();
	connect("old", "shop-1a2b", { auto: true, project: "shop" });
	await request("old", "tabs.create", {});
	connect("new", "shop-1a2b", { auto: true, project: "shop" });
	const mine = (await request("new", "tabs.create", {})).result.tabId;
	disconnect("old");
	await settle();
	assert.deepEqual(events("new", "session_assigned").at(-1), { session: "shop-1a2b-2" });
	assert.ok(fake.table()["bridge-claude-shop-1a2b-2"].tabIds.includes(mine));
});

test("tabs_release hands one tab to the user; session_end hands over the rest and the next call starts fresh", async () => {
	const { fake, request, settle, connect } = await startBridge();
	connect("c1", "work");
	const a = (await request("c1", "tabs.create", {})).result.tabId;
	const b = (await request("c1", "tabs.create", {})).result.tabId;
	const released = await request("c1", "tabs.release", { tabId: a });
	assert.equal(released.result.released, a);
	assert.equal(fake.groupOf(a), -1);
	assert.ok(fake.hasTab(a));
	const notMine = await request("c1", "tabs.release", { tabId: a });
	assert.equal(notMine.error.code, "not_found");
	assert.match(notMine.error.message, /tabs_context lists them/);
	const ended = await request("c1", "session.end", {});
	assert.deepEqual(ended.result, { ended: true, tabs: [b], closed: false });
	await settle();
	assert.equal(fake.table()["bridge-claude-work"], undefined);
	const fresh = await request("c1", "tabs.context");
	assert.deepEqual(fresh.result.tabs, []);
});

test("the CLI's admin methods list, rename and end sessions without opening one of their own", async () => {
	const { fake, port, request, settle, connect, events } = await startBridge();
	connect("agent", "shop-1a2b", { auto: true, project: "shop" });
	const tab = (await request("agent", "tabs.create", {})).result.tabId;
	connect("cli", undefined);
	const list = await request("cli", "sessions.list", {});
	assert.deepEqual(
		list.result.sessions.map((s) => [s.name, s.agent, s.project, s.tabCount, s.connected]),
		[["shop-1a2b", "claude", "shop", 1, 1]],
	);
	const renamed = await request("cli", "sessions.rename", { from: "shop", to: "checkout" });
	assert.equal(renamed.error, undefined, JSON.stringify(renamed.error));
	assert.deepEqual(events("agent", "session_renamed"), [{ session: "checkout" }]);
	await settle();
	assert.ok(fake.table()["bridge-claude-checkout"]?.tabIds.includes(tab));
	assert.equal(fake.table()["bridge-claude-shop-1a2b"], undefined);
	// The agent keeps driving it under the new name.
	const ctx = await request("agent", "tabs.context");
	assert.deepEqual(ctx.result.tabs.map((x) => x.tabId), [tab]);
	assert.equal(ctx.result.session.name, "checkout");
	const bad = await request("cli", "sessions.rename", { from: "checkout", to: "../x" });
	assert.equal(bad.error.code, "bad_params");
	const ended = await request("cli", "sessions.end", { name: "checkout" });
	assert.deepEqual(ended.result.tabs, [tab]);
	await settle();
	// The agent's next call opens a fresh session and hears why.
	const after = await request("agent", "tabs.context");
	assert.deepEqual(after.result.tabs, []);
	assert.match(after.result.notices[0], /The user ended your session from the terminal/);
	// None of this made a session for the CLI client.
	assert.ok(!Object.keys(fake.table()).some((k) => k.includes("cli")), JSON.stringify(Object.keys(fake.table())));
	assert.equal(port.sent.filter((m) => m.clientId === "cli" && m.error).length, 1, "only the bad rename failed");
});

test("tabkyra sessions focus shows a tab that still exists, even when the current one is gone", async () => {
	const { fake, request, settle, connect } = await startBridge();
	connect("agent", "focus-1a2b", { auto: true, project: "focus" });
	const first = (await request("agent", "tabs.create", {})).result.tabId;
	const second = (await request("agent", "tabs.create", {})).result.tabId;
	await request("agent", "tabs.context");
	await settle();
	// The current tab vanished without the worker hearing of it yet.
	fake.removeTab(second);
	connect("cli", undefined);
	const focused = await request("cli", "sessions.group", { name: "focus", action: "focus" });
	assert.equal(focused.error, undefined, JSON.stringify(focused.error));
	assert.equal(focused.result.tabId, first);
	assert.equal((await chrome.tabs.get(first)).active, true);
});

test("releasing its current tab leaves the agent with no current tab, not silently on another page", async () => {
	const { request, connect } = await startBridge();
	connect("c1", "rel");
	const a = (await request("c1", "tabs.create", {})).result.tabId;
	const b = (await request("c1", "tabs.create", {})).result.tabId;
	const released = await request("c1", "tabs.release", { tabId: b });
	assert.match(released.result.note, /It was your current tab/);
	const ctx = await request("c1", "tabs.context");
	assert.equal(ctx.result.session.currentTabId, null, JSON.stringify(ctx.result));
	assert.ok(!ctx.result.tabs.some((t) => t.current));
	assert.deepEqual(ctx.result.tabs.map((t) => t.tabId), [a]);
});

test("a session id the user didn't choose (a remote session, an older CLI) stays out of the group title", async () => {
	const { fake, request, settle, connect } = await startBridge();
	connect("r1", "remote-3f9c01ab-ab12cd34", { name: "remote-phone" });
	connect("o1", "6f1c2a9e-4b7d-4c1e-9a3f-1b2c3d4e5f60");
	await request("r1", "tabs.create", {});
	await request("o1", "tabs.create", {});
	await settle();
	assert.equal(fake.table()["bridge-remote-phone-remote-3f9c01ab-ab12cd34"].label, "remote-phone");
	assert.equal(fake.table()["bridge-claude-6f1c2a9e-4b7d-4c1e-9a3f-1b2c3d4e5f60"].label, "claude");
});
