// The change report (D43), review round 1 of PR 144: a report is a diff of two real looks or says
// it could not compare; the looks are bounded and never read the approval page; what "changed"
// means for reused rows, big pages and live counters; nothing leaks through tab URLs or titles.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installFakeChrome } from "./fake-chrome.mjs";

const GUARDED = ["tabkyra.example.com"];
const UNCOMPARED = "could not be compared; read_page shows it";

function noEvents() {
	const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
	chrome.tabs.onActivated ??= ev();
	chrome.webNavigation.onCommitted ??= ev();
}

/** Every debugger command, in order; `answer` stands in for the fake's `{}`. */
function recordCommands(answer = () => undefined) {
	const sent = [];
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => {
		sent.push({ method, params, at: Date.now() });
		const a = await answer(method, params);
		if (a !== undefined) return a;
		return send(target, method, params);
	};
	return sent;
}

const says = (value) => ({ result: { value: { ok: true, value } } });
/** The change report's look, told apart from other page scripts by what it calls. */
const isLook = (params) => /function refsGone/.test(params?.expression ?? "");

const node = (ref, name, extra = {}) => ({ ref, role: "button", name, x: 1, y: 1, width: 10, height: 10, visible: true, ...extra });
const look = (nodes, extra = {}) => ({ url: "https://shop.example/", title: "Shop", nodes, focus: "", doc: "d1", gone: [], text: "", ...extra });

async function load() {
	const fake = installFakeChrome();
	noEvents();
	const changes = await import(`../src/browser/changes.ts?ctx=${Math.random()}`);
	return { fake, ...changes };
}

test("second-S1: a look the page refuses gives 'could not be compared', never 'nothing changed'", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://chromewebstore.google.com/detail/x", status: "complete" });
	recordCommands((method) => (method === "Runtime.evaluate" ? Promise.reject(new Error("cannot be scripted")) : undefined));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	assert.equal(b.look, undefined);
	const r = await afterAction(b, [tabId], async () => "https://example.com/", () => false);
	assert.deepEqual(r, { page: UNCOMPARED });
});

test("second-S1 and first-F3 (ratchet): a look that times out says so, and both looks add at most 2 x LOOK_MS", async () => {
	const { fake, beforeAction, afterAction, LOOK_MS } = await load();
	assert.ok(LOOK_MS <= 750, `LOOK_MS grew to ${LOOK_MS}: the report may add at most 1.5 s to an action`);
	const tabId = fake.addTab({ url: "https://busy.example/", status: "complete" });
	// The page's main thread is busy: no look ever answers.
	const sent = recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? new Promise(() => {}) : undefined));
	let t = Date.now();
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://busy.example/", () => false);
	let ms = Date.now() - t;
	assert.deepEqual(r, { page: UNCOMPARED });
	assert.equal(sent.filter((c) => isLook(c.params)).length, 1, "no second look after the first ran out");
	assert.ok(ms < LOOK_MS + 300, `took ${ms} ms`);

	// The first look answers and the second runs out: still bounded, still not "nothing changed".
	let n = 0;
	recordCommands((method, params) => {
		if (method !== "Runtime.evaluate" || !isLook(params)) return undefined;
		return n++ === 0 ? says(look([node("e1", "Buy")])) : new Promise(() => {});
	});
	t = Date.now();
	const b2 = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r2 = await afterAction(b2, [tabId], async () => "https://busy.example/", () => false);
	ms = Date.now() - t;
	assert.deepEqual(r2, { page: UNCOMPARED });
	assert.ok(ms < 2 * LOOK_MS + 300, `took ${ms} ms`);
});

test("first-F3: a page too large to look at twice is not read, and the report says why", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://huge.example/", status: "complete" });
	const sent = recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? says("large") : undefined));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://huge.example/", () => false);
	assert.deepEqual(r, { page: "too large to compare quickly; read_page shows it" });
	assert.equal(sent.filter((c) => isLook(c.params)).length, 1);
});

