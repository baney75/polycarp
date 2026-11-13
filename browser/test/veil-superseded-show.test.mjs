// first-F2 of PR 204's second review: a show that ran past its EFFECT_TIMEOUT_MS (src/browser/veil.ts) and resumes after
// a newer show on its tab has already finished must draw nothing. Before, the newer show's entry was gone by then, so the
// late one injected the tag it read before a navigation onto the new document. Fake chrome.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
/** Every inject the veil sent, with when it reached the page. */
const injected = [];
chrome.scripting = {
	async executeScript({ target, args: [cmd] }) {
		injected.push({ tabId: target.tabId, cmd, at: performance.now() });
		return [{ result: cmd.op === "show" ? { tag: cmd.tag } : {} }];
	},
};
await chrome.storage.local.set({ veil_pointer: true });
// The first show's theme read is slow (a loaded browser): it is past its time when it gets there, tag already read.
let slowTheme = true;
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (Array.isArray(keys) && slowTheme) {
		slowTheme = false;
		await new Promise((r) => setTimeout(r, 2_500));
	}
	return get.call(chrome.storage.local, keys);
};
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

test("first-F2: a late show whose tab a newer show already drew (after a navigation) sends no inject", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/a" });
	const session = { id: "bridge-claude-shop", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
	veilEnd(session, "click", await veilBegin(session, "click", { tabId }));
	// The chain moved on; the first show still waits on its theme. The page navigates and the new document is drawn.
	const t0 = performance.now();
	fake.commitNav(tabId, "https://shop.example.com/b");
	await new Promise((r) => setTimeout(r, 2_000));
	const shows = injected.filter((i) => i.at >= t0 && i.cmd.op === "show");
	assert.equal(shows.length, 1, `the late show drew over the new document: ${JSON.stringify(shows.map((s) => s.cmd.tag))}`);
});
