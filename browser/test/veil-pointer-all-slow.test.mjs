// first-F1 of PR 219's review: after a worker restart every storage read is slow, not only the pointer setting's. The
// first show gives up on the setting, then waits on its theme past EFFECT_TIMEOUT_MS (1.5 s, src/browser/veil.ts). The
// setting settles while it waits and is sent to the open veil; the late show must not then draw the character off
// again with the value it read before. Fake chrome.
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
// Every read is slow. The theme's (an array of keys) takes 2.5 s; the pointer setting's settles 1.8 s after the theme
// read began, so after the show ran out of time and before its theme came back.
let themeAsked;
const themeStarted = new Promise((r) => {
	themeAsked = r;
});
const local = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
	if (keys === "veil_pointer") await themeStarted.then(() => sleep(1_800));
	else if (Array.isArray(keys)) {
		themeAsked();
		await sleep(2_500);
	} else await sleep(300);
	return local.call(chrome.storage.local, keys);
};
const session = chrome.storage.session.get;
chrome.storage.session.get = async (keys) => {
	await sleep(300);
	return session.call(chrome.storage.session, keys);
};
const { startVeil, veilBegin, veilEnd } = await import("../src/browser/veil.ts");
startVeil();

test("first-F1 (PR 219's review): with every storage read slow, the late show leaves the character on once the setting is read", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/" });
	const s = { id: "bridge-claude-shop", tabIds: [tabId], currentTabId: tabId, ended: false, record: { label: "claude", color: "blue" } };
	veilEnd(s, "click", await veilBegin(s, "click", { tabId }));
	await sleep(6_000);
	const withPointer = injected.filter((i) => i.tabId === tabId && "pointer" in i.cmd);
	const ops = JSON.stringify(withPointer.map((i) => [i.cmd.op, i.cmd.pointer]));
	assert.ok(withPointer.some((i) => i.cmd.op === "show"), `the late show never drew: ${ops}`);
	assert.ok(withPointer.some((i) => i.cmd.op === "set" && i.cmd.pointer === true), `the setting never reached the veil: ${ops}`);
	assert.equal(withPointer.at(-1).cmd.pointer, true, `the last word to the page turned the character off: ${ops}`);
});
