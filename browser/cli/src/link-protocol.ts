/**
 * The wire protocol on the device link (JSON text frames over a WebSocket from the device to the hub).
 *
 * hub to device: {t:"req", id, method, path:"/mcp", headers, body}, {t:"cancel", id} and {t:"roster", devices}
 * device to hub: {t:"head", id, status, headers}, {t:"chunk", id, data}, {t:"end", id},
 *                {t:"error", id, message} and {t:"status", ...} (the heartbeat)
 *
 * Every frame is checked against these shapes on arrival; anything else is dropped. A device from before the roster
 * frame drops it too: its parser required an id on every hub frame, and a roster has none.
 */

/**
 * A request body of up to MAX_BODY_BYTES is sent as a JSON string, and escaping can double it (every
 * backslash or quote) or, for stray control characters, multiply it by six. The frame limit leaves
 * room for the doubling; the hub checks the serialized size before sending and answers a request
 * that still doesn't fit with 413, without touching the link.
 */
export const MAX_BODY_BYTES = 4_000_000;
export const MAX_FRAME_BYTES = 16_000_000;
/** Requests (POST and DELETE) one device handles at once. Long-lived GET streams are counted apart. */
export const MAX_INFLIGHT_PER_DEVICE = 32;
/** Open MCP sessions a device's link token may hold, and so the most GET streams it can hold (one per session). */
export const MAX_LINK_SESSIONS = 24;
export const HEARTBEAT_MS = 15_000;
export const PING_MS = 20_000;
export const SILENT_MS = 60_000;
/** One chunk frame carries at most this much text, well inside MAX_FRAME_BYTES. */
export const CHUNK_BYTES = 256_000;

/** The only request headers a hub forwards to a device (lower case), besides the hub headers (remote.ts HUB_HEADERS). */
export const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"] as const;
/** The only response headers a device sends back. */
export const FORWARD_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control", "mcp-protocol-version"] as const;

export type Headers = Record<string, string>;

export interface ReqFrame {
	t: "req";
	id: string;
	method: "GET" | "POST" | "DELETE";
	path: "/mcp";
	headers: Headers;
	body: string;
}

export interface CancelFrame {
	t: "cancel";
	id: string;
}

export interface StatusFrame {
	t: "status";
	extensionConnected: boolean;
	sessions: number;
	busy: boolean;
	version: string;
	browser: string | null;
	/** How many sessions this device accepts; the hub stops routing new ones to a full device. */
	sessionCap: number;
	/** The scopes this device allows at most (its link token's cap). */
	scopes: string[];
	/** Polycarp's computer-use helper is on this device. Absent from devices older than the roster. */
	computer?: boolean;
	/** process.platform: darwin, linux, win32. Absent from devices older than the roster. */
	platform?: string;
}

/** Most devices a roster carries. */
export const MAX_ROSTER_DEVICES = 200;

/** One device as the hub tells its devices about it. lastSeen is null while it is online, or when it never connected. */
export interface RosterDevice {
	id: string;
	name: string;
	online: boolean;
	lastSeen: string | null;
	scopes: string[];
	computer: boolean;
	extension: boolean;
	platform: string | null;
}

/** Every device enrolled on the hub, sent to each linked device when any of them changes and when it connects. Read-only data: it never changes what a device allows. */
export interface RosterFrame {
	t: "roster";
	devices: RosterDevice[];
}

export type DeviceFrame = StatusFrame | { t: "head"; id: string; status: number; headers: Headers } | { t: "chunk"; id: string; data: string } | { t: "end"; id: string } | { t: "error"; id: string; message: string };
export type HubFrame = ReqFrame | CancelFrame | RosterFrame;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const isScopes = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 64 && v.every((x) => typeof x === "string" && x.length <= 40);
const isPlatform = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9]{1,20}$/.test(v);
/** Same shape as hub-state.ts validDeviceName, kept here so this file imports nothing. */
const isDeviceName = (v: unknown): v is string => typeof v === "string" && /^[\w.][\w. -]{0,39}$/.test(v);