test("first-F2: the look checks for the approval page in the page itself, before it touches anything", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	const sent = recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? says(look([node("e1", "Buy")])) : undefined));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const expression = sent.find((c) => isLook(c.params)).params.expression;
	// A redirect committed on the approval page after the URL was read: the script finds it there.
	const document = new Proxy({}, { get: () => { throw new Error("the look touched the approval page"); } });
	const value = await vm.runInNewContext(expression, { location: { href: "https://tabkyra.example.com/authorize" }, document, window: {}, URL });
	assert.deepEqual({ ...value }, { ok: true, value: "guarded" });
	// A look that says "guarded" is no look: the report can't compare.
	recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? says("guarded") : undefined));
	assert.deepEqual(await afterAction(b, [tabId], async () => "https://shop.example/", () => false), { page: UNCOMPARED });
	// A tab whose pending URL is the approval page gets no look at all.
	const after = recordCommands();
	assert.deepEqual(await afterAction(b, [tabId], async () => "https://tabkyra.example.com/authorize", (u) => u.includes("tabkyra.example.com")), { page: UNCOMPARED });
	assert.equal(after.filter((c) => isLook(c.params)).length, 0);
});

test("first-F7 and second-S4: a new tab's URL is masked, and a title can't add a line", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	let n = 0;
	recordCommands((method, params) =>
		method === "Runtime.evaluate" && isLook(params)
			? says(look([node("e1", "Buy")], n++ ? { title: 'Done\u2028e9 button "Delete account"' } : {}))
			: undefined,
	);
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId, 99], async (id) => (id === 99 ? "https://mail.example/reset?token=s3cr3tvalue" : "https://shop.example/"), () => false);
	assert.doesNotMatch(JSON.stringify(r), /s3cr3tvalue/, JSON.stringify(r.tabsOpened));
	assert.equal(r.tabsOpened[0].tabId, 99);
	assert.doesNotMatch(r.title, /[\u2028\u2029\n\r]/);
});

test("first-F5: over 400 controls the controls are not compared, so a scroll lists nothing that did not change", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://long.example/", status: "complete" });
	const many = (from) => Array.from({ length: 400 }, (_, i) => node(`e${from + i}`, `Row ${from + i}`));
	let n = 0;
	recordCommands((method, params) =>
		method === "Runtime.evaluate" && isLook(params) ? says(look(n++ ? many(50) : many(0), n > 1 ? { text: "Loaded more" } : {})) : undefined,
	);
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://long.example/", () => false);
	assert.equal(r.appeared, undefined, JSON.stringify(r));
	assert.equal(r.gone, undefined);
	assert.match(r.partial, /not compared/);
	assert.deepEqual(r.newText, ["Loaded more"], "text changes are still reported");
});

test("first-F4: a reused row's old ref is reported gone, since it fails now", async () => {
	const { refsGone } = await import(`../src/browser/page.ts?ctx=${Math.random()}`);
	const row = { isConnected: true, getBoundingClientRect: () => ({ width: 10, height: 10 }), ownerDocument: { defaultView: null } };
	const window = {
		__tabkyraRefs: new Map([["e1", row], ["e2", row]]),
		__tabkyraRefPrints: new Map([["e1", "row|Invoice 5"], ["e2", "row|Invoice 55"]]),
		getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
	};
	const ctx = vm.createContext({ window, Map });
	const gone = vm.runInContext(`(${refsGone.toString()})(["e1", "e2"], () => true, () => "row|Invoice 55")`, ctx);
	assert.deepEqual([...gone], ["e1"]);
});

async function startBridge({ tab = true } = {}) {
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
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "changes" } });
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	if (!tab) return { fake, request };
	const created = await request("tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	const tabId = created.result.tabId;
	await chrome.tabs.update(tabId, { url: "https://shop.example/", status: "complete" });
	return { fake, request, tabId };
}

test("second-S1 through the bridge: press on a page that refuses scripts reports it could not compare", async () => {
	const { request } = await startBridge();
	recordCommands((method) => (method === "Runtime.evaluate" ? Promise.reject(new Error("cannot be scripted")) : undefined));
	const reply = await request("press", { key: "Enter" });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.deepEqual(reply.result.changes, { page: UNCOMPARED });
});

test("first-F1: click looks at the page first, then finds its point, then clicks", async () => {
	const { request } = await startBridge();
	const sent = recordCommands((method, params) => {
		if (method !== "Runtime.evaluate") return undefined;
		if (isLook(params)) return says(look([node("e1", "Buy")]));
		if (/scrollIntoView/.test(params.expression)) return says({ x: 5, y: 5, width: 10, height: 10 });
		return undefined;
	});
	const reply = await request("click", { ref: "e1" });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	const lookAt = sent.findIndex((c) => isLook(c.params));
	const pointAt = sent.findIndex((c) => c.method === "Runtime.evaluate" && /scrollIntoView/.test(c.params.expression));
	const inputAt = sent.findIndex((c) => c.method.startsWith("Input."));
	assert.ok(lookAt >= 0 && lookAt < pointAt && pointAt < inputAt, `look ${lookAt}, point ${pointAt}, input ${inputAt}`);
});

