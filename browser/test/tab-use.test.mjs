// Which tabs a session is using (src/browser/tab-use.ts, docs/decisions.md D46): only those may hold the user up,
// by the veil or by a dialog left open for the agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callTab, IN_USE_MS, inUse, inUseUntil, movedTo, useBegin, useDrop, useEnd } from "../src/browser/tab-use.ts";
import { VEIL_IDLE_MS } from "../src/browser/veil-state.ts";

const session = { tabIds: [1, 2, 3], currentTabId: 1 };

test("in use while a call runs and for the veil's idle window after it ends, then not", () => {
	assert.equal(IN_USE_MS, VEIL_IDLE_MS);
	let u = useBegin({}, 2, 1000);
	assert.equal(inUseUntil(u, 2), Number.POSITIVE_INFINITY);
	assert.ok(inUse(u, 2, 10 ** 9), "a running call ends nothing");
	u = useEnd(u, 2, 3000);
	assert.equal(inUseUntil(u, 2), 3000 + IN_USE_MS);
	assert.ok(inUse(u, 2, 3000 + IN_USE_MS - 1));
	assert.equal(inUse(u, 2, 3000 + IN_USE_MS), false);
	assert.equal(inUse(useDrop(u, 2), 2, 3001), false);
});

test("a tab no call used is not in use, whatever group it sits in", () => {
	const u = useEnd(useBegin({}, 2, 0), 2, 10);
	assert.equal(inUseUntil(u, 1), undefined);
	assert.equal(inUse(u, 1, 11), false);
	assert.equal(inUse(u, 3, 11), false);
});

test("two calls overlap: the tab stays in use until the last one ends", () => {
	let u = useBegin(useBegin({}, 1, 0), 1, 5);
	u = useEnd(u, 1, 10);
	assert.equal(inUseUntil(u, 1), Number.POSITIVE_INFINITY);
	u = useEnd(u, 1, 20);
	assert.equal(inUseUntil(u, 1, 100), 120);
	// An end with no begin (the navigate that opened the tab) counts as a use and never goes below zero.
	assert.equal(inUseUntil(useEnd({}, 9, 50), 9, 100), 150);
});

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
