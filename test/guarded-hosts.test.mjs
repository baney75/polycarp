// Issue #94: an agent's tabs never open the host of the OAuth approval page (the public URL of
// serve or the hub), in any permission mode. The native host sends the hostnames with each request.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const GUARDED = ["tabkyra.example.com", "127.0.0.1:8787", "localhost:8787", "[::1]:8787"];

async function startBridge() {
	const fake = installFakeChrome();
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	// Left in place: the guard's two-minute commit watcher must not keep the test process alive.
	native.startBridge();
	const port = fake.ports[0];
	let nextId = 1;
	const request = async (clientId, method, params = {}, guardedHosts = GUARDED) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId, id, method, params, ...(guardedHosts ? { guardedHosts } : {}) });
		for (let i = 0; i < 500; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === clientId && m.id === id);
			if (reply) return reply;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "guard" } });
	return { fake, request, realSetTimeout };
}

test("isGuardedUrl matches the host exactly, ignoring case, a trailing dot and the port", async () => {
	installFakeChrome();
	const { isGuardedUrl } = await import("../src/bridge/permissions.ts");
	assert.equal(isGuardedUrl("https://tabkyra.example.com/authorize?x=1", GUARDED), true);
	assert.equal(isGuardedUrl("HTTPS://TabKyra.Example.COM./authorize", GUARDED), true);
	assert.equal(isGuardedUrl("https://tabkyra.example.com:8443/", GUARDED), true);
	assert.equal(isGuardedUrl("http://[::1]:8443/authorize", ["::1"]), true);
	assert.equal(isGuardedUrl("http://127.0.0.1:8787/authorize?x=1", GUARDED), true);
	assert.equal(isGuardedUrl("http://localhost:8787/", GUARDED), true);
	assert.equal(isGuardedUrl("http://[::1]:8787/authorize", GUARDED), true);
	assert.equal(isGuardedUrl("http://127.0.0.1:3000/", GUARDED), false, "another local port stays open");
	assert.equal(isGuardedUrl("http://127.0.0.1/", GUARDED), false);
	assert.equal(isGuardedUrl("http://127.0.0.1:80/", ["127.0.0.1:80"]), true, "default port counts");
	assert.equal(isGuardedUrl("https://example.com/", GUARDED), false);
	assert.equal(isGuardedUrl("https://evil-tabkyra.example.com/", GUARDED), false);
	assert.equal(isGuardedUrl("https://tabkyra.example.com/", []), false);
	assert.equal(isGuardedUrl("https://tabkyra.example.com/", undefined), false);
	assert.equal(isGuardedUrl("not a url", GUARDED), false);
});

test("navigate and tabs_create refuse the approval host, even with every host allowed", async () => {
	const { request } = await startBridge();
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	for (const [method, params] of [
		["navigate", { url: "https://tabkyra.example.com/authorize?client_id=x" }],
		["tabs.create", { url: "https://tabkyra.example.com/" }],
	]) {
		const reply = await request("c1", method, params);
		assert.equal(reply.result, undefined, `${method} opened the approval host`);
		assert.equal(reply.error?.code, "permission_denied");
		assert.match(reply.error?.message ?? "", /approval address/);
	}
	const ctx = await request("c1", "tabs.context");
	assert.deepEqual(ctx.result.tabs ?? [], [], "no tab was opened for the refused calls");
});

test("navigate and tabs_create refuse loopback aliases of the approval page, other local ports stay open", async () => {
	const { request } = await startBridge();
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	for (const url of [
		"http://127.0.0.1:8787/authorize?client_id=x",
		"http://localhost:8787/",
		"http://[::1]:8787/authorize",
	]) {
		for (const method of ["navigate", "tabs.create"]) {
			const reply = await request("c1", method, { url, timeoutMs: 1 });
			assert.equal(reply.result, undefined, `${method} opened ${url}`);
			assert.equal(reply.error?.code, "permission_denied");
		}
	}
	const open = await request("c1", "navigate", { url: "http://127.0.0.1:3000/", timeoutMs: 1 });
	assert.equal(open.error, undefined, "a dev server on another port is not guarded");
});

test("a redirect that commits after navigate timed out is blanked and its tab refused", async () => {
	const { fake, request, realSetTimeout } = await startBridge();
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	const first = await request("c1", "navigate", { url: "https://slow.example.com/", timeoutMs: 1 });
	assert.equal(first.error, undefined);
	const tabId = first.result.tabId;
	fake.commitNav(tabId, "https://tabkyra.example.com/authorize?client_id=x");
	for (let i = 0; i < 100 && (await chrome.tabs.get(tabId)).url !== "about:blank"; i++)
		await new Promise((r) => realSetTimeout(r, 5));
	assert.equal((await chrome.tabs.get(tabId)).url, "about:blank", "the late landing was reset");

	// The backstop: a landing the watcher missed is refused by every tool that resolves the tab.
	fake.commitNav(tabId, "http://127.0.0.1:8787/authorize");
	chrome.webNavigation.onCommitted.listeners.length = 0;
	const read = await request("c1", "text", {});
	assert.equal(read.result, undefined, "text read the approval page");
	assert.equal(read.error?.code, "permission_denied");
});
