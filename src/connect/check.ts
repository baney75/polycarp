/** The background worker's first look at a Connect request from the side panel; the host parses the rest. */

import { CONNECT_METHODS, type ConnectRequest } from "./types.js";

const METHODS: ReadonlySet<string> = new Set(CONNECT_METHODS);

/** The request as the host should get it, or the reason it is refused here. */
export function checkConnectRequest(
	raw: unknown,
): { ok: true; request: ConnectRequest } | { ok: false; id?: number; message: string } {
	const req = raw as Partial<ConnectRequest> | null;
	if (typeof req !== "object" || req === null || typeof req.id !== "number")
		return { ok: false, message: "A request has a numeric id." };
	if (typeof req.method !== "string") return { ok: false, id: req.id, message: "The method must be a string." };
	if (!METHODS.has(req.method)) return { ok: false, id: req.id, message: `Unknown method ${req.method.slice(0, 40)}` };
	if (
		req.params !== undefined &&
		(typeof req.params !== "object" || req.params === null || Array.isArray(req.params))
	) {
		return { ok: false, id: req.id, message: "params must be an object." };
	}
	return { ok: true, request: { id: req.id, method: req.method, ...(req.params ? { params: req.params } : {}) } };
}
