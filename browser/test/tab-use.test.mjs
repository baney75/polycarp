// Which tab a call acts on (src/browser/tab-use.ts, docs/decisions.md D48): the veil and the dialog guard count only those.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callTab, movedTo } from "../src/browser/tab-use.ts";

const session = { tabIds: [1, 2, 3], currentTabId: 1 };

test("the tab a call acts on: the one it names, else the current tab; tabs_create and non-tab calls act on none", () => {
	assert.equal(callTab(session, "click", { tabId: 3 }), 3);
	assert.equal(callTab(session, "click", {}), 1);
	assert.equal(callTab(session, "click", undefined), 1);
	// A tab the session doesn't own is never counted, and the current tab doesn't stand in for it.
	assert.equal(callTab(session, "click", { tabId: 99 }), undefined);
	assert.equal(callTab(session, "tabs.create", { url: "https://example.com" }), undefined);
	for (const method of ["status", "tabs.context", "tabs.close", "tabs.select", "tabs.release"])
		assert.equal(callTab(session, method, {}), undefined, method);
});

test("a call counts on the tab it moved the session to, never on a current tab it left alone", () => {
	// navigate or tabs_create opened tab 3.
	assert.equal(movedTo({ tabIds: [1, 3], currentTabId: 3 }, 1, 1), 3);
	assert.equal(movedTo({ tabIds: [3], currentTabId: 3 }, undefined, undefined), 3);
	// A click on tab 2 by id while tab 1 stayed current: tab 1 was not used.
	assert.equal(movedTo({ tabIds: [1, 2], currentTabId: 1 }, 1, 2), undefined);
	// The call made its own tab current: nothing more.
	assert.equal(movedTo({ tabIds: [1, 2], currentTabId: 2 }, 1, 2), undefined);
	// A current tab the session no longer owns.
	assert.equal(movedTo({ tabIds: [1], currentTabId: 5 }, 1, 1), undefined);
});
