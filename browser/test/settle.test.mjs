// The settle wait after input tools (D40), on the fake browser: it never runs past its cap, turns
// Network on once per action and before the first input, judges a page it may not script by its
// requests alone, and never runs anything in the approval page before the tab is blanked.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const GUARDED = ["tabkyra.example.com"];

function noEvents() {
	const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
	chrome.tabs.onActivated ??= ev();
	chrome.webNavigation.onCommitted ??= ev();
}

/** Record every debugger command, in order, and let `answer` stand in for the fake's `{}`. */
function recordCommands(answer = () => undefined) {
	const sent = [];
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		sent.push({ tabId: target.tabId, method, params });
		const a = answer(method, params);
		if (a !== undefined) return a;
		return send(target, method, params);
	};
	return sent;
}

async function startBridge() {
	const fake = installFakeChrome();
	noEvents();
	const native = await import(`../src/bridge/native.ts?ctx=${Math.random()}`);
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms, ...args) => {
		const t = realSetTimeout(fn, ms, ...args);
		if (ms >= 10000) t.unref();
		return t;
	};
	native.startBridge();
	const port = fake.ports[0];
	let nextId = 1;
	const request = async (method, params = {}) => {
		const id = nextId++;
		port.deliver({ type: "request", clientId: "c1", id, method, params, guardedHosts: GUARDED });
		for (let i = 0; i < 1000; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === "c1" && m.id === id);
			if (reply) return reply;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "settle" } });
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	return { fake, request };
}

test("a page the extension may not script settles on its requests alone, well before the cap", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const tabId = fake.addTab({ url: "https://chromewebstore.google.com/detail/x", status: "complete" });
	// Every probe is refused, as Chrome refuses to script the web store or the PDF viewer.
	recordCommands((method) => (method === "Runtime.evaluate" ? Promise.reject(new Error("cannot be scripted")) : undefined));
	const r = await settle(tabId, { quietMs: 300, capMs: 2500 });
	assert.equal(r.settled, true, `refused probes held the wait: ${JSON.stringify(r)}`);
	assert.ok(r.ms < 1200, `took ${r.ms} ms`);
});

test("settle turns Network on once per action: settleStart's enable is not sent again", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle, settleStart } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const tabId = fake.addTab({ url: "https://example.com/", status: "complete" });
	const sent = recordCommands();
	const since = await settleStart(tabId);
	await settle(tabId, { since, quietMs: 50, capMs: 500, watched: true });
	assert.equal(sent.filter((c) => c.method === "Network.enable").length, 1);
});

test("a debugger that never answers can't hold an action past its cap", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle, settleStart } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const tabId = fake.addTab({ url: "https://example.com/", status: "complete" });
	recordCommands(() => new Promise(() => {}));
	let t = Date.now();
	await settleStart(tabId);
	assert.ok(Date.now() - t < 800, `settleStart took ${Date.now() - t} ms`);
	t = Date.now();
	const r = await settle(tabId, { quietMs: 300, capMs: 600 });
	const took = Date.now() - t;
	assert.equal(r.settled, false);
	assert.ok(took < 800, `settle took ${took} ms with a 600 ms cap`);
});

test("a batch of hover steps turns Network on before its first input", async () => {
	const { request } = await startBridge();
	const created = await request("tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	await chrome.tabs.update(created.result.tabId, { url: "https://example.com/", status: "complete" });
	const sent = recordCommands();
	const reply = await request("actions", { steps: [{ hover: { x: 10, y: 10 } }, { hover: { x: 20, y: 20 } }] });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	const enable = sent.findIndex((c) => c.method === "Network.enable");
	const input = sent.findIndex((c) => c.method.startsWith("Input."));
	assert.ok(input >= 0, "no input was sent");
	assert.ok(enable >= 0 && enable < input, `Network.enable at ${enable}, first input at ${input}`);
});

test("a navigate that lands on the approval host is blanked before anything runs in it", async () => {
	const { fake, request } = await startBridge();
	const first = await request("navigate", { url: "https://example.com/", timeoutMs: 1 });
	assert.equal(first.error, undefined, JSON.stringify(first.error));
	const tabId = first.result.tabId;
	const guarded = "https://tabkyra.example.com/authorize";
	const order = [];
	const update = chrome.tabs.update;
	chrome.tabs.update = async (id, p) => {
		if (p.url === "about:blank") {
			// The commit watcher's reset is slow to land: the tab stays on the approval page meanwhile.
			await new Promise((r) => setTimeout(r, 300));
			const t = await update(id, p);
			order.push("blank");
			return t;
		}
		const t = await update(id, p);
		if (p.url === "https://redirect.example.com/")
			setTimeout(() => {
				// The load redirects to the approval page, commits there and finishes loading.
				fake.commitNav(id, guarded);
				setTimeout(() => {
					for (const fn of chrome.webNavigation.onDOMContentLoaded.listeners) fn({ tabId: id, frameId: 0, url: guarded });
				}, 30);
			}, 10);
		return t;
	};
	recordCommands((method) => {
		if (method === "Runtime.evaluate") order.push("evaluate");
		return undefined;
	});
	const reply = await request("navigate", { url: "https://redirect.example.com/", timeoutMs: 2000 });
	assert.equal(reply.error?.code, "permission_denied", JSON.stringify(reply));
	assert.equal(order[0], "blank", `ran in the approval page first: ${order.join(", ")}`);
});
