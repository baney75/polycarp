// Cross-origin frames (D46): a frame's refs carry its tag, and a ref read inside a frame stays
// live there, though the document around the frame is another origin's.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { crossOriginFrames, frameTag, splitFrameRef } = await import("../src/browser/frames.ts");
/** A rule that bars no frame, as the side panel's does. */
const open = () => undefined;
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
		if (method === "DOM.resolveNode") return { object: { type: "object", objectId: "o11" } };
		if (method === "Runtime.callFunctionOn") return { result: { value: "shown" } };
		if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
		if (method === "Runtime.evaluate" && params.contextId === 7) return { result: { value: { ok: true, value: { x: 10, y: 10, width: 4, height: 4 } } } };
		return {};
	};
	const at = await locate(1, { ref: `${frameTag("PAY")}e5` }, open);
	assert.deepEqual({ x: at.x, y: at.y }, { x: 113, y: 63 });
	// The wait runs in Polycarp's world of the top document, where the page can't replace requestAnimationFrame.
	const drawn = sent.findIndex((c) => c.method === "Runtime.evaluate" && /requestAnimationFrame/.test(c.params.expression) && c.params.contextId === 7 && !/resolveRef|getBoundingClientRect/.test(c.params.expression));
	const inFrame = sent.findIndex((c) => c.params?.contextId === 7);
	assert.ok(sent.every((c) => c.method !== "Runtime.evaluate" || c.params.contextId), "nothing runs in the page's own world");
	const measured = sent.findLastIndex((c) => c.method === "DOM.getContentQuads");
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
function fakeTab(tabId, { trees, kids = {}, holds = {}, owners = {}, box = {}, shown = {}, quads = {}, evaluate, hang = new Set(), fail = new Set(), delay = {} }) {
	const sent = [];
	const worlds = new Map();
	// The hit test answers with the <iframe> last asked about in that session: the point lands on the frame itself.
	const asked = new Map();
	let next = 100;
	chrome.debugger.sendCommand = async (target, method, params = {}) => {
		const session = target.sessionId ?? "";
		sent.push({ session, method, params });
		if (delay[method]) await new Promise((r) => setTimeout(r, delay[method]));
		if (hang.has(`${session}:${method}`)) return new Promise(() => {});
		if (fail.has(`${session}:${method}`)) throw new Error("No target with given id found");
		if (method === "Target.setAutoAttach" && params.autoAttach)
			for (const [targetId, k] of Object.entries(kids))
				if ((k.parent ?? "") === session)
					for (const fn of chrome.debugger.onEvent.listeners)
						fn({ tabId, ...(k.parent ? { sessionId: k.parent } : {}) }, "Target.attachedToTarget", { sessionId: k.sessionId, targetInfo: { targetId, type: "iframe", url: "" } });
		if (method === "Page.getFrameTree") return { frameTree: trees[session] };
		if (method === "DOM.getFrameOwner") {
			asked.set(session, owners[params.frameId]);
			return { backendNodeId: owners[params.frameId] };
		}
		if (method === "DOM.getNodeForLocation") return { backendNodeId: asked.get(session) };
		if (method === "Page.createIsolatedWorld") {
			const id = next++;
			worlds.set(id, params.frameId);
			return { executionContextId: id };
		}
		if (method === "DOM.resolveNode") {
			const frameId = Object.keys(owners).find((f) => owners[f] === params.backendNodeId);
			return worlds.get(params.executionContextId) === holds[frameId]
				? { object: { type: "object", objectId: `o${params.backendNodeId}` } }
				: { object: { type: "object", subtype: "null", value: null } };
		}
		const byNode = Object.keys(owners).find((f) => owners[f] === params.backendNodeId);
		if (method === "DOM.getContentQuads") return { quads: [quads[byNode] ?? [100, 50, 400, 50, 400, 150, 100, 150]] };
		if (method === "DOM.getBoxModel") {
			const q = quads[byNode];
			return { model: q ? { content: [q[0], q[1]], border: [q[0], q[1]], width: q[2] - q[0] } : { content: [103, 53], border: [100, 50], ...box } };
		}
		// Page code: `evaluate` gets the frame whose isolated world it runs in (none: the tab's page) and its expression.
		if (method === "Runtime.evaluate" && evaluate) {
			const value = await evaluate(params.contextId ? worlds.get(params.contextId) : undefined, params.expression);
			return { result: { value: { ok: true, value } } };
		}
		// frameShown in the <iframe>'s own world: `shown` maps a frame to what it gives, "shown" when unset.
		if (method === "Runtime.callFunctionOn") {
			const frameId = Object.keys(owners).find((f) => `o${owners[f]}` === params.objectId);
			return { result: { value: shown[frameId] ?? "shown" } };
		}
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
	const frames = await crossOriginFrames(2, open);
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
		const frames = await crossOriginFrames(tabId, open);
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
	const [frame] = await crossOriginFrames(5, open);
	assert.equal(frame.scale, 0.5);
	const at = await locate(5, { ref: `${frameTag("PAY")}e5` }, open);
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
		if (method === "DOM.resolveNode") return { object: { type: "object", objectId: "o11" } };
		if (method === "Runtime.callFunctionOn") return { result: { value: "shown" } };
		if (method !== "Runtime.evaluate") return {};
		const viewport = { width: 1280, height: 800 };
		if (params.contextId === 7)
			return { result: { value: { ok: true, value: { url: "https://pay.example/card", title: "", viewport, text: "Card number", nodes: [{ ref: "e5", role: "textbox", name: "Card number", x: 10, y: 10, width: 100, height: 20, visible: true }] } } } };
		return { result: { value: { ok: true, value: { url: "https://shop.example/", title: "Shop", viewport, text: pageText, nodes: [{ ...line }], crossFrames: 1 } } } };
	};
	try {
		pageText = "x".repeat(500);
		const capped = await snapshot(1, { maxTextChars: 500, skip: open });
		assert.doesNotMatch(capped.text, /\[frame/, "no frame text past the caller's 500 characters");
		assert.equal((await snapshot(1, { maxNodes: 1, skip: open })).nodes.length, 1, "no frame elements past the caller's 1 node");
		pageText = "x".repeat(20000);
		const full = await snapshot(1, { skip: open });
		assert.match(full.text, /\[frame pay\.example\]\nCard number/, "the default budget, used up by the page, still leaves the frame a share");
		assert.ok(full.nodes.some((n) => n.name === "Card number"));
	} finally {
		chrome.tabs.get = getTab;
	}
});

/** A snapshot of the page around frames: one line per <iframe>, as pageSnapshot lists it. */
const pageWith = (lines, text = "") => ({ url: "https://shop.example/", title: "Shop", viewport: { width: 1280, height: 800 }, text, nodes: lines, crossFrames: lines.length });
const frameLine = (ref, [x0, y0, x1, y1], shown = true) => ({
	ref,
	role: "iframe",
	name: "",
	x: (x0 + x1) / 2,
	y: (y0 + y1) / 2,
	width: x1 - x0,
	height: y1 - y0,
	visible: true,
	states: [shown ? "cross-origin: read it with navigate to its URL" : "cross-origin frame, not shown, so not read"],
});
const frameSnap = (word) => ({ url: `https://${word}.example/`, title: "", viewport: { width: 300, height: 120 }, text: `${word} text`, nodes: [{ ref: "e5", role: "button", name: `${word} button`, x: 10, y: 10, width: 50, height: 20, visible: true }] });
const quad = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

