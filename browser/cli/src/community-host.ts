/**
 * The native host's side of community skills (docs/decisions.md D27):
 *
 * - status: what the side panel shows and its "/" menu offers, sent as community_status on
 *   every hello and after every change;
 * - actions: the extension sends `{type: "community_action", action}` with action "on", "off"
 *   or "sync", and nothing else; a frame with any other field is refused;
 * - sync: about once a day while the host runs, and on "sync".
 */

import type { HostCommunitySkill, HostCommunityStatus, HostToExt } from "../../src/bridge/protocol.ts";
import { loadCatalog, readState, setEnabled, SYNC_INTERVAL_MS } from "./community-catalog.ts";
import { listSkills, readSkill, reconcileInstalled, syncCommunity } from "./skill.ts";

type Send = (message: HostToExt) => void;

export const COMMUNITY_ACTIONS = ["on", "off", "sync"] as const;
export type CommunityAction = (typeof COMMUNITY_ACTIONS)[number];

/** Exactly `{type, action}` with a known action, or undefined. */
export function parseCommunityAction(message: unknown): CommunityAction | undefined {
	if (!message || typeof message !== "object") return undefined;
	const keys = Object.keys(message);
	const m = message as { type?: unknown; action?: unknown };
	if (keys.length !== 2 || m.type !== "community_action" || typeof m.action !== "string") return undefined;
	return (COMMUNITY_ACTIONS as readonly string[]).includes(m.action) ? (m.action as CommunityAction) : undefined;
}

/** The status frame: community skills in use (or local copies of them) with their text. */
export function communityStatus(notes: string[] = []): HostCommunityStatus {
	const state = readState();
	const { catalog, problem } = loadCatalog();
	const skills: HostCommunitySkill[] = state.enabled
		? listSkills()
				.filter((s) => s.source === "community" || s.overrides === "community")
				.map((s) => ({ name: s.name, description: s.description, version: s.version, provenance: s.provenance, sites: s.sites ?? [], text: readSkill(s.name) }))
		: [];
	return {
		type: "community_status",
		enabled: state.enabled,
		serial: catalog?.serial,
		lastCheck: state.lastCheck,
		error: state.lastError ?? problem,
		skills,
		removed: state.removed.slice(-20).map((r) => ({ name: r.name, reason: r.reason })),
		notes,
	};
}

function sendStatus(send: Send, notes: string[] = []): void {
	try {
		send(communityStatus(notes));
	} catch (err) {
		process.stderr.write(`[tabkyra-host] community status failed: ${err instanceof Error ? err.message : String(err)}\n`);
	}
}

let syncing = false;

async function sync(send: Send, due: boolean): Promise<void> {
	if (syncing) return;
	syncing = true;
	try {
		const result = await syncCommunity({ due });
		sendStatus(send, result.notes);
	} catch (err) {
		process.stderr.write(`[tabkyra-host] community sync failed: ${err instanceof Error ? err.message : String(err)}\n`);
		sendStatus(send);
	} finally {
		syncing = false;
	}
}

export function handleCommunityAction(message: unknown, send: Send): void {
	const action = parseCommunityAction(message);
	if (!action) {
		process.stderr.write("[tabkyra-host] refused a community_action frame\n");
		return;
	}
	if (action === "sync") {
		void sync(send, false);
		return;
	}
	setEnabled(action === "on");
	if (action === "off") reconcileInstalled();
	if (action === "on") void sync(send, false);
	else sendStatus(send);
}

/** On each hello: the status now, then a sync if the last one is over a day old. */
export function onCommunityHello(send: Send): void {
	sendStatus(send);
	void sync(send, true);
}

/** Sync about once a day while the host runs (the browser keeps it running). */
export function startCommunityTimer(send: Send): void {
	const timer = setInterval(() => void sync(send, true), Math.min(SYNC_INTERVAL_MS, 60 * 60 * 1000));
	timer.unref();
}
