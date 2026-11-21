// The native host was renamed from ai.tabkyra.bridge to com.polycarp.browser. The extension asks for the new name first and
// falls back to the old one, so a helper installed before the rename (which registered only the old name) is still reached.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

test("the extension connects to the new host name, falls back to the old one, and keeps the one that answers", async (t) => {
	const fake = installFakeChrome();
	const protocol = await import("../src/bridge/protocol.ts");
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	assert.equal(protocol.NATIVE_HOST_NAME, "com.polycarp.browser");
	assert.deepEqual([...protocol.NATIVE_HOST_NAMES], ["com.polycarp.browser", "ai.tabkyra.bridge"]);
	const realSetTimeout = globalThis.setTimeout;
	const timers = [];
	globalThis.setTimeout = (fn, ms, ...rest) => {
		const h = realSetTimeout(fn, ms, ...rest);
		timers.push(h);
		return h;
	};
	t.after(() => {
		globalThis.setTimeout = realSetTimeout;
		for (const h of timers) clearTimeout(h);
		for (const p of fake.ports) {
			p.onMessage.listeners.splice(0);
			p.onDisconnect.listeners.splice(0);
		}
	});
	const wait = async (n) => {
		for (let i = 0; i < 200 && fake.ports.length < n; i++) await new Promise((r) => realSetTimeout(r, 5));
		assert.equal(fake.ports.length, n, `expected connect number ${n}`);
	};
	const notFound = (port) => {
		chrome.runtime.lastError = { message: "Specified native messaging host not found." };
		for (const fn of port.onDisconnect.listeners) fn();
		chrome.runtime.lastError = undefined;
	};

	native.startBridge();
	await wait(1);
	assert.equal(fake.ports[0].name, "com.polycarp.browser", "the new name is tried first");
	notFound(fake.ports[0]);
	await wait(2);
	assert.equal(fake.ports[1].name, "ai.tabkyra.bridge", "with no host under the new name, the old one is tried at once");
	// A host under the old name answers and later drops: the extension stays with the name that worked.
	fake.ports[1].deliver({ type: "client_disconnected", clientId: "none" });
	for (const fn of fake.ports[1].onDisconnect.listeners) fn();
	await new Promise((r) => realSetTimeout(r, 1200));
	await wait(3);
	assert.equal(fake.ports[2].name, "ai.tabkyra.bridge", "a host that answered keeps its name");
	// A host that starts and dies without a word keeps its name: a crash loop backs off instead of switching.
	for (const fn of fake.ports[2].onDisconnect.listeners) fn();
	await new Promise((r) => realSetTimeout(r, 1200));
	await wait(4);
	assert.equal(fake.ports[3].name, "ai.tabkyra.bridge", "a silent exit is not a missing host");
	// The old name is gone too: the next try goes back to the new name, after the backoff.
	notFound(fake.ports[3]);
	await new Promise((r) => realSetTimeout(r, 50));
	assert.equal(fake.ports.length, 4, "going back to the new name waits for the backoff");
});
