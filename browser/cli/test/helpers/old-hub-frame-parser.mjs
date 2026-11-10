// parseHubFrame as every device before the roster frame shipped it (cli/src/link-protocol.ts at 1342979), types
// removed and nothing else changed. Frozen on purpose: it is what an old device in the field runs, so a new hub
// frame must come out of it as undefined (the old `link run` drops those) and must not stop later frames parsing.
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
function toHeaders(v) {
	if (!isRecord(v)) return undefined;
	const out = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val !== "string" || val.length > 4096 || !/^[a-z0-9-]{1,64}$/.test(k)) return undefined;
		// A header value can't carry a line break.
		if (/[\r\n\0]/.test(val)) return undefined;
		out[k] = val;
	}
	return out;
}
export function oldParseHubFrame(text) {
	let v;
	try {
		v = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(v) || !isId(v.id)) return undefined;
	if (v.t === "cancel") return { t: "cancel", id: v.id };
	if (v.t !== "req") return undefined;
	const headers = toHeaders(v.headers);
	if (!headers || typeof v.body !== "string") return undefined;
	if (v.method !== "GET" && v.method !== "POST" && v.method !== "DELETE") return undefined;
	if (v.path !== "/mcp") return undefined;
	return { t: "req", id: v.id, method: v.method, path: "/mcp", headers, body: v.body };
}
