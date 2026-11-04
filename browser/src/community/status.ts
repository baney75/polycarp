/**
 * Community skills in the extension: where the host's status frame is kept and how its skills join
 * the bundled library. The host does the verifying and syncing (docs/decisions.md D27).
 */

import type { HostCommunityStatus } from "../bridge/protocol.js";

/** chrome.storage.local key the service worker keeps the host's latest community_status frame under. */
export const COMMUNITY_STATUS_KEY = "community.status";
/** The side panel's message to the service worker: on, off or sync. */
export const PANEL_COMMUNITY_MESSAGE = "tabkyra-community-action";

export type CommunityAction = "on" | "off" | "sync";

export async function readCommunityStatus(): Promise<HostCommunityStatus | undefined> {
	const stored = await chrome.storage.local.get(COMMUNITY_STATUS_KEY);
	return stored[COMMUNITY_STATUS_KEY] as HostCommunityStatus | undefined;
}

/**
 * The community skills the side panel can offer: none when the user turned them off, and none
 * whose name a bundled skill already has. The text starts with the header the MCP skill_read adds.
 */
export function communityLibrary(
	status: HostCommunityStatus | undefined,
	taken: ReadonlySet<string>,
): Array<{ name: string; description: string; text: string }> {
	if (!status?.enabled) return [];
	return status.skills
		.filter((s) => !taken.has(s.name))
		.map((s) => ({
			name: s.name,
			description: s.description,
			text: `${communityHeader(s.provenance, s.sites)}\n\n${s.text}`,
		}));
}

/**
 * The line before a community skill's text, the same as the CLI's skill_read adds. A user's own
 * edit of one keeps the scope but doesn't claim a maintainer reviewed it.
 */
export function communityHeader(provenance: string, sites: readonly string[]): string {
	const reviewed = provenance.startsWith("community")
		? "; written by the Tabkyra community and reviewed by a maintainer"
		: "";
	return `[${provenance}${reviewed}; scoped to ${sites.join(", ")}: use it only on those sites]`;
}
