/**
 * Waiting for a page to settle: no request the page is waiting on, no DOM mutation and no loading
 * marker (aria-busy, a skeleton or spinner) for a short quiet window, with a hard cap so a page
 * that never goes quiet (analytics pings, a websocket feed, a ticking clock, a long poll) still
 * returns. Input tools call it after the action; `wait {until:"settled"}` calls it on its own.
 *
 * Requests come from the debugger's Network events for the tab. Only the kinds a page waits on
 * to draw count (documents, scripts, stylesheets, fetch and XHR), only once they started after
 * the wait's origin, and only while they are younger than `longMs`: a long poll or a stream is
 * open for good and would hold every wait to its cap. DOM changes come from a MutationObserver
 * the first wait leaves in the document (in Polycarp's isolated world), which notes when the
 * page last changed; Polycarp's own veil element is left out.
 */

import { cdpSend, onDebuggerSessionEnd, openDialog } from "./cdp.js";
import { runInPage } from "./page.js";
import { veilTag } from "./veil-shared.js";

/** After an input tool: how long the page must stay quiet, and the most a call waits. */
export const ACTION_SETTLE = { quietMs: 300, capMs: 2500, longMs: 2000 };
/** `wait {until:"settled"}` with no timeoutMs. */
export const WAIT_SETTLE = { quietMs: 500, capMs: 10000, longMs: 5000 };

/** Request kinds a page waits on before it draws. Images, media, fonts, pings and streams don't hold a wait. */
const COUNTED = new Set(["Document", "Stylesheet", "Script", "XHR", "Fetch"]);

interface Pending {
	type: string;
	at: number;
	frameId: string;
}

const pending = new Map<number, Map<string, Pending>>();
/** When the last counted request on a tab finished. */
const lastEnd = new Map<number, number>();
/**
 * Each frame's current document loader, per tab. A frame's navigation request starts a new one:
 * whatever the old document had in flight dies with it, and the browser does not always say so.
 */
const loaders = new Map<number, Map<string, string>>();
let installed = false;

function install(): void {
	if (installed) return;
	installed = true;
	chrome.debugger.onEvent.addListener((source, method, params) => {
		const tabId = source.tabId;
		// Events from a child target (an out-of-process frame) carry its sessionId: not the tab's own.
		if (tabId === undefined || (source as { sessionId?: string }).sessionId) return;
		const p = (params ?? {}) as { requestId?: string; loaderId?: string; frameId?: string; type?: string };
		if (method === "Network.requestWillBeSent") {
			const type = String(p.type ?? "Other");
			if (!COUNTED.has(type)) return;
			const map = pending.get(tabId) ?? new Map<string, Pending>();
			pending.set(tabId, map);
			const frames = loaders.get(tabId) ?? new Map<string, string>();
			loaders.set(tabId, frames);
			const id = String(p.requestId);
			const frameId = String(p.frameId ?? "");
			if (type === "Document" && p.loaderId && id === p.loaderId) {
				// The frame is loading a new document: drop what its old one was waiting on. These
				// events arrive in order, so nothing the new document asks for is lost.
				frames.set(frameId, p.loaderId);
				if (frames.size > 100) frames.delete(frames.keys().next().value as string);
				for (const [k, r] of map) if (r.frameId === frameId && k !== id) map.delete(k);
			} else if (p.loaderId && frames.has(frameId) && frames.get(frameId) !== p.loaderId) {
				return; // the old document, still running until the new one commits
			}
			// A redirect reuses the request id: it is the same wait, timed from its first hop.
			const at = map.get(id)?.at ?? Date.now();
			map.set(id, { type, at, frameId });
			if (map.size > 500) map.delete(map.keys().next().value as string);
		} else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
			const map = pending.get(tabId);
			if (map?.delete(String(p.requestId))) lastEnd.set(tabId, Date.now());
		}
	});
	const forget = (tabId: number) => {
		pending.delete(tabId);
		lastEnd.delete(tabId);
		loaders.delete(tabId);
	};
	chrome.debugger.onDetach.addListener((source) => {
		if (source.tabId !== undefined) forget(source.tabId);
	});
	// Polycarp's own detach and a silent one raise no onDetach event; cdp.ts says so instead.
	onDebuggerSessionEnd(forget);
	chrome.tabs.onRemoved.addListener(forget);
}

/**
 * Start counting requests on a tab. Sent before every action, not remembered: a debugging session
 * can end with no event (a worker restart, a silent detach) and take Network with it, and enabling
 * it again is one cheap round trip. Best effort: a page the debugger can't reach is judged by its
 * DOM alone.
 */
async function watchNetwork(tabId: number): Promise<void> {
	install();
	await Promise.race([
		cdpSend(tabId, "Network.enable").catch(() => undefined),
		new Promise((r) => setTimeout(r, 1500)),
	]);
}

/**
 * Call just before an action: start listening (and counting the tab's requests) so a request the
 * action sends at once is seen, and return the wait's origin. With no tab yet, only the listener.
 */
export async function settleStart(tabId?: number): Promise<number> {
	install();
	if (tabId !== undefined) await watchNetwork(tabId);
	return Date.now();
}

