// Cross-origin frames (D46): a frame's refs carry its tag, and a ref read inside a frame stays
// live there, though the document around the frame is another origin's.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { crossOriginFrames, frameTag, splitFrameRef } = await import("../src/browser/frames.ts");
const { refLive } = await import("../src/browser/page.ts");

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
	const frames = await crossOriginFrames(1, (url) => (url.startsWith("http://localhost:8787/") ? "guarded" : undefined));
	assert.deepEqual(frames.map((f) => f.frameId), ["PAY"]);
	assert.deepEqual(frames[0].offset, { x: 103, y: 53 }, "the content box: the border inside the frame's quad");
	assert.equal(frames[0].tag, frameTag("PAY"));
	const touched = sent.filter((c) => c.method === "DOM.getFrameOwner").map((c) => c.params.frameId);
	assert.deepEqual(touched, ["PAY"], "nothing is asked about the guarded frame, what is in it, or the extension page");
});

test("a click on a frame ref waits for the page to draw before measuring where the frame is", async () => {
	const { locate } = await import("../src/browser/page.ts");
	const tree = { frame: { id: "TOP", url: "https://shop.example/", securityOrigin: "https://shop.example" }, childFrames: [{ frame: { id: "PAY", url: "https://pay.example/card", securityOrigin: "https://pay.example" } }] };
	const sent = [];
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	chrome.debugger.sendCommand = async (_target, method, params) => {
		sent.push({ method, params });
		if (method === "Page.getFrameTree") return { frameTree: tree };
		if (method === "DOM.getFrameOwner") return { backendNodeId: 11 };
		if (method === "DOM.getNodeForLocation") return { backendNodeId: 11 };
		if (method === "DOM.getContentQuads") return { quads: [[100, 50, 400, 50, 400, 150, 100, 150]] };
		if (method === "DOM.getBoxModel") return { model: { content: [103, 53], border: [100, 50] } };
		if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
		if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
		if (method === "Runtime.evaluate" && params.contextId === 7) return { result: { value: { ok: true, value: { x: 10, y: 10, width: 4, height: 4 } } } };
		return {};
	};
	const at = await locate(1, { ref: `${frameTag("PAY")}e5` });
	assert.deepEqual({ x: at.x, y: at.y }, { x: 113, y: 63 });
	// The wait runs in Polycarp's world of the top document, where the page can't replace requestAnimationFrame.
	const drawn = sent.findIndex((c) => c.method === "Runtime.evaluate" && /requestAnimationFrame/.test(c.params.expression) && c.params.contextId === 7 && !/resolveRef|getBoundingClientRect/.test(c.params.expression));
	const inFrame = sent.findIndex((c) => c.params?.contextId === 7);
	assert.ok(sent.every((c) => c.method !== "Runtime.evaluate" || c.params.contextId), "nothing runs in the page's own world");
	const measured = sent.findLastIndex((c) => c.method === "Page.getFrameTree");
	assert.ok(drawn > inFrame && drawn < measured, `waited at ${drawn}, after the element scrolled (${inFrame}), before the frame is measured (${measured})`);
});

test("a box a cross-origin frame opens is answered in that frame's session; one from the page in the tab's", async () => {
	const { answerDialog } = await import("../src/browser/cdp.ts");
	const { dialogSession } = await import("../src/browser/frames.ts");
	const sent = [];
	chrome.debugger.sendCommand = async (target, method) => {
		sent.push({ target, method });
		return method === "Page.getFrameTree" ? { frameTree: { frame: { id: "TOP", url: "https://shop.example/" } } } : {};
	};
	await crossOriginFrames(1); // the frames' listener is on once frames are read
	const open = (sessionId) => {
		for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId: 1, ...(sessionId ? { sessionId } : {}) }, "Page.javascriptDialogOpening", { type: "confirm", message: "Pay?" });
	};
	open("S1");
	assert.equal(dialogSession(1), "S1");
	await answerDialog(1, true, undefined, dialogSession(1));
	assert.deepEqual(sent.findLast((c) => c.method === "Page.handleJavaScriptDialog").target, { tabId: 1, sessionId: "S1" });
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId: 1, sessionId: "S1" }, "Page.javascriptDialogClosed", {});
	open();
	assert.equal(dialogSession(1), undefined);
	await answerDialog(1, false, undefined, dialogSession(1));
	assert.deepEqual(sent.findLast((c) => c.method === "Page.handleJavaScriptDialog").target, { tabId: 1 });
});

