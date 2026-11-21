// second-S1 (review of #189): a show that waits on the browser past its EFFECT_TIMEOUT_MS (src/browser/veil.ts) lets the
// tab's chain move on to a capture's conceal. When it then lands, it must not draw the veil unconcealed during that
// capture. Two causes of the wait: the pointer setting's read after a worker restart, and any other slow browser call.
// Fake chrome, with a page that keeps what it shows; each capture takes 800 ms.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
/** What each tab's page shows: a veil or not, and whether it is concealed. */
const pages = new Map();
const page = (tabId) => pages.get(tabId) ?? pages.set(tabId, { veil: false, concealed: false }).get(tabId);
chrome.scripting = {
	async executeScript({ target, args: [cmd] }) {
		const p = page(target.tabId);
		if (cmd.op === "show") {
			Object.assign(p, { veil: true, concealed: cmd.concealed === true });
			return [{ result: { tag: cmd.tag } }];
		}
		if (cmd.op === "hide") p.veil = false;
		if (cmd.op === "set" && p.veil && typeof cmd.concealed === "boolean") p.concealed = cmd.concealed;
		return [{ result: p.veil ? { tag: "t" } : {} }];
	},
};
/** Set while a capture runs: true if the page showed the veil unconcealed at any moment of it. */
let seen = false;
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Page.getLayoutMetrics")
		return { cssContentSize: { width: 800, height: 600 }, cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
	if (method === "Page.captureScreenshot") {
		for (const end = performance.now() + 800; performance.now() < end; await new Promise((r) => setTimeout(r, 10))) {
			const p = page(target.tabId);
			if (p.veil && !p.concealed) seen = true;
		}
		return { data: "" };
	}
	return send.call(chrome.debugger, target, method, params);
};
// After a worker restart, the pointer setting's read is slower than the veil's 1.5 s.
await chrome.storage.local.set({ veil_pointer: true });
await new Promise((r) => setTimeout(r, 50));
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") await new Promise((r) => setTimeout(r, 2_000));
	return get.call(chrome.storage.local, keys);
};
/** Tabs whose next chrome.tabs.get is slow (a loaded browser): the show's own read, not the capture's. */
const slow = new Set();
const tabsGet = chrome.tabs.get;
chrome.tabs.get = async (id) => {
	if (slow.delete(id)) await new Promise((r) => setTimeout(r, 2_000));
	return tabsGet.call(chrome.tabs, id);
};
const { captureScreenshot } = await import("../src/browser/cdp.ts");
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

const one = fake.addTab({ url: "https://shop.example.com/a" });
const two = fake.addTab({ url: "https://shop.example.com/b" });
const session = { id: "bridge-claude-shop", tabIds: [one, two], currentTabId: one, ended: false, record: { label: "claude", color: "blue" } };

/** The agent clicks on the tab, then takes a screenshot of it; returns once a late show has had time to land. */
async function clickThenShot(tabId) {
	const t0 = performance.now();
	seen = false;
	veilEnd(session, "click", await veilBegin(session, "click", { tabId }));
	await captureScreenshot(tabId, { maxWidth: 800 }).catch(() => undefined);
	const capturedSeen = seen;
	await new Promise((r) => setTimeout(r, Math.max(0, 2_600 - (performance.now() - t0))));
	return capturedSeen;
}

test("second-S1: the pointer setting's slow read after a restart never draws the veil unconcealed during a capture", async () => {
	assert.equal(await clickThenShot(one), false, "the veil was drawn unconcealed while the screenshot was taken");
	assert.deepEqual(page(one), { veil: true, concealed: false }, "the veil is not back after the screenshot");
});

test("second-S1: a show that ran past its time draws the tab as it is now, concealed for the capture that came after it", async () => {
	slow.add(two);
	assert.equal(await clickThenShot(two), false, "the late show drew the veil unconcealed during the capture");
	assert.deepEqual(page(two), { veil: true, concealed: false }, "the veil is not back after the screenshot");
});
