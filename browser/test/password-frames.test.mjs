// Whether a tab has a password field in any frame: the top document, a same-origin iframe, a nested one.
import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FRAMES, passwordInTab } from "../src/browser/password-frames.ts";

/**
 * A fake DevTools endpoint. `frames` is a tree { id, password?, hidden?, children? }: `password` says whether
 * that frame's document has a password field, `hidden` that its world can't be created (another process).
 */
function fakeTab(root, { treeFails = false } = {}) {
	const calls = [];
	const byId = new Map();
	const contexts = new Map();
	let nextContext = 100;
	const walk = (f) => {
		byId.set(f.id, f);
		for (const c of f.children ?? []) walk(c);
	};
	walk(root);
	const tree = (f) => ({ frame: { id: f.id }, childFrames: (f.children ?? []).map(tree) });
	const send = async (method, params = {}) => {
		calls.push([method, params.frameId ?? params.contextId]);
		if (method === "Runtime.evaluate") {
			const frame = params.contextId === undefined ? root : contexts.get(params.contextId);
			if (!frame) throw new Error("No execution context");
			return { result: { value: frame.password === true } };
		}
		if (method === "Page.getFrameTree") {
			if (treeFails) throw new Error("detached");
			return { frameTree: tree(root) };
		}
		if (method === "Page.createIsolatedWorld") {
			const frame = byId.get(params.frameId);
			if (!frame || frame.hidden) throw new Error("No frame with the given id");
			const id = nextContext++;
			contexts.set(id, frame);
			return { executionContextId: id };
		}
		throw new Error(`unexpected ${method}`);
	};
	return { send, calls };
}

test("a top document with a password field answers yes without looking further", async () => {
	const tab = fakeTab({ id: "top", password: true, children: [{ id: "a" }] });
	assert.equal(await passwordInTab(tab.send, "a"), true);
	assert.deepEqual(tab.calls.map((c) => c[0]), ["Runtime.evaluate"]);
});

test("a tab with no password field in any frame answers no", async () => {
	const tab = fakeTab({ id: "top", children: [{ id: "a", children: [{ id: "a1" }] }, { id: "b" }] });
	assert.equal(await passwordInTab(tab.send, "a1"), false);
	assert.equal(await passwordInTab(tab.send), false);
});

test("sol-F3: a password field in a same-origin iframe counts, whichever frame the request came from", async () => {
	const tab = () => fakeTab({ id: "top", children: [{ id: "a" }, { id: "b", password: true }] });
	assert.equal(await passwordInTab(tab().send, "b"), true, "the request came from the frame with the field");
	assert.equal(await passwordInTab(tab().send, "a"), true, "the request came from a sibling that can reach it");
	assert.equal(await passwordInTab(tab().send, "top"), true, "the request came from the top document");
	assert.equal(await passwordInTab(tab().send), true);
	// Nested two deep.
	assert.equal(await passwordInTab(fakeTab({ id: "top", children: [{ id: "a", children: [{ id: "a1", password: true }] }] }).send, "a1"), true);
});

test("fail closed: the frame a request came from can't be inspected, the tab's frames can't be listed, or the frame is gone", async () => {
	const hidden = () => fakeTab({ id: "top", children: [{ id: "a", hidden: true }, { id: "b" }] });
	assert.equal(await passwordInTab(hidden().send, "a"), true, "the initiating frame can't be asked");
	assert.equal(await passwordInTab(hidden().send, "b"), false, "another frame that can't be asked (another process) is skipped");
	assert.equal(await passwordInTab(fakeTab({ id: "top", children: [{ id: "a" }] }, { treeFails: true }).send, "a"), true);
	assert.equal(await passwordInTab(fakeTab({ id: "top", children: [{ id: "a" }] }).send, "gone"), true);
	const crowd = { id: "top", children: Array.from({ length: MAX_FRAMES + 5 }, (_, i) => ({ id: `f${i}` })) };
	assert.equal(await passwordInTab(fakeTab(crowd).send, "f0"), true, "too many frames to look through");
});

test("a page that can't be asked at all answers yes", async () => {
	assert.equal(await passwordInTab(async () => { throw new Error("detached"); }), true);
	assert.equal(await passwordInTab(async (method) => (method === "Runtime.evaluate" ? { result: {}, exceptionDetails: { text: "x" } } : {})), true);
});
