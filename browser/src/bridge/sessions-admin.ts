/**
 * `tabkyra sessions`: list, rename, end and control agent sessions and their tab groups from the
 * terminal. These run for a maintenance client, never open a session of their own, and act as
 * the user (the same trust as the side panel): only a local user process reaches the bridge.
 */

import {
	addNotice,
	BrowserSession,
	isAgentSession,
	listSessions,
	sanitizeLabel,
	takeNotices,
} from "../browser/session.js";
import { ERR } from "./protocol.js";
import { BridgeError } from "./tools.js";

type Params = Record<string, unknown>;

/** What native.ts lends this module: the live clients, and a way to repoint them after a rename. */
export interface AdminHost {
	liveSessionKeys(): Map<string, number>;
	renameLive(oldId: string, newId: string, newName: string): void;
}

/** The user-facing name of a stored session: what `tabkyra mcp --session` takes. */
function nameOf(s: { id: string; name?: string; agent?: string }): string {
	if (s.name) return s.name;
	const id = s.id.replace(/^bridge-/, "");
	return s.agent && id.startsWith(`${s.agent}-`) ? id.slice(s.agent.length + 1) : id;
}

async function describe(
	s: Awaited<ReturnType<typeof listSessions>>[number],
	live: Map<string, number>,
	withTabs: boolean,
) {
	const group = s.groupId === undefined ? undefined : await chrome.tabGroups.get(s.groupId).catch(() => undefined);
	const tabs: Array<{ tabId: number; url: string; title: string; current: boolean }> = [];
	for (const id of s.tabIds) {
		const tab = await chrome.tabs.get(id).catch(() => undefined);
		if (tab)
			tabs.push({
				tabId: id,
				url: tab.url ?? tab.pendingUrl ?? "",
				title: tab.title ?? "",
				current: id === s.currentTabId,
			});
	}
	return {
		id: s.id,
		name: nameOf(s),
		kind: isAgentSession(s.id) ? "agent" : "panel",
		agent: s.agent ?? (isAgentSession(s.id) ? s.label.split(" · ")[0] : undefined),
		project: s.project,
		label: s.label,
		group: group
			? { title: group.title ?? "", color: group.color, collapsed: group.collapsed, windowId: group.windowId }
			: null,
		color: s.color,
		tabCount: tabs.length,
		...(withTabs ? { tabs } : {}),
		connected: live.get(s.id) ?? 0,
		createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
		lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt).toISOString() : null,
	};
}

/**
 * The one session `query` names: its name, id, label or group title, or a unique prefix of its
 * name. Side panel chats are matched only when `panel` allows them.
 */
async function resolve(query: string, panel = false) {
	const q = query.trim().toLowerCase();
	if (!q) throw new BridgeError(ERR.BAD_PARAMS, "Which session? Give its name (tabkyra sessions lists them).");
	const all = (await listSessions()).filter((s) => panel || isAgentSession(s.id));
	const exact = all.filter((s) =>
		[nameOf(s), s.id, s.label, `Tabkyra · ${s.label}`].some((v) => v.toLowerCase() === q),
	);
	const hits = exact.length ? exact : all.filter((s) => nameOf(s).toLowerCase().startsWith(q));
	if (hits.length === 1) return hits[0];
	if (hits.length === 0)
		throw new BridgeError(ERR.NOT_FOUND, `No agent session matches "${query}". tabkyra sessions lists them.`);
	throw new BridgeError(
		ERR.BAD_PARAMS,
		`"${query}" matches ${hits.length} sessions: ${hits.map(nameOf).join(", ")}. Give the full name.`,
	);
}

export async function handleSessionsAdmin(method: string, params: Params, host: AdminHost): Promise<unknown> {
	const live = host.liveSessionKeys();
	switch (method) {
		case "sessions.list": {
			const all = (await listSessions()).filter((s) => params.all === true || isAgentSession(s.id));
			const out = [];
			for (const s of all) out.push(await describe(s, live, params.tabs === true));
			out.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""));
			return { sessions: out };
		}
		case "sessions.rename": {
			const from = await resolve(String(params.from ?? ""));
			const to = String(params.to ?? "")
				.trim()
				.toLowerCase();
			if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(to))
				throw new BridgeError(
					ERR.BAD_PARAMS,
					"A session name is 1 to 64 lowercase letters, digits, - or _, starting with a letter or digit.",
				);
			const agent = from.agent ?? from.label.split(" · ")[0];
			const newId = `bridge-${agent.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "harness"}-${to}`;
			if (newId === from.id) return { renamed: nameOf(from), to };
			if ((await listSessions()).some((s) => s.id === newId))
				throw new BridgeError(ERR.BAD_PARAMS, `A session named ${to} already exists for ${agent}.`);
			await BrowserSession.rename(from.id, newId);
			const session = await BrowserSession.existing(newId);
			if (session) {
				await session.setMeta({ name: to });
				await session.setLabel(sanitizeLabel(`${agent} · ${to}`));
			}
			const notices = await takeNotices(from.id);
			for (const n of notices) await addNotice(newId, n);
			host.renameLive(from.id, newId, to);
			return { renamed: nameOf(from), to, group: session?.groupName };
		}
		case "sessions.end": {
			const s = await resolve(String(params.name ?? ""));
			const session = await BrowserSession.existing(s.id);
			if (!session) throw new BridgeError(ERR.NOT_FOUND, `No agent session matches "${params.name}".`);
			const close = params.close === true;
			const result = await session.end({
				close,
				notice: `The user ended your session from the terminal${close ? " and closed its tabs" : "; its tabs are theirs now"}. navigate opens a new tab in a new group if the task needs one.`,
			});
			return { ended: nameOf(s), ...result };
		}
		case "sessions.group": {
			// focus | collapse | expand: the user's own view of a group.
			const s = await resolve(String(params.name ?? ""));
			const action = String(params.action ?? "");
			if (s.groupId === undefined || !(await chrome.tabGroups.get(s.groupId).catch(() => undefined)))
				throw new BridgeError(ERR.NOT_FOUND, `${nameOf(s)} has no tab group open right now.`);
			if (action === "collapse" || action === "expand") {
				await chrome.tabGroups.update(s.groupId, { collapsed: action === "collapse" });
				return { group: nameOf(s), collapsed: action === "collapse" };
			}
			if (action === "focus") {
				// The current tab, else the first that still exists; shown the way tabs_show shows one
				// (the agent's viewport override released first, so the user sees the real page).
				let tabId: number | undefined;
				for (const id of [...(s.currentTabId !== undefined ? [s.currentTabId] : []), ...s.tabIds])
					if (await chrome.tabs.get(id).catch(() => undefined)) {
						tabId = id;
						break;
					}
				const session = await BrowserSession.existing(s.id);
				if (tabId === undefined || !session) throw new BridgeError(ERR.NO_TAB, `${nameOf(s)} has no tabs.`);
				await chrome.tabGroups.update(s.groupId, { collapsed: false });
				await session.show(tabId);
				return { focused: nameOf(s), tabId };
			}
			throw new BridgeError(ERR.BAD_PARAMS, "action is focus, collapse or expand");
		}
	}
	throw new BridgeError(ERR.NOT_FOUND, `Unknown method ${method}`);
}
