// The settle wait after input tools (D41), on the fake browser: it never runs past its cap, turns
// Network on once per action and before the first input, judges a page it may not script by its
// requests alone, and never runs anything in the approval page before the tab is blanked.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
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

/** A probe's answer, as Runtime.evaluate returns the wrapped value. */
const probeSays = (value) => ({ result: { value: { ok: true, value } } });
const BUSY = { since: 0, parsing: false, busy: "loading placeholder" };

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
	let onApproval = false;
	const update = chrome.tabs.update;
	chrome.tabs.update = async (id, p) => {
		if (p.url === "about:blank") {
			// The commit watcher's reset is slow to land: the tab stays on the approval page meanwhile.
			await new Promise((r) => setTimeout(r, 300));
			const t = await update(id, p);
			onApproval = false;
			order.push("blank");
			return t;
		}
		const t = await update(id, p);
		if (p.url === "https://redirect.example.com/")
			setTimeout(() => {
				// The load redirects to the approval page, commits there and finishes loading.
				onApproval = true;
				fake.commitNav(id, guarded);
				setTimeout(() => {
					for (const fn of chrome.webNavigation.onDOMContentLoaded.listeners) fn({ tabId: id, frameId: 0, url: guarded });
				}, 30);
			}, 10);
		return t;
	};
	recordCommands((method) => {
		// A look at the page before the navigation (the change report, D43) is not in the approval page.
		if (method === "Runtime.evaluate" && onApproval) order.push("evaluate");
		return undefined;
	});
	const reply = await request("navigate", { url: "https://redirect.example.com/", timeoutMs: 2000 });
	assert.equal(reply.error?.code, "permission_denied", JSON.stringify(reply));
	assert.equal(order[0], "blank", `ran in the approval page first: ${order.join(", ")}`);
});

test("a batch of press steps turns Network on once, not once per step", async () => {
	const { request } = await startBridge();
	const created = await request("tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	await chrome.tabs.update(created.result.tabId, { url: "https://example.com/", status: "complete" });
	const sent = recordCommands();
	const reply = await request("actions", { steps: [{ press: { key: "a" } }, { press: { key: "b" } }, { press: { key: "c" } }] });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.ok(sent.some((c) => c.method.startsWith("Input.")), "no input was sent");
	assert.equal(sent.filter((c) => c.method === "Network.enable").length, 1);
});

test("a batch that names a tab other than the current one watches that tab's requests", async () => {
	const { request } = await startBridge();
	const named = await request("tabs.create");
	const current = await request("tabs.create");
	assert.equal(current.error, undefined, JSON.stringify(current.error));
	for (const t of [named, current])
		await chrome.tabs.update(t.result.tabId, { url: "https://example.com/", status: "complete" });
	const sent = recordCommands();
	const reply = await request("actions", { tabId: named.result.tabId, steps: [{ hover: { x: 10, y: 10 } }] });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	const enables = sent.filter((c) => c.method === "Network.enable").map((c) => c.tabId);
	assert.deepEqual(enables, [named.result.tabId], `Network.enable went to ${enables.join(", ")}`);
});

test("a page that refused its probes does not stop probes on the next page", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	// The web store refuses every probe (two in the first 200 ms); a link there then leads to a page
	// that draws a skeleton without a request.
	const tabId = fake.addTab({ url: "https://chromewebstore.google.com/detail/x", status: "complete" });
	recordCommands((method) => (method === "Runtime.evaluate" ? probeSays(BUSY) : undefined));
	setTimeout(() => chrome.tabs.update(tabId, { url: "https://example.com/", status: "complete" }), 250);
	const r = await settle(tabId, { quietMs: 300, capMs: 1500 });
	assert.equal(r.settled, false, `settled on a page whose skeleton is still up: ${JSON.stringify(r)}`);
	assert.equal(r.waitingOn, "loading");
});