test("a frame is read only as itself: a see-through or pixel frame over a shown one never takes its line or its place", async () => {
	const { snapshot } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		for (const [name, hidden, box] of [
			["a pixel at the shown frame's corner", "PIX", quad(0, 0, 1, 1)],
			["a see-through frame of the same box, first in frame order", "GHOST", quad(0, 0, 300, 120)],
		]) {
			chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
			fakeTab(20, {
				// The hidden frame comes first, as an earlier element or an earlier attach would put it.
				trees: { "": node("TOP", "https://shop.example", [node(hidden, `https://${hidden.toLowerCase()}.example`), node("SEEN", "https://seen.example")]) },
				holds: { [hidden]: "TOP", SEEN: "TOP" },
				owners: { [hidden]: 31, SEEN: 32 },
				quads: { [hidden]: box, SEEN: quad(0, 0, 300, 120) },
				shown: { [hidden]: "hidden" },
				evaluate: (frameId) =>
					frameId === undefined
						? pageWith([frameLine("e1", [box[0], box[1], box[4], box[5]], false), frameLine("e2", [0, 0, 300, 120])])
						: frameSnap(frameId.toLowerCase()),
			});
			const snap = await snapshot(20, { skip: open });
			assert.doesNotMatch(snap.text, new RegExp(`${hidden.toLowerCase()} text`), `${name}: none of its text is read`);
			assert.ok(!snap.nodes.some((n) => n.name === `${hidden.toLowerCase()} button`), `${name}: none of its elements`);
			assert.match(snap.text, /\[frame seen\.example\]\nseen text/, `${name}: the shown frame is read under its own line`);
		}
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("frameShown: a frame out of view is not taken as shown; shadow roots, faint opacity and opacity filters are judged right", async () => {
	const { frameShown } = await import("../src/browser/frames.ts");
	const view = { innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, getComputedStyle: (n) => n.style };
	const doc = { defaultView: view, elementFromPoint: () => null, nodeType: 9 };
	doc.documentElement = { ownerDocument: doc, style: {}, scrollHeight: 5000, scrollWidth: 1280 };
	const el = (rect, { style = {}, parent = null, root = doc, hit } = {}) => {
		const e = {
			nodeType: 1,
			ownerDocument: doc,
			style: { opacity: "1", filter: "none", ...style },
			parentElement: parent,
			getRootNode: () => root,
			getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
		};
		doc.elementFromPoint = () => hit ?? e;
		return e;
	};
	const at = (left, top) => ({ left, top, width: 300, height: 120 });
	const shown = (e) => [true, "shown"].includes(frameShown(e));
	assert.ok(shown(el(at(10, 10))));
	// Below the fold (perhaps under a sign-in wall there) or past the right edge: nothing can be tested yet.
	assert.ok(!shown(el(at(10, 3000))), "below the fold");
	assert.ok(!shown(el(at(20000, 10))), "past the right edge");
	assert.equal(frameShown(el(at(10, 3000))), "away", "named as out of view, so the agent can scroll to it");
	// In an open shadow root the document answers with the host; the shadow root answers with the frame.
	const host = { nodeType: 1, style: { opacity: "1", filter: "none" }, parentElement: null, getRootNode: () => doc, ownerDocument: doc };
	const shadow = { nodeType: 11, host, elementFromPoint: () => null };
	const inShadow = el(at(10, 10), { root: shadow, hit: host });
	shadow.elementFromPoint = () => inShadow;
	assert.ok(shown(inShadow), "in a shadow root");
	// See-through by a faint opacity above it, or by a filter on it.
	const faint = { nodeType: 1, style: { opacity: "0.01", filter: "none" }, parentElement: null, getRootNode: () => doc, ownerDocument: doc };
	assert.ok(!shown(el(at(10, 10), { parent: faint })), "opacity 0.01 above it");
	assert.ok(!shown(el(at(10, 10), { style: { filter: "opacity(0.02)" } })), "filter opacity(0.02)");
	assert.ok(!shown(el(at(10, 10), { style: { filter: "opacity(0)" } })), "filter opacity(0)");
});

test("finding frames and reading them wait once for frames that don't answer, not once per frame", async () => {
	const { snapshot, FRAMES_MS } = { ...(await import("../src/browser/page.ts")), ...(await import("../src/browser/frames.ts")) };
	const kids = {};
	const hang = new Set();
	for (let i = 0; i < 20; i++) {
		kids[`AD${i}`] = { sessionId: `S${i}` };
		hang.add(`S${i}:Page.getFrameTree`);
	}
	chrome.webNavigation.getAllFrames = async () => Array.from({ length: 21 }, () => ({}));
	fakeTab(21, { trees: { "": node("TOP", "https://shop.example") }, kids, hang });
	let start = Date.now();
	assert.deepEqual(await crossOriginFrames(21, open), []);
	assert.ok(Date.now() - start < FRAMES_MS + 300, `20 hung frame sessions took ${Date.now() - start} ms`);

	// Three shown frames whose snapshot never comes: the read gives up on all of them at once.
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		const ids = ["A", "B", "C"];
		const boxes = ids.map((_, i) => quad(0, i * 130, 300, i * 130 + 120));
		chrome.webNavigation.getAllFrames = async () => [{}, {}, {}, {}];
		fakeTab(22, {
			trees: { "": node("TOP", "https://shop.example", ids.map((id) => node(id, `https://${id.toLowerCase()}.example`))) },
			holds: Object.fromEntries(ids.map((id) => [id, "TOP"])),
			owners: Object.fromEntries(ids.map((id, i) => [id, 40 + i])),
			quads: Object.fromEntries(ids.map((id, i) => [id, boxes[i]])),
			evaluate: (frameId) => (frameId === undefined ? pageWith(boxes.map((b, i) => frameLine(`e${i}`, [b[0], b[1], b[4], b[5]]))) : new Promise(() => {})),
		});
		start = Date.now();
		const snap = await snapshot(22, { skip: open });
		assert.equal(snap.nodes.length, 3, "each frame keeps its plain line");
		assert.ok(Date.now() - start < 4500, `three hung frame reads took ${Date.now() - start} ms`);
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("a frame inside a frame drawn at half size is hit-tested at the point its own session measures", async () => {
	const { frameTakesPoint } = await import("../src/browser/frames.ts");
	const asked = [];
	chrome.debugger.sendCommand = async (target, method, params = {}) => {
		if (method === "DOM.getFrameOwner") return { backendNodeId: params.frameId === "OUTER" ? 11 : 12 };
		if (method === "DOM.getNodeForLocation") {
			asked.push({ session: target.sessionId, x: params.x, y: params.y });
			return { backendNodeId: target.sessionId ? 12 : 11 };
		}
		// The outer frame's own document is scrolled 30 px down: the hit test takes document coordinates.
		if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { pageX: 0, pageY: target.sessionId ? 30 : 0, clientWidth: 800, clientHeight: 600 } };
		return {};
	};
	const outer = { frameId: "OUTER", sessionId: "S1", ownerSessionId: undefined, base: { x: 0, y: 0 }, baseScale: 1 };
	const inner = { frameId: "IN", sessionId: "S2", ownerSessionId: "S1", base: { x: 100, y: 50 }, baseScale: 0.5 };
	outer.chain = [outer];
	inner.chain = [outer, inner];
	assert.equal(await frameTakesPoint(23, inner, 150, 80), true);
	// 50 tab px right of the outer frame's corner is 100 of its own px, drawn at half size, and 30 px down its scrolled document.
	assert.deepEqual(asked.find((a) => a.session === "S1"), { session: "S1", x: 100, y: 90 });
	assert.deepEqual(asked.find((a) => !a.session), { session: undefined, x: 150, y: 80 });
});

test("one click on a frame ref finds the tab's frames once: its change report and the point reuse that frame", async () => {
	const { beforeAction, afterAction } = await import("../src/browser/changes.ts");
	const { locate } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	let passes = 0;
	chrome.webNavigation.getAllFrames = async () => {
		passes++;
		return [{}, {}];
	};
	const look = { url: "https://shop.example/", title: "Shop", nodes: [], focus: "", doc: "d1", gone: [], same: {}, text: "" };
	fakeTab(24, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
		evaluate: (_frameId, expression) => (/resolveRef/.test(expression) && !/focusProbe|refsGone/.test(expression) ? { x: 10, y: 10, width: 4, height: 4 } : look),
	});
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = (target, method, params) => (method === "DOM.getNodeForLocation" ? { backendNodeId: 11 } : send(target, method, params));
	try {
		const ref = `${frameTag("PAY")}e5`;
		const b = await beforeAction(24, [24], ref, [], open);
		await locate(24, { ref }, open, "click", b.frame?.hit);
		await afterAction(b, [24], async () => "https://shop.example/", () => false);
		assert.equal(passes, 1, `the tab's frames were looked for ${passes} times`);
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("hover and type name their own action when a frame ref can't be reached", async () => {
	const { handlers } = await import("../src/bridge/tools.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	fakeTab(25, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
		evaluate: () => ({ x: 10, y: 10, width: 4, height: 4 }),
	});
	const send = chrome.debugger.sendCommand;
	// A banner over the frame takes the point.
	chrome.debugger.sendCommand = (target, method, params) => (method === "DOM.getNodeForLocation" ? { backendNodeId: 99 } : send(target, method, params));
	const tab = { id: 25, url: "https://shop.example/" };
	const ctx = {
		session: { tabIds: [25], setCurrent: async () => {}, attachedCurrentTab: async () => tab, requireCurrentTab: async () => tab },
		isGuarded: () => false,
		guardedHosts: [],
		batch: true,
		aborted: () => false,
	};
	const err = await handlers.hover(ctx, { ref: `${frameTag("PAY")}e5` }).catch((e) => e);
	assert.match(String(err?.message), /covered by something over its frame, which would take the hover\./);
});

test("no rule given, no frame is read or acted in: guarded hosts hold without every caller remembering them", async () => {
	const { snapshot, locate } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}];
		fakeTab(26, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			holds: { PAY: "TOP" },
			owners: { PAY: 11 },
			evaluate: (frameId) => (frameId === undefined ? pageWith([frameLine("e1", [100, 50, 400, 150])]) : frameSnap("pay")),
		});
		assert.doesNotMatch((await snapshot(26)).text, /pay text/);
		await assert.rejects(locate(26, { ref: `${frameTag("PAY")}e5` }), /not found/);
		assert.equal((await crossOriginFrames(26)).length, 0);
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("a function's doc comment is one block: no stale comment stacked over the one that holds", async () => {
	const { readFileSync } = await import("node:fs");
	for (const f of ["src/bridge/tools.ts", "src/browser/frames.ts", "src/browser/page.ts", "src/browser/changes.ts"])
		assert.doesNotMatch(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), /\*\/\n\/\*\*/, `${f} stacks two doc comments`);
});

test("every page script click, hover, type, fill and scroll send parses, for a top-page ref, a selector and a frame ref", async () => {
	// tsc can't see into these template strings and the fake debugger never ran them, so a lost quote broke every click.
	const { locate, fillElement, scrollPage } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	const parsed = [];
	const broken = [];
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}];
		fakeTab(31, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			holds: { PAY: "TOP" },
			owners: { PAY: 11 },
			evaluate: (frameId, expression) => {
				try {
					new vm.Script(expression);
					parsed.push(expression);
				} catch (e) {
					broken.push(`${String(e)}\n${expression.slice(0, 200)}`);
				}
				if (frameId === undefined && /pageSnapshot|maxNodes/.test(expression)) return pageWith([frameLine("e1", [100, 50, 400, 150])]);
				return { x: 10, y: 10, width: 4, height: 4, scrollX: 0, scrollY: 0, pageHeight: 800 };
			},
		});
		const pay = `${frameTag("PAY")}e5`;
		for (const target of [{ ref: "e12" }, { selector: "#buy" }, { ref: pay }]) {
			for (const act of ["click", "hover", "type", "fill"]) await locate(31, target, open, act).catch(() => undefined);
			await fillElement(31, target, "Eve", open).catch(() => undefined);
			await scrollPage(31, { ...target, dy: 100 }, open).catch(() => undefined);
		}
	} finally {
		chrome.tabs.get = getTab;
	}
	assert.deepEqual(broken, [], "a page script that doesn't parse");
	assert.ok(parsed.filter((e) => /which would take/.test(e)).length >= 8, `locate's script ran for each act and target: ${parsed.length} parsed`);
	assert.ok(parsed.some((e) => /frameworks|HTMLSelectElement/.test(e)), "fillElement's script ran");
	assert.ok(parsed.some((e) => /scrollHeight/.test(e)), "scrollPage's script ran");
});

