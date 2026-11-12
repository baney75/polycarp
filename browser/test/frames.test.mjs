// Cross-origin frames (D45): a frame's refs carry its tag, and a ref read inside a frame stays
// live there, though the document around the frame is another origin's.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { crossOriginFrames, frameForRef, frameSurvey, frameTag, guardedFrameAt, splitFrameRef } = await import(
	"../src/browser/frames.ts"
);
const { FRAME_NOT_READ, refLive, snapshot } = await import("../src/browser/page.ts");
const CROSS = "cross-origin: read it with navigate to its URL";

test("a frame ref is the frame's tag and the ref inside it; a top-page ref is not split", () => {
	const tag = frameTag("D9EB0E2832BA70621CD63AE11B150CE9");
	assert.match(tag, /^f[0-9a-z]{4}$/);
	assert.equal(frameTag("D9EB0E2832BA70621CD63AE11B150CE9"), tag, "the same frame keeps its tag");
	assert.notEqual(frameTag("4A1CDCB70B1A9EF6A90637E571336971"), tag);
	assert.deepEqual(splitFrameRef(`${tag}e518173398`), { tag, inner: "e518173398" });
	assert.equal(splitFrameRef("e518173398"), undefined);
	assert.equal(splitFrameRef(`${tag}x12`), undefined);
});

test("refLive: an element in a cross-origin frame is live in that frame's own window", () => {
	const run = (window, el) => vm.runInNewContext(`(${refLive.toString()})(el)`, { window, el });
	// The frame's window: its parent is another origin's, so it has no frameElement.
	const top = {};
	top.parent = top;
	const frame = { parent: top, frameElement: null };
	const el = { isConnected: true, ownerDocument: { defaultView: frame } };
	assert.equal(run(frame, el), true, "live in the frame it was read in");
	// The same climb from another window (the top page's script) has no way up: not live there.
	assert.equal(run(top, el), false);
	assert.equal(run(frame, { ...el, isConnected: false }), false, "a removed element is not live");
});

test("crossOriginFrames leaves out a guarded frame and a non-web frame, and places the rest", async () => {
	const frame = (id, url, origin, childFrames) => ({ frame: { id, url, securityOrigin: origin }, ...(childFrames ? { childFrames } : {}) });
	const tree = frame("TOP", "https://shop.example/", "https://shop.example", [
		frame("PAY", "https://pay.example/card", "https://pay.example"),
		frame("AUTH", "http://localhost:8787/authorize", "http://localhost:8787", [frame("DEEP", "https://deep.example/", "https://deep.example")]),
		frame("EXT", "chrome-extension://abc/page.html", "chrome-extension://abc"),
	]);
	const owners = { PAY: 11, AUTH: 12, EXT: 13 };
	const sent = [];
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}, {}, {}];
	chrome.debugger.sendCommand = async (_target, method, params) => {
		sent.push({ method, params });
		if (method === "Page.getFrameTree") return { frameTree: tree };
		if (method === "DOM.getFrameOwner") return { backendNodeId: owners[params.frameId] };
		if (method === "DOM.getContentQuads") return { quads: [[100, 50, 400, 50, 400, 150, 100, 150]] };
		if (method === "DOM.getBoxModel") return { model: { content: [103, 53], border: [100, 50] } };
		return {};
	};
	const frames = await crossOriginFrames(1, (url) => url.startsWith("http://localhost:8787/"));
	assert.deepEqual(frames.map((f) => f.frameId), ["PAY"]);
	assert.deepEqual(frames[0].offset, { x: 103, y: 53 }, "the content box: the border inside the frame's quad");
	assert.equal(frames[0].tag, frameTag("PAY"));
	const touched = sent.filter((c) => c.method === "DOM.getFrameOwner").map((c) => c.params.frameId);
	assert.deepEqual(touched, ["PAY", "AUTH"], "the guarded frame is placed, for its box; nothing in it or the extension page is");
	assert.equal(sent.filter((c) => /Runtime|IsolatedWorld/.test(c.method)).length, 0, "and no script runs anywhere");
});

