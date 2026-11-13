/**
 * A dialog on an agent's tab is answered Cancel only when it freezes the person (service worker;
 * docs/decisions.md, D48).
 *
 * Chrome itself cancels an alert, confirm or prompt that a hidden tab opens. With Polycarp's debugger attached it waits
 * for the agent's answer instead (cdp.ts turns on Page events), and while it waits the page's renderer runs nothing.
 * Chrome runs a site's tabs in one process, so the box froze the person's own tabs of that site.
 *
 * Facts only (open boxes by identity, `PageDialog.seq`; tab owners, sites and which is in front; answers that arrived;
 * when each box's freeze began), one pure `decide`, and one `reconcile` that runs one at a time on every trigger.
 */

import { registrableDomain } from "../site-edits/store.js";
import {
	allDialogs,
	answerDialog,
	cdpMemoryReady,
	forgetDialog,
	openDialog,
	type PageDialog,
	watchDialogs,
} from "./cdp.js";
import { addNotice, dropNotice, isAgentSession, listSessions, SESSIONS_KEY } from "./session.js";

export const GRACE_MS = 3_000;
export const OPEN_MS = 60_000;
const TOLD_MS = 10 * 60_000;
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** How long handle_dialog waits for the guard's Cancel of its box to come back before it says so. */
const SETTLE_MS = 5_000;
/** CDP's words for a box that is no longer there: its Cancel will never work, and it is dropped. */
const GONE =
	/no dialog is showing|no tab with (given )?id|not attached|no target|cannot access|debugger is not attached/i;

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
	/**
	 * Cancel the box only if it is still this one; false when it is gone. Sent before the first await, so the facts it
	 * was decided on are the ones it acts on. Never raced against a timer: until it settles, no second Cancel goes out.
	 */
	cancel: async (tabId: number, seq: number): Promise<boolean> => {
		if (openDialog(tabId)?.seq !== seq) return false;
		await answerDialog(tabId, false, undefined, seq);
		return true;
	},
	forget: forgetDialog,
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
/** Each box's Cancel on its way to the page, one at most, until it settles; settling records it and tells. */
const inflight = new Map<number, { tabId: number; job: Promise<void> }>();
/** Boxes whose Cancel failed: how often, and not before when to try again. */
const failures = new Map<number, { n: number; retryAt: number }>();
/**
 * The action that opened a box: recorded by the bridge only for a box that opened on the tab its last input went to,
 * while that input was on its way (native.ts). What the notice may tell the agent to do next comes from this alone.
 */
export interface DialogCause {
	/** The tool called: click, press, type, fill, actions, ... */
	method: string;
	/** The tab the input went to: the box's own tab. */
	tabId: number;
	/** The single action that opened the box: the call's own arguments, or the batch step's. */
	step: { kind: string; params: Record<string, unknown> };
	/** In an `actions` call: the step's index, and how many steps there were. */
	batch?: { index: number; total: number };
	/** A box the same call's on_dialog had already answered: that answer stands, and the call is not repeated. */
	after?: { type: string; message: string };
}
/** The call that opened each box, for the notice's next step. */
const causes = new Map<number, DialogCause>();
/** The steps on_dialog may be set on: a single action that, done again, does only that (D48). */
export const ONE_STEP = new Set(["click", "press"]);
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
	const live = new Set(deps.dialogs().map(([, d]) => d.seq));
	for (const m of [failures, causes] as Map<number, unknown>[])
		for (const seq of m.keys()) if (!live.has(seq)) m.delete(seq);
	if (live.size === 0) {
		clearTimeout(wake);
		since = new Map();
		return;
	}
	let wakeAt: number | undefined;
	// One Cancel per look, each decided on facts read after the last await (sol-F2): a box whose tab changed hands, or
	// whose person's tab closed, while an earlier one went out is decided again before anything is sent for it.
	for (;;) {
		const [tabs, owned] = await Promise.all([deps.tabs(), deps.owners()]);
		owners = owned;
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
		wakeAt = v.nextWakeAt;
		for (const seq of v.cancel) {
			const at = failures.get(seq)?.retryAt;
			if (at !== undefined && at > now) wakeAt = Math.min(wakeAt ?? at, at);
		}
		const due = v.cancel.find((seq) => !inflight.has(seq) && !((failures.get(seq)?.retryAt ?? 0) > now));
		const hit = due === undefined ? undefined : open.find(([, d]) => d.seq === due);
		if (!hit) break;
		// No await between the decision and the send.
		startCancel(
			hit[0],
			hit[1],
			owned.get(hit[0]) as string,
			siteOf(hit[1].url || tabs.find((t) => t.id === hit[0])?.url),
			// Which rule fired: the person's tab in front past the grace, or a minute open.
			(() => {
				const active = since.get(due as number)?.active;
				return active !== undefined && active + deps.grace() <= now && !asking.has(owned.get(hit[0]) as string);
			})(),
		);
	}
	clearTimeout(wake);
	if (wakeAt !== undefined && Number.isFinite(wakeAt))
		wake = setTimeout(() => void reconcile(), Math.max(0, wakeAt - Date.now()) + 20);
}

