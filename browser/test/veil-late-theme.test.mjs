// Review of PR 204: a show that runs past its EFFECT_TIMEOUT_MS (src/browser/veil.ts) must never draw what it was queued
// with. first-F1: after a worker restart the theme's storage read is as slow as the pointer setting's, so the show
// must decide what to draw after its last wait, not before it. second-S2: a late show must not draw over a newer one.
// Fake chrome, with a page that keeps what it shows; each capture takes 800 ms.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const pages = new Map();
const page = (tabId) => pages.get(tabId) ?? pages.set(tabId, { veil: false, concealed: false, agent: undefined }).get(tabId);
chrome.scripting = {
	async executeScript({ target, args: [cmd] }) {
		const p = page(target.tabId);
		if (cmd.op === "show") {
			Object.assign(p, { veil: true, concealed: cmd.concealed === true, agent: cmd.agent });
			return [{ result: { tag: cmd.tag } }];
		}
		if (cmd.op === "hide") p.veil = false;
		if (cmd.op === "set" && p.veil && typeof cmd.concealed === "boolean") p.concealed = cmd.concealed;
		return [{ result: p.veil ? { tag: "t" } : {} }];
	},
};
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
await chrome.storage.local.set({ veil_pointer: true });
await new Promise((r) => setTimeout(r, 50));
// After a worker restart, the theme's read (an array of keys) is slower than the veil's 1.5 s, once.
let slowTheme = true;
const get = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (Array.isArray(keys) && slowTheme) {
		slowTheme = false;
		await new Promise((r) => setTimeout(r, 2_000));
	}
	return get.call(chrome.storage.local, keys);
};
/** Tabs whose next chrome.tabs.get is slow (a loaded browser). */
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

test("first-F1: a show whose theme read outlasts its time never draws the veil unconcealed during the capture", async () => {
	const t0 = performance.now();
	seen = false;
	veilEnd(session, "click", await veilBegin(session, "click", { tabId: one }));
	await captureScreenshot(one, { maxWidth: 800 }).catch(() => undefined);
	assert.equal(seen, false, "the veil was drawn unconcealed while the screenshot was taken");
	await new Promise((r) => setTimeout(r, Math.max(0, 2_600 - (performance.now() - t0))));
	assert.deepEqual({ ...page(one), agent: undefined }, { veil: true, concealed: false, agent: undefined }, "the veil is not back after the screenshot");
});

test("second-S2: a late show does not draw over the newer one queued after it", async () => {
	// The first show waits on the browser past its time; meanwhile another agent's call takes the tab.
	slow.add(two);
	veilEnd(session, "click", await veilBegin(session, "click", { tabId: two }));
	const other = { ...session, id: "bridge-codex-shop", record: { label: "codex", color: "green" } };
	veilEnd(other, "click", await veilBegin(other, "click", { tabId: two }));
	await new Promise((r) => setTimeout(r, 2_600));
	assert.equal(page(two).agent, "Codex", "the late show drew the earlier agent's pill over the newer one");
});