test("a cap that lands in the middle of a pass keeps the reason the last pass found", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const tabId = fake.addTab({ url: "https://example.com/", status: "complete" });
	// A spinner that never goes away; after 300 ms the browser is slow to say where the tab is, so
	// the cap lands while a pass reads the tab.
	const probes = [];
	recordCommands((method) => {
		if (method !== "Runtime.evaluate") return undefined;
		probes.push(Date.now());
		return probeSays(BUSY);
	});
	const get = chrome.tabs.get;
	const t = Date.now();
	let slow = true;
	chrome.tabs.get = async (id) => {
		// One slow read: a probe the cut-short pass sent after it would go out at once.
		if (slow && Date.now() - t > 300) {
			slow = false;
			await new Promise((r) => setTimeout(r, 700));
		}
		return get(id);
	};
	const r = await settle(tabId, { quietMs: 300, capMs: 500 });
	const done = Date.now();
	assert.equal(r.settled, false);
	assert.equal(r.waitingOn, "loading", JSON.stringify(r));
	// The pass the cap cut short sends no probe after it.
	await new Promise((r) => setTimeout(r, 800));
	assert.ok(probes.length > 0, "the wait probed the page before the cap");
	assert.deepEqual(probes.filter((at) => at >= done), [], "no probe goes out after settle returned");
});

test("a probe that lands on the approval page touches nothing there and stops the wait", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	// The tab still reads as the old page: the redirect committed after the loop looked.
	const tabId = fake.addTab({ url: "https://example.com/", status: "complete" });
	const touched = [];
	const page = {
		location: { href: "https://tabkyra.example.com/authorize" },
		URL,
		performance,
		get window() {
			touched.push("window");
			return {};
		},
		get document() {
			touched.push("document");
			return {};
		},
	};
	recordCommands((method, params) =>
		method === "Runtime.evaluate"
			? vm.runInNewContext(params.expression, page).then((value) => ({ result: { value } }))
			: undefined,
	);
	const r = await settle(tabId, {
		quietMs: 300,
		capMs: 1500,
		skip: (u) => u.includes("tabkyra.example.com"),
		guardedHosts: GUARDED,
	});
	assert.equal(r.stopped, true, JSON.stringify(r));
	assert.deepEqual(touched, []);
});

test("wait until settled that lands on the approval page refuses, not 'still changing'", async () => {
	const { request } = await startBridge();
	const first = await request("navigate", { url: "https://example.com/", timeoutMs: 1 });
	assert.equal(first.error, undefined, JSON.stringify(first.error));
	const tabId = first.result.tabId;
	// The tab moves there with no commit event, so the commit watcher's reset never runs.
	setTimeout(() => chrome.tabs.update(tabId, { url: "https://tabkyra.example.com/authorize" }), 100);
	const reply = await request("wait", { until: "settled", timeoutMs: 3000 });
	assert.equal(reply.error?.code, "permission_denied", JSON.stringify(reply));
});

test("the veil coming or going is not the page changing", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const { rememberVeilTag } = await import("../src/browser/veil-shared.ts");
	const tabId = fake.addTab({ url: "https://example.com/", status: "complete" });
	await rememberVeilTag(tabId, "abcde-fghijk");
	// The real probe, in a page whose only change is the veil added to body.
	const body = { nodeType: 1, localName: "body", parentNode: null };
	const veil = { nodeType: 1, localName: "abcde-fghijk", parentNode: body };
	let observer;
	const page = {
		location: { href: "https://example.com/" },
		URL,
		performance,
		// tsx names the probe's inner functions with esbuild's helper; the extension's bundle doesn't.
		__name: (f) => f,
		innerHeight: 800,
		innerWidth: 1200,
		MutationObserver: class {
			constructor(fn) {
				observer = fn;
			}
			observe() {}
		},
		document: { readyState: "complete", querySelectorAll: () => [] },
	};
	page.window = page;
	let probes = 0;
	recordCommands((method, params) => {
		if (method !== "Runtime.evaluate") return undefined;
		const answer = vm.runInNewContext(params.expression, page);
		if (++probes === 1) setTimeout(() => observer([{ type: "childList", target: body, addedNodes: [veil], removedNodes: [] }]), 150);
		return answer.then((value) => ({ result: { value } }));
	});
	const r = await settle(tabId, { quietMs: 300, capMs: 2000 });
	assert.equal(r.settled, true, JSON.stringify(r));
	assert.ok(r.ms < 470, `the veil held the wait: ${r.ms} ms`);
});