test("a frame in a same-process frame in another process: points are measured from the frame its session draws, not one sharing its session", async () => {
	// TOP holds X (its own process, S1); X holds Y (another site, X's process, so S1 too); Y holds Z (its own, S2).
	const { locate } = await import("../src/browser/page.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}, {}];
	fakeTab(32, {
		trees: { "": node("TOP", "https://shop.example"), S1: node("X", "https://x.example", [node("Y", "https://y.example")]), S2: node("Z", "https://z.example") },
		kids: { X: { sessionId: "S1" }, Z: { sessionId: "S2", parent: "S1" } },
		holds: { X: "TOP", Y: "X", Z: "Y" },
		owners: { X: 11, Y: 12, Z: 13 },
		// Each in its owner session's CSS px: X at 100,50 in the tab; Y at 20,30 and Z at 40,60 in X's viewport.
		quads: { X: [100, 50, 500, 50, 500, 350, 100, 350], Y: [20, 30, 320, 30, 320, 230, 20, 230], Z: [40, 60, 240, 60, 240, 160, 40, 160] },
		evaluate: () => ({ x: 10, y: 10, width: 4, height: 4 }),
	});
	const frames = await crossOriginFrames(32, open);
	assert.deepEqual(frames.find((f) => f.frameId === "Z")?.chain.map((f) => f.frameId), ["X", "Y", "Z"]);
	const at = await locate(32, { ref: `${frameTag("Z")}e5` }, open);
	assert.deepEqual({ x: at.x, y: at.y }, { x: 150, y: 120 }, "X's corner 100,50, plus Z's 40,60 in X, plus the point 10,10");
});

test("a fill on a frame ref compares the frame even when finding the tab's frames takes a second", async () => {
	const { beforeAction, afterAction } = await import("../src/browser/changes.ts");
	const { fillElement } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	let passes = 0;
	chrome.webNavigation.getAllFrames = async () => {
		passes++;
		return [{}, {}];
	};
	let filled = false;
	const page = { url: "https://shop.example/", title: "Shop", nodes: [], focus: "", doc: "d1", gone: [], same: {}, text: "" };
	const pay = () => ({ ...page, url: "https://pay.example/", nodes: [{ ref: "e5", role: "textbox", name: "Card name", value: filled ? "Eve" : "", x: 1, y: 1, width: 1, height: 1 }] });
	fakeTab(33, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
		// Slow but within each call's limit: about a second to find the frames, past the look's 750 ms.
		delay: { "Page.getFrameTree": 350, "DOM.getFrameOwner": 350, "DOM.getContentQuads": 300 },
		evaluate: (frameId, expression) => {
			if (/focusProbe/.test(expression)) return frameId === "PAY" ? pay() : page;
			if (/HTMLSelectElement/.test(expression)) filled = true;
			return { x: 10, y: 10, width: 4, height: 4 };
		},
	});
	try {
		const ref = `${frameTag("PAY")}e5`;
		const b = await beforeAction(33, [33], ref, [], open);
		assert.ok(b.look, `the before look ran: ${b.miss}`);
		await fillElement(33, { ref }, "Eve", open, b.frame.hit);
		const r = await afterAction(b, [33], async () => "https://shop.example/", () => false);
		assert.match(JSON.stringify(r), /Eve/, `the report shows the fill in the frame: ${JSON.stringify(r)}`);
		assert.equal(passes, 1, `the tab's frames were looked for ${passes} times`);
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("scroll by a frame ref refuses a frame the page hid after it was read, as click and fill do", async () => {
	const { scrollPage } = await import("../src/browser/page.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	const sent = fakeTab(34, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
		shown: { PAY: "hidden" },
		evaluate: () => ({ scrollX: 0, scrollY: 0, pageHeight: 800, scrolled: "element", scrollTop: 100 }),
	});
	await assert.rejects(scrollPage(34, { ref: `${frameTag("PAY")}e5`, dy: 100 }, open), /isn't shown now: its frame is hidden/);
	assert.ok(!sent.some((c) => c.method === "Runtime.evaluate" && /scrollHeight/.test(c.params.expression)), "nothing scrolled in the frame");
});

test("a hit test that gives no answer counts as covered: the action is not sent on no evidence", async () => {
	const { frameTakesPoint } = await import("../src/browser/frames.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	fakeTab(35, {
		trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
	});
	const [pay] = await crossOriginFrames(35, open);
	assert.equal(await frameTakesPoint(35, pay, 150, 100), true, "the frame itself answers");
	const send = chrome.debugger.sendCommand;
	try {
		for (const answer of [() => ({}), () => Promise.reject(new Error("No node found at given location"))]) {
			chrome.debugger.sendCommand = (target, method, params) => (method === "DOM.getNodeForLocation" ? answer() : send(target, method, params));
			assert.equal(await frameTakesPoint(35, pay, 150, 100), false);
		}
	} finally {
		chrome.debugger.sendCommand = send;
	}
});

test("type by a frame ref retried after the debugger detached finds the frame again on the new attachment", async () => {
	const { handlers } = await import("../src/bridge/tools.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	chrome.webNavigation.getAllFrames = async () => [{}, {}];
	const kids = { PAY: { sessionId: "S1" } };
	const trees = { "": node("TOP", "https://shop.example"), S1: node("PAY", "https://pay.example") };
	fakeTab(36, {
		trees,
		kids,
		holds: { PAY: "TOP" },
		owners: { PAY: 11 },
		evaluate: () => ({ x: 10, y: 10, width: 4, height: 4 }),
	});
	const send = chrome.debugger.sendCommand;
	let detached = false;
	chrome.debugger.sendCommand = async (target, method, params) => {
		// The first click finds the debugger gone: the frame's session goes with it, and it comes back as another.
		if (method === "Input.dispatchMouseEvent" && !detached) {
			detached = true;
			kids.PAY.sessionId = "S9";
			trees.S9 = trees.S1;
			// In flight: cdpSend leaves this one to the handler, which attaches again and tries once more.
			throw new Error("Detached while handling command.");
		}
		if (detached && target.sessionId === "S1") throw new Error("No target with given id found");
		return send(target, method, params);
	};
	const tab = { id: 36, url: "https://shop.example/" };
	const ctx = {
		session: { tabIds: [36], setCurrent: async () => {}, attachedCurrentTab: async () => tab, requireCurrentTab: async () => tab },
		isGuarded: () => false,
		guardedHosts: [],
		batch: false,
		aborted: () => false,
		delivered: () => {},
	};
	try {
		const r = await handlers.type(ctx, { ref: `${frameTag("PAY")}e5`, text: "Eve" }).catch((e) => e);
		assert.ok(!(r instanceof Error), `type retried in the frame: ${r?.message}`);
		assert.ok(detached, "the first try met the detach");
	} finally {
		chrome.tabs.get = getTab;
		chrome.debugger.sendCommand = send;
	}
});

test("an out-of-process frame whose holder the debugger can't name is left out: it may sit in a guarded frame", async () => {
	// TOP holds G (guarded, the same process); G's document holds K (its own process, an allowed host).
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
	const setup = {
		trees: { "": node("TOP", "https://shop.example", [node("G", "https://guarded.example")]), S1: node("K", "https://pay.example") },
		kids: { K: { sessionId: "S1" } },
		holds: { G: "TOP", K: "G" },
		owners: { G: 11, K: 12 },
	};
	const rule = (url) => (url.startsWith("https://guarded.example") ? "guarded" : undefined);
	fakeTab(37, setup);
	assert.deepEqual(await crossOriginFrames(37, rule), [], "K is found inside G, and left out with it");
	// Now the debugger can't say which frame holds K (out of time, or no answer).
	fakeTab(37, { ...setup, fail: new Set([":DOM.resolveNode"]) });
	assert.deepEqual((await crossOriginFrames(37, rule)).map((f) => f.frameId), [], "not placed as if it sat in the page");
});

test("an action on a frame ref can't wait out the handler cap on a frame session that stopped answering", async () => {
	const { frameTakesPoint, scrollFrameIntoView } = await import("../src/browser/frames.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
	const setup = {
		trees: { "": node("TOP", "https://shop.example"), S1: node("X", "https://x.example"), S2: node("Z", "https://z.example") },
		kids: { X: { sessionId: "S1" }, Z: { sessionId: "S2", parent: "S1" } },
		holds: { X: "TOP", Z: "X" },
		owners: { X: 11, Z: 12 },
	};
	fakeTab(38, setup);
	const z = (await crossOriginFrames(38, open)).find((f) => f.frameId === "Z");
	assert.ok(z);
	const late = (work) => Promise.race([work, new Promise((r) => setTimeout(r, 4000, "hung"))]);
	for (const method of ["DOM.getFrameOwner", "Page.getLayoutMetrics", "DOM.getNodeForLocation"]) {
		fakeTab(38, { ...setup, hang: new Set([`S1:${method}`]) });
		const start = Date.now();
		assert.equal(await late(frameTakesPoint(38, z, 150, 100)), false, `a hung ${method} counts as covered`);
		assert.ok(Date.now() - start < 3000, `${method} waited ${Date.now() - start} ms`);
	}
	fakeTab(38, { ...setup, hang: new Set(["S1:DOM.scrollIntoViewIfNeeded"]) });
	assert.notEqual(await late(scrollFrameIntoView(38, z)), "hung", "a hung scroll gives up");
});

test("a frame the page lists as shown but the tab finds hidden or barred says why its line isn't read", async () => {
	const { snapshot } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
		const away = { ...frameLine("e2", [100, 400, 400, 500]), href: "https://ads.example/", states: ["cross-origin frame out of view: scroll to it, then read_page"] };
		fakeTab(39, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example"), node("ADS", "https://ads.example")]) },
			holds: { PAY: "TOP", ADS: "TOP" },
			owners: { PAY: 11, ADS: 12 },
			quads: { PAY: quad(100, 50, 400, 150), ADS: quad(100, 400, 400, 500) },
			shown: { PAY: "hidden", ADS: "away" },
			evaluate: (frameId) =>
				frameId === undefined
					? pageWith([{ ...frameLine("e1", [100, 50, 400, 150]), href: "https://pay.example/" }, away])
					: frameSnap(frameId === "PAY" ? "pay" : "ads"),
		});
		const rule = (url) => (url.startsWith("https://ads.example") ? "blocked" : undefined);
		const { text, nodes } = await snapshot(39, { skip: rule });
		const pay = String(nodes.find((n) => n.ref === "e1")?.states);
		const ads = String(nodes.find((n) => n.ref === "e2")?.states);
		assert.match(pay, /not shown, so not read/, pay);
		assert.doesNotMatch(pay, /navigate to its URL/, "never told to go to a frame the person can't see");
		assert.match(ads, /not allowed for agents: ads\.example/, ads);
		assert.doesNotMatch(text, /pay text|ads text/);
	} finally {
		chrome.tabs.get = getTab;
	}
});

async function lookAfter(tabId, where, shown, { guarded = false } = {}) {
	const { changeLook } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	const page = { url: "https://shop.example/", title: "Shop", nodes: [], focus: "", doc: "d1", gone: [], same: {}, text: "shop text" };
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}];
		let navigated = false;
		const now = { PAY: "shown" };
		fakeTab(tabId, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			holds: { PAY: "TOP" },
			owners: { PAY: 11 },
			shown: now,
			evaluate: (frameId) =>
				frameId === "PAY" && navigated && guarded
					? "guarded"
					: frameId === "PAY"
					? { ...page, url: navigated ? where : "https://pay.example/", nodes: [{ ref: "e5", role: "button", name: "Secret pay", x: 1, y: 1, width: 1, height: 1 }], text: "secret pay text" }
					: { ...page, nodes: [], gone: [] },
		});
		const rule = (url) => (url.startsWith("https://checkout.") ? "blocked" : undefined);
		const ref = `${frameTag("PAY")}e5`;
		const before = await changeLook(tabId, 400, [], [], { ref, rule });
		assert.match(before.text, /secret pay text/, "read while allowed and shown");
		navigated = true;
		now.PAY = shown;
		const frame = { ref, rule, hit: { frame: (await crossOriginFrames(tabId, rule))[0], inner: "e5" } };
		const after = await changeLook(tabId, 400, [ref], [], frame);
		assert.doesNotMatch(after.text, /secret pay text/, "its text");
		assert.ok(!after.nodes.some((n) => n.ref.startsWith(frameTag("PAY"))), "its controls");
		assert.ok(after.gone.includes(ref), "its refs are gone");
	} finally {
		chrome.tabs.get = getTab;
	}
}