// C: a frame the extension leaves out or may not script is said on its line, never skipped in silence.
const frame = (id, url, origin, childFrames) => ({ frame: { id, url, securityOrigin: origin }, ...(childFrames ? { childFrames } : {}) });
const TREE = frame("TOP", "https://shop.example/", "https://shop.example", [
	frame("PAY", "https://pay.example/card", "https://pay.example"),
	frame("AUTH", "https://tabkyra.example.com/approve", "https://tabkyra.example.com"),
	frame("EXT", "chrome-extension://abc/page.html", "chrome-extension://abc"),
]);
/** Each frame's <iframe> drawn in its own row: 300 x 100 at y = 100, 300, 500. */
const ROW = { PAY: 11, AUTH: 12, EXT: 13 };
const quad = (n) => {
	const y = 100 + (n - 11) * 200;
	return [100, y, 400, y, 400, y + 100, 100, y + 100];
};
const guarded = (url) => url.startsWith("https://tabkyra.example.com/");
function fakeFrames(answer = () => undefined) {
	const sent = [];
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}, {}];
	chrome.debugger.sendCommand = async (_target, method, params) => {
		sent.push({ method, params });
		const a = await answer(method, params);
		if (a !== undefined) return a;
		if (method === "Page.getFrameTree") return { frameTree: TREE };
		if (method === "DOM.getFrameOwner") return { backendNodeId: ROW[params.frameId] };
		if (method === "DOM.getContentQuads") return { quads: [quad(params.backendNodeId)] };
		if (method === "DOM.getBoxModel") return { model: { content: [0, 0], border: [0, 0] } };
		return {};
	};
	return sent;
}

test("C: frameSurvey says why each frame is left out, and where a guarded one is drawn", async () => {
	fakeFrames();
	const { frames, left } = await frameSurvey(2, guarded);
	assert.deepEqual(frames.map((f) => f.frameId), ["PAY"]);
	assert.deepEqual(left, [
		{ tag: frameTag("AUTH"), url: "https://tabkyra.example.com/approve", why: "guarded", box: { x: 100, y: 300, width: 300, height: 100 } },
		{ tag: frameTag("EXT"), url: "chrome-extension://abc/page.html", why: "not-web" },
	]);
	// Ten frames are read at most: the eleventh is left out as past the limit, not dropped.
	const many = frame("TOP", "https://shop.example/", "https://shop.example",
		Array.from({ length: 11 }, (_, i) => frame(`W${i}`, `https://w${i}.example/`, `https://w${i}.example`)));
	fakeFrames((method, params) =>
		method === "Page.getFrameTree" ? { frameTree: many } : method === "DOM.getFrameOwner" ? { backendNodeId: 11 } : undefined,
	);
	const big = await frameSurvey(3, guarded);
	assert.equal(big.frames.length, 10);
	assert.deepEqual(big.left.map((l) => [l.tag, l.why]), [[frameTag("W10"), "limit"]]);
});

test("C: read_page says on each frame's line why it wasn't read; a guarded frame is never scripted", async () => {
	await chrome.tabs.create({ url: "https://shop.example/" });
	const [tab] = await chrome.tabs.query({});
	const line = (ref, y, href) => ({ ref, role: "iframe", name: "", x: 250, y, width: 300, height: 100, visible: true, href, states: [CROSS] });
	const top = {
		url: "https://shop.example/", title: "Shop", text: "", viewport: { width: 1200, height: 800 }, crossFrames: 4,
		nodes: [
			line("e1", 150, "https://pay.example/card"),
			line("e2", 350, "https://tabkyra.example.com/approve"),
			line("e3", 550, "chrome-extension://abc/page.html"),
			line("e4", 750, "https://blocked.example/"),
		],
	};
	const sent = fakeFrames((method, params) => {
		// PAY's world can't be made: a frame the browser won't let an extension script.
		if (method === "Page.createIsolatedWorld") return Promise.reject(new Error("Cannot access contents of url"));
		if (method === "Runtime.evaluate" && !params.contextId) return { result: { value: { ok: true, value: structuredClone(top) } } };
		return undefined;
	});
	const snap = await snapshot(tab.id, { filter: "interactive", skip: guarded });
	assert.deepEqual(
		snap.nodes.map((n) => [n.ref, n.states?.[0]]),
		[
			["e1", FRAME_NOT_READ.refused],
			["e2", FRAME_NOT_READ.guarded],
			["e3", FRAME_NOT_READ["not-web"]],
			["e4", FRAME_NOT_READ.unknown],
		],
	);
	const worlds = sent.filter((c) => c.method === "Page.createIsolatedWorld").map((c) => c.params.frameId);
	assert.deepEqual(worlds, ["PAY"], "the guarded frame gets no world, no script");
});

