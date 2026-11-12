// handle_dialog answers the box it was called for, by identity (docs/decisions.md D46): fake chrome, real cdp events.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const { installCdpListeners, openDialog } = await import("../src/browser/cdp.ts");
const { dialogAnswerArrive } = await import("../src/browser/dialog-guard.ts");
const { handlers } = await import("../src/bridge/tools.ts");
installCdpListeners();

const event = (tabId, method, params) => {
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, method, params);
};
const sent = [];
const send = chrome.debugger.sendCommand;
chrome.debugger.sendCommand = async (target, method, params) => {
	if (method === "Page.handleJavaScriptDialog") sent.push({ tabId: target.tabId, ...params });
	return send.call(chrome.debugger, target, method, params);
};
const session = { id: "bridge-claude-shop", tabIds: [7], currentTabId: 7 };

test("sol-F2: a call for a box that closed while it waited never answers the next box on that tab", async () => {
	event(7, "Page.javascriptDialogOpening", { type: "confirm", message: "Delete this record?", url: "https://shop.example.com/" });
	const answer = dialogAnswerArrive(session.id, session.tabIds, 7);
	assert.ok(answer.target, "the call found its box on arrival");
	// While the call waits its turn, the person answers the first box and the page opens another.
	event(7, "Page.javascriptDialogClosed", { result: true });
	event(7, "Page.javascriptDialogOpening", { type: "confirm", message: "Also delete the backups?", url: "https://shop.example.com/" });
	await assert.rejects(
		handlers.dialog({ session, dialogAnswer: answer }, { accept: true, tabId: 7 }),
		(err) => /The dialog this call was for on tab 7 is gone\. Open now: tab 7: "Also delete the backups\?"/.test(err.message),
	);
	assert.deepEqual(sent, [], "OK went to a box the agent never saw");
	assert.equal(openDialog(7)?.message, "Also delete the backups?");
	// A fresh call for the box that is open now answers it.
	const again = await handlers.dialog({ session }, { accept: false, tabId: 7 });
	assert.equal(again.message, "Also delete the backups?");
	assert.deepEqual(sent, [{ tabId: 7, accept: false }]);
});
