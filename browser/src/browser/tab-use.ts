/**
 * Which tabs a session is using right now (docs/decisions.md, D46). Pure: dialog-guard.ts and
 * veil.ts keep the state and feed it calls.
 *
 * A tab is in use while a tool call on it runs and for IN_USE_MS after the last one ended. A tab
 * that only sits in the agent's group, or is the session's current tab, is not in use until a call
 * acts on it. Only a tab in use may hold the user up: its veil shows, and a dialog its page opened
 * stays open for the agent to answer.
 */

import { VEIL_IDLE_MS } from "./veil-state.js";

/** As long as the veil stays after the last call: the gap between two calls never ends a tab's use. */
export const IN_USE_MS = VEIL_IDLE_MS;

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

export interface TabUse {
	/** Calls on the tab in flight. */
	busy: number;
	/** When the last call on the tab began or ended (ms). */
	lastAt: number;
}

export type TabUses = Readonly<Record<number, TabUse>>;

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

export function useBegin(uses: TabUses, tabId: number, at: number): TabUses {
	const old = uses[tabId];
	return { ...uses, [tabId]: { busy: (old?.busy ?? 0) + 1, lastAt: Math.max(old?.lastAt ?? 0, at) } };
}

/** A call ended on the tab. One that ends where it didn't begin (the navigate that opened the tab) counts too. */
export function useEnd(uses: TabUses, tabId: number, at: number): TabUses {
	const old = uses[tabId];
	return { ...uses, [tabId]: { busy: Math.max(0, (old?.busy ?? 0) - 1), lastAt: Math.max(old?.lastAt ?? 0, at) } };
}

export function useDrop(uses: TabUses, tabId: number): TabUses {
	if (!uses[tabId]) return uses;
	const next = { ...uses };
	delete next[tabId];
	return next;
}

/**
 * Until when the tab is in use: Infinity while a call runs, the end of its idle window after
 * that, undefined for a tab no call has used.
 */
export function inUseUntil(uses: TabUses, tabId: number, idleMs = IN_USE_MS): number | undefined {
	const u = uses[tabId];
	if (!u) return undefined;
	return u.busy > 0 ? Number.POSITIVE_INFINITY : u.lastAt + idleMs;
}

export function inUse(uses: TabUses, tabId: number, now: number, idleMs = IN_USE_MS): boolean {
	const until = inUseUntil(uses, tabId, idleMs);
	return until !== undefined && now < until;
}
