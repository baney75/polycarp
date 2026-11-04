/**
 * `tabkyra hub`: remote MCP profile — tokens scoped to browser.read and browser.navigate
 * only, and a Tailscale tunnel with Funnel off by default. Nothing in this module turns Funnel on.
 */

import { createToken, loadTokens, SCOPES } from "./remote.ts";
import { DEFAULT_PORT, tailscaleTunnel } from "./tunnel.ts";

export const HUB_SCOPES = ["browser.read", "browser.navigate"] as const;

export function hubScopesValid(scopes: string[]): boolean {
	return scopes.length === HUB_SCOPES.length && HUB_SCOPES.every((s) => scopes.includes(s));
}

/** Create a new hub-scoped token. Fails if the name is already taken. */
export function createHubToken(name = "hub"): { token: string; id: string } {
	for (const s of HUB_SCOPES) {
		if (!Object.hasOwn(SCOPES, s)) throw new Error(`Unknown hub scope ${s}`);
	}
	if (loadTokens().some((t) => t.name === name && !t.revokedAt)) {
		throw new Error(
			`A token named ${name} already exists. Revoke it with tabkyra token revoke <id>, or pass a different --name.`,
		);
	}
	const { token, record } = createToken(name, [...HUB_SCOPES]);
	return { token, id: record.id };
}

/** Open the Tailscale path to serve. Funnel stays off (`public: false`). */
export function hubTunnel(port = DEFAULT_PORT): { ok: boolean; url?: string; message: string } {
	return tailscaleTunnel({ port, public: false, off: false });
}

export { DEFAULT_PORT, HUB_SCOPES as hubScopeList };
