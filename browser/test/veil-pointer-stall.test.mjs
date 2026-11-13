// The pointer never holds up the veil (src/browser/veil.ts, D47, first-F1 of the #189 review): a point inject that a
// busy page doesn't answer must not add its own timeout in front of the capture cover or the next call's veilBegin,
// which wait on the tab's veil changes. A busy page runs none of the worker's injects, so the veil's own change also
// waits out one EFFECT_TIMEOUT_MS (1.5 s); before, the stalled point's 1.5 s came first, about 3 s in all. Fake chrome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
/** Every inject the veil sent, with when it reached the page. */
const injected = [];
let busy = false;
chrome.scripting = {
	async executeScript({ target, args: [cmd] }) {
		injected.push({ tabId: target.tabId, cmd, at: performance.now() });
		// A page whose main thread is busy runs nothing the worker sends it.
		if (busy) return new Promise(() => undefined);
		return [{ result: cmd.op === "show" ? { tag: cmd.tag } : {} }];
	},
};
await chrome.storage.local.set({ veil_pointer: true });
/** When each capture reached the browser: after the veil was concealed, or the conceal's time ran out. */
const captures = [];
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Page.getLayoutMetrics")
		return { cssContentSize: { width: 800, height: 600 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
	if (method === "Page.captureScreenshot") {
		captures.push(performance.now());
		return { data: "" };
	}
	return send.call(chrome.debugger, target, method, params);
};
/** veil.ts's EFFECT_TIMEOUT_MS, and what one wait on it may take on a loaded machine. */
const EFFECT_TIMEOUT_MS = 1500;
const ONE_WAIT = EFFECT_TIMEOUT_MS + 500;
const { cuePointer, captureScreenshot } = await import("../src/browser/cdp.ts");
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

const tabId = fake.addTab({ url: "https://shop.example.com/" });
const session = { id: "bridge-claude-shop", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
const after = (t0, pred) => injected.find((i) => i.at >= t0 && pred(i.cmd));
const until = async (pred, ms = 3000) => {
	for (const end = performance.now() + ms; performance.now() < end; await new Promise((r) => setTimeout(r, 5))) {
		const hit = pred();
		if (hit) return hit;
	}
	return undefined;
};

test("first-F1: on a busy page a stalled point adds no timeout in front of the capture cover or the next veilBegin", async () => {
	// The agent clicks: the veil is drawn, the call ends, and the character is sent to the point on a page that then
	// keeps its main thread busy, so nothing the worker injects runs.
	veilEnd(session, "click", await veilBegin(session, "click", {}));
	assert.ok(injected.some((i) => i.cmd.op === "show"), "no veil was drawn");
	await new Promise((r) => setTimeout(r, 100));
	busy = true;
	const tBusy = performance.now();
	cuePointer(tabId, "click", 40, 40);
	await new Promise((r) => setTimeout(r, 20));

	// The next screenshot conceals the veil first. The conceal is sent at once and waits out its own time, once.
	let t0 = performance.now();
	const before = captures.length;
	await captureScreenshot(tabId, { maxWidth: 800 }).catch(() => undefined);
	const conceal = after(t0, (c) => c.op === "set" && c.concealed === true);
	assert.ok(conceal && conceal.at - t0 < 400, `the conceal was sent ${conceal ? Math.round(conceal.at - t0) : "never"} ms after the screenshot began`);
	const took = captures.length > before ? captures[before] - t0 : Number.POSITIVE_INFINITY;
	assert.ok(took < ONE_WAIT, `the capture waited ${Math.round(took)} ms: more than one EFFECT_TIMEOUT_MS`);
	const stalled = after(tBusy, (c) => c.op === "point");
	assert.ok(stalled && stalled.at < t0, "the point was not sent before the screenshot, so nothing was stalled");

	// Let the uncover after the capture wait out its own time, then a new cue while the page is still busy.
	await new Promise((r) => setTimeout(r, EFFECT_TIMEOUT_MS + 100));
	cuePointer(tabId, "click", 45, 45);
	await new Promise((r) => setTimeout(r, 20));
	// The next input call turns the pill's button off before it runs: one wait at most.
	t0 = performance.now();
	await veilBegin(session, "click", {});
	const began = performance.now() - t0;
	assert.ok(began < ONE_WAIT, `veilBegin waited ${Math.round(began)} ms: more than one EFFECT_TIMEOUT_MS`);
	assert.ok(after(t0, (c) => c.op === "set" && c.interactive === false), "the button was not turned off");
	veilEnd(session, "click", undefined);
	await new Promise((r) => setTimeout(r, EFFECT_TIMEOUT_MS + 100));

	// The page is free again. Cues that pile up behind the stalled one: only the newest is sent.
	busy = false;
	t0 = performance.now();
	cuePointer(tabId, "click", 50, 50);
	cuePointer(tabId, "click", 60, 60);
	const sent = await until(() => after(t0, (c) => c.op === "point"));
	await new Promise((r) => setTimeout(r, 100));
	const points = injected.filter((i) => i.at >= t0 && i.cmd.op === "point").map((i) => i.cmd.cue.x);
	assert.ok(sent, "no cue was sent after the stall");
	assert.deepEqual(points, [60], "a cue a newer one replaced was sent");
});
