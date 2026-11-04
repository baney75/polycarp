// The service worker's side of updates (src/update/worker.ts): the side panel's buttons become
// bare {type, action} frames to the native host, only from Tabkyra's own pages, and the reload
// after an update waits while an agent runs.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

async function start() {
	const fake = installFakeChrome();
	chrome.runtime.getURL = (p) => `chrome-extension://fake/${p}`;
	let reloads = 0;
	chrome.runtime.reload = () => {
		reloads++;
	};
	// The hello reads build-info.json over fetch; there is none here.
	globalThis.fetch = async () => ({ ok: false });
	const native = await import("../src/bridge/native.ts");
	const worker = await import("../src/update/worker.ts");
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	try {
		native.startBridge();
		worker.startUpdateWorker();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	const port = fake.ports[0];
	// The extension says hello once it has read its build and its browser id (storage reads).
	for (let i = 0; i < 200 && !port.sent.some((m) => m.type === "hello"); i++) await new Promise((r) => realSetTimeout(r, 5));
	const ask = (message, url) =>
		new Promise((resolve) => {
			for (const fn of chrome.runtime.onMessage.listeners) fn(message, { id: "fake", url }, resolve);
		});
	return { fake, port, ask, reloads: () => reloads };
}

const ctx = await start();
const gate = await import("../src/update/gate.ts");

const panelUrl = "chrome-extension://fake/sidepanel.html";

test("Update now sends only the action name to the native host", async () => {
	const before = ctx.port.sent.length;
	assert.deepEqual(await ctx.ask({ type: "tabkyra-update", action: "update" }, panelUrl), { ok: true });
	const sent = ctx.port.sent.slice(before).filter((m) => m.type === "update_action");
	assert.deepEqual(sent, [{ type: "update_action", action: "update" }]);
});

test("unknown actions and web pages are refused before anything reaches the host", async () => {
	const before = ctx.port.sent.length;
	const bad = await ctx.ask({ type: "tabkyra-update", action: "update --channel nightly" }, panelUrl);
	assert.equal(bad.ok, false);
	// A content script's sender.url is the page, not the extension.
	const page = await ctx.ask({ type: "tabkyra-update", action: "update" }, "https://example.com/");
	assert.equal(page.ok, false);
	assert.equal(ctx.port.sent.slice(before).filter((m) => m.type === "update_action").length, 0);
});

test("a fence a dead worker left holds panels off even with the lock free", async () => {
	await chrome.storage.session.set({ "tabkyra.installFence": { at: Date.now(), action: "activate" } });
	assert.equal(await gate.reserveRun(async () => {}), false);
	await chrome.storage.session.set({ "tabkyra.installFence": { at: Date.now() - 16 * 60 * 1000, action: "activate" } });
	assert.equal(await gate.reserveRun(async () => {}), true, "a stale fence doesn't count");
	await chrome.storage.session.remove("tabkyra.installFence");
});

const progressNow = async () => (await chrome.storage.local.get("tabkyra.updateProgress"))["tabkyra.updateProgress"];
const pendingNow = async () => (await chrome.storage.local.get("tabkyra.updatePending"))["tabkyra.updatePending"];
const actionsSent = (from) => ctx.port.sent.slice(from).filter((m) => m.type === "update_action").map((m) => m.action);

const gateHeld = async () => (await navigator.locks.query()).held.some((l) => l.name === gate.INSTALL_GATE_LOCK);
const busy = (on) => chrome.storage.session.set({ sidepanel_busy_1: on ? 105 : false, sidepanel_busy_beat_1: Date.now() });

test("a staged update is activated only when no side panel run is going, then reloads", async () => {
	// The first test's Update now is still pending (no host answers here).
	await chrome.storage.local.remove("tabkyra.updatePending");
	await busy(true);
	assert.equal((await ctx.ask({ type: "tabkyra-update", action: "update" }, panelUrl)).ok, true, "builds while the agent runs");
	const from = ctx.port.sent.length;
	await sleep(100);
	ctx.port.deliver({ type: "update_progress", action: "update", phase: "done", message: "Built", at: Date.now(), staged: true });
	await sleep(400);
	assert.deepEqual(actionsSent(from), [], "nothing is installed while the agent runs");
	const waiting = await progressNow();
	assert.equal(waiting.phase, "waiting");
	assert.match(waiting.message, /agent run is going in a side panel/);
	assert.equal(await gateHeld(), false, "no gate while waiting");

	await busy(false);
	await sleep(3600);
	assert.deepEqual(actionsSent(from), ["activate"], "activates once the run ended");
	assert.equal(ctx.reloads(), 0, "no reload before the install is done");

	// While it installs, the gate holds: new bridge requests are refused, a panel can't start a run.
	assert.equal(await gateHeld(), true, "the gate is held");
	let marked = false;
	assert.equal(await gate.reserveRun(async () => { marked = true; }), false, "a panel send is refused");
	assert.equal(marked, false);
	// Another update action while this one runs is refused, not queued behind it.
	assert.equal((await ctx.ask({ type: "tabkyra-update", action: "rollback" }, panelUrl)).ok, false);
	ctx.port.deliver({ type: "client_connected", clientId: "c9", client: { name: "claude", session: "s9" } });
	await sleep(50);
	ctx.port.deliver({ type: "request", clientId: "c9", id: 77, method: "tabs.context", params: {} });
	await sleep(300);
	const refused = ctx.port.sent.find((m) => m.type === "response" && m.clientId === "c9" && m.id === 77);
	assert.match(refused?.error?.message ?? "", /installing an update/);

	ctx.port.deliver({ type: "update_progress", action: "activate", phase: "done", message: "Installed", at: Date.now(), reload: true, extensionBuild: "new-build" });
	await sleep(400);
	assert.equal(ctx.reloads(), 1, "reloads right after the install");
	const pending = await pendingNow();
	assert.equal(pending.extensionBuild, "new-build");
	assert.ok(pending.reloadedFrom, "remembers the build that reloaded, to check the result after");
});

test("a failed install drops the gate and nothing reloads", async () => {
	// The stub reload didn't end the worker: it tries once more, then lets go of the gate.
	await sleep(7000);
	assert.equal(await gateHeld(), false, "a reload that didn't happen releases the gate");
	assert.equal((await progressNow()).phase, "failed");
	await busy(false);
	const before = ctx.reloads();
	assert.equal((await ctx.ask({ type: "tabkyra-update", action: "update" }, panelUrl)).ok, true);
	await sleep(100);
	ctx.port.deliver({ type: "update_progress", action: "update", phase: "done", message: "Built", at: Date.now(), staged: true });
	await sleep(400);
	ctx.port.deliver({ type: "update_progress", action: "activate", phase: "failed", message: "disk full", at: Date.now() });
	await sleep(300);
	assert.equal((await chrome.storage.session.get("tabkyra.installFence"))["tabkyra.installFence"], undefined, "the fence goes too");
	assert.equal(await gateHeld(), false);
	assert.equal(await pendingNow(), undefined);
	assert.equal(await gate.reserveRun(async () => {}), true, "runs may start again");
	assert.equal(ctx.reloads(), before);
});

test("a busy flag without a fresh heartbeat (its panel crashed) doesn't hold the reload", async () => {
	await chrome.storage.local.remove("tabkyra.updatePending");
	await chrome.storage.session.set({ sidepanel_busy_1: false, sidepanel_busy_7: 300, sidepanel_busy_beat_7: Date.now() - 4 * 60 * 1000 });
	const before = ctx.reloads();
	assert.deepEqual(await ctx.ask({ type: "tabkyra-update", action: "reload" }, panelUrl), { ok: true });
	await sleep(600);
	assert.equal(ctx.reloads(), before + 1);
	await chrome.storage.session.set({ sidepanel_busy_7: false });
	await sleep(7000);
});

test("Roll back waits for idle in the worker before the host swaps anything", async () => {
	await chrome.storage.local.remove("tabkyra.updatePending");
	await busy(true);
	const from = ctx.port.sent.length;
	await ctx.ask({ type: "tabkyra-update", action: "rollback" }, panelUrl);
	await sleep(400);
	assert.deepEqual(actionsSent(from), []);
	await busy(false);
	await sleep(3600);
	assert.deepEqual(actionsSent(from), ["rollback"]);
	// "activate" is the worker's own step; the panel can't send it directly.
	const bad = await ctx.ask({ type: "tabkyra-update", action: "activate" }, panelUrl);
	assert.equal(bad.ok, false);
});

test("a result a new host replays is matched, not shown", async () => {
	const shown = await progressNow();
	const waiting = await pendingNow();
	ctx.port.deliver({ type: "update_progress", action: "activate", phase: "done", message: "Installed 9.9.9", at: Date.now() - 60000, reload: true, replay: true });
	await sleep(300);
	assert.deepEqual(await progressNow(), shown, "the panel's progress line is unchanged");
	assert.deepEqual(await pendingNow(), waiting, "an older result for another step moves nothing");
});

test("an install that failed after it may have changed files still reloads", async () => {
	await chrome.storage.local.remove("tabkyra.updatePending");
	await busy(false);
	await sleep(7000);
	const before = ctx.reloads();
	await ctx.ask({ type: "tabkyra-update", action: "rollback" }, panelUrl);
	await sleep(400);
	ctx.port.deliver({ type: "update_progress", action: "rollback", phase: "failed", message: "rename failed. Reloading Tabkyra to run what is installed.", at: Date.now(), reload: true, extensionBuild: "x" });
	await sleep(400);
	assert.equal(ctx.reloads(), before + 1);
});
