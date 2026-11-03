/** Small text helpers for Settings > Connect. */

import { CONNECT_CODE, HUB_ORIGIN } from "../agent-setup-prompt.js";
import type { ApprovalCode, ConnectStatus, DeviceCode, JoinScope } from "./types.js";

export const MALFORMED_CODE = "The helper answered with a malformed code. Try again, or update it: tabkyra update";

/**
 * A code reply is shown in a box the owner copies, and a device code also goes into a command they
 * paste into a shell. Only the exact shapes may be drawn: a code TK-XXXX-XXXX, an origin, a time.
 */
export function validApprovalCode(value: ApprovalCode | undefined): value is ApprovalCode {
	return (
		value !== undefined &&
		typeof value.code === "string" &&
		CONNECT_CODE.test(value.code) &&
		Number.isFinite(value.expiresAt) &&
		typeof value.connectorUrl === "string" &&
		value.connectorUrl.endsWith("/mcp") &&
		HUB_ORIGIN.test(value.connectorUrl.slice(0, -4))
	);
}

export function validDeviceCode(value: DeviceCode | undefined): value is DeviceCode {
	return (
		value !== undefined &&
		typeof value.code === "string" &&
		CONNECT_CODE.test(value.code) &&
		Number.isFinite(value.expiresAt) &&
		typeof value.hubUrl === "string" &&
		HUB_ORIGIN.test(value.hubUrl)
	);
}

/** "9:41" for the time left on a code, or "" once it has expired. */
export function countdown(expiresAt: number, now: number): string {
	const left = Math.ceil((expiresAt - now) / 1000);
	if (left <= 0) return "";
	return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** "never", "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function lastSeen(iso: string | null, now: number): string {
	if (!iso) return "never";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "never";
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
	if (seconds < 60) return "just now";
	if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
	if (seconds < 86_400) return unit(Math.round(seconds / 3600), "hour");
	return unit(Math.round(seconds / 86_400), "day");
}

/** The connector URL for an origin. */
export const connectorUrl = (origin: string): string => `${origin}/mcp`;

/** The command another device runs to join a hub. */
export const linkCommand = (hubUrl: string, code: string): string => `tabkyra link ${hubUrl} --code ${code}`;

/** The host of a hub address as typed (a pasted connector URL included), or undefined when it isn't an address. */
export function hubHost(typed: string): string | undefined {
	const text = typed.trim();
	if (!text || text.length > 300) return undefined;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
		return url.host || undefined;
	} catch {
		return undefined;
	}
}

/** What the person is told before a hub is given control of this browser. */
export const JOIN_WARNING =
	"The hub's owner will be able to open sites, read pages, and click and type in this browser as you.";

/** Said when the helper's status has no scope list (a helper from before the list): joining is not offered. */
export const HELPER_OUT_OF_DATE = "Tabkyra's helper is out of date. Run tabkyra update, then try again.";

/** The scopes a join would grant, as the helper listed them; undefined when it listed none in the shape this panel reads. */
export function joinScopesOf(status: Pick<ConnectStatus, "joinScopes">): JoinScope[] | undefined {
	const list: unknown = status.joinScopes;
	if (!Array.isArray(list) || list.length === 0) return undefined;
	const out: JoinScope[] = [];
	for (const item of list) {
		const entry = item as Partial<JoinScope> | null;
		if (!entry || typeof entry.id !== "string" || typeof entry.what !== "string" || !entry.id || !entry.what)
			return undefined;
		out.push({ id: entry.id, what: entry.what.slice(0, 200) });
	}
	return out;
}
