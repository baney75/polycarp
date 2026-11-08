/**
 * Network capture to a HAR 1.2 file: the DevTools Network events of one tab, folded into entries,
 * with secrets taken out before anything leaves the extension.
 *
 * What a HAR never holds:
 * - the value of Authorization, Cookie, Set-Cookie, Proxy-Authorization, or any header whose name
 *   contains token, key, secret or auth; the same names in a query string, plus whatever
 *   mask-body.ts treats as a credential (a token's shape, a password's name, an OAuth code);
 * - any request body, whatever the address or page;
 * - a value that has the shape of a credential (a JWT, a long hex or base64 token, a Bearer or Basic
 *   scheme, a known key prefix) under any name: in a header, a query or a JSON response body;
 * - more than 64 KB (UTF-8 bytes) of any body, or a response body that isn't same-origin JSON with its secrets masked.
 *
 * Every address that can enter the file goes through `redactUrl`: the request URL, the query string, a
 * redirect's target, and any header whose value is a path or an address, which on HTTP/2 and HTTP/3 includes the
 * `:path` pseudo-header. The page's URL, the response's own URL, the fragment and the initiator are never stored.
 *
 * The builder only reads events. The caller fetches the bodies the builder asks for
 * (`wantsResponseBody`) and hands them back, so this runs and is tested without a browser.
 */

import { holdsCredential, maskJsonResponse, maskUrl } from "./mask-body.js";

export const HAR_BODY_CAP = 64 * 1024;
/** A capture stops growing here. The frame to the helper holds 60 MiB, and this leaves room for its envelope. */
export const HAR_SIZE_CAP = 50_000_000;
/** What the HAR's own wrapper (version, creator, comment) takes, counted against the size cap before any entry. */
export const HAR_ENVELOPE_BYTES = 2048;
export const REDACTED = "[redacted]";