const READ_FIRST = "Read the page (read_page) to see what happened before you act again.";

/**
 * What the agent may do about a box Polycarp answers without it: never "repeat the whole call" (D48). An alert, or a box
 * after one the call's on_dialog answered, needs nothing; a box with no known cause, or one a step that can't take
 * on_dialog opened, needs a look first; otherwise the one click or press that opened it, on its own tab, with on_dialog.
 */
export function dialogAdvice(seq: number, tabId: number, dialog: PageDialog): string {
	const cause = causes.get(seq);
	// An alert may say the action failed: it is quoted, never taken as success (first-F4 of the review of PR 200).
	if (dialog.type === "alert")
		return `The alert said ${JSON.stringify(dialog.message)}. Do not take it as a sign the action worked, and do not repeat the action yet. ${READ_FIRST}`;
	if (cause?.after)
		return `It opened after the ${cause.after.type} (${JSON.stringify(cause.after.message)}) that your call's on_dialog answered. That answer stands: do not repeat the call. ${READ_FIRST}`;
	if (!cause || cause.tabId !== tabId)
		return `Polycarp does not know which action opened it (a script, a hover, a page timer, leaving the page): no call can answer it in advance. ${READ_FIRST} Ask the user if the page still needs this box answered.`;
	const repeat = Number(cause.step.params.repeat);
	const ran = cause.batch
		? `${cause.batch.index === 0 ? "No step" : `The first ${cause.batch.index} step${cause.batch.index === 1 ? "" : "s"}`} of your actions call ran before it${cause.batch.index === 0 ? "" : ": do not run them again"}. Step ${cause.batch.index + 1} (${cause.step.kind}) opened it${cause.batch.total > cause.batch.index + 1 ? `, and the ${cause.batch.total - cause.batch.index - 1} after it did not run` : ""}. `
		: "";
	// Only the last press opened it (second-S4, sol-F5 of the review of PR 200): the earlier ones ran and stay done.
	const presses =
		cause.step.kind === "press" && Number.isInteger(repeat) && repeat > 1
			? `The first ${repeat - 1} of the ${repeat} presses ran before it: do not press them again. `
			: "";
	if (!ONE_STEP.has(cause.step.kind))
		return `${ran}It opened during ${cause.step.kind}, which can't take on_dialog: done again, it would type again. ${READ_FIRST} If what the user asked for is not done, do the click or press that finishes it with "on_dialog".`;
	const args = Object.fromEntries(
		Object.entries(cause.step.params).filter(
			([k]) => k !== "on_dialog" && k !== "on_dialog_text" && k !== "tabId" && k !== "repeat",
		),
	);
	const text = dialog.type === "prompt" ? ', "on_dialog_text": "<the text to enter>"' : "";
	const json = (on: string) =>
		`${JSON.stringify({ tabId, ...args, on_dialog: on }).slice(0, -1)}${on === "ok" ? text : ""}}`;
	const alone = cause.batch ? " on its own (not inside actions)" : "";
	return `${ran}${presses}To do that one ${cause.step.kind === "press" ? "press" : "step"} again, call ${cause.step.kind}${alone} with ${json("ok")}: the box is then answered OK as it opens. Use "on_dialog": "ok" only if the box confirms exactly what the user asked for; otherwise ask the user first, or call ${cause.step.kind} with ${json("cancel")}.`;
}

/**
 * A box an action just opened, for that call's own note: when the person has a tab of the site in front, Polycarp will
 * cancel it before a handle_dialog can arrive (first-F5 of the review of PR 193), so the note says what works instead.
 */
export async function dialogSoon(tabId: number, dialog: PageDialog): Promise<string | undefined> {
	const [tabs, owned] = await Promise.all([deps.tabs(), deps.owners()]).catch(() => [[], new Map()] as const);
	const site = siteOf(dialog.url || tabs.find((t) => t.id === tabId)?.url);
	if (!site) return undefined;
	// A pending ask_user turns the grace rule off (decide): only the minute rule cancels, so handle_dialog can still
	// arrive (first-F5 of the review of PR 200).
	const owner = owned.get(tabId);
	if (owner !== undefined && asking.has(owner)) return undefined;
	const front = tabs.some((t) => {
		const owner = t.id === undefined ? undefined : owned.get(t.id);
		return t.id !== tabId && t.active && siteOf(t.url || t.pendingUrl) === site && !(owner && isAgentSession(owner));
	});
	if (!front) return undefined;
	const secs = Math.max(1, Math.round(deps.grace() / 1000));
	if (dialog.type === "alert")
		return `The person has a tab of ${site} in front, so Polycarp dismisses this alert in about ${secs} s. ${dialogAdvice(dialog.seq, tabId, dialog)}`;
	return `The person has a tab of ${site} in front, so Polycarp cancels this box in about ${secs} s, before a handle_dialog can arrive: do not call handle_dialog. ${dialogAdvice(dialog.seq, tabId, dialog)}`;
}