test("a change report reads nothing of a frame the action took to a host never allowed, though it keeps its id", async () => {
	await lookAfter(40, "https://checkout.pay.example/", "shown");
});

test("a change report reads nothing of a frame the action hid (#73)", async () => {
	await lookAfter(41, "https://pay.example/", "hidden");
});

test("PR 223 r1 second-S1: a frame only out of view is read by the change look; a hidden one is not", async () => {
	const { changeLook } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	const page = { url: "https://shop.example/", title: "Shop", nodes: [], focus: "", doc: "d1", gone: [], same: {}, text: "shop text" };
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}];
		const now = { PAY: "away" };
		fakeTab(42, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			holds: { PAY: "TOP" },
			owners: { PAY: 11 },
			shown: now,
			evaluate: (frameId) =>
				frameId === "PAY"
					? { ...page, url: "https://pay.example/", nodes: [{ ref: "e5", role: "button", name: "Pay", x: 1, y: 1, width: 1, height: 1 }], text: "pay text" }
					: { ...page },
		});
		const ref = `${frameTag("PAY")}e5`;
		const frame = { ref, rule: open, hit: { frame: (await crossOriginFrames(42, open))[0], inner: "e5" } };
		// Before the action scrolls it in, the frame is out of view: it is still read, so the report is its real change.
		const before = await changeLook(42, 400, [ref], [], frame);
		assert.match(before.text, /pay text/, "a frame out of view is read");
		assert.ok(!before.gone.includes(ref), "its refs are not gone");
		now.PAY = "shown";
		const after = await changeLook(42, 400, [ref], [], frame);
		assert.match(after.text, /pay text/);
		now.PAY = "hidden";
		const hidden = await changeLook(42, 400, [ref], [], frame);
		assert.doesNotMatch(hidden.text, /pay text/, "a hidden frame is not read (#73)");
		assert.ok(hidden.gone.includes(ref));
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 223 r1 second-S2: a change report reads nothing of a frame the action took to an error page", async () => {
	await lookAfter(43, "chrome-error://chromewebdata/", "shown");
});

