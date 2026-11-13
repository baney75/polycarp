// The pointer never holds up the veil (src/browser/veil.ts, D47): a point inject that a busy page doesn't answer must
// not delay the capture cover or the next call's veilBegin, which wait on the tab's veil changes. Fake chrome.
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
		if (cmd.op === "point" && busy) return new Promise(() => undefined);
		return [{ result: cmd.op === "show" ? { tag: cmd.tag } : {} }];
	},
};
// The person turned the pointer off; after a worker restart the setting's read is slow.
await chrome.storage.local.set({ veil_pointer: false });
// Stored in an earlier worker life: its change event is long gone when this worker starts.
await new Promise((r) => setTimeout(r, 50));
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") await new Promise((r) => setTimeout(r, 300));
	return get.call(chrome.storage.local, keys);
};
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

test("first-F3: a veil drawn before the pointer setting is read waits for it, and a cue then draws nothing", async () => {
	veilEnd(session, "click", await veilBegin(session, "click", {}));
	cuePointer(tabId, "click", 40, 40);
	await new Promise((r) => setTimeout(r, 500));
	const show = injected.find((i) => i.cmd.op === "show");
	assert.equal(show?.cmd.pointer, false, "the veil was drawn with the pointer on");
	assert.ok(!injected.some((i) => i.cmd.op === "point"), "the character moved with the setting off");
	// The person turns it back on.
	await chrome.storage.local.set({ veil_pointer: true });
	assert.ok(await until(() => injected.find((i) => i.cmd.op === "set" && i.cmd.pointer === true)), "turning it on reached no page");
});

test("first-F1: a stalled point inject delays neither the capture cover nor the next call's veilBegin", async () => {
	// The agent clicks: the veil is drawn, the call ends, and the character is sent to the point on a busy page.
	veilEnd(session, "click", await veilBegin(session, "click", {}));
	assert.ok(injected.some((i) => i.cmd.op === "show"), "no veil was drawn");
	busy = true;
	cuePointer(tabId, "click", 40, 40);
	assert.ok(await until(() => injected.find((i) => i.cmd.op === "point")), "the point was never sent");

	// The next screenshot conceals the veil first.
	let t0 = performance.now();
	const shot = captureScreenshot(tabId).catch(() => undefined);
	const conceal = await until(() => after(t0, (c) => c.op === "set" && c.concealed === true));
	assert.ok(conceal && conceal.at - t0 < 400, `the capture cover waited ${conceal ? Math.round(conceal.at - t0) : "over 3000"} ms behind the pointer`);
	await shot;

	// The next input call turns the pill's button off before it runs.
	t0 = performance.now();
	await veilBegin(session, "click", {});
	assert.ok(performance.now() - t0 < 400, `veilBegin waited ${Math.round(performance.now() - t0)} ms behind the pointer`);
	assert.ok(after(t0, (c) => c.op === "set" && c.interactive === false), "the button was not turned off");
	// Cues that pile up behind the stalled one: only the newest is sent.
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