/** Requests the page is still waiting on that started at or after `since` and are younger than `longMs`. */
function inFlight(tabId: number, since: number, longMs: number, now: number): number {
	let n = 0;
	for (const r of pending.get(tabId)?.values() ?? []) if (r.at >= since && now - r.at < longMs) n++;
	return n;
}

/**
 * Page side: leave a MutationObserver in the document once, and say how long ago the page last
 * changed, whether it is still parsing, and whether a loading marker is on screen. Self-contained.
 */
function settleProbe(veil: string): { since: number; parsing: boolean; busy: string } {
	const w = window as unknown as { __tabkyraSettle?: { last: number; doc: Document } };
	const now = performance.now();
	let s = w.__tabkyraSettle;
	if (!s || s.doc !== document) {
		s = { last: now, doc: document };
		w.__tabkyraSettle = s;
		const mark = s;
		const inVeil = (n: Node | null) => {
			for (let p: Node | null = n; p && veil; p = p.parentNode)
				if (p.nodeType === 1 && (p as Element).localName === veil) return true;
			return false;
		};
		new MutationObserver((records) => {
			if (records.some((r) => !inVeil(r.target))) mark.last = performance.now();
		}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	}
	// A loading marker a person would read as "not ready": aria-busy, or a skeleton, shimmer or
	// spinner class on something shown in the window.
	const token = /(^|[-_])(skeleton|shimmer|spinner)([-_]|$)|^(is-)?loading$/i;
	let busy = "";
	const marked = document.querySelectorAll(
		"[aria-busy=true],[class*=skeleton i],[class*=shimmer i],[class*=spinner i],[class*=loading i]",
	);
	for (let i = 0; i < marked.length && i < 200 && !busy; i++) {
		const el = marked[i];
		if (el.getAttribute("aria-busy") !== "true" && !Array.from(el.classList).some((c) => token.test(c))) continue;
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
		const st = getComputedStyle(el);
		if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
		busy = el.getAttribute("aria-busy") === "true" ? "aria-busy" : "loading placeholder";
	}
	return { since: Math.round(now - s.last), parsing: document.readyState === "loading", busy };
}

export interface SettleResult {
	settled: boolean;
	ms: number;
	/** What was still going on when the cap ran out. */
	waitingOn?: "network" | "dom" | "loading" | "navigation";
	/** Cut short by the caller or a dialog: the call reports that instead. */
	stopped?: boolean;
}

/**
 * Wait until the tab's page has been quiet for `quietMs`, at most `capMs`. `since` is when the
 * action began: requests started earlier don't hold the wait (0 counts every request in flight).
 * Stops at once, unsettled, when `stop()` says so or a dialog opens: the page is frozen then.
 */
export async function settle(
	tabId: number,
	options: { quietMs?: number; capMs?: number; longMs?: number; since?: number; stop?: () => boolean } = {},
): Promise<SettleResult> {
	const { quietMs = ACTION_SETTLE.quietMs, capMs = ACTION_SETTLE.capMs, longMs = ACTION_SETTLE.longMs } = options;
	const start = Date.now();
	const since = options.since ?? start;
	const deadline = start + capMs;
	await watchNetwork(tabId);
	const veil = (await veilTag(tabId).catch(() => undefined)) ?? "";
	const code = `(${settleProbe.toString()})(${JSON.stringify(veil)})`;
	let lastActivity = start;
	let waitingOn: SettleResult["waitingOn"];
	for (;;) {
		if (options.stop?.() || openDialog(tabId)) return { settled: false, ms: Date.now() - start, stopped: true };
		waitingOn = undefined;
		const tab = await chrome.tabs.get(tabId).catch(() => undefined);
		if (!tab) return { settled: false, ms: Date.now() - start, stopped: true };
		const t0 = Date.now();
		// A page in the middle of a navigation can't answer; never let one probe hold the loop.
		const page = tab.pendingUrl
			? undefined
			: await Promise.race([
					runInPage<ReturnType<typeof settleProbe>>(tabId, code).catch(() => undefined),
					new Promise<undefined>((r) => setTimeout(() => r(undefined), 400)),
				]);
		const now = Date.now();
		if (!page) {
			waitingOn = "navigation";
			lastActivity = now;
		} else {
			// The probe's clock is the page's: its "since" is measured at the page, about when the call went out.
			lastActivity = Math.max(lastActivity, t0 - page.since);
			if (page.parsing || page.busy) {
				waitingOn = "loading";
				lastActivity = now;
			}
		}
		if (inFlight(tabId, since, longMs, now) > 0) {
			waitingOn = "network";
			lastActivity = now;
		} else lastActivity = Math.max(lastActivity, Math.min(now, lastEnd.get(tabId) ?? 0));
		if (!waitingOn && now - lastActivity >= quietMs) return { settled: true, ms: now - start };
		if (now >= deadline) return { settled: false, ms: now - start, waitingOn: waitingOn ?? "dom" };
		await new Promise((r) => setTimeout(r, Math.max(10, Math.min(100, deadline - now))));
	}
}

/** What an action's result carries when the page did not settle in time; nothing when it did. */
export function unsettledNote(r: SettleResult): { settled: false; waitingOn: string } | Record<string, never> {
	return r.settled || r.stopped ? {} : { settled: false, waitingOn: r.waitingOn ?? "dom" };
}