function toRosterDevice(v: unknown): RosterDevice | undefined {
	if (!isRecord(v)) return undefined;
	const { id, name, online, lastSeen, scopes, computer, extension, platform } = v;
	if (typeof id !== "string" || !/^[a-z0-9-]{6,40}$/.test(id) || !isDeviceName(name)) return undefined;
	if (typeof online !== "boolean" || typeof computer !== "boolean" || typeof extension !== "boolean" || !isScopes(scopes)) return undefined;
	if (lastSeen !== null && (typeof lastSeen !== "string" || lastSeen.length > 40)) return undefined;
	if (platform !== null && !isPlatform(platform)) return undefined;
	return { id, name, online, lastSeen, scopes: [...scopes], computer, extension, platform };
}

/** A string-to-string map with names and values small enough to be headers, or undefined. */
function toHeaders(v: unknown): Headers | undefined {
	if (!isRecord(v)) return undefined;
	const out: Headers = {};
	for (const [k, val] of Object.entries(v)) {
		if (typeof val !== "string" || val.length > 4096 || !/^[a-z0-9-]{1,64}$/.test(k)) return undefined;
		// A header value can't carry a line break.
		if (/[\r\n\0]/.test(val)) return undefined;
		out[k] = val;
	}
	return out;
}

export function parseDeviceFrame(text: string): DeviceFrame | undefined {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(v)) return undefined;
	if (v.t === "status") {
		const { extensionConnected, sessions, busy, version, browser, sessionCap, scopes } = v;
		if (typeof extensionConnected !== "boolean" || typeof busy !== "boolean") return undefined;
		if (typeof sessions !== "number" || !Number.isInteger(sessions) || sessions < 0 || sessions > 10_000) return undefined;
		if (typeof version !== "string" || version.length > 40) return undefined;
		if (browser !== null && (typeof browser !== "string" || browser.length > 40)) return undefined;
		if (typeof sessionCap !== "number" || !Number.isInteger(sessionCap) || sessionCap < 1 || sessionCap > 10_000) return undefined;
		if (!isScopes(scopes)) return undefined;
		// Newer fields are optional: a device from before them still reports, and a malformed one is left out rather than failing the frame.
		const extra: Pick<StatusFrame, "computer" | "platform"> = {};
		if (typeof v.computer === "boolean") extra.computer = v.computer;
		if (isPlatform(v.platform)) extra.platform = v.platform;
		return { t: "status", extensionConnected, sessions, busy, version, browser: browser ?? null, sessionCap, scopes: [...scopes], ...extra };
	}
	if (!isId(v.id)) return undefined;
	if (v.t === "head") {
		const headers = toHeaders(v.headers);
		if (typeof v.status !== "number" || !Number.isInteger(v.status) || v.status < 100 || v.status > 599 || !headers) return undefined;
		return { t: "head", id: v.id, status: v.status, headers };
	}
	if (v.t === "chunk") return typeof v.data === "string" ? { t: "chunk", id: v.id, data: v.data } : undefined;
	if (v.t === "end") return { t: "end", id: v.id };
	if (v.t === "error") return { t: "error", id: v.id, message: typeof v.message === "string" ? v.message.slice(0, 300) : "error" };
	return undefined;
}

export function parseHubFrame(text: string): HubFrame | undefined {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(v)) return undefined;
	if (v.t === "roster") {
		if (!Array.isArray(v.devices) || v.devices.length > MAX_ROSTER_DEVICES) return undefined;
		const devices = v.devices.map(toRosterDevice);
		return devices.every((d) => d !== undefined) ? { t: "roster", devices: devices as RosterDevice[] } : undefined;
	}
	if (!isId(v.id)) return undefined;
	if (v.t === "cancel") return { t: "cancel", id: v.id };
	if (v.t !== "req") return undefined;
	const headers = toHeaders(v.headers);
	if (!headers || typeof v.body !== "string") return undefined;
	if (v.method !== "GET" && v.method !== "POST" && v.method !== "DELETE") return undefined;
	if (v.path !== "/mcp") return undefined;
	return { t: "req", id: v.id, method: v.method, path: "/mcp", headers, body: v.body };
}