test("second-S2: actions on a tab going to the approval page runs no look in it", async () => {
	const { request, tabId } = await startBridge();
	await chrome.tabs.update(tabId, { pendingUrl: "https://tabkyra.example.com/authorize" });
	const sent = recordCommands();
	await request("actions", { steps: [{ press: { key: "a" } }] });
	assert.equal(sent.filter((c) => c.method === "Runtime.evaluate" && isLook(c.params)).length, 0);
});

test("second-S3: wait {until:settled} on a tab whose pending URL is the approval page is refused and blanked", async () => {
	const { request, tabId } = await startBridge();
	await chrome.tabs.update(tabId, { pendingUrl: "https://tabkyra.example.com/authorize" });
	const reply = await request("wait", { until: "settled", timeoutMs: 2000 });
	assert.equal(reply.error?.code, "permission_denied", JSON.stringify(reply));
	assert.equal((await chrome.tabs.get(tabId)).url, "about:blank");
});

test("short by construction: a page that fills every field still gets a report under CHANGES_MAX_CHARS", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const { CHANGES_MAX_CHARS } = await import("../src/bridge/fit-changes.ts");
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	// Names of quotes and backslashes double when JSON escapes them; states and values are as long as a page likes.
	const loud = '"\\'.repeat(200);
	const many = (from) =>
		Array.from({ length: 30 }, (_, i) =>
			node(`e${from + i}`, loud, { value: loud, states: Array.from({ length: 50 }, (_, j) => `state${j}`) }),
		);
	const long = `https://shop.example/${"a".repeat(5000)}`;
	let n = 0;
	recordCommands((method, params) =>
		method === "Runtime.evaluate" && isLook(params)
			? says(n++ ? look(many(100), { url: long, title: loud, text: Array.from({ length: 9 }, (_, i) => `${loud} ${i}`).join("\n") }) : look(many(0)))
			: undefined,
	);
	const tabs = Array.from({ length: 20 }, () => fake.addTab({ url: long, status: "complete" }));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId, ...tabs], async () => long, () => false);
	const json = JSON.stringify(r);
	assert.ok(json.length <= CHANGES_MAX_CHARS, `${json.length} characters`);
	assert.notEqual(r, "nothing changed");
	assert.match(String(r.more ?? r.page), /read_page/, json.slice(0, 300));
});

test("fitChanges: drops new text, then element lines, counts them, and never says nothing changed", async () => {
	const { fitChanges, CHANGES_TOO_LONG } = await import("../src/bridge/fit-changes.ts");
	const lines = (k) => Array.from({ length: 6 }, (_, i) => `e${i} button "${k} ${i} ${"x".repeat(60)}"`);
	const report = { url: "https://a.example/next", appeared: lines("New"), changed: lines("Changed"), newText: ["one", "two", "three"], more: "4 more; read_page lists them" };
	assert.equal(fitChanges(report, 100_000), report, "a report that fits is untouched");
	const fit = fitChanges(report, 500);
	assert.ok(JSON.stringify(fit).length <= 500, JSON.stringify(fit));
	assert.equal(fit.url, report.url, "the URL stays");
	assert.equal(fit.newText, undefined);
	assert.equal(fit.moreText, 3);
	const kept = (fit.appeared?.length ?? 0) + (fit.changed?.length ?? 0);
	assert.equal(fit.more, `${4 + 12 - kept} more; read_page lists them`);
	assert.equal(report.appeared.length, 6, "the input is not changed");
	assert.deepEqual(fitChanges(report, 40), { page: CHANGES_TOO_LONG });
	assert.equal(fitChanges("nothing changed", 5), "nothing changed");
});

/** Loads land in the fake: a URL set on a tab commits and fires DOMContentLoaded. */
function loadsLand(fake) {
	const update = chrome.tabs.update;
	chrome.tabs.update = async (id, p) => {
		const t = await update(id, p);
		if (p.url && p.url !== "about:blank")
			setTimeout(() => {
				const at = { tabId: id, frameId: 0, url: p.url };
				if (p.url.includes("#")) {
					Object.assign(t, { url: p.url });
					for (const fn of chrome.webNavigation.onReferenceFragmentUpdated.listeners) fn(at);
					return;
				}
				fake.commitNav(id, p.url);
				setTimeout(() => {
					for (const fn of chrome.webNavigation.onDOMContentLoaded.listeners) fn(at);
				}, 30);
			}, 10);
		return t;
	};
}

