// second-S1 of the PR 204 review: the pointer setting's read after a worker restart can be slow or never settle. A tool
// call must still wait on the veil for at most EFFECT_TIMEOUT_MS (1.5 s, src/browser/veil.ts). Fake chrome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
chrome.scripting = {
	async executeScript({ args: [cmd] }) {
		return [{ result: cmd.op === "show" ? { tag: cmd.tag } : {} }];
	},
};
await chrome.storage.local.set({ veil_pointer: true });
await new Promise((r) => setTimeout(r, 50));
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") return new Promise(() => undefined);
	return get.call(chrome.storage.local, keys);
};
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

test("second-S1: a pointer setting read that never settles holds a tool call for one EFFECT_TIMEOUT_MS at most", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/" });
	const session = { id: "bridge-claude-shop", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
	const t0 = performance.now();
	const begun = await Promise.race([veilBegin(session, "click", { tabId }), new Promise((r) => setTimeout(() => r("hung"), 4_000))]);
	const took = performance.now() - t0;
	assert.notEqual(begun, "hung", "veilBegin never returned");
	assert.ok(took < 2_000, `veilBegin took ${Math.round(took)} ms`);
	veilEnd(session, "click", begun);
});

test("second-S1 (PR 204's second review): after that, a show on a fresh tab no longer waits on the hung read at all", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/two" });
	const session = { id: "bridge-claude-two", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "green" } };
	const t0 = performance.now();
	const begun = await Promise.race([veilBegin(session, "click", { tabId }), new Promise((r) => setTimeout(() => r("hung"), 4_000))]);
	const took = performance.now() - t0;
	assert.notEqual(begun, "hung", "veilBegin never returned");
	assert.ok(took < 750, `the second veilBegin waited ${Math.round(took)} ms on the read that never settles`);
	veilEnd(session, "click", begun);
});
