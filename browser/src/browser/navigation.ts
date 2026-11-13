/**
 * Navigating a tab and waiting for its top frame, for the bridge and the side panel. Kept apart from
 * page.ts, whose page code (snapshots, refs, frames) the side panel does not load when it opens.
 */

import { isPdfTab } from "../offscreen/pdf-client.js";

export interface NavigateOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Resolve on DOMContentLoaded (default) or on load complete. */
	waitUntil?: "domcontentloaded" | "load";
}

/**
 * Navigate a tab and wait for its top frame. Returns the final URL.
 *
 * Only events after the new document commits count, so a load still finishing from the
 * previous page cannot satisfy the wait. Same-document navigations (hash or pushState)
 * finish at commit. Network errors reject with Chrome's error code. A page that keeps
 * loading past the timeout resolves with where the tab is; callers report the tab's
 * status so the model knows it may still be loading.
 */
export async function navigateTab(tabId: number, url: string, options: NavigateOptions = {}): Promise<string> {
	return (await navigateTabDetailed(tabId, url, options)).url;
}

/** Where a navigation ended, whether the wait ran out first, and whether a new document committed. */
export interface NavigationResult {
	url: string;
	timedOut: boolean;
	committed: boolean;
}

/** navigateTab that also says whether the wait ran out and whether a new document committed. */
export async function navigateTabDetailed(
	tabId: number,
	url: string,
	options: NavigateOptions = {},
): Promise<NavigationResult> {
	const from = await chrome.tabs.get(tabId).then(
		(t) => t.url,
		() => undefined,
	);
	if (isPdfPageJump(from, url) && (await isPdfTab(tabId))) {
		// Chrome's PDF viewer reads #page=N only when the file loads: a change of the hash alone leaves it on the
		// page it shows. So set the hash, then reload, and the viewer opens at that page.
		// The hash change is quick; if a viewer reports no event for it, the reload still runs.
		const hashWait = { ...options, timeoutMs: Math.min(options.timeoutMs ?? 20000, 3000) };
		await waitForNavigation(tabId, url, hashWait, true, () => chrome.tabs.update(tabId, { url }), from);
		return waitForNavigation(tabId, url, options, false, () => chrome.tabs.reload(tabId), from);
	}
	// Only a new hash on the page the tab shows can keep the document; any other URL, the same one included, loads one.
	const hashOf = (u: string) => (URL.canParse(u) ? new URL(u).hash : u);
	const jump = url.includes("#") && from !== undefined && sameDocumentUrl(from, url) && hashOf(from) !== hashOf(url);
	return waitForNavigation(tabId, url, options, jump, () => chrome.tabs.update(tabId, { url }), from);
}

/**
 * True when `to` is the PDF `from` already shows, with a #page=N (Chrome's PDF open parameter) that differs: the one
 * case where a same-document navigation must reload.
 */
