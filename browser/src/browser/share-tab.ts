import { isRestrictedUrl } from "./cdp.js";

/** A blank new tab: the agent may start there and navigate away. */
const NEW_TAB = /^(chrome|edge|brave|vivaldi|opera|arc):\/\/(newtab|new-tab-page)\/?$|^about:blank$/;

/**
 * The tab the user is looking at, when the agent should get it with their next message: it is
 * not one of the session's tabs yet, and it is a web page or a blank new tab. Browser pages
 * (settings, the extension's own pages, the web store) never go to the agent, since it can't
 * work there and would navigate the user's page away.
 */
export async function tabToShare(
	windowId: number | undefined,
	sessionTabIds: readonly number[] | undefined,
): Promise<number | undefined> {
	if (windowId === undefined || !sessionTabIds) return undefined;
	const [tab] = await chrome.tabs.query({ active: true, windowId });
	const url = tab?.url ?? "";
	if (!tab?.id || (isRestrictedUrl(url) && !NEW_TAB.test(url))) return undefined;
	return sessionTabIds.includes(tab.id) ? undefined : tab.id;
}

interface SharingSession {
	readonly tabIds: readonly number[];
	adoptIfFree(
		tabId: number,
		makeCurrent?: boolean,
		options?: { group?: boolean },
	): Promise<{ id: string; label: string } | undefined>;
}

/**
 * Give the session the tab the user is looking at, unless another agent is driving it.
 * Returns what happened, so the panel can say so when the tab stayed with someone else.
 */
export async function shareActiveTab(
	session: SharingSession,
	windowId: number | undefined,
	makeCurrent: boolean,
): Promise<{ tabId: number; heldBy?: string } | undefined> {
	const tabId = await tabToShare(windowId, session.tabIds);
	if (tabId === undefined) return undefined;
	// The user's tab: the agent may use it, but it stays where they keep it (no group).
	const owner = await session.adoptIfFree(tabId, makeCurrent, { group: false });
	return owner ? { tabId, heldBy: owner.label } : { tabId };
}
