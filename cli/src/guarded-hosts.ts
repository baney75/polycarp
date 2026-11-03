/**
 * Hosts an agent's tabs must never open (issue #94): the host of this machine's public URL, where
 * the OAuth approval page lives (remote.json, hub.json) and the hub a linked device joined
 * (link.json). The page asks for the owner's passcode, so a password manager or a prompt-injected
 * agent must not be able to reach it through browser.navigate. A person who opens the URL in their
 * own tab is unaffected: only agent-driven navigation is checked, in the extension.
 */

import { loadHubConfig } from "./hub-state.ts";
import { loadLinkConfig } from "./link.ts";
import { loadRemoteConfig } from "./remote-setup.ts";

const hostnameOf = (url: string | undefined): string | undefined => {
	if (!url) return undefined;
	try {
		return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "") || undefined;
	} catch {
		return undefined;
	}
};

/** Lowercase hostnames, deduplicated. A config file that is missing or unreadable adds nothing. */
export function guardedHosts(): string[] {
	const urls: (string | undefined)[] = [];
	for (const read of [() => loadRemoteConfig()?.publicUrl, () => loadHubConfig()?.publicUrl, () => loadLinkConfig()?.hubUrl]) {
		try {
			urls.push(read());
		} catch {
			/* a broken file guards nothing; its own command reports it */
		}
	}
	return [...new Set(urls.map(hostnameOf).filter((h): h is string => h !== undefined))];
}