// A fake debugger for a tab: `trees` maps a session ("" for the tab's) to its frame tree, `kids` are the
// out-of-process frames auto-attach announces (targetId to { sessionId, parent }), `contexts` the frame
// each isolated world belongs to, and `holds` which frame's document holds each frame's <iframe>.
function fakeTab(tabId, { trees, kids = {}, holds = {}, owners = {}, box = {}, hang = new Set(), fail = new Set() }) {
	const sent = [];
	const worlds = new Map();
	let next = 100;
	chrome.debugger.sendCommand = async (target, method, params = {}) => {
		const session = target.sessionId ?? "";
		sent.push({ session, method, params });
		if (hang.has(`${session}:${method}`)) return new Promise(() => {});
		if (fail.has(`${session}:${method}`)) throw new Error("No target with given id found");
		if (method === "Target.setAutoAttach" && params.autoAttach)
			for (const [targetId, k] of Object.entries(kids))
				if ((k.parent ?? "") === session)
					for (const fn of chrome.debugger.onEvent.listeners)
						fn({ tabId, ...(k.parent ? { sessionId: k.parent } : {}) }, "Target.attachedToTarget", { sessionId: k.sessionId, targetInfo: { targetId, type: "iframe", url: "" } });
		if (method === "Page.getFrameTree") return { frameTree: trees[session] };
		if (method === "DOM.getFrameOwner") return { backendNodeId: owners[params.frameId] };
		if (method === "Page.createIsolatedWorld") {
			const id = next++;
			worlds.set(id, params.frameId);
			return { executionContextId: id };
		}
		if (method === "DOM.resolveNode") {
			const frameId = Object.keys(owners).find((f) => owners[f] === params.backendNodeId);
			return worlds.get(params.executionContextId) === holds[frameId]
				? { object: { type: "object", objectId: "o1" } }
				: { object: { type: "object", subtype: "null", value: null } };
		}
		if (method === "DOM.getContentQuads") return { quads: [[100, 50, 400, 50, 400, 150, 100, 150]] };
		if (method === "DOM.getBoxModel") return { model: { content: [103, 53], border: [100, 50], ...box } };
		if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
		return {};
	};
	return sent;
}
const node = (id, origin, childFrames) => ({ frame: { id, url: `${origin}/`, securityOrigin: origin }, ...(childFrames ? { childFrames } : {}) });

test("an out-of-process frame inside a same-process one is placed inside it, and left out with it", async () => {
	// Top shop.example holds pay.example (the same process); pay.example's document holds deep.example (its own).
	const setup = {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]), S1: node("DEEP", "https://deep.example") },
		kids: { DEEP: { sessionId: "S1" } },
		holds: { PAY: "TOP", DEEP: "PAY" },
		owners: { PAY: 11, DEEP: 12 },
	};
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
	fakeTab(2, setup);
	const frames = await crossOriginFrames(2);
	assert.deepEqual(frames.map((f) => f.frameId), ["PAY", "DEEP"]);
	assert.deepEqual(frames[1].chain.map((f) => f.frameId), ["PAY", "DEEP"], "scrolls and cover checks go through PAY");

	const sent = fakeTab(2, setup);
	const guarded = await crossOriginFrames(2, (url) => (url.startsWith("https://pay.example") ? "guarded" : undefined));
	assert.deepEqual(guarded, [], "nothing inside a guarded frame is read, in any process");
	assert.equal(sent.filter((c) => c.method === "Page.getFrameTree" && c.session === "").length, 1, "every frame is counted, so nothing is polled");
});

test("a frame session that fails or never answers is counted and left out, without polling or hanging", async () => {
	for (const how of ["fail", "hang"]) {
		const tabId = how === "fail" ? 3 : 4;
		chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
		const sent = fakeTab(tabId, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			kids: { AD: { sessionId: "S2" } },
			holds: { PAY: "TOP", AD: "TOP" },
			owners: { PAY: 11, AD: 12 },
			[how]: new Set(["S2:Page.getFrameTree"]),
		});
		const start = Date.now();
		const frames = await crossOriginFrames(tabId);
		assert.deepEqual(frames.map((f) => f.frameId), ["PAY"], how);
		assert.ok(Date.now() - start < 1500, `${how}: took ${Date.now() - start} ms`);
		assert.equal(sent.filter((c) => c.method === "Page.getFrameTree" && c.session === "").length, 1, `${how}: one pass`);
	}
});