test("PR 223 r1 first-F1: a frame the action took to the approval page has its refs listed as gone", async () => {
	await lookAfter(44, "https://tabkyra.example.com/authorize", "shown", { guarded: true });
});

test("PR 223 r1 first-F3: the change look's test of a frame keeps to the look's budget", async () => {
	const { changeLook, FRAME_SHOWN_MS } = await import("../src/browser/page.ts");
	const { LOOK_MS } = await import("../src/browser/changes.ts");
	assert.equal(FRAME_SHOWN_MS, LOOK_MS, "the frame's test and the look share one budget");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
		const setup = {
			trees: { "": node("TOP", "https://shop.example"), S1: node("X", "https://x.example"), S2: node("Z", "https://z.example") },
			kids: { X: { sessionId: "S1" }, Z: { sessionId: "S2", parent: "S1" } },
			holds: { X: "TOP", Z: "X" },
			owners: { X: 11, Z: 12 },
			evaluate: () => ({ url: "https://z.example/", title: "", nodes: [], focus: "", doc: "d", gone: [], same: {}, text: "" }),
		};
		fakeTab(45, setup);
		const z = (await crossOriginFrames(45, open)).find((f) => f.frameId === "Z");
		// Alive but slow: each level's test answers just inside the per-call limit.
		fakeTab(45, { ...setup, delay: { "Runtime.callFunctionOn": 900 } });
		const ref = `${frameTag("Z")}e5`;
		const start = Date.now();
		await changeLook(45, 400, [ref], [], { ref, rule: open, hit: { frame: z, inner: "e5" } });
		const ms = Date.now() - start;
		assert.ok(ms < LOOK_MS + 450, `the look took ${ms} ms`);
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 223 r1 first-F2: a slow frame session costs one round of calls, not one per level, within POINT_MS", async () => {
	const { frameTakesPoint, POINT_MS } = await import("../src/browser/frames.ts");
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
	const setup = {
		trees: { "": node("TOP", "https://shop.example"), S1: node("X", "https://x.example"), S2: node("Z", "https://z.example") },
		kids: { X: { sessionId: "S1" }, Z: { sessionId: "S2", parent: "S1" } },
		holds: { X: "TOP", Z: "X" },
		owners: { X: 11, Z: 12 },
	};
	fakeTab(46, setup);
	const z = (await crossOriginFrames(46, open)).find((f) => f.frameId === "Z");
	fakeTab(46, { ...setup, delay: { "DOM.getFrameOwner": 400, "Page.getLayoutMetrics": 400, "DOM.getNodeForLocation": 400 } });
	const start = Date.now();
	assert.equal(await frameTakesPoint(46, z, 150, 100), true, "slow but answering: the point is the frame's");
	const ms = Date.now() - start;
	assert.ok(ms < 1500, `two levels took ${ms} ms`);
	assert.ok(POINT_MS <= 2000, `POINT_MS grew to ${POINT_MS}`);
	// A session that never answers refuses within POINT_MS.
	fakeTab(46, { ...setup, hang: new Set(["S1:DOM.getNodeForLocation"]) });
	const t = Date.now();
	assert.equal(await frameTakesPoint(46, z, 150, 100), false);
	assert.ok(Date.now() - t < POINT_MS + 300, `${Date.now() - t} ms`);
});

