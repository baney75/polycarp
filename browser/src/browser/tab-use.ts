/**
 * Which tab a tool call acts on (docs/decisions.md, D48). Pure: veil.ts and dialog-guard.ts keep
 * their own state and feed it calls. A tab that only sits in the agent's group, or is the session's
 * current tab, is not acted on until a call names it or runs on it.
 */

/** Bridge methods that act on a tab. Every other method (status, tabs_context, ...) uses no tab. */
export const TAB_METHODS = new Set([
	"navigate",
	"tabs.create",
	"screenshot",
	"snapshot",
	"text",
	"html",
	"inspect",
	"find",
	"click",
	"hover",
	"drag",
	"type",
	"press",
	"scroll",
	"fill",
	"evaluate",
	"wait",
	"dialog",
	"actions",
	"console.read",
	"network.read",
]);

/** The tab a call acts on: the one it names, if the session owns it, else the session's current tab. */
export function callTab(
	session: { tabIds: readonly number[]; currentTabId?: number },
	method: string,
	params: Record<string, unknown> | undefined,
): number | undefined {
	if (!TAB_METHODS.has(method)) return undefined;
	// tabs_create acts on the tab it opens, which the call's end finds as the current tab.
	if (method === "tabs.create") return undefined;
	const named = Number(params?.tabId);
	if (params?.tabId !== undefined)
		return Number.isInteger(named) && session.tabIds.includes(named) ? named : undefined;
	return session.currentTabId;
}

/**
 * The tab a call moved the session to (the tab navigate or tabs_create opened), which it counts as
 * used when it ends. A current tab the call didn't change is not used by it.
 */
export function movedTo(
	session: { tabIds: readonly number[]; currentTabId?: number },
	currentBefore: number | undefined,
	begunOn: number | undefined,
): number | undefined {
	const now = session.currentTabId;
	if (now === undefined || now === currentBefore || now === begunOn || !session.tabIds.includes(now)) return undefined;
	return now;
}
