/**
 * Whether in-page scripts can use `chrome.userScripts`, and if not, why.
 *
 * Chromium 138+ exposes the API only when two separate things are true:
 * 1. The optional `userScripts` permission is granted (manifest `optional_permissions`;
 *    granted by `chrome.permissions.request` from a click, see Settings > Agents).
 * 2. The "Allow user scripts" toggle on the extension's Details page is on.
 * The toggle can be on while the permission was never granted; the API is then missing,
 * and the fix is the grant, not the toggle.
 *
 * The injection path (`src/browser/inject.ts`) and `bridge.debug` (what `polycarp browser doctor`
 * reads) both start from `userScriptsApi()` here, so they cannot disagree about presence.
 */

import type { UserScriptsStatus } from "../bridge/protocol.js";

export interface UserScriptsApi {
	configureWorld(config: { worldId: string; messaging?: boolean; csp?: string }): Promise<void>;
	execute(config: {
		js: Array<{ code: string }>;
		target: { tabId: number; allFrames?: boolean };
		world: "USER_SCRIPT";
		worldId?: string;
		injectImmediately?: boolean;
		executionId?: string;
	}): Promise<Array<{ result?: unknown; error?: unknown }>>;
	getScripts?(): Promise<unknown>;
	terminate?(tabId: number, executionId: string): Promise<void>;
}

/** The API the injection path uses, or undefined when `execute` is missing. */
export function userScriptsApi(): UserScriptsApi | undefined {
	try {
		// Reading the property can throw while the API is gated, so it is inside the try.
		const api = (chrome as unknown as { userScripts?: UserScriptsApi }).userScripts;
		return api && typeof api.execute === "function" ? api : undefined;
	} catch {
		return undefined;
	}
}

export type UserScriptsProbe = Omit<UserScriptsStatus, "state">;

// What Chromium says when a call is blocked by the toggle (or developer mode before 138).
const TOGGLE_ERROR = /toggle|allow user scripts|developer mode/i;

/**
 * True when `err` is the browser refusing a userScripts call (permission or toggle). Check only
 * errors thrown by the API call itself: a refused call never reached the page, so the debugger
 * path can run the code instead without running it twice. A script's own error is not this.
 */
export function isUserScriptsGated(err: unknown): boolean {
	return TOGGLE_ERROR.test(err instanceof Error ? err.message : String(err));
}

export function classifyUserScripts(probe: UserScriptsProbe): UserScriptsStatus {
	if (probe.apiPresent && probe.callWorks) return { ...probe, state: "ready" };
	if (probe.permissionGranted === false) return { ...probe, state: "not_granted" };
	if (probe.permissionGranted === true) {
		if (!probe.apiPresent) return { ...probe, state: "toggle_off" };
		if (!probe.error || isUserScriptsGated(probe.error)) return { ...probe, state: "toggle_off" };
	}
	return { ...probe, state: "probe_error", error: probe.error ?? "chrome.permissions.contains failed" };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function probeUserScripts(): Promise<UserScriptsStatus> {
	let permissionGranted: boolean | null = null;
	let error: string | undefined;
	try {
		permissionGranted = await chrome.permissions.contains({ permissions: ["userScripts"] });
	} catch (err) {
		error = `permissions.contains: ${message(err)}`;
	}
	const api = userScriptsApi();
	let callWorks = false;
	if (api) {
		try {
			if (typeof api.getScripts !== "function") throw new Error("userScripts.getScripts is missing");
			await api.getScripts();
			callWorks = true;
		} catch (err) {
			error = error ? `${error}; ${message(err)}` : message(err);
		}
	}
	return classifyUserScripts({ permissionGranted, apiPresent: api !== undefined, callWorks, error });
}