export function isPdfPageJump(from: string | undefined, to: string): boolean {
	if (!from) return false;
	let a: URL;
	let b: URL;
	try {
		a = new URL(from);
		b = new URL(to);
	} catch {
		return false;
	}
	if (!/^https?:|^file:/.test(b.protocol) || !/(^#|&)page=\d+/i.test(b.hash) || a.hash === b.hash) return false;
	a.hash = "";
	b.hash = "";
	return a.href === b.href;
}

/** Whether two URLs are one document apart from the hash. */
export function sameDocumentUrl(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		x.hash = "";
		y.hash = "";
		return x.href === y.href;
	} catch {
		return a === b;
	}
}

/** How often an aborted navigation checks whether the tab has a navigation pending before it counts as kept. */
const ABORT_GRACE_MS = 500;
/** Chrome clears pendingUrl at the commit, a moment before onCommitted arrives: an empty one is read twice, this far apart. */
const COMMIT_TICK_MS = 150;

function waitForNavigation(
	tabId: number,
	url: string,
	options: NavigateOptions,
	/** Whether this navigation can stay in the document (a new hash): only then does a same-document event end it. */
	jump: boolean,
	start: () => Promise<unknown>,
	/** The URL the tab showed before: a tab that shows another document has committed one. */
	from?: string,
): Promise<NavigationResult> {
	const { signal, timeoutMs = 20000, waitUntil = "domcontentloaded" } = options;
	if (signal?.aborted) throw new Error("Aborted");
	return new Promise<NavigationResult>((resolve, reject) => {
		let committed = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		/** The last grace check found nothing pending; a second such check, a tick later, ends the wait. */
		let clear = false;
		const nav = chrome.webNavigation;
		const doneEvent = waitUntil === "load" ? nav.onCompleted : nav.onDOMContentLoaded;
		const cleanup = () => {
			nav.onCommitted.removeListener(onCommitted);
			doneEvent.removeListener(onDone);
			nav.onReferenceFragmentUpdated.removeListener(onSameDocument);
			nav.onHistoryStateUpdated.removeListener(onSameDocument);
			nav.onErrorOccurred.removeListener(onError);
			signal?.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			clearTimeout(grace);
			grace = undefined;
		};
		const finish = (fn: () => void) => {
			cleanup();
			fn();
		};
		const top = (d: { tabId: number; frameId: number }) => d.tabId === tabId && d.frameId === 0;
		const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
			if (top(d)) committed = true;
		};
		const onDone = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (top(d) && committed) finish(() => resolve({ url: d.url, timedOut: false, committed }));
		};
		// Only this navigation's own jump: the old page's router can push a URL of its own while the new document
		// loads, the very URL of a reload included.
		const onSameDocument = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
			if (jump && top(d) && sameDocumentUrl(d.url, url))
				finish(() => resolve({ url: d.url, timedOut: false, committed }));
		};
		const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
			if (!top(d)) return;
			if (!d.error.includes("ERR_ABORTED"))
				finish(() => reject(new Error(`Navigation to ${url} failed: ${d.error}`)));
			// ERR_ABORTED with nothing committed: a URL that loads no document (a 204, a download), so the tab
			// stays on its page; or an earlier navigation that this one cancelled. The tab's pending navigation
			// says which: while it has one, the wait goes on until a commit or the timeout. Its load status does
			// not: a page that streams or never fires load stays "loading" whatever this navigation did.
			else if (!committed && grace === undefined) grace = setTimeout(kept, ABORT_GRACE_MS);
		};
		const kept = () => {
			chrome.tabs.get(tabId).then(
				(tab) => {
					if (committed || grace === undefined) return;
					if (tab.pendingUrl) {
						clear = false;
						grace = setTimeout(kept, ABORT_GRACE_MS);
					} else if (!clear) {
						// Nothing pending: a 204, or a commit whose onCommitted is still on its way. A tick, then the tab's URL, tell them apart.
						clear = true;
						grace = setTimeout(kept, COMMIT_TICK_MS);
					} else if (from !== undefined && tab.url && !sameDocumentUrl(tab.url, from)) {
						// The tab shows another document: it committed, however late its onCommitted is. Its load ends the wait.
						committed = true;
						grace = undefined;
					} else finish(() => resolve({ url: tab.url ?? url, timedOut: false, committed }));
				},
				() => {
					if (!committed && grace !== undefined)
						finish(() => reject(new Error("The tab closed during the navigation")));
				},
			);
		};
		const onAbort = () => finish(() => reject(new Error("Aborted")));
		const timer = setTimeout(() => {
			finish(() => {
				chrome.tabs.get(tabId).then(
					(tab) => resolve({ url: tab.url ?? tab.pendingUrl ?? url, timedOut: true, committed }),
					() => reject(new Error("Navigation timed out and the tab is gone")),
				);
			});
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort);
		nav.onCommitted.addListener(onCommitted);
		doneEvent.addListener(onDone);
		nav.onReferenceFragmentUpdated.addListener(onSameDocument);
		nav.onHistoryStateUpdated.addListener(onSameDocument);
		nav.onErrorOccurred.addListener(onError);
		start().catch((err: Error) => finish(() => reject(err)));
	});
}

/** Wait for the top frame of a tab to be ready (DOMContentLoaded), bounded. False on timeout. */
export function waitForLoad(tabId: number, timeoutMs = 15000): Promise<boolean> {
	return new Promise((resolve) => {
		let ok = true;
		const done = () => {
			chrome.webNavigation.onCompleted.removeListener(listener);
			chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
			clearTimeout(timer);
			resolve(ok);
		};
		const listener = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
			if (d.tabId === tabId && d.frameId === 0) done();
		};
		const timer = setTimeout(() => {
			ok = false;
			done();
		}, timeoutMs);
		chrome.webNavigation.onCompleted.addListener(listener);
		// DOMContentLoaded is enough to read and act on a page; heavy sites take ages to "complete".
		chrome.webNavigation.onDOMContentLoaded.addListener(listener);
		chrome.tabs.get(tabId).then(
			(tab) => {
				if (tab.status === "complete" && !tab.pendingUrl) done();
			},
			() => done(),
		);
	});
}

export async function goBack(tabId: number): Promise<boolean> {
	await chrome.tabs.goBack(tabId);
	return waitForLoad(tabId);
}

export async function goForward(tabId: number): Promise<boolean> {
	await chrome.tabs.goForward(tabId);
	return waitForLoad(tabId);
}
