// second-G3 (review of #184): a key press cues the pointer after its key events, so a Tab or an Enter that moves focus
// sends the character to where focus is now. Fake chrome, the real cdp input path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const log = [];
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Input.dispatchKeyEvent") log.push(`${params.type} ${params.key}`);
	return send.call(chrome.debugger, target, method, params);
};
const { pressKey, setPointerCue } = await import("../src/browser/cdp.ts");
setPointerCue((_tabId, cue) => log.push(`cue ${cue.action}`));

test("second-G3: press cues the pointer after the key is up", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/" });
	await pressKey(tabId, "Tab");
	assert.equal(log.at(-1), "cue press", log.join(", "));
	assert.ok(log.indexOf("keyUp Tab") < log.indexOf("cue press"), log.join(", "));
});
