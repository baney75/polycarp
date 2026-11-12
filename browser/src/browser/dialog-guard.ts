/**
 * A dialog on an agent's tab is answered Cancel only when it freezes the person (service worker;
 * docs/decisions.md, D46).
 *
 * Chrome itself cancels an alert, confirm or prompt that a hidden tab opens. With Polycarp's
 * debugger attached it waits for the agent's answer instead (cdp.ts turns on Page events), and while
 * it waits the page's renderer process runs nothing. Chrome runs tabs of one site in one process, so
 * the box froze the person's own tabs of that site. Which tabs share a process can't be read from an
 * extension; the same site is the proxy. The box stays open for the agent, with no timer, unless:
 * - one of the person's tabs on that site is in front of them (active in its window): Cancel after
 *   GRACE_MS;
 * - the person has a tab on that site that is not in front: Cancel once the box has been open OPEN_MS.
 * Never while a call on the tab runs (handle_dialog wins), and a pending ask_user from the session
 * puts the box under the second rule only. The agent hears once what happened.
 */

import { answerDialog, openDialog, type PageDialog, watchDialogs } from "./cdp.js";
import { addNotice, dropNotice, isAgentSession, listSessions } from "./session.js";
import { callTab } from "./tab-use.js";

export const GRACE_MS = 3_000;
export const OPEN_MS = 60_000;
const TOLD_MS = 10 * 60_000;

/**
 * The site a URL belongs to: its registrable domain, approximated without the public suffix list
 * (the last two labels, three under a two-letter country code with a short second level such as
 * co.uk). It errs toward one site for a shared host like github.io, which only cancels sooner.
 */