test("leftover first-F4: navigate always returns changes, the first of a session and a load that timed out too", async () => {
	const { fake, request } = await startBridge({ tab: false });
	const { NEW_PAGE, STILL_LOADING } = await import("../src/browser/changes.ts");
	const slow = await request("navigate", { url: "https://shop.example/", timeoutMs: 1 });
	assert.deepEqual(slow.result.changes, { page: STILL_LOADING }, JSON.stringify(slow));
	loadsLand(fake);
	const timed = await request("navigate", { url: "https://shop.example/slow", timeoutMs: 1 });
	assert.deepEqual(timed.result.changes, { page: STILL_LOADING }, JSON.stringify(timed));
	const { request: fresh, fake: f2 } = await startBridge({ tab: false });
	loadsLand(f2);
	const first = await fresh("navigate", { url: "https://shop.example/" });
	assert.deepEqual(first.result?.changes, { page: NEW_PAGE }, JSON.stringify(first));
});

test("leftover second-S3: a full navigation takes no look; a jump within the page is compared", async () => {
	const { fake, request } = await startBridge();
	const { NEW_PAGE } = await import("../src/browser/changes.ts");
	loadsLand(fake);
	const sent = recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? says(look([node("e1", "Buy")])) : undefined));
	const nav = await request("navigate", { url: "https://other.example/" });
	assert.deepEqual(nav.result?.changes, { page: NEW_PAGE }, JSON.stringify(nav));
	assert.equal(sent.filter((c) => isLook(c.params)).length, 0, "a full load looked at the page");
	await request("navigate", { url: "https://other.example/#reviews" });
	assert.equal(sent.filter((c) => isLook(c.params)).length, 2, "a hash jump keeps the document: it is compared");
});

test("r1 second-S2-2: a drop that reorders 100 ms later is in drag's report, with a short wait and no Network turned on", async () => {
	const { request } = await startBridge();
	let dropAt = 0;
	const late = () => dropAt && Date.now() - dropAt >= 100;
	const sent = recordCommands((method, params) => {
		if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") dropAt = Date.now();
		if (method !== "Runtime.evaluate") return undefined;
		if (isLook(params)) return says(look([node("e1", "Card A")], late() ? { text: "Moved Card A to Done" } : {}));
		// The settle probe: the page is changing until the reorder lands.
		return says({ since: late() ? Date.now() - dropAt - 100 : 0, parsing: false, busy: "" });
	});
	const t0 = Date.now();
	const reply = await request("drag", { from: { x: 10, y: 10 }, to: { x: 50, y: 50 } });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.deepEqual(reply.result.changes, { newText: ["Moved Card A to Done"] }, JSON.stringify(reply.result));
	assert.equal(sent.filter((c) => c.method === "Network.enable").length, 0, "drag turned Network on");
	// The short wait (0.6 s) and two looks (1.5 s), with 300 ms for the test machine.
	assert.ok(Date.now() - t0 < 600 + 2 * 750 + 300, `${Date.now() - t0} ms`);
});

test("leftover first-F1: scroll keeps the wait (new rows load after it) and on a page that never goes quiet returns within its bound", async () => {
	const { request } = await startBridge();
	// Each part takes its documented most: Network.enable never answers (cut at 0.5 s), each look
	// answers just inside LOOK_MS, and the settle probe says a loader is up every time (the 2.5 s cap).
	const slow = (v) => new Promise((r) => setTimeout(() => r(v), 740));
	recordCommands((method, params) =>
		method === "Network.enable"
			? new Promise(() => {})
			: method !== "Runtime.evaluate"
				? undefined
				: isLook(params)
					? slow(says(look([node("e1", "Row")])))
					: /scrollX/.test(params.expression)
						? says({ scrollX: 0, scrollY: 400 })
						: says({ since: 0, parsing: false, busy: "loading placeholder" }),
	);
	const t0 = Date.now();
	const reply = await request("scroll", { dy: 400 });
	const ms = Date.now() - t0;
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.equal(reply.result.settled, false, JSON.stringify(reply.result));
	// The documented bound, about 4.5 s: D41's cap (2.5 s), Network.enable (0.5 s) and two looks (1.5 s).
	// 300 ms is the stated margin for the test machine; the parts above take their full time, so a
	// regression of more than that fails.
	assert.ok(ms >= 2500 + 500 + 2 * 740, `${ms} ms: a part did not take its full time`);
	assert.ok(ms < 4500 + 300, `${ms} ms`);
});

