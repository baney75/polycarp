/**
 * A dialog on a tab no one is using is answered Cancel (service worker; docs/decisions.md, D46).
 *
 * Chrome itself cancels an alert, confirm or prompt that a hidden tab opens. With Polycarp's
 * debugger attached it waits for an answer instead (cdp.ts turns on Page events to report it), and
 * while it waits the page's renderer process is stopped. Chrome often runs tabs of the same site in
 * one process, so one agent tab's unanswered box froze every other tab on that site, the user's
 * included. A box stays open only while its tab is in use (tab-use.ts) or in front of the user;
 * after that it gets Cancel, Chrome's own answer, and the agent hears so on its next call.
 */

import { answerDialog, openDialog, type PageDialog, watchDialogs } from "./cdp.js";
import { addNotice, sessionOwningTab } from "./session.js";
import { callTab, inUseUntil, movedTo, TAB_METHODS, type TabUses, useBegin, useDrop, useEnd } from "./tab-use.js";

let uses: TabUses = {};
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/** Boxes this guard answered, by tab, so handle_dialog can say what became of one. */
const cancelled = new Map<number, { dialog: PageDialog; at: number }>();
let started = false;
let log: (line: string) => void = () => undefined;

/** Tests shorten the window through the worker's global. */
function idleMs(): number | undefined {
	const override = (globalThis as { __POLYCARP_IN_USE_MS?: number }).__POLYCARP_IN_USE_MS;
	return typeof override === "number" && override > 0 ? override : undefined;
}

function dialogWord(dialog: PageDialog): string {
	return dialog.type === "beforeunload" ? "leave-page" : dialog.type;
}

async function consider(tabId: number): Promise<void> {
	clearTimeout(timers.get(tabId));
	timers.delete(tabId);
	const dialog = openDialog(tabId);
	if (!dialog) return;
	const until = inUseUntil(uses, tabId, idleMs());
	// A call on the tab is running: its end looks again.
	if (until === Number.POSITIVE_INFINITY) return;
	const wait = (until ?? 0) - Date.now();
	if (wait > 0) {
		timers.set(
			tabId,
			setTimeout(() => void consider(tabId).catch(() => undefined), wait + 20),
		);
		return;
	}
	// The user can see this one and answer it, as on any page.
	const tab = await chrome.tabs.get(tabId).catch(() => undefined);
	if (!tab || tab.active) return;
	if (openDialog(tabId) !== dialog) return;
	await answerDialog(tabId, false);
	cancelled.set(tabId, { dialog, at: Date.now() });
	log(`dialog-guard: tab=${tabId} ${dialog.type} answered Cancel (tab not in use)`);
	const owner = await sessionOwningTab(tabId);
	if (owner)
		await addNotice(
			owner.id,
			`A ${dialogWord(dialog)} dialog on tab ${tabId} (${JSON.stringify(dialog.message)}) was answered Cancel, because no call used that tab for a while. An open dialog stops every tab of that site, the user's too.`,
		);
}

export interface CallUse {
	method: string;
	/** The tab the call acts on, if any. */
	tabId?: number;
	/** The session's current tab when the call began. */
	currentBefore?: number;
}

/** A call on a session's tab is about to run. Give what it returns to `dialogUseEnd`. */
export function dialogUseBegin(
	session: { tabIds: readonly number[]; currentTabId?: number },
	method: string,
	params: Record<string, unknown> | undefined,
): CallUse {
	const tabId = callTab(session, method, params);
	if (tabId !== undefined) uses = useBegin(uses, tabId, Date.now());
	return { method, tabId, currentBefore: session.currentTabId };
}

/** The call ended: counted on the tab it began on, and on the tab it moved the session to. */
export function dialogUseEnd(session: { tabIds: readonly number[]; currentTabId?: number }, call: CallUse): void {
	if (!TAB_METHODS.has(call.method)) return;
	const at = Date.now();
	for (const tabId of [call.tabId, movedTo(session, call.currentBefore, call.tabId)]) {
		if (tabId === undefined) continue;
		uses = useEnd(uses, tabId, at);
		void consider(tabId).catch(() => undefined);
	}
}

/** What handle_dialog says when the box it was asked about was answered here. */
export function cancelledDialog(tabIds: readonly number[]): string | undefined {
	for (const tabId of tabIds) {
		const c = cancelled.get(tabId);
		if (c && Date.now() - c.at < 10 * 60_000)
			return `The ${dialogWord(c.dialog)} dialog on tab ${tabId} (${JSON.stringify(c.dialog.message)}) was already answered Cancel, because no call used that tab for a while.`;
	}
	return undefined;
}

/** Wire the listeners. Call once per worker start. */
export function startDialogGuard(logger?: (line: string) => void): void {
	if (logger) log = logger;
	if (started) return;
	started = true;
	watchDialogs((tabId) => {
		cancelled.delete(tabId);
		void consider(tabId).catch(() => undefined);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		uses = useDrop(uses, tabId);
		cancelled.delete(tabId);
		clearTimeout(timers.get(tabId));
		timers.delete(tabId);
	});
	// The user switched away from a tab whose box they left open: it is hidden now.
	chrome.tabs.onActivated.addListener(({ tabId: shown, windowId }) => {
		void chrome.tabs
			.query({ windowId })
			.then((tabs) => {
				for (const t of tabs) if (t.id !== undefined && t.id !== shown && openDialog(t.id)) void consider(t.id);
			})
			.catch(() => undefined);
	});
}
