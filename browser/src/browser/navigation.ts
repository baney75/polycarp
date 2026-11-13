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

/** navigateTab that also says whether the wait ran out before the page was ready. */
export async function navigateTabDetailed(
	tabId: number,
	url: string,
	options: NavigateOptions = {},
): Promise<{ url: string; timedOut: boolean }> {
	const from = await chrome.tabs.get(tabId).then(
		(t) => t.url,
		() => undefined,
	);
	if (isPdfPageJump(from, url) && (await isPdfTab(tabId))) {
		// Chrome's PDF viewer reads #page=N only when the file loads: a change of the hash alone leaves it on the
		// page it shows. So set the hash, then reload, and the viewer opens at that page.
		// The hash change is quick; if a viewer reports no event for it, the reload still runs.
		const hashWait = { ...options, timeoutMs: Math.min(options.timeoutMs ?? 20000, 3000) };
		await waitForNavigation(tabId, url, hashWait, () => chrome.tabs.update(tabId, { url }));
		return waitForNavigation(tabId, url, options, () => chrome.tabs.reload(tabId));
	}
	return waitForNavigation(tabId, url, options, () => chrome.tabs.update(tabId, { url }));
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

function waitForNavigation(
	tabId: number,
	url: string,
	options: NavigateOptions,
	start: () => Promise<unknown>,
): Promise<{ url: string; timedOut: boolean }> {
	const { signal, timeoutMs = 20000, waitUntil = "domcontentloaded" } = options;
	if (signal?.aborted) throw new Error("Aborted");
	return new Promise<{ url: string; timedOut: boolean }>((resolve, reject) => {
		let committed = false;
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
			if (top(d) && committed) finish(() => resolve({ url: d.url, timedOut: false }));
		};
		const onSameDocument = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
			if (top(d)) finish(() => resolve({ url: d.url, timedOut: false }));
		};
		const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
			// ERR_ABORTED is a superseded navigation (redirect to a download, a newer navigate).
			if (top(d) && !d.error.includes("ERR_ABORTED"))
				finish(() => reject(new Error(`Navigation to ${url} failed: ${d.error}`)));
		};
		const onAbort = () => finish(() => reject(new Error("Aborted")));
		const timer = setTimeout(() => {
			finish(() => {
				chrome.tabs.get(tabId).then(
					(tab) => resolve({ url: tab.url ?? tab.pendingUrl ?? url, timedOut: true }),
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