test("a frame drawn at half size: its points are scaled into the tab's", async () => {
	const { locate } = await import("../src/browser/page.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	const sent = fakeTab(5, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
		box: { width: 600 }, // laid out 600 px wide, drawn 300 px wide
	});
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params = {}) =>
		method === "Runtime.evaluate" && /resolveRef/.test(params.expression)
			? { result: { value: { ok: true, value: { x: 40, y: 20, width: 10, height: 8 } } } }
			: method === "DOM.getNodeForLocation"
				? { backendNodeId: 11 }
				: send(target, method, params);
	const [frame] = await crossOriginFrames(5);
	assert.equal(frame.scale, 0.5);
	const at = await locate(5, { ref: `${frameTag("PAY")}e5` });
	assert.deepEqual(at, { x: 103 + 20, y: 53 + 10, width: 5, height: 4 });
	assert.ok(sent.length > 0);
});

test("a frame on a host not allowed for agents is placed but not entered, and a ref into it is refused", async () => {
	const { classify } = await import("../src/bridge/errors.ts");
	const { frameForRef } = await import("../src/browser/frames.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
	const sent = fakeTab(6, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example", [node("IN", "https://in.example")])]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11, IN: 12 },
	});
	const rule = (url) => (url.startsWith("https://pay.example") ? "blocked" : undefined);
	const frames = await crossOriginFrames(6, rule);
	assert.deepEqual(frames.map((f) => [f.frameId, !!f.blocked]), [["PAY", true]], "nothing inside it is placed");
	assert.ok(!sent.some((c) => c.method === "DOM.getFrameOwner" && c.params.frameId === "IN"));
	const err = await frameForRef(6, `${frameTag("PAY")}e3`, rule).catch((e) => e);
	assert.match(err.message, /^Not allowed to open pay\.example: ref \S+ is in a frame .*polycarp browser allow pay\.example/);
	assert.equal(classify(err, "click").error.code, "permission_denied");
});

test("a frame's text and elements fit the budget the caller set; past a page that used up the default one they get a share", async () => {
	const { snapshot } = await import("../src/browser/page.ts");
	const tree = { frame: { id: "TOP", url: "https://shop.example/", securityOrigin: "https://shop.example" }, childFrames: [{ frame: { id: "PAY", url: "https://pay.example/card", securityOrigin: "https://pay.example" } }] };
	const line = { ref: "e1", role: "iframe", name: "", x: 250, y: 100, width: 300, height: 100, visible: true, states: ["cross-origin: read it with navigate to its URL"] };
	let pageText = "";
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	chrome.debugger.sendCommand = async (_target, method, params) => {
		if (method === "Page.getFrameTree") return { frameTree: tree };
		if (method === "DOM.getFrameOwner") return { backendNodeId: 11 };
		if (method === "DOM.getContentQuads") return { quads: [[100, 50, 400, 50, 400, 150, 100, 150]] };
		if (method === "DOM.getBoxModel") return { model: { content: [103, 53], border: [100, 50] } };
		if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
		if (method !== "Runtime.evaluate") return {};
		const viewport = { width: 1280, height: 800 };
		if (params.contextId === 7)
			return { result: { value: { ok: true, value: { url: "https://pay.example/card", title: "", viewport, text: "Card number", nodes: [{ ref: "e5", role: "textbox", name: "Card number", x: 10, y: 10, width: 100, height: 20, visible: true }] } } } };
		return { result: { value: { ok: true, value: { url: "https://shop.example/", title: "Shop", viewport, text: pageText, nodes: [{ ...line }], crossFrames: 1 } } } };
	};
	try {
		pageText = "x".repeat(500);
		const capped = await snapshot(1, { maxTextChars: 500 });
		assert.doesNotMatch(capped.text, /\[frame/, "no frame text past the caller's 500 characters");
		assert.equal((await snapshot(1, { maxNodes: 1 })).nodes.length, 1, "no frame elements past the caller's 1 node");
		pageText = "x".repeat(20000);
		const full = await snapshot(1);
		assert.match(full.text, /\[frame pay\.example\]\nCard number/, "the default budget, used up by the page, still leaves the frame a share");
		assert.ok(full.nodes.some((n) => n.name === "Card number"));
	} finally {
		chrome.tabs.get = getTab;
	}
});
