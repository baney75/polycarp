// Cross-origin frames (D45): a frame's refs carry its tag, and a ref read inside a frame stays
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
	const frames = await crossOriginFrames(1, (url) => url.startsWith("http://localhost:8787/"));
	assert.deepEqual(frames.map((f) => f.frameId), ["PAY"]);
	assert.deepEqual(frames[0].offset, { x: 103, y: 53 }, "the content box: the border inside the frame's quad");
	assert.equal(frames[0].tag, frameTag("PAY"));
	const touched = sent.filter((c) => c.method === "DOM.getFrameOwner").map((c) => c.params.frameId);
	assert.deepEqual(touched, ["PAY"], "nothing is asked about the guarded frame, what is in it, or the extension page");
});
