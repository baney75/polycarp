/**
 * A dialog on an agent's tab is answered Cancel only when it freezes the person (service worker;
 * docs/decisions.md, D46).
 *
 * Chrome itself cancels an alert, confirm or prompt that a hidden tab opens. With Polycarp's debugger attached it waits
 * for the agent's answer instead (cdp.ts turns on Page events), and while it waits the page's renderer runs nothing.
 * Chrome runs a site's tabs in one process, so the box froze the person's own tabs of that site.
 *
 * Facts only (open boxes by identity, `PageDialog.seq`; tab owners, sites and which is in front; answers that arrived;
 * when each box's freeze began), one pure `decide`, and one `reconcile` that runs one at a time on every trigger.
 */

import { registrableDomain } from "../site-edits/store.js";
import { allDialogs, answerDialog, cdpMemoryReady, openDialog, watchDialogs } from "./cdp.js";
import { addNotice, dropNotice, isAgentSession, listSessions, SESSIONS_KEY } from "./session.js";

export const GRACE_MS = 3_000;
export const OPEN_MS = 60_000;
const TOLD_MS = 10 * 60_000;
const RETRY_MS = 1_000;

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

/** Since when a tab of the person's on the box's site has existed, and has been in front (active in its window). */
export type Since = { present?: number; active?: number };

export interface Facts {
	dialogs: Array<{ seq: number; tabId: number; owner?: string; site?: string }>;
	tabs: Array<{ id: number; site?: string; active: boolean; owner?: string }>;
	/** Boxes a handle_dialog for exactly that box has arrived for and not finished. */
	answering: ReadonlySet<number>;
	/** Sessions with an ask_user waiting for the person. */
	asking: ReadonlySet<string>;
	since: ReadonlyMap<number, Since>;
}

/** Which boxes to Cancel now, when to look again, and the conditions' start times as of `now`. */
export function decide(
	f: Facts,
	now: number,
	grace = GRACE_MS,
	open = OPEN_MS,
): { cancel: number[]; nextWakeAt?: number; since: Map<number, Since> } {
	const cancel: number[] = [];
	const since = new Map<number, Since>();
	let nextWakeAt: number | undefined;
	for (const d of f.dialogs) {
		if (!d.site) continue;
		const person = f.tabs.filter(
			(t) => t.id !== d.tabId && t.site === d.site && !(t.owner && isAgentSession(t.owner)),
		);
		const was = f.since.get(d.seq) ?? {};
		const s: Since = {
			present: person.length ? (was.present ?? now) : undefined,
			active: person.some((t) => t.active) ? (was.active ?? now) : undefined,
		};
		if (s.present === undefined) continue;
		// Kept whoever owns the box's tab now: the freeze began then either way.
		since.set(d.seq, s);
		// Only a box on an agent's tab: the side panel's box is in the person's own tab, theirs to answer.
		if (!d.owner || !isAgentSession(d.owner) || f.answering.has(d.seq)) continue;
		const at = Math.min(
			s.present + open,
			s.active !== undefined && !f.asking.has(d.owner) ? s.active + grace : Number.POSITIVE_INFINITY,
		);
		if (at <= now) cancel.push(d.seq);
		else nextWakeAt = Math.min(nextWakeAt ?? at, at);
	}
	return { cancel, nextWakeAt, since };
}

type Tab = { id?: number; url?: string; pendingUrl?: string; active: boolean };

