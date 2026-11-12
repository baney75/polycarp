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

import { registrableDomain } from "../site-edits/store.js";
import { answerDialog, cdpMemoryReady, dialogTabs, openDialog, type PageDialog, watchDialogs } from "./cdp.js";
import { addNotice, dropNotice, isAgentSession, listSessions } from "./session.js";
import { callTab } from "./tab-use.js";

export const GRACE_MS = 3_000;
export const OPEN_MS = 60_000;
const TOLD_MS = 10 * 60_000;

/**
 * The site a URL belongs to: its registrable domain by the Public Suffix List (src/site-edits/public-suffixes.ts), the
 * grouping Chrome puts in one process; an IP address or a one-label host is its own site.
 */
export function siteOf(url: string | undefined): string | undefined {
	let host: string;
	try {
		const u = new URL(url ?? "");
		if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
		host = u.hostname.replace(/\.$/, "");
	} catch {
		return undefined;
	}
	if (!host.includes(".") || /^[\d.]+$|[[:]/.test(host)) return host;
	return registrableDomain(host);
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
	/** The tabs with a box open once an earlier worker's memory is back. */
	restored: async (): Promise<number[]> => {
		await cdpMemoryReady();
		return dialogTabs();
	},
	notice: addNotice,
	unnotice: dropNotice,
	log: (_line: string): void => undefined,
	grace: () => GRACE_MS,
	open: () => OPEN_MS,
};

/**
 * A call in flight, from the moment it is taken off the wire. It holds the boxes on `holds`: every tab of its session
 * until it knows its tab (and while it opens one: tabs_create, a first navigate), then that one tab, which a tab
 * replacement rewrites. Ending it removes exactly this call.
 */
export interface CallUse {
	session: string;
	holds: "session" | number | undefined;
	/** handle_dialog's box, resolved once: the tab it answers, or why it answers none. */
	dialog?: DialogTarget;
}

export type DialogTarget =
	| { tabId: number }
	| { refuse: "none" | "cancelled" | "several"; tabId?: number; open: number[] };

const uses = new Set<CallUse>();
const asks = new Map<string, number>();
const opened = new Map<number, number>();
const shown = new Map<number, number>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const cancelled = new Map<number, { owner: string; text: string; at: number }>();

/** The guard cancelled this tab's box in the last TOLD_MS and the agent has not asked about it since. */
const wasCancelled = (tabId: number) => Date.now() - (cancelled.get(tabId)?.at ?? -Infinity) < TOLD_MS;

function isBusy(tabId: number, owner: string): boolean {
	for (const u of uses) if (u.holds === tabId || (u.holds === "session" && u.session === owner)) return true;
	return false;
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
		clearTimeout(timers.get(tabId));
		timers.set(
			tabId,
			setTimeout(() => void consider(tabId).catch(() => undefined), at - now + 20),
		);
		return;
	}
	const why = v.why === "using" ? `the person was using a tab on ${site}` : `the person has a tab open on ${site}`;
	const text = `The ${dialog.type === "beforeunload" ? "leave-page" : dialog.type} dialog on tab ${tabId} (${JSON.stringify(dialog.message)}) was cancelled, because ${why} and an open dialog freezes every tab of that site. The page saw Cancel. Do the action again when you are ready to answer its dialog at once.`;
	// Recorded first: from here handle_dialog refuses this box rather than race the Cancel.
	cancelled.set(tabId, { owner, text, at: Date.now() });
	await deps.cancel(tabId);
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

let pendingAll: ReturnType<typeof setTimeout> | undefined;
/** Look at every box again, once per burst of tab events. */
function considerAll(): void {
	clearTimeout(pendingAll);
	pendingAll = setTimeout(() => {
		for (const tabId of opened.keys()) void consider(tabId).catch(() => undefined);
	}, 50);
}

/** After a worker restart: boxes an earlier worker kept get a clock from now, then a look. */
export async function restoreDialogs(): Promise<void> {
	for (const tabId of await deps.restored()) if (!opened.has(tabId)) opened.set(tabId, Date.now());
	considerAll();
}

/** A call was taken off the wire for this session: until it ends it holds every box of the session. */
export function dialogArrive(sessionId: string): CallUse {
	const use: CallUse = { session: sessionId, holds: "session" };
	uses.add(use);
	return use;
}

/**
 * Which box handle_dialog answers, decided once from what is open now: the tab it names; with none, the one box open on
 * the session's tabs. Never a guess: with several open, or after the guard cancelled one, it answers none.
 */
export function dialogTarget(tabIds: readonly number[], requested: number | undefined): DialogTarget {
	const open = tabIds.filter((id) => deps.openDialog(id) !== undefined && !wasCancelled(id));
	if (requested !== undefined)
		return open.includes(requested)
			? { tabId: requested }
			: { refuse: wasCancelled(requested) ? "cancelled" : "none", tabId: requested, open };
	const gone = tabIds.find(wasCancelled);
	if (gone !== undefined) return { refuse: "cancelled", tabId: gone, open };
	if (open.length === 1) return { tabId: open[0] };
	return { refuse: open.length > 1 ? "several" : "none", open };
}

/**
 * The call knows its session: from here it holds only the tab it acts on (for handle_dialog, its resolved box), or the
 * session's boxes while it opens a tab. No await may come between this and the handler reading `use.dialog`.
 */
export function dialogUseBegin(
	use: CallUse,
	session: { id: string; tabIds: readonly number[]; currentTabId?: number },
	method: string,
	params: Record<string, unknown> | undefined,
): CallUse {
	use.session = session.id;
	if (method === "dialog") {
		const asked = params?.tabId === undefined ? undefined : Number(params.tabId);
		use.dialog = dialogTarget(session.tabIds, asked);
		use.holds = "refuse" in use.dialog ? undefined : use.dialog.tabId;
		return use;
	}
	const tabId = callTab(session, method, params);
	use.holds = tabId ?? (method === "tabs.create" || method === "navigate" ? "session" : undefined);
	return use;
}

/** The call ended, however it ended: it holds nothing, and the boxes it held get a look. */
export function dialogUseEnd(use: CallUse): void {
	if (!uses.delete(use)) return;
	if (typeof use.holds === "number") void consider(use.holds).catch(() => undefined);
	else considerAll();
}

/** An ask_user from the session is waiting for the person, or no longer is. */
export function dialogAsk(sessionId: string, on: boolean): void {
	const n = (asks.get(sessionId) ?? 0) + (on ? 1 : -1);
	if (n > 0) asks.set(sessionId, n);
	else asks.delete(sessionId);
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

/** A tab's id changed (prerender, instant pages): its box, and the calls on it, go with it. */
export function replaced(from: number, to: number): void {
	for (const m of [opened, shown, cancelled] as Map<number, unknown>[])
		if (m.has(from)) {
			m.set(to, m.get(from));
			m.delete(from);
		}
	for (const u of uses) if (u.holds === from) u.holds = to;
	clearTimeout(timers.get(from));
	timers.delete(from);
	void consider(to).catch(() => undefined);
}

function forget(tabId: number): void {
	for (const m of [opened, shown, cancelled]) m.delete(tabId);
	clearTimeout(timers.get(tabId));
	timers.delete(tabId);
}

/** @internal Tests start each case from nothing. */
export function resetDialogGuard(): void {
	for (const tabId of [...timers.keys()]) forget(tabId);
	clearTimeout(pendingAll);
	pendingAll = undefined;
	uses.clear();
	for (const m of [asks, opened, shown, cancelled] as Map<unknown, unknown>[]) m.clear();
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
	void restoreDialogs().catch(() => undefined);
	chrome.tabs.onRemoved.addListener(forget);
	chrome.webNavigation.onTabReplaced.addListener(({ replacedTabId, tabId }) => replaced(replacedTabId, tabId));
	// The person brings a tab of the site to the front, opens or loads one, or comes back to a window.
	chrome.tabs.onActivated.addListener(considerAll);
	chrome.tabs.onUpdated.addListener((_id, change) => {
		if (change.url || change.status) considerAll();
	});
	chrome.windows.onFocusChanged.addListener(considerAll);
}
