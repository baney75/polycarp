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

import { isGuardedUrl } from "../bridge/permissions.js";
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
	loaderId: string;
}

const pending = new Map<number, Map<string, Pending>>();
/** When the last counted request on a tab finished. */
const lastEnd = new Map<number, number>();
/**
 * Each frame's committed document loader, per tab, from Page.frameNavigated. A document that
 * replaced another takes what the old one had in flight with it, and the browser does not always
 * say so. Set on commit, never on the request: a download or a 204 asks for a document that never
 * commits, and the old page goes on with its own loader.
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
			const id = String(p.requestId);
			const frameId = String(p.frameId ?? "");
			const loaderId = String(p.loaderId ?? "");
			// A request from a document that was already replaced: it is going away with that page.
			const current = loaders.get(tabId)?.get(frameId);
			if (current && loaderId && loaderId !== current && !(type === "Document" && id === loaderId)) return;
			// A redirect reuses the request id: it is the same wait, timed from its first hop.
			const at = map.get(id)?.at ?? Date.now();
			map.set(id, { type, at, frameId, loaderId });
			if (map.size > 500) map.delete(map.keys().next().value as string);
		} else if (method === "Page.frameNavigated") {
			const frame = (params as { frame?: { id?: string; loaderId?: string } }).frame;
			if (!frame?.id || !frame.loaderId) return;
			const frames = loaders.get(tabId) ?? new Map<string, string>();
			loaders.set(tabId, frames);
			frames.set(frame.id, frame.loaderId);
			if (frames.size > 100) frames.delete(frames.keys().next().value as string);
			const map = pending.get(tabId);
			for (const [k, r] of map ?? []) if (r.frameId === frame.id && r.loaderId !== frame.loaderId) map?.delete(k);
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
		new Promise((r) => setTimeout(r, ENABLE_MS)),
	]);
}

/** The most turning Network on may take; a stuck debugger is not worth more. */
const ENABLE_MS = 500;

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
 * On a guarded page (the approval address, #94) it touches nothing and says so: a navigation can
 * commit there after the loop last read the tab's URL.
 */
function settleProbe(
	veil: string,
	hosts: readonly string[],
	guarded: (url: string, hosts: readonly string[]) => boolean,
): { since: number; parsing: boolean; busy: string } | { guarded: true } {
	if (guarded(location.href, hosts)) return { guarded: true };
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
		// The veil coming or going is not the page changing: a childList record's target is its parent.
		const veilOnly = (r: MutationRecord) => {
			if (inVeil(r.target)) return true;
			const nodes = r.type === "childList" ? [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)] : [];
			return nodes.length > 0 && nodes.every((n) => inVeil(n));
		};
		new MutationObserver((records) => {
			if (records.some((r) => !veilOnly(r))) mark.last = performance.now();
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
		if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth)
			continue;
		// Seen means seen: a loader faded out (opacity 0 on an ancestor) or hidden by one stays in the
		// page after many transitions, and must not hold every wait.
		const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
		if (check) {
			if (!check.call(el, { opacityProperty: true, visibilityProperty: true })) continue;
		} else {
			const st = getComputedStyle(el);
			if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
		}
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
 * Wait until the tab's page has been quiet for `quietMs`, at most `capMs`, which is a hard limit:
 * the result comes at the cap whatever the page or the debugger does. `since` is when the action
 * began: requests started earlier don't hold the wait (0 counts every request in flight).
 * Stops at once, unsettled, when `stop()` says so, a dialog opens (the page is frozen then) or the
 * tab lands on a page no tool may touch (`skip`). `watched`: settleStart already turned Network on.
 */
export async function settle(
	tabId: number,
	options: {
		quietMs?: number;
		capMs?: number;
		longMs?: number;
		since?: number;
		stop?: () => boolean;
		skip?: (url: string) => boolean;
		/** The hosts behind `skip`: the probe checks them itself before it touches the page. */
		guardedHosts?: readonly string[];
		watched?: boolean;
	} = {},
): Promise<SettleResult> {
	const { quietMs = ACTION_SETTLE.quietMs, capMs = ACTION_SETTLE.capMs, longMs = ACTION_SETTLE.longMs } = options;
	const start = Date.now();
	const since = options.since ?? start;
	const deadline = start + capMs;
	let over = false;
	let waitingOn: SettleResult["waitingOn"];
	/** The reason the last full pass found, for a cap that lands in the middle of a pass. */
	let lastReason: SettleResult["waitingOn"];
	const run = async (): Promise<SettleResult> => {
		if (!options.watched) await watchNetwork(tabId);
		const veil = (await within(veilTag(tabId), 300)) ?? "";
		const code = `(${settleProbe.toString()})(${JSON.stringify(veil)}, ${JSON.stringify(options.guardedHosts ?? [])}, ${isGuardedUrl.toString()})`;
		let lastActivity = start;
		/** Probes refused in a row. A page the extension may not script (a store page, a viewer) is judged by its requests alone. */
		let refused = 0;
		/** The document the refusals were counted on: a new one may be scriptable. */
		let refusedOn = "";
		for (;;) {
			if (over) return { settled: false, ms: Date.now() - start };
			if (options.stop?.() || openDialog(tabId)) return { settled: false, ms: Date.now() - start, stopped: true };
			const before = waitingOn;
			waitingOn = undefined;
			const tab = await chrome.tabs.get(tabId).catch(() => undefined);
			// The cap came while the tab was read: no probe goes out after it.
			if (over) return { settled: false, ms: Date.now() - start };
			if (!tab || options.skip?.(tab.pendingUrl || tab.url || ""))
				return { settled: false, ms: Date.now() - start, stopped: true };
			const t0 = Date.now();
			if (tab.pendingUrl || tab.url !== refusedOn) {
				refused = 0;
				refusedOn = tab.url ?? "";
			}
			if (tab.pendingUrl) {
				waitingOn = "navigation";
				lastActivity = t0;
			} else if (refused < 2) {
				// Never let one probe hold the loop, or run past the cap.
				const budget = Math.max(0, Math.min(PROBE_MS, deadline - t0));
				const page = await within(
					runInPage<ReturnType<typeof settleProbe>>(tabId, code).then(
						(v) => v ?? "refused",
						() => "refused" as const,
					),
					budget,
				);
				if (page && page !== "refused" && "guarded" in page)
					return { settled: false, ms: Date.now() - start, stopped: true };
				if (page === "refused") refused++;
				else if (page !== undefined) refused = 0;
				if (page === undefined) {
					// No answer in time: the page's main thread is busy (a long task, hydration). Cut
					// short by the cap instead, it says nothing new about the page.
					waitingOn = budget < PROBE_MS ? (before ?? "dom") : "loading";
					lastActivity = Date.now();
				} else if (page !== "refused" && !("guarded" in page)) {
					// The probe's clock is the page's: its "since" is measured at the page, about when the call went out.
					lastActivity = Math.max(lastActivity, t0 - page.since);
					if (page.parsing || page.busy) {
						waitingOn = "loading";
						lastActivity = Date.now();
					}
				} else if (refused < 2) lastActivity = Date.now(); // once may be a document being swapped
			}
			const now = Date.now();
			if (inFlight(tabId, since, longMs, now) > 0) {
				waitingOn = "network";
				lastActivity = now;
			} else lastActivity = Math.max(lastActivity, Math.min(now, lastEnd.get(tabId) ?? 0));
			lastReason = waitingOn;
			if (!waitingOn && now - lastActivity >= quietMs) return { settled: true, ms: now - start };
			if (now >= deadline) return { settled: false, ms: now - start, waitingOn: waitingOn ?? "dom" };
			await new Promise((r) => setTimeout(r, Math.max(10, Math.min(100, deadline - now))));
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const capped = new Promise<SettleResult>((r) => {
		timer = setTimeout(() => {
			over = true;
			r({ settled: false, ms: Date.now() - start, waitingOn: waitingOn ?? lastReason ?? "dom" });
		}, capMs);
	});
	try {
		return await Promise.race([run(), capped]);
	} finally {
		clearTimeout(timer);
	}
}

/** The longest one DOM probe may take before the page counts as busy. */
const PROBE_MS = 400;

/** A promise's value, or undefined once `ms` have passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
}

/** What an action's result carries when the page did not settle in time; nothing when it did. */
export function unsettledNote(r: SettleResult): { settled: false; waitingOn: string } | Record<string, never> {
	return r.settled || r.stopped ? {} : { settled: false, waitingOn: r.waitingOn ?? "dom" };
}
