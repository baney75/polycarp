// browserjs() on the provider side (src/tools/repl/runtime-providers.ts): a script whose result does not come back
// is an error the agent sees, never success with nothing in it, which browserjs() returns as a silent undefined
// (second-F7 of the review of PR 260). Fake chrome with no userScripts, so injectScript takes the debugger path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
// The router listens for sandbox messages on window, as in the panel.
globalThis.window ??= Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
delete chrome.userScripts;
const plain = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	// The page answers with no value: a result that was lost on its way back.
	if (method === "Runtime.evaluate") return { result: {} };
	if (method === "Runtime.enable" || method === "Runtime.addBinding") return {};
	return plain.call(chrome.debugger, target, method, params);
};
const { setAppStorage } = await import("@mariozechner/pi-web-ui");
const { setCurrentBrowserSession } = await import("../src/browser/current.ts");
const { BrowserJsRuntimeProvider } = await import("../src/tools/repl/runtime-providers.ts");
setAppStorage({ skills: { getSkillsForUrl: async () => [] } });
const tab = await chrome.tabs.create({ url: "https://shop.example.com/" });
setCurrentBrowserSession({ id: "s1", requireCurrentTab: async () => ({ id: tab.id, url: "https://shop.example.com/" }) });

test("second-F7 (review of PR 260): a result that never came back is success false, so browserjs() throws", async () => {
	const said = await new Promise((respond) => {
		void new BrowserJsRuntimeProvider([]).handleMessage({ type: "browser-js", code: "() => 1 + 1", args: "[]" }, respond);
	});
	assert.equal(said.success, false, JSON.stringify(said));
	assert.match(said.error, /did not come back from the page.*read_page/);
});
