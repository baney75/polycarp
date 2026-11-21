// A click whose last input is out and a dialog opens: success only if the dialog opened on the tab
// the click went to. A dialog on another tab of the session is not the click's doing.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

installFakeChrome();
const noEvent = () => ({ addListener() {}, removeListener() {} });
chrome.tabs.onActivated ??= noEvent();
chrome.webNavigation ??= {};
chrome.webNavigation.onCommitted ??= noEvent();
const { installCdpListeners } = await import("../src/browser/cdp.ts");
const { raceDialogs } = await import("../src/bridge/dialogs.ts");
installCdpListeners();

const session = { tabIds: [1, 2] };
const open = (tabId, message) => {
	for (const fn of chrome.debugger.onEvent.listeners) fn({ tabId }, "Page.javascriptDialogOpening", { type: "alert", message });
};
const pending = () => new Promise(() => {});

test("a dialog on the tab the click went to is the click's effect: success with a note", async () => {
	const race = raceDialogs(session, pending(), () => {}, () => ({ result: { clicked: { x: 1, y: 2 } }, tabId: 1 }));
	open(1, "Really delete?");
	const result = await race;
	assert.deepEqual(result.clicked, { x: 1, y: 2 });
	assert.equal(result.dialog.tabId, 1);
	assert.match(result.note, /handle_dialog/);
});

test("a dialog on another tab of the session while the click is in flight still fails with dialog_open", async () => {
	let aborted = false;
	const race = raceDialogs(session, pending(), () => { aborted = true; }, () => ({ result: { clicked: { x: 1, y: 2 } }, tabId: 1 }));
	open(2, "Timer fired on tab 2");
	await assert.rejects(race, (err) => err.code === "dialog_open" && /tab 2/.test(err.message) && /Timer fired/.test(err.message));
	assert.equal(aborted, true);
});

test("without a delivered input any dialog fails the call", async () => {
	const race = raceDialogs(session, pending(), () => {}, () => undefined);
	open(1, "x");
	await assert.rejects(race, (err) => err.code === "dialog_open");
});