test("PR 223 r1 second-S3: a frame the debugger gave no answer for keeps its line; a hidden one takes no other frame's line", async () => {
	const { snapshot } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}];
		const line = (href) => ({ ...frameLine("e1", [100, 50, 400, 150]), href });
		// No answer from frameShown in the frame's own world.
		fakeTab(47, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			holds: { PAY: "TOP" },
			owners: { PAY: 11 },
			hang: new Set([":Runtime.callFunctionOn"]),
			evaluate: (frameId) => (frameId === undefined ? pageWith([line("https://pay.example/")]) : frameSnap("pay")),
		});
		let { nodes, text } = await snapshot(47, { skip: open });
		assert.deepEqual(nodes.find((n) => n.ref === "e1")?.states, ["cross-origin: read it with navigate to its URL"], "no answer is not 'not shown'");
		assert.doesNotMatch(text, /pay text/, "and it is not read");
		// A hidden frame of the same box as a shown frame that was never placed: the shown frame's line stays.
		fakeTab(47, {
			trees: { "": node("TOP", "https://shop.example", [node("GHOST", "https://ghost.example")]) },
			holds: { GHOST: "TOP" },
			owners: { GHOST: 11 },
			shown: { GHOST: "hidden" },
			evaluate: (frameId) => (frameId === undefined ? pageWith([line("https://video.example/")]) : frameSnap("ghost")),
		});
		({ nodes } = await snapshot(47, { skip: open }));
		assert.deepEqual(nodes.find((n) => n.ref === "e1")?.states, ["cross-origin: read it with navigate to its URL"], "the visible frame keeps its line");
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 223 r1 first-F4: pageSnapshot writes the frame states readFrames matches, from one definition", async () => {
	const { snapshot, FRAME_STATES } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		chrome.webNavigation.getAllFrames = async () => [{}];
		let expression = "";
		fakeTab(48, {
			trees: { "": node("TOP", "https://shop.example") },
			evaluate: (frameId, e) => {
				if (frameId === undefined && /maxNodes|frameShown/.test(e)) expression ||= e;
				return pageWith([]);
			},
		});
		await snapshot(48, { skip: open });
		assert.ok(expression, "the snapshot ran");
		for (const note of Object.values(FRAME_STATES))
			assert.equal(expression.split(note).length - 1, 1, `"${note}" is written once, as the state passed in`);
		assert.ok(expression.includes(JSON.stringify(FRAME_STATES)), "the states reach pageSnapshot as its argument");
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 228 r1 first-F2 and PR 235 r1: out of view, a frame is away only when a test proves a scroll brings it into sight", async () => {
	const { frameShown } = await import("../src/browser/frames.ts");
	const view = { innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, getComputedStyle: (n) => n.style };
	const box = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });
	const make = ({ scrollHeight = 5000, bodyStyle = {}, htmlStyle = {} } = {}) => {
		const doc = { defaultView: view, nodeType: 9 };
		const part = (style, rect, parent = null, root = doc) => ({ nodeType: 1, ownerDocument: doc, style: { opacity: "1", filter: "none", ...style }, parentElement: parent, getRootNode: () => root, getBoundingClientRect: rect, scrollTop: 0, scrollLeft: 0, scrollHeight: 5000, scrollWidth: 1280 });
		doc.documentElement = { ...part(htmlStyle, box(0, 0, 1280, scrollHeight)), scrollWidth: 1280, scrollHeight };
		doc.body = part(bodyStyle, box(0, 0, 1280, scrollHeight), doc.documentElement);
		doc.stackAt = (f) => Object.assign(doc, { elementsFromPoint: f, elementFromPoint: (x, y) => f(x, y)[0] ?? null });
		doc.stackAt(() => [doc.body]);
		const frameIn = (rect, parent = doc.body, root = doc) => part({}, rect, parent, root);
		return { doc, part, frameIn };
	};
	// Moved far to the right inside a box that clips and does not scroll.
	let t = make();
	const clipper = t.part({ overflowX: "hidden", overflowY: "visible" }, box(0, 0, 1280, 800), t.doc.body);
	assert.equal(frameShown(t.frameIn(box(100000, 10, 300, 120), clipper)), "hidden", "clipped off by overflow: hidden");
	// PR 235 r1: fixed (a closed drawer) or sticky, clip-path, paint containment, across shadow hosts too.
	const low = box(10, 3000, 300, 120);
	const under = (style, rect = box(0, 2900, 1280, 300), frame = low) => frameShown(t.frameIn(frame, t.part(style, rect, t.doc.body)));
	for (const style of [{ position: "fixed" }, { position: "sticky" }, { clipPath: "inset(50%)" }, { contain: "paint" }]) assert.equal(under(style), "hidden", JSON.stringify(style));
	assert.equal(under({ position: "fixed" }, box(0, 900, 1280, 300), box(0, 900, 300, 120)), "hidden", "first-F1: a fixed box off the viewport");
	const host = t.part({ overflowY: "hidden" }, box(0, 0, 1280, 300), t.doc.body);
	assert.equal(frameShown(t.frameIn(low, null, { nodeType: 11, host })), "hidden", "second-S1: a shadow root's host clips");
	const shell = t.part({ position: "fixed", overflowY: "auto" }, box(0, 0, 1280, 800), t.doc.body);
	assert.equal(frameShown(t.frameIn(low, t.part({}, box(0, 0, 1280, 5000), null, { nodeType: 11, host: shell }))), "hidden", "second-S2: a fixed shell, across a shadow host");
	// Past the end of the page, where no scroll goes; and a page whose scroll is turned off.
	t = make({ scrollHeight: 2000 });
	assert.equal(frameShown(t.frameIn(box(10, 3000, 300, 120))), "hidden", "past the page's end");
	t = make({ bodyStyle: { overflowY: "hidden", overflowX: "visible" } });
	assert.equal(frameShown(t.frameIn(box(10, 3000, 300, 120))), "hidden", "the page does not scroll");
	// Still out of view only: below the fold of a page that scrolls, or down an inner box that scrolls.
	t = make();
	assert.equal(frameShown(t.frameIn(box(10, 3000, 300, 120))), "away", "below the fold");
	t = make({ bodyStyle: { overflowY: "hidden", overflowX: "visible" } });
	const scroller = t.part({ overflowY: "auto", overflowX: "visible" }, box(0, 0, 1280, 800), t.doc.body);
	assert.equal(frameShown(t.frameIn(box(10, 3000, 300, 120), scroller)), "away", "down a box that scrolls");
	t = make({ htmlStyle: { overflowY: "auto" }, bodyStyle: { overflowY: "hidden" } });
	assert.equal(frameShown(t.frameIn(low)), "away", "first-F4: html scrolls, so body's overflow clips only body's own box");
	// PR 235 r2: per axis, right to left, the flat tree through a slot, and a cover fixed over the viewport.
	t = make();
	const pane = (style, extra = {}) => Object.assign(t.part(style, box(0, 0, 1280, 800), t.doc.body), extra);
	assert.equal(frameShown(t.frameIn(low, pane({ overflowX: "hidden", overflowY: "auto" }))), "away", "first-F2: a pane that scrolls down only");
	const rtl = pane({ overflowX: "auto", overflowY: "hidden", direction: "rtl" }, { scrollWidth: 5000, clientWidth: 1280 });
	assert.equal(frameShown(t.frameIn(box(-2000, 10, 300, 120), rtl)), "away", "second-second-F3: past the end of a right-to-left carousel");
	const sheet = t.part({}, box(0, 0, 1280, 5000), t.doc.body);
	const slot = t.part({}, box(0, 900, 1280, 400), t.part({ position: "fixed" }, box(0, 900, 1280, 400), null, { nodeType: 11, host: sheet }));
	assert.equal(frameShown(Object.assign(t.frameIn(low, sheet), { assignedSlot: slot })), "hidden", "second-second-F1: slotted in a fixed panel");
	const wall = t.part({ position: "fixed", backgroundColor: "rgb(0, 0, 0)" }, box(0, 0, 1280, 800), t.doc.body);
	t.doc.stackAt(() => [wall]);
	assert.equal(frameShown(t.frameIn(low)), "hidden", "first-F1: under a cover fixed over the viewport");
	t.doc.stackAt((x, y) => (y === 400 ? [wall] : [t.doc.body]));
	assert.equal(frameShown(t.frameIn(low)), "away", "a fixed box in the middle only is no cover");
	// PR 240 r1: inside classic scrollbars; an overlay beside a centered panel; one in a shadow root; one the pointer goes through.
	Object.assign(t.doc.documentElement, { clientWidth: 1265, clientHeight: 785 });
	const fit = t.part({ position: "fixed", backgroundColor: "rgba(0, 0, 0, 0.8)" }, box(0, 0, 1265, 785), t.doc.body);
	t.doc.stackAt((x, y) => (x < 1265 && y < 785 ? [fit] : [t.doc.documentElement]));
	assert.equal(frameShown(t.frameIn(low)), "hidden", "first-F1: innerWidth counts the scrollbar");
	const panel = t.part({ position: "fixed" }, box(440, 300, 400, 200), t.doc.body);
	t.doc.stackAt((x, y) => (x > 440 && x < 840 && y > 300 && y < 500 ? [panel, fit] : [fit]));
	assert.equal(frameShown(t.frameIn(low)), "hidden", "second-S1: a full overlay beside a centered dialog");
	const consent = t.part({}, box(0, 0, 0, 0), t.doc.body);
	consent.shadowRoot = { host: consent, elementsFromPoint: () => [fit, consent] };
	t.doc.stackAt(() => [consent, t.doc.body]);
	assert.equal(frameShown(t.frameIn(low)), "hidden", "first-F2: a cover in an open shadow root");
	t.doc.stackAt(() => [t.doc.body]);
	t.doc.body.children = [fit];
	assert.equal(frameShown(t.frameIn(low)), "hidden", "first-F6: a cover with pointer-events: none");
	// PR 240 r2: a cover must be seen, on top, and paint; none of these hide anything.
	const layer = (style, extra = {}) => Object.assign(t.part({ position: "fixed", ...style }, box(0, 0, 1265, 785), t.doc.body), extra);
	t.doc.body.children = [layer({ backgroundColor: "rgb(0, 0, 0)", opacity: "0" })];
	assert.equal(frameShown(t.frameIn(low)), "away", "first-F1: a closed overlay at opacity 0");
	const canvas = layer({ zIndex: "-1" }, { tagName: "CANVAS" });
	t.doc.body.children = [canvas];
	t.doc.stackAt(() => [t.doc.body, canvas]);
	assert.equal(frameShown(t.frameIn(low)), "away", "first-F2: a fixed canvas behind the page");
	t.doc.stackAt(() => [t.doc.body]);
	t.doc.body.children = [layer({ backgroundColor: "rgba(0, 0, 0, 0)" })];
	assert.equal(frameShown(t.frameIn(low)), "away", "second-F5: an empty portal root");
	const backdrop = layer({});
	t.doc.body.children = [];
	t.doc.stackAt(() => [backdrop]);
	assert.equal(frameShown(t.frameIn(low)), "away", "second-F5: a transparent click-away backdrop");
});