test("leftover first-F3: a control that only changed its name is one changed line, not gone and appeared", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	let n = 0;
	recordCommands((method, params) => {
		if (method !== "Runtime.evaluate" || !isLook(params)) return undefined;
		return says(
			n++
				? look([node("e3", "Clock at 2"), node("e2", "Buy", { x: 1, y: 40 }), node("e4", "Added", { x: 1, y: 80 })], { gone: ["e1"], same: { e1: "e3" } })
				: look([node("e1", "Clock at 1"), node("e2", "Buy", { x: 1, y: 40 })]),
		);
	});
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://shop.example/", () => false);
	assert.deepEqual(r.changed, ['e3 (was e1) button "Clock at 2": name "Clock at 1" -> "Clock at 2"'], JSON.stringify(r));
	assert.deepEqual(r.appeared, ['e4 button "Added"']);
	assert.equal(r.gone, undefined);
});

test("leftover second-S1: actions whose step moved to another tab says so, never nothing changed", async () => {
	const { request, tabId: other } = await startBridge();
	const { movedTo } = await import("../src/browser/changes.ts");
	const a = await request("tabs.create");
	await chrome.tabs.update(a.result.tabId, { url: "https://shop.example/a", status: "complete" });
	recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? says(look([node("e1", "Buy")])) : undefined));
	const reply = await request("actions", { steps: [{ press: { key: "a", tabId: other } }] });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.deepEqual(reply.result.changes, { page: movedTo(other) }, JSON.stringify(reply.result));
});

test("leftover first-F2: a reload of the same URL is a new document, so its refusals start over", async () => {
	const fake = installFakeChrome();
	noEvents();
	const { settle } = await import(`../src/browser/settle.ts?ctx=${Math.random()}`);
	const tabId = fake.addTab({ url: "https://viewer.example/doc", status: "complete" });
	// Refused until the reload, then a page that is still drawing.
	let reloaded = false;
	recordCommands((method) =>
		method !== "Runtime.evaluate"
			? undefined
			: reloaded
				? says({ since: 0, parsing: false, busy: "loading placeholder" })
				: Promise.reject(new Error("cannot be scripted")),
	);
	const navigated = (loaderId) => {
		for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, "Page.frameNavigated", { frame: { id: "main", loaderId } });
	};
	setTimeout(() => navigated("L1"), 5);
	setTimeout(() => {
		reloaded = true;
		navigated("L2");
	}, 300);
	const r = await settle(tabId, { quietMs: 300, capMs: 1500 });
	assert.equal(r.settled, false, `the reloaded page was never probed: ${JSON.stringify(r)}`);
	assert.equal(r.waitingOn, "loading");
});

// Review round 1 of PR 147.
const twoLooks = (before, after) => {
	let n = 0;
	recordCommands((method, params) => (method !== "Runtime.evaluate" || !isLook(params) ? undefined : says(n++ ? after : before)));
};

test("r1 first-F1: an identical node put in a control's place is a gone and an appeared line, so the old ref is named", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	const field = (ref) => node(ref, "Email", { role: "textbox" });
	// A form re-render: e4's element left the page, a new one with the same role, name and place is e7.
	twoLooks(look([field("e4")]), look([field("e7")], { gone: ["e4"], same: {} }));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://shop.example/", () => false);
	assert.deepEqual(r, { appeared: ['e7 textbox "Email"'], gone: ['e4 textbox "Email"'] }, JSON.stringify(r));
});

test("r1 first-F1: the same element under a new ref with nothing visible changed still names its old ref", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	twoLooks(look([node("e4", "Send")]), look([node("e9", "Send")], { gone: ["e4"], same: { e4: "e9" } }));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://shop.example/", () => false);
	assert.deepEqual(r, { changed: ['e9 (was e4) button "Send"'] }, JSON.stringify(r));
});

