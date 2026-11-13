// second-S1 of PR 219's review: a show that runs past EFFECT_TIMEOUT_MS (1.5 s, src/browser/veil.ts) while its tab read is
// slow, then resumes after the veil hid or the tab closed, stores its tag on the way. It must not leave it stored: the
// restart sweep and the next show read it. Fake chrome.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tabs whose next read takes 2 s: it answers with the tab as it was when asked, as a read already under way does. */
const slow = new Set();
const tabsGet = chrome.tabs.get;
chrome.tabs.get = async (id) => {
	if (!slow.delete(id)) return tabsGet.call(chrome.tabs, id);
	const tab = await tabsGet.call(chrome.tabs, id);
	await sleep(2_000);
	return tab;
};
const { startVeil, veilBegin, veilEnd, veilSessionGone } = await import("../src/browser/veil.ts");
const { storedVeilTags } = await import("../src/browser/veil-shared.ts");
startVeil();

async function lateShow(name) {
	const tabId = fake.addTab({ url: `https://shop.example.com/${name}` });
	const s = { id: `bridge-claude-${name}`, tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
	slow.add(tabId);
	veilEnd(s, "click", await veilBegin(s, "click", { tabId }));
	return { tabId, s };
}

test("second-S1 (PR 219's review): a veil hidden while its show waited leaves no tag stored", async () => {
	const { tabId, s } = await lateShow("hide");
	// The chain moved on at 1.5 s; the show still waits on its tab. The session goes and the veil hides.
	veilSessionGone(s.id);
	await sleep(1_500);
	const tags = new Map(await storedVeilTags());
	assert.equal(tags.get(tabId), undefined, "the late show wrote its tag back after the hide");
});

test("second-S1 (PR 219's review): a tab closed while its show waited leaves no tag stored", async () => {
	const { tabId } = await lateShow("close");
	fake.userCloseTab(tabId);
	await sleep(1_500);
	const tags = new Map(await storedVeilTags());
	assert.equal(tags.get(tabId), undefined, "the late show wrote its tag back for a closed tab");
});