/** Two levels of frames (X holds Z), Z found once with no delay; `extra` is the fakeTab setup for the looks. */
async function slowZ(tabId, extra) {
	const setup = {
		trees: { "": node("TOP", "https://shop.example"), S1: node("X", "https://x.example"), S2: node("Z", "https://z.example") },
		kids: { X: { sessionId: "S1" }, Z: { sessionId: "S2", parent: "S1" } },
		holds: { X: "TOP", Z: "X" },
		owners: { X: 11, Z: 12 },
	};
	chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
	fakeTab(tabId, setup);
	const z = (await crossOriginFrames(tabId, open)).find((f) => f.frameId === "Z");
	fakeTab(tabId, { ...setup, ...extra });
	return z;
}

const zLook = { url: "https://z.example/", title: "", focus: "", doc: "d", gone: [], same: {}, text: "z text", nodes: [{ ref: "e5", role: "button", name: "Z", x: 1, y: 1, width: 1, height: 1 }] };

test("PR 228 r1 first-F1: a frame whose test gets no answer in time is not read, and its refs are not listed as gone", async () => {
	const { changeLook } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		const z = await slowZ(49, { delay: { "Runtime.callFunctionOn": 900 }, evaluate: (frameId) => (frameId ? zLook : { ...zLook, url: "https://shop.example/", nodes: [], text: "" }) });
		const ref = `${frameTag("Z")}e5`;
		const look = await changeLook(49, 400, [ref], [], { ref, rule: open, hit: { frame: z, inner: "e5" } });
		assert.ok(!look.gone.includes(ref), `untested is unknown, not gone: ${JSON.stringify(look.gone)}`);
		assert.doesNotMatch(look.text, /z text/, "and not read");
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 228 r1 second-S2: a frame found again after its look failed still keeps to one look's budget", async () => {
	const { changeLook } = await import("../src/browser/page.ts");
	const { LOOK_MS } = await import("../src/browser/changes.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		let first = true;
		const z = await slowZ(50, {
			delay: { "Runtime.callFunctionOn": 900 },
			evaluate: (frameId) => {
				if (!frameId) return { ...zLook, url: "https://shop.example/", nodes: [], text: "" };
				if (first) {
					first = false;
					throw new Error("Cannot find context with specified id");
				}
				return zLook;
			},
		});
		const ref = `${frameTag("Z")}e5`;
		const start = Date.now();
		await changeLook(50, 400, [ref], [], { ref, rule: open, hit: { frame: z, inner: "e5" } });
		const ms = Date.now() - start;
		assert.ok(!first, "the first look failed");
		assert.ok(ms < LOOK_MS + 450, `the look took ${ms} ms`);
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 228 r1 first-F3 and second-S1: a redirected hidden frame says so on its line; a barred one takes no other frame's line", async () => {
	const { snapshot } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		chrome.webNavigation.getAllFrames = async () => [{}, {}];
		const line = (href) => ({ ...frameLine("e1", [100, 50, 400, 150]), href });
		// Its <iframe> names /checkout; the frame redirected to the origin's root.
		fakeTab(51, {
			trees: { "": node("TOP", "https://shop.example", [node("PAY", "https://pay.example")]) },
			holds: { PAY: "TOP" },
			owners: { PAY: 11 },
			shown: { PAY: "hidden" },
			evaluate: (frameId) => (frameId === undefined ? pageWith([line("https://pay.example/checkout")]) : frameSnap("pay")),
		});
		let { nodes } = await snapshot(51, { skip: open });
		assert.deepEqual(nodes.find((n) => n.ref === "e1")?.states, ["cross-origin frame, not shown, so not read"], "never told to navigate to a hidden frame");
		// A barred frame the tab finds hidden, of the same box as a shown frame that was never placed.
		fakeTab(51, {
			trees: { "": node("TOP", "https://shop.example", [node("GHOST", "https://ghost.example")]) },
			holds: { GHOST: "TOP" },
			owners: { GHOST: 11 },
			shown: { GHOST: "hidden" },
			evaluate: (frameId) => (frameId === undefined ? pageWith([line("https://video.example/")]) : frameSnap("ghost")),
		});
		const barred = (url) => (url.startsWith("https://ghost.example") ? "blocked" : undefined);
		({ nodes } = await snapshot(51, { skip: barred }));
		assert.deepEqual(nodes.find((n) => n.ref === "e1")?.states, ["cross-origin: read it with navigate to its URL"], "the video frame keeps its line");
	} finally {
		chrome.tabs.get = getTab;
	}
});

