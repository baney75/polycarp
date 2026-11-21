/**
 * Hosts an agent's tabs must never open (issue #94): the host of this machine's public URL, where
 * the OAuth approval page lives (remote.json, hub.json) and the hub a linked device joined
 * (link.json). The page asks for the owner's passcode, so a password manager or a prompt-injected
 * agent must not be able to reach it through browser.navigate. serve and the hub also answer on
 * loopback (127.0.0.1, localhost, [::1]) on their own port, so those aliases are guarded as
 * "host:port" entries: other local ports stay open. A person who opens the URL in their
 * own tab is unaffected: only agent-driven navigation is checked, in the extension.
 */

import { loadHubConfig } from "./hub-state.ts";
import { loadLinkConfig } from "./link.ts";
import { loadRemoteConfig } from "./remote-setup.ts";
import { DEFAULT_PORT } from "./tunnel.ts";

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

const portOf = (port: number | undefined): number[] => (port !== undefined && port > 0 ? [port] : []);

const hostnameOf = (url: string | undefined): string | undefined => {
	if (!url) return undefined;
	try {
		return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "") || undefined;
	} catch {
		return undefined;
	}
};

/** Lowercase hostnames and loopback "host:port" entries, deduplicated. A config file that is missing or unreadable adds nothing. */
export function guardedHosts(): string[] {
	const urls: (string | undefined)[] = [];
	const ports: number[] = [DEFAULT_PORT];
	for (const read of [
		() => {
			const remote = loadRemoteConfig();
			ports.push(...portOf(remote?.port));
			return remote?.publicUrl;
		},
		() => {
			const hub = loadHubConfig();
			ports.push(...portOf(hub?.port));
			return hub?.publicUrl;
		},
		() => loadLinkConfig()?.hubUrl,
	]) {
		try {
			urls.push(read());
		} catch {
			/* a broken file guards nothing; its own command reports it */
		}
	}
	const loopback = [...new Set(ports)].flatMap((port) => LOOPBACK.map((host) => `${host}:${port}`));
	return [...new Set([...urls.map(hostnameOf).filter((h): h is string => h !== undefined), ...loopback])];
}
