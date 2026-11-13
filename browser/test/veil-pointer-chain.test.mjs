// The pointer setting after a worker restart (src/browser/veil.ts, D47). Fake chrome. The stalled point is in
// veil-pointer-stall.test.mjs.
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
// The person turned the pointer off; after a worker restart the setting's read is slow.
await chrome.storage.local.set({ veil_pointer: false });
// Stored in an earlier worker life: its change event is long gone when this worker starts.
await new Promise((r) => setTimeout(r, 50));
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") await new Promise((r) => setTimeout(r, 300));
	return get.call(chrome.storage.local, keys);
};
const { cuePointer } = await import("../src/browser/cdp.ts");
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
