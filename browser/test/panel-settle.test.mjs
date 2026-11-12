// The side panel's page tools run the bridge's own handlers (src/bridge/panel-calls.ts), so an act call
// waits for the page to settle (D41) as an MCP call does. One fake browser for the whole file: settle's
// listener is installed once per process.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const fake = installFakeChrome();
const ev = () => ({ listeners: [], addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= ev();
chrome.webNavigation.onCommitted ??= ev();
const { runPanelCall } = await import("../src/bridge/panel-calls.ts");
const { handlers } = await import("../src/bridge/tools.ts");

function recordCommands(answer) {
	const send = chrome.debugger.sendCommand;
	chrome.debugger.sendCommand = async (target, method, params) => (await answer(method, params)) ?? send(target, method, params);
}

test("the side panel's act calls settle too: a key that starts a fetch returns after it", async () => {
	const tabId = fake.addTab({ url: "https://shop.example.com/", status: "complete" });
	const tab = async () => chrome.tabs.get(tabId);
	const session = { id: "s1", groupName: "Polycarp", tabIds: [tabId], currentTabId: tabId, currentTab: tab, setCurrent() {}, requireCurrentTab: tab, attachedCurrentTab: tab };
	const event = (method, params) => {
		for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, method, params);
	};
	recordCommands((method, params) => {
		if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown") {
			event("Network.requestWillBeSent", { requestId: "r1", type: "Fetch", frameId: "f", loaderId: "l" });
			setTimeout(() => event("Network.loadingFinished", { requestId: "r1" }), 600);
		}
		return undefined;
	});
	const t0 = Date.now();
	const result = await runPanelCall({ session, handlers, openDialog: () => undefined }, "press", { key: "a" });
	assert.equal(result.pressed, "a");
	assert.ok(Date.now() - t0 >= 550, `returned after ${Date.now() - t0} ms, before the fetch ended`);
});