/** The size of a string as UTF-8, which is what the cap, the helper's file and the bridge frame all count (not UTF-16 units). */
export function utf8Bytes(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A whole value that is one long opaque token: 32 or more hex digits, 32 or more letters and digits with
 * both kinds present, or a base64 or base64url run with upper case, lower case and a digit. A UUID, a slug
 * and a sentence are not.
 */
export function looksLikeToken(value: string): boolean {
	const v = value.trim();
	if (v.length < 32 || UUID.test(v)) return false;
	if (/^[0-9a-f]+$/i.test(v)) return true;
	const digit = /\d/.test(v);
	if (/^[A-Za-z0-9]+$/.test(v)) return digit && /[A-Za-z]/.test(v);
	return /^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && digit && /[a-z]/.test(v) && /[A-Z]/.test(v);
}

/** Whether a value, wherever it sits, has the shape of a credential. */
export function credentialShaped(value: string): boolean {
	return holdsCredential(value) || looksLikeToken(value);
}

/** An authorization scheme at the start of a header value: what follows is a credential however short. */
const SCHEME_VALUE = /^\s*(?:bearer|basic|digest|negotiate|ntlm|token)\s+\S/i;
/** A path or an address: a token can ride in its query. */
const ADDRESS_VALUE = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i;

export interface HarHeader {
	name: string;
	value: string;
}

const SECRET_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization"]);
const SECRET_NAME = /token|key|secret|auth/i;

/** Whether a header's value is a credential. */
export function isSecretHeader(name: string): boolean {
	const n = name.toLowerCase();
	return SECRET_HEADERS.has(n) || SECRET_NAME.test(n);
}

/** Headers whose value is an address, whatever it looks like. Others are read by their value (ADDRESS_VALUE). */
const URL_HEADERS = new Set(["location", "referer", "content-location", ":path"]);

function redactHeaderValue(name: string, value: string): string {
	if (isSecretHeader(name)) return REDACTED;
	if (URL_HEADERS.has(name.toLowerCase())) return redactUrl(value);
	if (SCHEME_VALUE.test(value) || credentialShaped(value)) return REDACTED;
	return ADDRESS_VALUE.test(value) ? redactUrl(value) : value;
}

/** DevTools gives headers as an object; a header sent twice is one value joined with newlines. */
export function redactHeaders(headers: Record<string, unknown> | undefined): HarHeader[] {
	const out: HarHeader[] = [];
	for (const [name, raw] of Object.entries(headers ?? {})) {
		for (const value of String(raw).split("\n")) out.push({ name, value: redactHeaderValue(name, value) });
	}
	return out;
}

/** An address with credentials taken out of its query and fragment. */
export function redactUrl(url: string): string {
	let masked = maskUrl(url);
	try {
		const u = new URL(masked, "https://relative.invalid");
		let changed = false;
		// A reset or magic link carries its token in the path.
		const segments = u.pathname.split("/");
		if (segments.some(looksLikeToken)) {
			u.pathname = segments.map((s) => (looksLikeToken(s) ? REDACTED : s)).join("/");
			changed = true;
		}
		for (const [key, value] of [...u.searchParams])
			if (SECRET_NAME.test(key) || looksLikeToken(value)) {
				u.searchParams.set(key, REDACTED);
				changed = true;
			}
		if (u.hash.includes("=")) {
			const fragment = new URLSearchParams(u.hash.slice(1));
			let hit = false;
			for (const [key, value] of [...fragment])
				if (SECRET_NAME.test(key) || looksLikeToken(value)) {
					fragment.set(key, REDACTED);
					hit = true;
				}
			if (hit) {
				u.hash = fragment.toString();
				changed = true;
			}
		}
		if (changed) masked = /^[a-z][a-z0-9+.-]*:/i.test(masked) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
	} catch {
		/* not an address: as masked */
	}
	return masked;
}

function queryString(url: string): HarHeader[] {
	try {
		return [...new URL(redactUrl(url)).searchParams].map(([name, value]) => ({ name, value }));
	} catch {
		return [];
	}
}

/** Sign-in and token endpoints: whatever is sent to them is a credential, whatever its shape. */
const AUTH_PATH = /login|log-in|logon|signin|sign-in|signon|auth|password|passwd|token|credential/i;

export function isAuthPath(url: string): boolean {
	try {
		return AUTH_PATH.test(decodeURIComponent(new URL(url).pathname));
	} catch {
		return AUTH_PATH.test(url);
	}
}

export interface StoredBody {
	text?: string;
	/** Why there is no text. */
	comment?: string;
}

const JSON_TYPE = /^application\/(?:json|[\w.+-]*\+json)\b/i;

function originOf(url: string | undefined): string | undefined {
	try {
		return url ? new URL(url).origin : undefined;
	} catch {
		return undefined;
	}
}

/** A same-origin JSON response body that fits, with its secrets masked. */
export function redactResponseBody(text: string): StoredBody {
	if (utf8Bytes(text) > HAR_BODY_CAP) return { comment: `body not stored: over ${HAR_BODY_CAP / 1024} KB` };
	const masked = maskJsonResponse(text, looksLikeToken);
	return masked === undefined ? { comment: "body not stored: not complete JSON" } : { text: masked };
}

// ---- Events to entries -------------------------------------------------------------------

type Params = Record<string, unknown>;

interface Pending {
	requestId: string;
	startedWall: number;
	startedMono: number;
	method: string;
	url: string;
	documentURL?: string;
	type?: string;
	headers: Record<string, unknown>;
	extraHeaders?: Record<string, unknown>;
	/** Bytes of the request body, when known. */
	bodySize: number;
	hasBody: boolean;
	body?: StoredBody;
	response?: {
		status: number;
		statusText: string;
		headers: Record<string, unknown>;
		extraHeaders?: Record<string, unknown>;
		mimeType: string;
		protocol?: string;
		remoteIPAddress?: string;
		connectionId?: number;
		timing?: Params;
	};
	responseBody?: StoredBody;
	dataLength: number;
	encodedLength?: number;
	finishedMono?: number;
	failed?: string;
	canceled?: boolean;
}

export interface HarEntry {
	startedDateTime: string;
	time: number;
	request: {
		method: string;
		url: string;
		httpVersion: string;
		cookies: [];
		headers: HarHeader[];
		queryString: HarHeader[];
		postData?: { mimeType: string; text?: string; comment?: string };
		headersSize: number;
		bodySize: number;
	};
	response: {
		status: number;
		statusText: string;
		httpVersion: string;
		cookies: [];
		headers: HarHeader[];
		content: { size: number; mimeType: string; text?: string; comment?: string };
		redirectURL: string;
		headersSize: number;
		bodySize: number;
		_error?: string;
	};
	cache: Record<string, never>;
	timings: Record<string, number>;
	serverIPAddress?: string;
	connection?: string;
	_resourceType?: string;
}

export interface Har {
	log: {
		version: "1.2";
		creator: { name: string; version: string };
		comment: string;
		entries: HarEntry[];
	};
}

function httpVersion(protocol: string | undefined): string {
	const p = (protocol ?? "").toLowerCase();
	if (p === "h2") return "HTTP/2.0";
	if (p === "h3" || p.startsWith("h3-")) return "HTTP/3.0";
	if (p === "http/1.0") return "HTTP/1.0";
	return "HTTP/1.1";
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Params => (v && typeof v === "object" ? (v as Params) : {});

function headerOf(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return String(v);
	return undefined;
}

export interface HarBuilderOptions {
	/** Stop adding once the entries would total this many bytes (default HAR_SIZE_CAP). */
	maxBytes?: number;
}

/** Most requests whose extra headers wait for their event; past this the oldest are forgotten. */
const MAX_EARLY = 500;

export class HarBuilder {
	private readonly early = new Map<string, { request?: Params; response?: Params }>();
	readonly maxBytes: number;
	private pending = new Map<string, Pending>();
	private done: HarEntry[] = [];
	private bytes = HAR_ENVELOPE_BYTES;
	private skipped = 0;
	private capped = false;

	constructor(options: HarBuilderOptions = {}) {
		this.maxBytes = options.maxBytes ?? HAR_SIZE_CAP;
	}

	/** The size cap was reached: later requests are not recorded. */
	get full(): boolean {
		return this.capped;
	}

	/** About how many bytes the file will take. */
	get size(): number {
		return this.bytes;
	}

	/** Entries finished so far. */
	get count(): number {
		return this.done.length;
	}

	/** Requests seen after the cap was reached. */
	get dropped(): number {
		return this.skipped;
	}

	/** Feed one DevTools Network event. */
	event(method: string, params: Params): void {
		const id = str(params.requestId);
		if (!id) return;
		switch (method) {
			case "Network.requestWillBeSent": {
				const redirect = rec(params.redirectResponse);
				const previous = this.pending.get(id);
				if (previous && Object.keys(redirect).length) {
					this.respond(previous, redirect);
					previous.finishedMono = num(params.timestamp);
					this.finish(id);
				}
				if (this.capped) {
					this.skipped++;
					return;
				}
				this.start(id, params);
				return;
			}
			case "Network.requestWillBeSentExtraInfo": {
				const p = this.pending.get(id);
				if (p) p.extraHeaders = rec(params.headers);
				else this.earlyExtra(id).request = rec(params.headers);
				return;
			}
			case "Network.responseReceived": {
				const p = this.pending.get(id);
				if (p) this.respond(p, rec(params.response));
				return;
			}
			case "Network.responseReceivedExtraInfo": {
				const p = this.pending.get(id);
				if (p?.response) p.response.extraHeaders = rec(params.headers);
				else this.earlyExtra(id).response = rec(params.headers);
				return;
			}
			case "Network.dataReceived": {
				const p = this.pending.get(id);
				if (p) p.dataLength += num(params.dataLength) ?? 0;
				return;
			}
			case "Network.loadingFinished": {
				const p = this.pending.get(id);
				if (!p) return;
				p.finishedMono = num(params.timestamp);
				p.encodedLength = num(params.encodedDataLength);
				// A JSON response waits for its body (setResponseBody or complete); anything else is done.
				if (!this.wantsResponseBody(id)) this.finish(id);
				return;
			}
			case "Network.loadingFailed": {
				const p = this.pending.get(id);
				if (!p) return;
				p.failed = str(params.errorText) || "failed";
				p.canceled = params.canceled === true;
				p.finishedMono = num(params.timestamp);
				this.finish(id);
				return;
			}
		}
	}

	/** DevTools may send a request's extra headers before the event they belong to; they wait here. */
	private earlyExtra(id: string): { request?: Params; response?: Params } {
		if (this.early.size >= MAX_EARLY && !this.early.has(id)) this.early.clear();
		const held = this.early.get(id) ?? {};
		this.early.set(id, held);
		return held;
	}

	private start(id: string, params: Params): void {
		const request = rec(params.request);
		const inline = str(request.postData);
		const hasBody = request.hasPostData === true || inline.length > 0;
		const p: Pending = {
			requestId: id,
			startedWall: num(params.wallTime) ?? Date.now() / 1000,
			startedMono: num(params.timestamp) ?? 0,
			method: str(request.method) || "GET",
			url: str(request.url),
			documentURL: str(params.documentURL) || undefined,
			type: str(params.type) || undefined,
			headers: rec(request.headers),
			bodySize: hasBody ? utf8Bytes(inline) : 0,
			hasBody,
			dataLength: 0,
			extraHeaders: this.early.get(id)?.request,
		};
		this.pending.set(id, p);
		if (!hasBody) return;
		// The body is never read: a password can sit under any field name, and a page can remove its form before anything could look.
		p.body = { comment: "body not stored: request bodies are never written to the file" };
	}

	private respond(p: Pending, r: Params): void {
		p.response = {
			status: num(r.status) ?? 0,
			statusText: str(r.statusText),
			headers: rec(r.headers),
			mimeType: str(r.mimeType),
			protocol: str(r.protocol) || undefined,
			remoteIPAddress: str(r.remoteIPAddress) || undefined,
			connectionId: num(r.connectionId),
			timing: r.timing && typeof r.timing === "object" ? (r.timing as Params) : undefined,
			extraHeaders: this.early.get(p.requestId)?.response,
		};
		this.early.delete(p.requestId);
	}

	/** Whether the caller should fetch this finished request's response body. */
	wantsResponseBody(requestId: string): boolean {
		const p = this.pending.get(requestId);
		if (!p?.response || p.failed || p.finishedMono === undefined || p.responseBody) return false;
		if (!JSON_TYPE.test(p.response.mimeType)) return false;
		if (isAuthPath(p.url)) return false;
		// Only what the page's own scripts could read: a cross-origin response is opaque to them.
		const origin = originOf(p.url);
		if (!origin || (p.documentURL !== undefined && originOf(p.documentURL) !== origin)) return false;
		return (p.encodedLength ?? 0) <= HAR_BODY_CAP;
	}

	/** Hand over a response body, already decoded to text; the request is then done. */
	setResponseBody(requestId: string, text: string): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		p.responseBody = redactResponseBody(text);
		this.finish(requestId);
	}

	/** The response body could not be had (evicted, still loading): finish the request without it. */
	complete(requestId: string, why = "the browser no longer had it"): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		p.responseBody ??= { comment: `body not stored: ${why}` };
		this.finish(requestId);
	}

	private finish(requestId: string): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		this.pending.delete(requestId);
		if (this.capped) {
			this.skipped++;
			return;
		}
		const entry = this.entry(p);
		const size = utf8Bytes(JSON.stringify(entry)) + 1;
		if (this.bytes + size > this.maxBytes) {
			this.capped = true;
			this.skipped++;
			this.skipped += this.pending.size;
			this.pending.clear();
			return;
		}
		this.bytes += size;
		this.done.push(entry);
	}

	private entry(p: Pending): HarEntry {
		const response = p.response;
		const reqHeaders = { ...p.headers, ...(p.extraHeaders ?? {}) };
		const resHeaders = { ...(response?.headers ?? {}), ...(response?.extraHeaders ?? {}) };
		const timing = response?.timing;
		const t = (key: string): number => {
			const v = num(timing?.[key]);
			return v === undefined || v < 0 ? -1 : v;
		};
		const end = p.finishedMono ?? p.startedMono;
		const total = Math.max(0, (end - p.startedMono) * 1000);
		let timings: Record<string, number>;
		if (timing) {
			const sendStart = t("sendStart");
			const sendEnd = t("sendEnd");
			const headersEnd = t("receiveHeadersEnd");
			const dnsStart = t("dnsStart");
			const dnsEnd = t("dnsEnd");
			const connectStart = t("connectStart");
			const connectEnd = t("connectEnd");
			const sslStart = t("sslStart");
			const sslEnd = t("sslEnd");
			const requestTime = num(timing.requestTime);
			const sinceRequest = requestTime === undefined ? total : Math.max(0, (end - requestTime) * 1000);
			timings = {
				blocked: Math.max(0, total - sinceRequest),
				dns: dnsStart >= 0 && dnsEnd >= 0 ? dnsEnd - dnsStart : -1,
				connect: connectStart >= 0 && connectEnd >= 0 ? connectEnd - connectStart : -1,
				ssl: sslStart >= 0 && sslEnd >= 0 ? sslEnd - sslStart : -1,
				send: sendStart >= 0 && sendEnd >= 0 ? sendEnd - sendStart : 0,
				wait: sendEnd >= 0 && headersEnd >= 0 ? Math.max(0, headersEnd - sendEnd) : 0,
				receive: headersEnd >= 0 ? Math.max(0, sinceRequest - headersEnd) : 0,
			};
		} else {
			timings = { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: total, receive: 0 };
		}
		for (const k of Object.keys(timings)) timings[k] = Math.round(timings[k] * 100) / 100;
		// HAR 1.2: ssl is part of connect, so it is not added again.
		const time =
			Math.round(Object.entries(timings).reduce((n, [k, v]) => n + (k !== "ssl" && v > 0 ? v : 0), 0) * 100) / 100;
		const bodyLen = p.encodedLength ?? -1;
		const requestBodySize = p.hasBody ? p.bodySize || Number(headerOf(reqHeaders, "content-length")) || -1 : 0;
		const post = p.body;
		return {
			startedDateTime: new Date(p.startedWall * 1000).toISOString(),
			time,
			request: {
				method: p.method,
				url: redactUrl(p.url),
				httpVersion: httpVersion(response?.protocol),
				cookies: [],
				headers: redactHeaders(reqHeaders),
				queryString: queryString(p.url),
				...(p.hasBody
					? {
							postData: {
								mimeType: headerOf(reqHeaders, "content-type") ?? "",
								...(post?.text !== undefined ? { text: post.text } : {}),
								...(post?.text === undefined ? { comment: post?.comment ?? "body not stored" } : {}),
							},
						}
					: {}),
				headersSize: -1,
				bodySize: requestBodySize,
			},
			response: {
				status: response?.status ?? 0,
				statusText: response?.statusText ?? "",
				httpVersion: httpVersion(response?.protocol),
				cookies: [],
				headers: redactHeaders(resHeaders),
				content: {
					size: p.dataLength || (bodyLen >= 0 ? bodyLen : 0),
					mimeType: response?.mimeType || "x-unknown",
					...(p.responseBody?.text !== undefined ? { text: p.responseBody.text } : {}),
					...(p.responseBody?.comment ? { comment: p.responseBody.comment } : {}),
				},
				redirectURL: redactUrl(headerOf(resHeaders, "location") ?? ""),
				headersSize: -1,
				bodySize: bodyLen,
				...(p.failed ? { _error: p.canceled ? `canceled: ${p.failed}` : p.failed } : {}),
			},
			cache: {},
			timings,
			...(response?.remoteIPAddress ? { serverIPAddress: response.remoteIPAddress } : {}),
			...(response?.connectionId !== undefined ? { connection: String(response.connectionId) } : {}),
			...(p.type ? { _resourceType: p.type } : {}),
		};
	}

	/**
	 * The HAR so far. Requests still in flight are included as they stand (no end; status 0 until a
	 * response came), unless the cap was reached.
	 */
	toHar(creator: { name: string; version: string }, note?: string): Har {
		const entries = [...this.done];
		if (!this.capped) {
			let room = this.maxBytes - this.bytes;
			for (const p of this.pending.values()) {
				const e = this.entry(p);
				room -= utf8Bytes(JSON.stringify(e)) + 1;
				if (room < 0) break;
				entries.push(e);
			}
		}
		entries.sort((a, b) =>
			a.startedDateTime < b.startedDateTime ? -1 : a.startedDateTime > b.startedDateTime ? 1 : 0,
		);
		return {
			log: {
				version: "1.2",
				creator,
				comment:
					note ??
					"Secrets are redacted: credential headers and query parameters, and values under secret names. Request bodies are never stored.",
				entries,
			},
		};
	}
}
