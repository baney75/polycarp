// Capture markers in session storage tell a worker restart from a first call. Tabs that start
// capture at the same moment must each keep theirs (one shared object would lose all but the last).
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
// What cdp.ts's listeners need and the fake lacks.
const noEvent = () => ({ addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= noEvent();
chrome.webNavigation ??= {};
chrome.webNavigation.onCommitted ??= noEvent();
const { startCapture } = await import("../src/browser/cdp.ts");

const keys = async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith("capture_tab:")).sort();

test("tabs starting capture at once each keep their marker", async () => {
	const tabs = [201, 202, 203, 204, 205];
	assert.deepEqual(await Promise.all(tabs.map((id) => startCapture(id))), tabs.map(() => undefined));
	assert.deepEqual(
		await keys(),
		tabs.flatMap((id) => [`capture_tab:${id}:console`, `capture_tab:${id}:network`]),
	);
});

test("closing one tab removes only its markers", async () => {
	for (const fn of chrome.tabs.onRemoved.listeners) fn(202);
	await new Promise((r) => setTimeout(r, 50));
	const left = await keys();
	assert.ok(!left.some((k) => k.startsWith("capture_tab:202:")));
	assert.equal(left.length, 8);
});