function startCancel(
	tabId: number,
	dialog: PageDialog,
	owner: string,
	site: string | undefined,
	// Read when the Cancel is decided (second-S4): once it lands, a look can drop the box's start times.
	front: boolean,
): void {
	const { seq } = dialog;
	const job = (async () => {
		let done = false;
		try {
			done = await deps.cancel(tabId, seq);
		} catch (err) {
			// A box Chrome no longer shows (restored from an earlier worker, or its close was missed): drop it, say nothing.
			if (GONE.test(errText(err))) {
				deps.forget(tabId, seq);
				deps.log(`dialog-guard: tab=${tabId} box is gone, dropped: ${errText(err)}`);
				return;
			}
			const n = (failures.get(seq)?.n ?? 0) + 1;
			failures.set(seq, { n, retryAt: Date.now() + Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS) });
			deps.log(`dialog-guard: tab=${tabId} Cancel failed (${n}), will retry: ${errText(err)}`);
			return;
		}
		failures.delete(seq);
		if (!done) return;
		const kind = dialog.type === "beforeunload" ? "leave-page" : dialog.type;
		const alert = dialog.type === "alert";
		const what = `The ${kind} dialog on tab ${tabId} (${JSON.stringify(dialog.message)}) was ${alert ? "dismissed" : "cancelled"}`;
		const rule = front
			? `because the person was using a tab on ${site}, and an open dialog freezes every tab of that site. A handle_dialog sent after a box opens cannot arrive in time while that tab is in front.`
			: `because it stayed open a minute while the person had a tab open on ${site}, and an open dialog freezes every tab of that site.`;
		const text = `${what}, ${rule}${alert ? "" : " The page saw Cancel."} ${dialogAdvice(seq, tabId, dialog)}`;
		cancelled.set(seq, { owner, tabId, text, at: Date.now() });
		deps.log(`dialog-guard: tab=${tabId} ${dialog.type} answered Cancel`);
		await deps.notice(owner, text).catch(() => undefined);
	})().finally(() => {
		inflight.delete(seq);
		void reconcile();
	});
	inflight.set(seq, { tabId, job });
}

/** The call that opened a box, from the bridge: the guard's notice names it to repeat with on_dialog. */
export function dialogCause(seq: number, cause: DialogCause): void {
	causes.set(seq, cause);
}

/** A handle_dialog, from the moment it reaches the worker: the box it answers, fixed then, or none. */
export interface DialogAnswer {
	session: string;
	tabIds: readonly number[];
	requested?: number;
	target?: { tabId: number; seq: number };
}

/**
 * A handle_dialog arrived (before any queue or await), or its handler found no box fixed at arrival and looks again.
 * With a tabId it is that tab's box; without, the one box open on the session's tabs. A box whose Cancel is on its
 * way is still its box: the handler learns how that Cancel ended. Only this box's Cancel waits for it, until
 * `dialogAnswerEnd`.
 */
export function dialogAnswerArrive(
	sessionId: string,
	tabIds: readonly number[] | undefined,
	requested: number | undefined,
): DialogAnswer {
	const tabs = tabIds ?? [...owners].filter(([, s]) => s === sessionId).map(([t]) => t);
	const open = deps.dialogs().filter(([t]) => tabs.includes(t));
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
 * Before handle_dialog answers: the guard's Cancel that the session has not heard of yet, said once. For a fixed box,
 * only that box's (another box's notice reaches the agent with its next call); without one, any on `tabIds` the
 * session owned. Waits for a look in progress and, up to 5 s, for a Cancel on its way, so the notice and this answer
 * are the same message, given once. `pending`: that Cancel had not come back yet.
 */
export async function dialogUnheard(
	sessionId: string,
	scope: { seq: number } | { tabIds: readonly number[] },
): Promise<{ text?: string; pending?: boolean }> {
	await chain;
	const mine = (seq: number, tabId: number) => ("seq" in scope ? seq === scope.seq : scope.tabIds.includes(tabId));
	const waiting = [...inflight].filter(([seq, c]) => mine(seq, c.tabId));
	if (waiting.length) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = await Promise.race([
			Promise.all(waiting.map(([, c]) => c.job)).then(() => false),
			new Promise<boolean>((r) => {
				timer = setTimeout(() => r(true), SETTLE_MS);
			}),
		]);
		clearTimeout(timer);
		if (late) return { pending: true };
	}
	for (const [seq, c] of cancelled) {
		if (c.owner !== sessionId || !mine(seq, c.tabId)) continue;
		cancelled.delete(seq);
		if (await deps.unnotice(c.owner, c.text)) return { text: c.text };
	}
	return {};
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
	for (const m of [inflight, failures, causes] as Map<unknown, unknown>[]) m.clear();
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
