// first-F2 of PR 219's review: a cue that comes after the shows gave up on the pointer setting's read (EFFECT_TIMEOUT_MS,
// 1.5 s, src/browser/veil.ts) must not wait on a read: the character is off by then, and a read that never settles would
// keep one waiting cue per input for the life of the worker. It is dropped, never drawn late. Fake chrome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
/** Every inject the veil sent. */
const injected = [];
chrome.scripting = {
	async executeScript({ target, args: [cmd] }) {
		injected.push({ tabId: target.tabId, cmd });
		return [{ result: cmd.op === "show" ? { tag: cmd.tag } : {} }];
	},
};
await chrome.storage.local.set({ veil_pointer: true });
await new Promise((r) => setTimeout(r, 50));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Each read of the setting takes 2 s.
let pointerReads = 0;
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") {
		pointerReads++;
		await sleep(2_000);
	}
	return get.call(chrome.storage.local, keys);
};
const { cuePointer } = await import("../src/browser/cdp.ts");
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

test("first-F2 (PR 219's review): a cue after the read's deadline starts no read and is never drawn late", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/" });
	const s = { id: "bridge-claude-shop", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
	veilEnd(s, "click", await veilBegin(s, "click", { tabId }));
	// Past the deadline (1.5 s from the read's start), before the read settles at 2 s.
	await sleep(250);
	const at = injected.length;
	cuePointer(tabId, "click", 40, 40);
	await sleep(3_000);
	const points = injected.slice(at).filter((i) => i.cmd.op === "point");
	assert.deepEqual(points, [], "a cue the character was off for was drawn once a later read settled");
	assert.equal(pointerReads, 1, `${pointerReads} reads of the setting were started`);
});