test("PR 235 r2 first-F3, first-F4, second-second-F2: query URLs bind their own lines; no frame notes throws; a refind that fails fast is unknown", async () => {
	const { snapshot, changeLook, pageSnapshot } = await import("../src/browser/page.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		// Stacked ad slots with queries; the snapshot writes each href with no query.
		chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
		const pay = (id, path) => ({ frame: { id, url: `https://pay.example/${path}`, securityOrigin: "https://pay.example" } });
		const lines = ["a", "b"].map((p, i) => ({ ...frameLine(`e${i + 1}`, [100, 50, 400, 150]), href: `https://pay.example/${p}` }));
		fakeTab(56, { trees: { "": node("TOP", "https://shop.example", [pay("PA", "a?slot=1"), pay("PB", "b?slot=2")]) }, holds: { PA: "TOP", PB: "TOP" }, owners: { PA: 11, PB: 12 }, shown: { PA: "no answer", PB: "hidden" }, evaluate: (frameId) => (frameId === undefined ? pageWith(lines) : frameSnap("pay")) });
		const got = (await snapshot(56, { skip: open })).nodes;
		assert.deepEqual(got.find((n) => n.ref === "e1")?.states, ["cross-origin: read it with navigate to its URL"], "first-F3: /a keeps its line");
		assert.deepEqual(got.find((n) => n.ref === "e2")?.states, ["cross-origin frame, not shown, so not read"], "first-F3: /b says not shown");
		// PR 240 r1 first-F3: one path, two queries; neither frame may take the line by its URL.
		const ads = (id, q) => ({ frame: { id, url: `https://ads.example/slot?id=${q}`, securityOrigin: "https://ads.example" } });
		const slots = ["e1", "e2"].map((r) => ({ ...frameLine(r, [100, 50, 400, 150]), href: "https://ads.example/slot" }));
		fakeTab(58, { trees: { "": node("TOP", "https://shop.example", [ads("A1", 1), ads("A2", 2)]) }, holds: { A1: "TOP", A2: "TOP" }, owners: { A1: 11, A2: 12 }, shown: { A1: "no answer", A2: "hidden" }, evaluate: (frameId) => (frameId === undefined ? pageWith(slots) : frameSnap("ads")) });
		const both = (await snapshot(58, { skip: open })).nodes.filter((n) => n.role === "iframe").map((n) => n.states?.[0]);
		assert.deepEqual(both, ["cross-origin: read it with navigate to its URL", "cross-origin: read it with navigate to its URL"], "first-F3");
		// first-F4: frame notes left out throw on any page, not only one with a cross-origin frame.
		const page = crossPage();
		page.document.querySelectorAll = () => [];
		const call = `(${pageSnapshot.toString()})(300, 1000, "all", () => true, () => "p", false, () => "shown")`;
		assert.throws(() => vm.runInContext(call, page), /pageSnapshot: its caller passed no frameShown/);
		// second-second-F2: the refind's frame tree rejects at once; the frame may still be there.
		const top = { ...zLook, url: "https://shop.example/", nodes: [], text: "" };
		const z = await slowZ(57, { fail: new Set(["S2:Page.getFrameTree"]), evaluate: (frameId) => { if (frameId) throw new Error("Cannot find context with specified id"); return top; } });
		const ref = `${frameTag("Z")}e5`;
		const look = await changeLook(57, 400, [ref], [], { ref, rule: open, hit: { frame: z, inner: "e5" } });
		assert.ok(!look.gone.includes(ref), `a refind with no answer is unknown, not gone: ${JSON.stringify(look.gone)}`);
		// PR 240 r1 first-F4: the tree and owner answer, but the frame's box never comes: not found is not certain.
		const { frameForRef } = await import("../src/browser/frames.ts");
		await slowZ(59, { hang: new Set(["S1:DOM.getContentQuads"]) });
		const err = await frameForRef(59, ref, open).catch((e) => e);
		assert.match(String(err?.message), /did not answer/, "first-F4");
	} finally {
		chrome.tabs.get = getTab;
	}
});

/** A page in a sandbox with one cross-origin <iframe>, to run page code as the tab would. */
function crossPage() {
	const g = { innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0, __name: (f) => f, crypto, CSS: { escape: (s) => s }, location: { href: "https://shop.example/" }, frameElement: null, getComputedStyle: () => ({ opacity: "1", filter: "none", visibility: "visible", display: "block", paddingLeft: "0", paddingTop: "0" }) };
	const doc = { nodeType: 9, defaultView: g, title: "Shop", body: { innerText: "Shop" }, activeElement: null, documentElement: { scrollHeight: 800 }, getElementsByTagName: () => [] };
	const frame = { nodeType: 1, tagName: "IFRAME", src: "https://pay.example/checkout", ownerDocument: doc, isConnected: true, parentElement: null, textContent: "", offsetWidth: 400, offsetHeight: 150, clientLeft: 0, clientTop: 0, getAttribute: () => null, getRootNode: () => doc, getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 150, right: 500, bottom: 200 }), matches: () => false, closest: () => null, querySelector: () => null, checkVisibility: () => true };
	Object.assign(doc, { querySelectorAll: (sel) => (sel === "*" ? [frame] : []), elementFromPoint: () => frame });
	return vm.createContext(Object.assign(g, { document: doc, window: g, parent: g }));
}

test("PR 235 r1 first-F3, second-S3, second-S4: a refind keeps to the deadline; no taking a kin frame's line; every caller labels a frame", async () => {
	const { snapshot, changeLook, pageSnapshot } = await import("../src/browser/page.ts");
	const { LOOK_MS } = await import("../src/browser/changes.ts");
	const getTab = chrome.tabs.get;
	chrome.tabs.get = async (id) => ({ id, url: "https://shop.example/" });
	try {
		// first-F3: the look failed and finding the frame again hangs; it is unknown, not gone, by the deadline.
		const top = { ...zLook, url: "https://shop.example/", nodes: [], text: "" };
		const z = await slowZ(53, { hang: new Set(["S2:Page.getFrameTree"]), evaluate: (frameId) => { if (frameId) throw new Error("Cannot find context with specified id"); return top; } });
		const ref = `${frameTag("Z")}e5`;
		const start = Date.now();
		const look = await changeLook(53, 400, [ref], [], { ref, rule: open, hit: { frame: z, inner: "e5" } });
		assert.ok(Date.now() - start < LOOK_MS + 450, `the look took ${Date.now() - start} ms`);
		assert.ok(!look.gone.includes(ref), `not found again in time is unknown, not gone: ${JSON.stringify(look.gone)}`);
		const note = ["cross-origin: read it with navigate to its URL"];
		// Stacked ad slots of one origin and box: /a on top, untested; /b hidden under it.
		chrome.webNavigation.getAllFrames = async () => [{}, {}, {}];
		const pay = (id, path) => ({ frame: { id, url: `https://pay.example/${path}`, securityOrigin: "https://pay.example" } });
		const line = { ...frameLine("e1", [100, 50, 400, 150]), href: "https://pay.example/a" };
		fakeTab(54, { trees: { "": node("TOP", "https://shop.example", [pay("PA", "a"), pay("PB", "b")]) }, holds: { PA: "TOP", PB: "TOP" }, owners: { PA: 11, PB: 12 }, shown: { PA: "no answer", PB: "hidden" }, evaluate: (frameId) => (frameId === undefined ? pageWith([line]) : frameSnap("pay")) });
		assert.deepEqual((await snapshot(54, { skip: open })).nodes.find((n) => n.ref === "e1")?.states, note, "the /a frame keeps its line");
		// The page code of snapshot, find and changeLook, run on a page with a cross-origin frame.
		chrome.webNavigation.getAllFrames = async () => [{}];
		const run = async (frameId, e) => { const r = await vm.runInContext(e, crossPage()); if (!r.ok) throw new Error(r.error); return r.value; };
		fakeTab(55, { trees: { "": node("TOP", "https://shop.example") }, evaluate: run });
		const states = (look) => Array.from(look.nodes.find((n) => n.role === "iframe")?.states ?? []);
		assert.deepEqual(states(await snapshot(55, { skip: open })), note, "snapshot");
		assert.deepEqual(states(await snapshot(55, { filter: "all", maxNodes: 600, maxTextChars: 0, skip: open })), note, "find");
		assert.deepEqual(states(await changeLook(55, 400, [], [])), note, "changeLook");
		const bare = `(${pageSnapshot.toString()})(300, 1000, "all", () => true, () => "p", false)`;
		assert.throws(() => vm.runInContext(bare, crossPage()), /pageSnapshot: its caller passed no frameShown/);
	} finally {
		chrome.tabs.get = getTab;
	}
});