/** What the guard reads and does; tests swap these. */
export const deps = {
	dialogs: allDialogs,
	/** Cancel the box only if it is still this one; false when it is gone. */
	cancel: async (tabId: number, seq: number): Promise<boolean> => {
		if (openDialog(tabId)?.seq !== seq) return false;
		// A send that never returns must not stall every later look.
		await Promise.race([
			answerDialog(tabId, false, undefined, seq),
			new Promise((_, reject) => setTimeout(() => reject(new Error("no answer from the page in 5 s")), 5_000)),
		]);
		return true;
	},
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

const answering = new Map<number, number>();
const asking = new Map<string, number>();
let since = new Map<number, Since>();
/** Boxes being cancelled right now: an answer that arrives meanwhile is told it was cancelled. */
const cancelling = new Set<number>();
/** Boxes the guard cancelled, until the agent hears of it once. */
const cancelled = new Map<number, { owner: string; tabId: number; text: string; at: number }>();
/** The ownership the last run read, for an answer that arrives before its session is open. */
let owners = new Map<number, string>();
let wake: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();
let queued = false;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const bump = <K>(m: Map<K, number>, k: K, by: number) => {
	const n = (m.get(k) ?? 0) + by;
	if (n > 0) m.set(k, n);
	else m.delete(k);
};

/** Look at every box again. Runs one at a time; calls while one waits to start share it. */
export function reconcile(): Promise<void> {
	if (queued) return chain;
	queued = true;
	chain = chain.then(() => {
		queued = false;
		return run().catch((err) => deps.log(`dialog-guard: ${errText(err)}`));
	});
	return chain;
}

async function run(): Promise<void> {
	const now0 = Date.now();
	for (const [seq, c] of cancelled) if (now0 - c.at >= TOLD_MS) cancelled.delete(seq);
	if (deps.dialogs().length === 0) {
		clearTimeout(wake);
		since = new Map();
		return;
	}
	const [tabs, owned] = await Promise.all([deps.tabs(), deps.owners()]);
	owners = owned;
	// Everything below is read after the await and decided with none before the cancels are marked.
	const open = deps.dialogs();
	const now = Date.now();
	const v = decide(
		{
			dialogs: open.map(([tabId, d]) => ({
				seq: d.seq,
				tabId,
				owner: owned.get(tabId),
				site: siteOf(d.url || tabs.find((t) => t.id === tabId)?.url),
			})),
			tabs: tabs.flatMap((t) =>
				t.id === undefined
					? []
					: [{ id: t.id, site: siteOf(t.url || t.pendingUrl), active: t.active, owner: owned.get(t.id) }],
			),
			answering: new Set(answering.keys()),
			asking: new Set(asking.keys()),
			since,
		},
		now,
		deps.grace(),
		deps.open(),
	);
	since = v.since;
	for (const seq of v.cancel) cancelling.add(seq);
	let retry = false;
	for (const [tabId, dialog] of open.filter(([, d]) => cancelling.has(d.seq))) {
		const { seq } = dialog;
		const owner = owned.get(tabId) as string;
		let done = false;
		try {
			done = await deps.cancel(tabId, seq);
		} catch (err) {
			retry = true;
			deps.log(`dialog-guard: tab=${tabId} Cancel failed, will retry: ${errText(err)}`);
		} finally {
			cancelling.delete(seq);
		}
		if (!done) continue;
		const site = siteOf(dialog.url || tabs.find((t) => t.id === tabId)?.url);
		const why =
			since.get(seq)?.active !== undefined
				? `the person was using a tab on ${site}`
				: `the person has a tab open on ${site}`;
		const text = `The ${dialog.type === "beforeunload" ? "leave-page" : dialog.type} dialog on tab ${tabId} (${JSON.stringify(dialog.message)}) was cancelled, because ${why} and an open dialog freezes every tab of that site. The page saw Cancel. Do the action again when you are ready to answer its dialog at once.`;
		cancelled.set(seq, { owner, tabId, text, at: Date.now() });
		deps.log(`dialog-guard: tab=${tabId} ${dialog.type} answered Cancel`);
		await deps.notice(owner, text).catch(() => undefined);
	}
	const at = retry ? Math.min(v.nextWakeAt ?? Number.POSITIVE_INFINITY, Date.now() + RETRY_MS) : v.nextWakeAt;
	clearTimeout(wake);
	if (at !== undefined && Number.isFinite(at))
		wake = setTimeout(() => void reconcile(), Math.max(0, at - Date.now()) + 20);
}

/** A handle_dialog, from the moment it reaches the worker: the box it answers, fixed then, or none. */
export interface DialogAnswer {
	session: string;
	tabIds: readonly number[];
	requested?: number;
	target?: { tabId: number; seq: number };
}

/**
 * A handle_dialog arrived (before any queue or await). With a tabId it is that tab's box; without, the one box open on
 * the session's tabs. Only this box's Cancel waits for it, until `dialogAnswerEnd`.
 */
export function dialogAnswerArrive(
	sessionId: string,
	tabIds: readonly number[] | undefined,
	requested: number | undefined,
): DialogAnswer {
	const tabs = tabIds ?? [...owners].filter(([, s]) => s === sessionId).map(([t]) => t);
	const open = deps.dialogs().filter(([t, d]) => tabs.includes(t) && !cancelling.has(d.seq));
	const hit =
		requested === undefined ? (open.length === 1 ? open[0] : undefined) : open.find(([t]) => t === requested);
	const answer: DialogAnswer = { session: sessionId, tabIds: tabs, requested };
	if (hit) {
		answer.target = { tabId: hit[0], seq: hit[1].seq };
		bump(answering, hit[1].seq, 1);
		void reconcile();
	}
	return answer;
}

/** The handle_dialog ended, however it ended. */
export function dialogAnswerEnd(answer: DialogAnswer): void {
	if (!answer.target) return;
	bump(answering, answer.target.seq, -1);
	void reconcile();
}

/**
 * Before handle_dialog answers: the guard's Cancel of a box on these tabs that the agent has not heard of yet, said
 * once. Waits for a Cancel in flight, so the notice and this answer are the same message, given once.
 */
export async function dialogUnheard(tabIds: readonly number[]): Promise<string | undefined> {
	await chain;
	for (const [seq, c] of cancelled) {
		if (!tabIds.includes(c.tabId)) continue;
		cancelled.delete(seq);
		if (await deps.unnotice(c.owner, c.text)) return c.text;
	}
	return undefined;
}

/** An ask_user from the session is waiting for the person, or no longer is. */
export function dialogAsk(sessionId: string, on: boolean): void {
	bump(asking, sessionId, on ? 1 : -1);
	void reconcile();
}

/** @internal Tests start each case from nothing. */
export function resetDialogGuard(): void {
	clearTimeout(wake);
	for (const m of [answering, asking, cancelled] as Map<unknown, unknown>[]) m.clear();
	cancelling.clear();
	since = new Map();
	owners = new Map();
	chain = Promise.resolve();
	queued = false;
}

let started = false;

/** Wire the triggers. Call once per worker start. */
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
	const look = () => void reconcile();
	// Worker start: the boxes an earlier worker kept come back first.
	void cdpMemoryReady().then(look);
	watchDialogs(look);
	for (const e of [
		chrome.tabs.onActivated,
		chrome.tabs.onUpdated,
		chrome.tabs.onCreated,
		chrome.tabs.onRemoved,
		chrome.tabs.onAttached,
		chrome.tabs.onDetached,
		chrome.tabs.onReplaced,
		chrome.windows.onFocusChanged,
	] as chrome.events.Event<() => void>[])
		e.addListener(look);
	// Any change of who owns a tab: a session's tabs, the person taking one, an ungroup.
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && SESSIONS_KEY in changes) look();
	});
}