test("C: a ref inside a guarded frame is refused as guarded, not as gone", async () => {
	fakeFrames();
	await assert.rejects(frameForRef(2, `${frameTag("AUTH")}e5`, guarded), /guarded host \(tabkyra\.example\.com\): no tool acts there/);
	await assert.rejects(frameForRef(2, `${frameTag("GONE")}e5`, guarded), /its frame is gone or changed/);
});

test("C: guardedFrameAt finds the guarded frame under a point, and skips the survey on a page with no frame", async () => {
	const sent = fakeFrames();
	assert.equal(await guardedFrameAt(2, 250, 350, guarded), "https://tabkyra.example.com/approve");
	assert.equal(await guardedFrameAt(2, 250, 150, guarded), undefined, "the open frame beside it is not refused");
	sent.length = 0;
	chrome.webNavigation.getAllFrames = async () => [{}];
	assert.equal(await guardedFrameAt(2, 250, 350, guarded), undefined);
	assert.equal(sent.length, 0, "no debugger call on a page with no frame");
});

test("C through the bridge: a click at a point over a guarded frame is refused; over an open frame it goes", async () => {
	const fake = installFakeChrome();
	const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
	for (const k of ["onActivated", "onAttached", "onDetached", "onMoved", "onReplaced"]) chrome.tabs[k] ??= ev();
	chrome.webNavigation.onCommitted ??= ev();
	const native = await import(`../src/bridge/native.ts?frames=${Math.random()}`);
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
		port.deliver({ type: "request", clientId: "c1", id, method, params, guardedHosts: ["tabkyra.example.com"] });
		for (let i = 0; i < 1000; i++) {
			const reply = port.sent.find((m) => m.type === "response" && m.clientId === "c1" && m.id === id);
			if (reply) return reply;
			await new Promise((r) => realSetTimeout(r, 5));
		}
		throw new Error(`no reply to ${method}`);
	};
	port.deliver({ type: "client_connected", clientId: "c1", client: { name: "claude", session: "frames" } });
	await chrome.storage.local.set({ bridge_permission_mode: "allow_all" });
	const created = await request("tabs.create");
	assert.equal(created.error, undefined, JSON.stringify(created.error));
	await chrome.tabs.update(created.result.tabId, { url: "https://shop.example/", status: "complete" });
	const sent = fakeFrames((method) => (method === "Runtime.evaluate" ? { result: { value: { ok: true, value: null } } } : undefined));
	const mouse = () => sent.filter((c) => c.method === "Input.dispatchMouseEvent").length;
	const refused = await request("click", { x: 250, y: 350 });
	assert.match(refused.error?.message ?? "", /guarded host \(tabkyra\.example\.com\): no tool acts there/);
	assert.equal(mouse(), 0, "no mouse event went out");
	const open = await request("click", { x: 250, y: 150 });
	assert.equal(open.error, undefined, JSON.stringify(open.error));
	assert.ok(mouse() > 0, "the click over the open frame went out");
	const was = mouse();
	const drag = await request("drag", { from: { x: 250, y: 150 }, to: { x: 250, y: 350 } });
	assert.match(drag.error?.message ?? "", /guarded host/, "a drag that ends in it is refused");
	const wheel = await request("scroll", { x: 250, y: 350, dy: 200 });
	assert.match(wheel.error?.message ?? "", /guarded host/, "a wheel over it is refused");
	assert.equal(mouse(), was, "neither sent a mouse event");
});