test("r1 first-F2: new rows in old places are not renames: by position alone nothing pairs, and a scroll pairs nothing", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	const row = (ref, name) => node(ref, name, { role: "row" });
	// A virtualized list: new elements where the old rows were.
	twoLooks(look([row("e5", "Item 1")]), look([row("e21", "Item 21")], { gone: ["e5"], same: {} }));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://shop.example/", () => false);
	assert.deepEqual(r, { appeared: ['e21 row "Item 21"'], gone: ['e5 row "Item 1"'] }, JSON.stringify(r));
	// A list that recycles its elements: the same element shows a new item. Through scroll, not a rename.
	const { request } = await startBridge();
	let n = 0;
	recordCommands((method, params) =>
		method !== "Runtime.evaluate"
			? undefined
			: isLook(params)
				? says(n++ ? look([row("e21", "Item 21")], { gone: ["e5"], same: { e5: "e21" } }) : look([row("e5", "Item 1")]))
				: /scrollX/.test(params.expression)
					? says({ scrollX: 0, scrollY: 400 })
					: says({ since: 1000, parsing: false, busy: "" }),
	);
	const reply = await request("scroll", { dy: 400 });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.deepEqual(reply.result.changes, { appeared: ['e21 row "Item 21"'], gone: ['e5 row "Item 1"'] }, JSON.stringify(reply.result));
});

test("r1 second-S2-1: a long name's changed line keeps its old ref", async () => {
	const { fake, beforeAction, afterAction } = await load();
	const tabId = fake.addTab({ url: "https://shop.example/", status: "complete" });
	const long = (k) => `Status of the nightly import for the north region: ${k} of 12 files`;
	twoLooks(look([node("e1", long(3))]), look([node("e123", long(4))], { gone: ["e1"], same: { e1: "e123" } }));
	const b = await beforeAction(tabId, [tabId], undefined, GUARDED);
	const r = await afterAction(b, [tabId], async () => "https://shop.example/", () => false);
	assert.equal(r.changed.length, 1, JSON.stringify(r));
	assert.match(r.changed[0], /^e123 \(was e1\) button /);
	assert.ok(r.changed[0].length <= 160, r.changed[0]);
	assert.equal(r.gone, undefined);
});

test("r1 first-F3: a navigate that loads no new document (a 204) says so, not new page", async () => {
	const { fake, request } = await startBridge();
	const { NEW_PAGE, NOT_LOADED } = await import("../src/browser/changes.ts");
	loadsLand(fake);
	let loader = "L1";
	recordCommands((method) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main", loaderId: loader } } } : undefined));
	const kept = await request("navigate", { url: "https://shop.example/empty-204" });
	assert.deepEqual(kept.result?.changes, { page: NOT_LOADED }, JSON.stringify(kept));
	const real = chrome.tabs.update;
	chrome.tabs.update = async (...args) => {
		loader = "L2";
		return real(...args);
	};
	const loaded = await request("navigate", { url: "https://other.example/" });
	assert.deepEqual(loaded.result?.changes, { page: NEW_PAGE }, JSON.stringify(loaded));
});

test("r1 second-S2-3: actions on a named tab with only a wait step moves nowhere: the report is that tab's", async () => {
	const { request, tabId: named } = await startBridge();
	const { movedTo } = await import("../src/browser/changes.ts");
	const a = await request("tabs.create");
	await chrome.tabs.update(a.result.tabId, { url: "https://shop.example/a", status: "complete" });
	const sent = recordCommands((method, params) => (method === "Runtime.evaluate" && isLook(params) ? says(look([node("e1", "Buy")])) : undefined));
	const reply = await request("actions", { tabId: named, steps: [{ wait: 50 }] });
	assert.equal(reply.error, undefined, JSON.stringify(reply.error));
	assert.notDeepEqual(reply.result.changes, { page: movedTo(a.result.tabId) });
	assert.equal(reply.result.changes, "nothing changed", JSON.stringify(reply.result));
	assert.equal(sent.filter((c) => isLook(c.params)).length, 2, "a before and an after look, on the named tab");
});

test("r1 first-F1: refsRenewed maps an old ref to its element's new ref, never to a node put in its place", async () => {
	await load();
	const { refsRenewed } = await import("../src/browser/page.ts");
	const kept = {};
	const replaced = {};
	const refs = new Map([["e1", kept], ["e2", replaced]]);
	const refOf = new WeakMap([[kept, "e9"], [replaced, "e2"]]);
	const window = { __tabkyraRefs: refs, __tabkyraRefOf: refOf };
	const ctx = vm.createContext({ window, Map, WeakMap, Set });
	// e1's element shows something new and is e9 now; e2's element left (a new node is e7, not tied to it).
	const out = vm.runInContext(`(${refsRenewed.toString()})(["e1", "e2"], new Set(["e7", "e9"]))`, ctx);
	assert.deepEqual({ ...out }, { e1: "e9" });
});
