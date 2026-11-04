/**
 * What the user does to an agent's tab group means something (service worker).
 *
 * - Dragging a tab out of an agent's group, or ungrouping it, hands that tab to the user: the
 *   agent loses it and hears about it on its next tabs_context.
 * - Dragging one of the user's tabs into an agent's group gives it to that agent.
 * - Closing the group (its last tab) ends the session; its record goes.
 * - A window closing is not a gesture: the session survives and reopens in another window.
 *
 * Side panel chats keep their old rules (their tabs are the user's already). Changes Tabkyra
 * makes itself (an agent closing or releasing a tab) are skipped via isAgentTouching.
 * BrowserSession.reconcile applies the same rules to moves made while the worker slept.
 */

import {
	addNotice,
	BrowserSession,
	isAgentSession,
	isAgentTouching,
	listSessions,
	sessionOwningTab,
} from "./session.js";

let log: (line: string) => void = () => undefined;

async function onGroupChanged(tabId: number, groupId: number, tab: chrome.tabs.Tab): Promise<void> {
	if (isAgentTouching(tabId)) return;
	const owner = await sessionOwningTab(tabId);
	if (owner && isAgentSession(owner.id)) {
		// A tab seen in the group and now outside it was moved by the user, even when that emptied
		// the group (Chrome deletes it before this event arrives).
		if (groupId === owner.groupId || !owner.grouped?.includes(tabId)) return;
		log(`gesture: tab=${tabId} left ${owner.id}'s group`);
		await (await BrowserSession.existing(owner.id))?.userTook(tabId, tab);
	} else if (owner) return;
	if (groupId === -1) return;
	// Into an agent's group, from the user's tabs or another agent's group.
	const target = (await listSessions()).find((s) => isAgentSession(s.id) && s.groupId === groupId);
	if (!target || target.id === owner?.id) return;
	log(`gesture: tab=${tabId} given to ${target.id}`);
	await (await BrowserSession.existing(target.id))?.userGave(tabId, tab);
}

async function onTabRemoved(tabId: number, windowClosing: boolean): Promise<void> {
	if (isAgentTouching(tabId) || windowClosing) return;
	const owner = await sessionOwningTab(tabId);
	if (!owner || !isAgentSession(owner.id)) return;
	const session = await BrowserSession.existing(owner.id);
	if (!session) return;
	await session.reconcile();
	if (session.tabIds.length > 0) {
		await addNotice(owner.id, `Your tab ${tabId} was closed (by the user, or by the page itself).`);
		return;
	}
	// The agent's last tab or its whole group was closed (a page closing itself looks the same):
	// the group is gone, so the session is over.
	log(`gesture: ${owner.id} ended (its group was closed)`);
	await session.end({
		notice:
			"Your tab group was closed (its last tab too), which ended your session. navigate opens a new tab in a new group if the task needs one.",
	});
}

/** Wire the listeners. Call once per worker start. */
export function startGroupGestures(logger?: (line: string) => void): void {
	if (logger) log = logger;
	chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
		if (info.groupId !== undefined) void onGroupChanged(tabId, info.groupId, tab).catch(() => undefined);
	});
	chrome.tabs.onRemoved.addListener(
		(tabId, info) => void onTabRemoved(tabId, info.isWindowClosing).catch(() => undefined),
	);
}
