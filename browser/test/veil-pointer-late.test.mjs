// first-F1 of PR 204's second review: after a worker restart the pointer setting's read can settle after the show gave
// up on it (EFFECT_TIMEOUT_MS, 1.5 s, src/browser/veil.ts). The show draws no character, the safe side; once the read
// settles with the setting on, the open veil must get it. Fake chrome.
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
// Stored in an earlier worker life; this worker's first read of it takes 2 s.
await chrome.storage.local.set({ veil_pointer: true });
await new Promise((r) => setTimeout(r, 50));
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") await new Promise((r) => setTimeout(r, 2_000));
	return get.call(chrome.storage.local, keys);
};
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

test("first-F1: a pointer setting read that settles after the show gave up on it turns the character on in the open veil", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/" });
	const session = { id: "bridge-claude-shop", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
	veilEnd(session, "click", await veilBegin(session, "click", { tabId }));
	await new Promise((r) => setTimeout(r, 3_000));
	const show = injected.find((i) => i.tabId === tabId && i.cmd.op === "show");
	assert.equal(show?.cmd.pointer, false, "the show waited for the slow read instead of drawing without it");
	assert.ok(
		injected.some((i) => i.tabId === tabId && i.cmd.op === "set" && i.cmd.pointer === true),
		"the setting read at 2 s never reached the open veil: the character stays hidden",
	);
});