export function siteOf(url: string | undefined): string | undefined {
	let host: string;
	try {
		const u = new URL(url ?? "");
		if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
		host = u.hostname;
	} catch {
		return undefined;
	}
	if (!host.includes(".") || /^[\d.]+$|[[:]/.test(host)) return host;
	const parts = host.split(".");
	const cc = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3;
	return parts.slice(cc ? -3 : -2).join(".");
}

/** What decides a box: undefined holds it (no timer), else when to answer Cancel and why. */
export function dialogVerdict(
	f: {
		openedAt: number;
		busy: boolean;
		/** The person's tabs on the box's site: tabs in no agent's group. */
		personTabs: number;
		/** Since when one of them has been in front of the person. */
		shownSince?: number;
		asking: boolean;
	},
	grace = GRACE_MS,
	open = OPEN_MS,
): { at: number; why: "using" | "open" } | undefined {
	if (f.busy || f.personTabs === 0) return undefined;
	if (f.shownSince !== undefined && !f.asking) return { at: f.shownSince + grace, why: "using" };
	return { at: f.openedAt + open, why: "open" };
}

type Tab = { id?: number; url?: string; pendingUrl?: string; active: boolean };

/** What the guard reads and does; tests swap these. */
export const deps = {
	openDialog: (tabId: number): PageDialog | undefined => openDialog(tabId),
	cancel: (tabId: number): Promise<unknown> => answerDialog(tabId, false),
	tabs: (): Promise<Tab[]> => chrome.tabs.query({}),
	/** Tab id to the id of the session that owns it. */
	owners: async (): Promise<Map<number, string>> =>
		new Map((await listSessions()).flatMap((s) => s.tabIds.map((t) => [t, s.id] as [number, string]))),
	notice: addNotice,
	unnotice: dropNotice,
	log: (_line: string): void => undefined,
	grace: () => GRACE_MS,
	open: () => OPEN_MS,
};

const busy = new Map<number, number>();
/** Calls that open a tab (tabs_create, a first navigate), by session: their new tab is busy too. */
const opening = new Map<string, number>();
const asks = new Map<string, number>();
const opened = new Map<number, number>();
const shown = new Map<number, number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const cancelled = new Map<number, { owner: string; text: string; at: number }>();

const bump = (m: Map<string | number, number>, key: string | number, by: number) => {
	const n = (m.get(key) ?? 0) + by;
	if (n > 0) m.set(key, n);
	else m.delete(key);
};

function isBusy(tabId: number, owner: string): boolean {
	return (busy.get(tabId) ?? 0) > 0 || (opening.get(owner) ?? 0) > 0;
}

export async function consider(tabId: number): Promise<void> {
	clearTimeout(timers.get(tabId));
	timers.delete(tabId);
	const dialog = deps.openDialog(tabId);
	if (!dialog) {
		opened.delete(tabId);
		shown.delete(tabId);
		return;
	}
	const [tabs, owners] = await Promise.all([deps.tabs(), deps.owners()]);
	const owner = owners.get(tabId);
	// Everything below is read after the await, with no await before Cancel: a call that began
	// meanwhile (handle_dialog) wins. A tab no session owns yet is one a call is opening.
	if (owner === undefined || deps.openDialog(tabId) !== dialog) return;
	const site = siteOf(dialog.url || tabs.find((t) => t.id === tabId)?.url);
	const person = tabs.filter((t) => {
		if (t.id === undefined || t.id === tabId || siteOf(t.url || t.pendingUrl) !== site || !site) return false;
		const o = owners.get(t.id);
		return o === undefined || !isAgentSession(o);
	});
	const now = Date.now();
	if (!person.some((t) => t.active)) shown.delete(tabId);
	else if (!shown.has(tabId)) shown.set(tabId, now);
	const openedAt = opened.get(tabId) ?? now;
	opened.set(tabId, openedAt);
	const v = dialogVerdict(
		{
			openedAt,
			busy: isBusy(tabId, owner),
			personTabs: person.length,
			shownSince: shown.get(tabId),
			asking: (asks.get(owner) ?? 0) > 0,
		},
		deps.grace(),
		deps.open(),
	);
	if (!v) return;
	const at = v.at;
	if (at > now) {
		timers.set(
			tabId,
			setTimeout(() => void consider(tabId).catch(() => undefined), at - now + 20),
		);
		return;
	}
	await deps.cancel(tabId);
	const why = v.why === "using" ? `the person was using a tab on ${site}` : `the person has a tab open on ${site}`;
	const text = `The ${dialog.type === "beforeunload" ? "leave-page" : dialog.type} dialog on tab ${tabId} (${JSON.stringify(dialog.message)}) was cancelled, because ${why} and an open dialog freezes every tab of that site. The page saw Cancel. Do the action again when you are ready to answer its dialog at once.`;
	cancelled.set(tabId, { owner, text, at: Date.now() });
	deps.log(`dialog-guard: tab=${tabId} ${dialog.type} answered Cancel (${v.why})`);
	await deps.notice(owner, text);
}

/** A page opened a box: its clock starts now. */
export function dialogOpened(tabId: number): void {
	cancelled.delete(tabId);
	opened.set(tabId, Date.now());
	shown.delete(tabId);
	void consider(tabId).catch(() => undefined);
}

function considerAll(): void {
	for (const tabId of opened.keys()) void consider(tabId).catch(() => undefined);
}

export interface CallUse {
	/** The tab the call counted as busy. */
	tabId?: number;
	/** The session whose call opens a tab. */
	opening?: string;
}

/** A call on a session's tab is about to run. Give what it returns to `dialogUseEnd`. */
export function dialogUseBegin(
	session: { id: string; tabIds: readonly number[]; currentTabId?: number },
	method: string,
	params: Record<string, unknown> | undefined,
): CallUse {
	const tabId = callTab(session, method, params);
	if (tabId !== undefined) {
		bump(busy, tabId, 1);
		return { tabId };
	}
	if (method === "tabs.create" || method === "navigate") {
		bump(opening, session.id, 1);
		return { opening: session.id };
	}
	return {};
}

/** The call ended: undo exactly what its begin counted, then look at the boxes again. */
export function dialogUseEnd(call: CallUse): void {
	if (call.tabId !== undefined) {
		bump(busy, call.tabId, -1);
		void consider(call.tabId).catch(() => undefined);
	}
	if (call.opening !== undefined) {
		bump(opening, call.opening, -1);
		considerAll();
	}
}

/** An ask_user from the session is waiting for the person, or no longer is. */
export function dialogAsk(sessionId: string, on: boolean): void {
	bump(asks, sessionId, on ? 1 : -1);
	if (!on) considerAll();
}

/**
 * What handle_dialog says when the box it was asked about was cancelled here: the notice once, if
 * tabs_context or session_info hasn't already told it, and never again.
 */
export async function cancelledDialog(tabIds: readonly number[]): Promise<string | undefined> {
	for (const tabId of tabIds) {
		const c = cancelled.get(tabId);
		if (!c) continue;
		cancelled.delete(tabId);
		if (Date.now() - c.at < TOLD_MS && (await deps.unnotice(c.owner, c.text))) return c.text;
	}
	return undefined;
}

/** A tab's id changed (prerender, instant pages): its counts and box go with it. */
function replaced(from: number, to: number): void {
	for (const m of [busy, opened, shown, cancelled] as Map<number, unknown>[])
		if (m.has(from)) {
			m.set(to, m.get(from));
			m.delete(from);
		}
	clearTimeout(timers.get(from));
	timers.delete(from);
	void consider(to).catch(() => undefined);
}

function forget(tabId: number): void {
	for (const m of [busy, opened, shown, cancelled]) m.delete(tabId);
	clearTimeout(timers.get(tabId));
	timers.delete(tabId);
}

/** @internal Tests start each case from nothing. */
export function resetDialogGuard(): void {
	for (const tabId of [...timers.keys()]) forget(tabId);
	for (const m of [busy, opening, asks, opened, shown, cancelled] as Map<unknown, unknown>[]) m.clear();
}

let started = false;

/** Wire the listeners. Call once per worker start. */
export function startDialogGuard(logger?: (line: string) => void): void {
	if (logger) deps.log = logger;
	const override = (name: string, fallback: number) => () => {
		const v = (globalThis as Record<string, unknown>)[name];
		return typeof v === "number" && v > 0 ? v : fallback;
	};
	// Tests shorten the waits through the worker's globals.
	deps.grace = override("__POLYCARP_DIALOG_GRACE_MS", GRACE_MS);
	deps.open = override("__POLYCARP_DIALOG_OPEN_MS", OPEN_MS);
	if (started) return;
	started = true;
	watchDialogs(dialogOpened);
	chrome.tabs.onRemoved.addListener(forget);
	chrome.webNavigation.onTabReplaced.addListener(({ replacedTabId, tabId }) => replaced(replacedTabId, tabId));
	// The person brings a tab of the site to the front, opens or loads one, or comes back to a window.
	chrome.tabs.onActivated.addListener(considerAll);
	chrome.tabs.onUpdated.addListener((_id, change) => {
		if (change.url || change.status) considerAll();
	});
	chrome.windows.onFocusChanged.addListener(considerAll);
}
