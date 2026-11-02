/**
 * OAuth for remote MCP: `tabkyra serve --public-url <https url>` turns this on so web clients
 * that can't send a static bearer header (claude.ai, ChatGPT, grok.com connectors) can connect.
 *
 * A single-owner OAuth 2.1 authorization server: dynamic client registration (RFC 7591), the
 * authorization code grant with PKCE S256 only, rotating refresh tokens, and an owner passcode
 * on the consent page. The owner picks the scopes there, from the same SCOPES a static token
 * has; there is still no wildcard. Each grant is one "family": its access tokens rotate, but
 * the family id is stable, so an MCP session (and its tab group) survives a refresh.
 *
 * Stored: SHA-256 hashes of tokens and client secrets and an scrypt hash of the passcode,
 * in oauth.json (0600) next to tokens.json. Codes live in memory for five minutes.
 */

import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODE_TTL_MS, CodeLimitError, type CodeRecord, findCode, hashCode, liveCodes, newCode, normalizeCode, REQUEST_LOCK_MS } from "./codes.ts";
import { configDir, LockTimeoutError, readJsonFile, withFileLock, writeJsonPrivate } from "./files.ts";
import { pageCss } from "./theme.ts";

export { configDir };

const ACCESS_TTL = 3600;
const REFRESH_TTL = 30 * 86400;
const CODE_TTL = 300;
const REQUEST_TTL = 600;
const MAX_CLIENTS = 100;
const MAX_TOKENS = 10_000;
/**
 * Spent refresh tokens a grant may hold for replay detection: a month at two refreshes an hour.
 * A grant past it ends (its evidence is never dropped while it lives).
 */
const MAX_SPENT_PER_GRANT = 1500;
const REUSE_GRACE = 60;

/** Web connectors' documented callbacks, matched exactly. Loopback http is for native clients (RFC 8252). */
export const DEFAULT_REDIRECTS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback", "https://chatgpt.com/connector_platform_oauth_redirect"];
/** ChatGPT's per-connector callbacks, used when a server doesn't send iss. */
const CHATGPT_CALLBACK_PREFIX = "https://chatgpt.com/connector/oauth/";
/** Hosts whose callback path isn't documented (grok.com): any path on them, like --redirect-host. */
export const DEFAULT_REDIRECT_HOSTS = ["grok.com", "x.ai"];

/** Checked on the consent page unless the owner unticks them. browser.script and threads.read must be ticked by hand. */
export const DEFAULT_GRANT = ["browser.read", "browser.navigate", "browser.act", "library.read", "library.write", "skills.read", "user.ask"];

type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";

interface Client {
	client_id: string;
	client_secret_hash?: string;
	redirect_uris: string[];
	client_name: string;
	token_endpoint_auth_method: AuthMethod;
	created_at: number;
	last_used?: number;
}

interface Token {
	kind: "access" | "refresh";
	client_id: string;
	expires: number;
	family: string;
	resource: string;
	scopes: string[];
	revoked?: boolean;
	/** When a refresh token was rotated (seconds); a retry within REUSE_GRACE gets a new pair instead of ending the grant. */
	rotated_at?: number;
}

interface State {
	version: 1;
	key: string;
	passcode?: string;
	clients: Record<string, Client>;
	tokens: Record<string, Token>;
}

export interface OAuthConfig {
	/** The public origin clients reach, such as https://tabkyra.example.com. The MCP endpoint is <publicUrl>/mcp. */
	publicUrl: string;
	/** Extra https hosts a client may register a redirect URI on. */
	redirectHosts: string[];
	/** Every scope name a grant may hold (remote.ts SCOPES). */
	scopes: Record<string, { what: string }>;
}

export class OAuthError extends Error {
	constructor(
		readonly status: number,
		readonly error: string,
		readonly description: string,
	) {
		super(description);
	}
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
const b64 = (bytes = 32) => randomBytes(bytes).toString("base64url");

function stateFile(): string {
	return join(configDir(), "oauth.json");
}

/** Normalize and check a --public-url: https (or http on loopback, for tests), no path, query or credentials. */
export function normalizePublicUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`--public-url must be a URL like https://tabkyra.example.com (got ${raw}).`);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("--public-url must use https.");
	if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
		throw new Error("--public-url is an origin only (https://host), with no path, query or credentials.");
	}
	return url.origin;
}

export const resourceUrl = (config: OAuthConfig) => `${config.publicUrl}/mcp`;
export const resourceMetadataUrl = (config: OAuthConfig) => `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

function load(): State {
	if (!existsSync(stateFile())) return { version: 1, key: b64(), clients: {}, tokens: {} };
	const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<State>;
	if (raw.version !== 1 || typeof raw.key !== "string") throw new Error(`${stateFile()} is not a Tabkyra OAuth file. Move it aside; every client will need to connect again.`);
	return { version: 1, key: raw.key, passcode: raw.passcode, clients: raw.clients ?? {}, tokens: raw.tokens ?? {} };
}

function save(state: State): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const tmp = `${stateFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, stateFile());
}

/** Change oauth.json under an exclusive lock file, pruning expired tokens on the way out. */
function change<T>(update: (state: State) => T): T {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const lock = `${stateFile()}.lock`;
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			break;
		} catch {
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > 30_000;
			} catch {
				/* gone */
			}
			if (stale) rmSync(lock, { force: true });
			else if (Date.now() > deadline) throw new Error(`oauth.json is locked (${lock}).`);
			else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		const state = load();
		const result = update(state);
		const time = now();
		for (const [hash, item] of Object.entries(state.tokens)) if (item.expires < time) delete state.tokens[hash];
		// Over the cap: drop whole grants, oldest first, never part of one. A live grant keeps its spent
		// refresh tokens, so a replay of one still ends it.
		if (Object.keys(state.tokens).length > MAX_TOKENS) {
			const newest = new Map<string, number>();
			for (const t of Object.values(state.tokens)) newest.set(t.family, Math.max(newest.get(t.family) ?? 0, t.expires));
			for (const [family] of [...newest].sort((a, b) => a[1] - b[1])) {
				if (Object.keys(state.tokens).length <= MAX_TOKENS) break;
				for (const [hash, t] of Object.entries(state.tokens)) if (t.family === family) delete state.tokens[hash];
			}
		}
		save(state);
		return result;
	} finally {
		rmSync(lock, { force: true });
	}
}

// ---------- Owner passcode ----------

function hashPasscode(passcode: string, salt = randomBytes(16)): string {
	const derived = scryptSync(passcode, salt, 32, { N: 16384, r: 8, p: 1 });
	return `scrypt$16384$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

let scrypting = 0;

/** Off the event loop, and at most four at once, so wrong-passcode traffic can't stall serve. */
async function checkPasscode(stored: string | undefined, passcode: string): Promise<boolean> {
	if (!stored || passcode.length < 1 || passcode.length > 200) return false;
	const [scheme, n, r, p, salt, hash] = stored.split("$");
	if (scheme !== "scrypt" || !salt || !hash) return false;
	if (scrypting >= 4) throw new OAuthError(503, "temporarily_unavailable", "Busy. Try again in a moment.");
	scrypting++;
	try {
		const expected = Buffer.from(hash, "base64url");
		const derived = await new Promise<Buffer>((resolve, reject) =>
			scrypt(passcode, Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) }, (err, key) => (err ? reject(err) : resolve(key))),
		);
		return timingSafeEqual(derived, expected);
	} finally {
		scrypting--;
	}
}

/** A new owner passcode, returned once. Rotating it doesn't end grants already approved. */
export function setPasscode(): string {
	const passcode = (randomBytes(15).toString("base64url").replace(/[-_]/g, "x").match(/.{1,5}/g) ?? []).join("-");
	change((state) => {
		state.passcode = hashPasscode(passcode);
	});
	return passcode;
}

export function passcodeSet(): boolean {
	try {
		return Boolean(load().passcode);
	} catch {
		return false;
	}
}

// ---------- One-time approval codes ----------

/** Codes a connector may be approved with instead of the passcode: TK-XXXX-XXXX, ten minutes, once (codes.ts). Only SHA-256 is stored. */
const approvalFile = () => join(configDir(), "oauth-codes.json");
const MAX_LIVE_APPROVAL_CODES = 20;

function loadApprovalCodes(): CodeRecord[] {
	try {
		const data = readJsonFile<{ codes?: CodeRecord[] }>(approvalFile(), {});
		return Array.isArray(data.codes) ? data.codes : [];
	} catch {
		return [];
	}
}

/** A new approval code, returned once. `lockMs` is how long to wait for the lock (a request handler passes a short one). */
export function mintApprovalCode(lockMs?: number): { code: string; expiresAt: number } {
	return withFileLock(
		approvalFile(),
		() => {
			const time = Date.now();
			const live = liveCodes(loadApprovalCodes(), time);
			if (live.length >= MAX_LIVE_APPROVAL_CODES) throw new CodeLimitError(`${MAX_LIVE_APPROVAL_CODES} approval codes are already waiting. Use or wait out one first.`);
			const code = newCode();
			const expiresAt = time + CODE_TTL_MS;
			writeJsonPrivate(approvalFile(), { codes: [...live, { sha256: hashCode(code), expiresAt, createdAt: time }] });
			return { code, expiresAt };
		},
		lockMs,
	);
}

/** Whether a typed value is a live approval code. Does not use it up. */
function approvalCodeLive(typed: string): boolean {
	return findCode(loadApprovalCodes(), typed, Date.now()) >= 0;
}

/** Use up a live approval code. False when it is wrong, expired or already used (two requests racing for one code: one wins). */
function consumeApprovalCode(typed: string): boolean {
	try {
		// Runs in the server's event loop: wait briefly for the lock, and answer 503 if it stays held.
		return withFileLock(
			approvalFile(),
			() => {
				const time = Date.now();
				const live = liveCodes(loadApprovalCodes(), time);
				const at = findCode(live, typed, time);
				writeJsonPrivate(approvalFile(), { codes: live.filter((_, i) => i !== at) });
				return at >= 0;
			},
			REQUEST_LOCK_MS,
		);
	} catch (err) {
		if (err instanceof LockTimeoutError) throw new OAuthError(503, "temporarily_unavailable", "Busy. Try again in a moment.");
		throw err;
	}
}

// ---------- Owner management ----------

export interface ClientSummary {
	client_id: string;
	client_name: string;
	redirect_hosts: string[];
	created: string;
	last_used: string | null;
	grants: { id: string; scopes: string[] }[];
}

export function listClients(): ClientSummary[] {
	const state = load();
	const time = now();
	return Object.values(state.clients).map((c) => {
		const grants = new Map<string, string[]>();
		for (const t of Object.values(state.tokens)) if (t.client_id === c.client_id && !t.revoked && t.expires > time) grants.set(t.family, t.scopes);
		return {
			client_id: c.client_id,
			client_name: c.client_name,
			redirect_hosts: [...new Set(c.redirect_uris.map((u) => new URL(u).host))],
			created: new Date(c.created_at * 1000).toISOString(),
			last_used: c.last_used ? new Date(c.last_used * 1000).toISOString() : null,
			grants: [...grants].map(([family, scopes]) => ({ id: familyId(family), scopes })),
		};
	});
}

/** Remove one OAuth client and every grant it holds. Returns false when no client has that id. */
export function revokeClient(clientId: string): boolean {
	return change((state) => {
		if (!state.clients[clientId]) return false;
		delete state.clients[clientId];
		for (const [hash, t] of Object.entries(state.tokens)) if (t.client_id === clientId) delete state.tokens[hash];
		return true;
	});
}

/** End one grant ("o-<hex>" from token clients). Returns false when no live grant has that id. */
export function revokeGrantById(id: string): boolean {
	const family = id.startsWith("o-") ? id.slice(2) : "";
	if (!/^[0-9a-f]{32}$/.test(family)) return false;
	return change((state) => {
		let n = 0;
		for (const [hash, t] of Object.entries(state.tokens)) {
			if (t.family === family) {
				delete state.tokens[hash];
				n++;
			}
		}
		return n > 0;
	});
}

// ---------- Metadata ----------

export function protectedResourceMetadata(config: OAuthConfig) {
	return {
		resource: resourceUrl(config),
		authorization_servers: [config.publicUrl],
		bearer_methods_supported: ["header"],
		scopes_supported: Object.keys(config.scopes),
		resource_name: "Tabkyra",
	};
}

export function authorizationServerMetadata(config: OAuthConfig) {
	const base = config.publicUrl;
	return {
		issuer: base,
		authorization_endpoint: `${base}/authorize`,
		token_endpoint: `${base}/token`,
		registration_endpoint: `${base}/register`,
		revocation_endpoint: `${base}/revoke`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
		revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
		scopes_supported: Object.keys(config.scopes),
		// The redirect carries iss (RFC 9207), so ChatGPT uses its one fixed callback.
		authorization_response_iss_parameter_supported: true,
	};
}

// ---------- Registration ----------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function redirectAllowed(config: OAuthConfig, uri: string): boolean {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.hash || url.username || url.password || url.search || uri.length > 500) return false;
	if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return true;
	if (url.protocol !== "https:" || url.port) return false;
	if (DEFAULT_REDIRECTS.includes(url.href)) return true;
	if (url.href.startsWith(CHATGPT_CALLBACK_PREFIX) && /^[A-Za-z0-9_-]{1,128}$/.test(url.href.slice(CHATGPT_CALLBACK_PREFIX.length))) return true;
	const hosts = new Set([...DEFAULT_REDIRECT_HOSTS, ...config.redirectHosts].map((h) => h.toLowerCase()));
	return hosts.has(url.hostname.toLowerCase());
}

/**
 * Rate limits, in memory. Counted per source (Cloudflare's CF-Connecting-IP, else the first
 * X-Forwarded-For, else the socket address) with a high global cap that only bounds work. A
 * header can be forged, so a determined flood can still fill the global cap for a while; the
 * owner's way out is `tabkyra token passcode`, which clears every limit (serve notices the new
 * passcode on the next request).
 */
const limits = { registrations: [] as { at: number; source: string }[], failures: [] as { at: number; client: string; source: string }[], passcode: "" };

function resetLimitsOnNewPasscode(state: State): void {
	const current = state.passcode ?? "";
	if (current === limits.passcode) return;
	limits.passcode = current;
	limits.registrations.length = 0;
	limits.failures.length = 0;
}

export function registerClient(config: OAuthConfig, body: unknown, source = "unknown") {
	resetLimitsOnNewPasscode(load());
	const time = Date.now();
	while (limits.registrations.length && limits.registrations[0].at < time - 10 * 60_000) limits.registrations.shift();
	if (limits.registrations.filter((r) => r.source === source).length >= 10 || limits.registrations.length >= 300) {
		throw new OAuthError(429, "temporarily_unavailable", "Too many client registrations. Try again in a few minutes.");
	}
	limits.registrations.push({ at: time, source });
	const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const uris = request.redirect_uris;
	if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === "string")) {
		throw new OAuthError(400, "invalid_client_metadata", "redirect_uris is required (1 to 5 URIs).");
	}
	const redirectUris = uris as string[];
	for (const uri of redirectUris) {
		if (!redirectAllowed(config, uri)) {
			throw new OAuthError(400, "invalid_redirect_uri", `Redirect URIs must be a known connector callback (claude.ai, ChatGPT), https on ${[...DEFAULT_REDIRECT_HOSTS, ...config.redirectHosts].join(", ")}, or http on localhost.`);
		}
	}
	const method = (request.token_endpoint_auth_method ?? "none") as AuthMethod;
	if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
		throw new OAuthError(400, "invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic.");
	}
	const grants = request.grant_types;
	if (grants !== undefined && (!Array.isArray(grants) || grants.some((g) => g !== "authorization_code" && g !== "refresh_token"))) {
		throw new OAuthError(400, "invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
	}
	const clientId = `tkc_${b64(16)}`;
	const secret = method === "none" ? undefined : `tks_${b64()}`;
	const rawName = typeof request.client_name === "string" ? request.client_name : "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips.
	const name = rawName.replace(/[\x00-\x1f\x7f<>]/g, "").slice(0, 100) || "MCP client";
	change((state) => {
		const clients = Object.values(state.clients);
		if (clients.length >= MAX_CLIENTS) {
			// Evict the oldest client that never got a grant, at any age: a flood of registrations pushes
			// out itself, never an approved connector, and never blocks a new registration.
			const active = new Set(Object.values(state.tokens).map((t) => t.client_id));
			const oldest = clients.filter((c) => !active.has(c.client_id) && c.last_used === undefined).sort((a, b) => a.created_at - b.created_at)[0];
			if (!oldest) throw new OAuthError(400, "invalid_client_metadata", "Too many registered clients. Remove unused ones with tabkyra token revoke <client id>.");
			delete state.clients[oldest.client_id];
		}
		state.clients[clientId] = {
			client_id: clientId,
			...(secret ? { client_secret_hash: sha(secret) } : {}),
			redirect_uris: redirectUris,
			client_name: name,
			token_endpoint_auth_method: method,
			created_at: now(),
		};
	});
	return {
		client_id: clientId,
		...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
		client_id_issued_at: now(),
		client_name: name,
		redirect_uris: redirectUris,
		token_endpoint_auth_method: method,
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
	};
}

// ---------- Authorization ----------

interface AuthorizeRequest {
	client_id: string;
	redirect_uri: string;
	state?: string;
	code_challenge: string;
	resource: string;
	exp: number;
}

export interface ConsentDetails {
	signed: string;
	clientName: string;
	redirectHost: string;
	redirectOrigin: string;
	redirectUri: string;
	registeredAgo: string;
	passcodeSet: boolean;
	/** The scopes to show ticked: the defaults, or what the owner ticked before an error. */
	ticked?: string[];
}

const codes = new Map<string, AuthorizeRequest & { scopes: string[]; expires: number }>();

/** Check an authorize request. Errors about the client or redirect URI throw (shown on the page); the rest redirect back. */
export function validateAuthorize(config: OAuthConfig, params: URLSearchParams): ConsentDetails | { redirect: string } {
	const state = load();
	const clientId = params.get("client_id") ?? "";
	const redirectUri = params.get("redirect_uri") ?? "";
	const registered = state.clients[clientId];
	// Never redirect to an unverified URI.
	if (!registered) throw new OAuthError(400, "invalid_client", "Unknown client. Remove the connector and add it again so it registers.");
	if (!registered.redirect_uris.includes(redirectUri)) throw new OAuthError(400, "invalid_request", "The redirect URI doesn't match the registered client.");
	const fail = (error: string, description: string) => {
		const url = new URL(redirectUri);
		url.searchParams.set("error", error);
		url.searchParams.set("error_description", description);
		const st = params.get("state");
		if (st) url.searchParams.set("state", st);
		url.searchParams.set("iss", config.publicUrl);
		return { redirect: url.href };
	};
	if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
	const challenge = params.get("code_challenge") ?? "";
	if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
	const resource = params.get("resource") ?? resourceUrl(config);
	if (resource.replace(/\/$/, "") !== resourceUrl(config)) return fail("invalid_target", "This server issues tokens only for its own MCP endpoint.");
	const request: AuthorizeRequest = { client_id: clientId, redirect_uri: redirectUri, state: params.get("state") ?? undefined, code_challenge: challenge, resource: resourceUrl(config), exp: now() + REQUEST_TTL };
	return details(state, request);
}

function details(state: State, request: AuthorizeRequest): ConsentDetails {
	const blob = Buffer.from(JSON.stringify(request)).toString("base64url");
	const signature = createHmac("sha256", state.key).update(blob).digest("base64url");
	const redirect = new URL(request.redirect_uri);
	const age = Math.max(0, now() - state.clients[request.client_id].created_at);
	const registeredAgo = age < 120 ? `${age} seconds ago` : age < 7200 ? `${Math.round(age / 60)} minutes ago` : `${Math.round(age / 3600)} hours ago`;
	return {
		signed: `${blob}.${signature}`,
		clientName: state.clients[request.client_id].client_name,
		redirectHost: redirect.host,
		redirectOrigin: redirect.origin,
		redirectUri: request.redirect_uri,
		registeredAgo,
		passcodeSet: Boolean(state.passcode),
	};
}

function signedRequest(state: State, signed: string): AuthorizeRequest {
	const [blob = "", signature = ""] = signed.split(".");
	const expected = createHmac("sha256", state.key).update(blob).digest();
	const given = Buffer.from(signature, "base64url");
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new OAuthError(400, "invalid_request", "The approval form is invalid. Start the connection again.");
	const request = JSON.parse(Buffer.from(blob, "base64url").toString("utf8")) as AuthorizeRequest;
	if (request.exp < now()) throw new OAuthError(400, "invalid_request", "The approval form expired. Start the connection again.");
	if (!state.clients[request.client_id]?.redirect_uris.includes(request.redirect_uri)) throw new OAuthError(400, "invalid_client", "The client is no longer registered.");
	return request;
}

/** The consent page again, after a wrong passcode, from the already signed request. */
export function describeSigned(signed: string, ticked?: string[]): ConsentDetails {
	const state = load();
	return { ...details(state, signedRequest(state, signed)), ticked };
}

/** The consent POST: verify the signed request, the passcode and the scopes, then issue a single-use code. */
export async function approveAuthorize(config: OAuthConfig, form: URLSearchParams, source = "unknown"): Promise<{ redirect: string }> {
	const state = load();
	resetLimitsOnNewPasscode(state);
	const request = signedRequest(state, form.get("request") ?? "");
	const back = (params: Record<string, string>) => {
		const url = new URL(request.redirect_uri);
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		if (request.state) url.searchParams.set("state", request.state);
		url.searchParams.set("iss", config.publicUrl);
		return { redirect: url.href };
	};
	if (form.get("decision") === "deny") return back({ error: "access_denied" });
	const time = Date.now();
	const failures = limits.failures;
	while (failures.length && failures[0].at < time - 15 * 60_000) failures.shift();
	// The passcode carries about 100 bits, so these caps bound work, not guessing. Per client and
	// per source first; the global cap is high, and a new passcode clears all of them.
	if (failures.filter((f) => f.client === request.client_id).length >= 5 || failures.filter((f) => f.source === source).length >= 20 || failures.length >= 1000) {
		throw new OAuthError(429, "temporarily_unavailable", "Too many wrong passcodes or connect codes. Wait 15 minutes, or run tabkyra token passcode for a new passcode, which clears this limit.");
	}
	const typed = form.get("passcode") ?? "";
	// A live approval code stands in for the passcode. It is checked first (a file read), and used up only once the scopes are valid.
	const byCode = normalizeCode(typed) !== undefined && approvalCodeLive(typed);
	const refuse = (message: string): never => {
		failures.push({ at: time, client: request.client_id, source });
		throw new OAuthError(401, "access_denied", message);
	};
	if (!byCode && !(await checkPasscode(state.passcode, typed))) {
		refuse(state.passcode ? "Wrong passcode or connect code." : "No passcode is set. Run tabkyra token passcode, or tabkyra token approval-code for a one-time connect code, on the computer that runs serve.");
	}
	const scopes = [...new Set(form.getAll("scope"))];
	if (scopes.length === 0) throw new OAuthError(400, "invalid_scope", "Tick at least one permission.");
	for (const s of scopes) if (!Object.hasOwn(config.scopes, s)) throw new OAuthError(400, "invalid_scope", `Unknown permission ${s}.`);
	if (byCode && !consumeApprovalCode(typed)) refuse("That connect code was already used or has expired.");
	const code = `tka_${b64()}`;
	for (const [key, value] of codes) if (value.expires < now()) codes.delete(key);
	codes.set(sha(code), { ...request, scopes, expires: now() + CODE_TTL });
	return back({ code });
}

// ---------- Tokens ----------

function authenticateClient(state: State, params: URLSearchParams, authorization: string | undefined): Client {
	let id = params.get("client_id") ?? "";
	let secret = params.get("client_secret") ?? undefined;
	if (authorization?.startsWith("Basic ")) {
		const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
		const split = decoded.indexOf(":");
		if (split > 0) {
			try {
				id = decodeURIComponent(decoded.slice(0, split));
				secret = decodeURIComponent(decoded.slice(split + 1));
			} catch {
				throw new OAuthError(401, "invalid_client", "Client authentication failed.");
			}
		}
	}
	const registered = state.clients[id];
	if (!registered) throw new OAuthError(401, "invalid_client", "Unknown client.");
	if (registered.client_secret_hash) {
		const given = Buffer.from(sha(secret ?? ""));
		const stored = Buffer.from(registered.client_secret_hash);
		if (!secret || given.length !== stored.length || !timingSafeEqual(given, stored)) throw new OAuthError(401, "invalid_client", "Client authentication failed.");
	}
	return registered;
}

function newFamily(state: State): string {
	const taken = new Set(Object.values(state.tokens).map((t) => t.family));
	for (;;) {
		const family = randomBytes(16).toString("hex");
		if (!taken.has(family)) return family;
	}
}

function issue(state: State, clientId: string, resource: string, scopes: string[], family = newFamily(state)) {
	const access = `tko_${b64()}`;
	const refresh = `tkf_${b64()}`;
	const time = now();
	state.tokens[sha(access)] = { kind: "access", client_id: clientId, expires: time + ACCESS_TTL, family, resource, scopes };
	state.tokens[sha(refresh)] = { kind: "refresh", client_id: clientId, expires: time + REFRESH_TTL, family, resource, scopes };
	const registered = state.clients[clientId];
	if (registered) registered.last_used = time;
	return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
}

export function exchangeToken(params: URLSearchParams, authorization: string | undefined) {
	const grant = params.get("grant_type");
	if (grant === "authorization_code") {
		const code = params.get("code") ?? "";
		const saved = codes.get(sha(code));
		codes.delete(sha(code));
		return change((state) => {
			const registered = authenticateClient(state, params, authorization);
			if (!saved || saved.expires < now() || saved.client_id !== registered.client_id) throw new OAuthError(400, "invalid_grant", "The authorization code is invalid, expired or already used.");
			if (params.get("redirect_uri") !== saved.redirect_uri) throw new OAuthError(400, "invalid_grant", "redirect_uri doesn't match the authorization request.");
			const verifier = params.get("code_verifier") ?? "";
			if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== saved.code_challenge) {
				throw new OAuthError(400, "invalid_grant", "PKCE verification failed.");
			}
			const resource = params.get("resource");
			if (resource && resource.replace(/\/$/, "") !== saved.resource) throw new OAuthError(400, "invalid_target", "The resource doesn't match the authorization request.");
			return issue(state, registered.client_id, saved.resource, saved.scopes);
		});
	}
	if (grant === "refresh_token") {
		const presented = sha(params.get("refresh_token") ?? "");
		const result = change((state) => {
			const registered = authenticateClient(state, params, authorization);
			const saved = state.tokens[presented];
			if (!saved || saved.kind !== "refresh" || saved.client_id !== registered.client_id || saved.expires < now()) throw new OAuthError(400, "invalid_grant", "The refresh token is invalid or expired.");
			const same = (t: Token) => t.family === saved.family && t.client_id === saved.client_id;
			/** Retire the grant's live tokens: access tokens go; a live refresh token becomes spent (a later use ends the grant). */
			const retireLive = () => {
				for (const [hash, t] of Object.entries(state.tokens)) {
					if (!same(t) || t.revoked) continue;
					if (t.kind === "access") delete state.tokens[hash];
					else t.revoked = true;
				}
			};
			if (saved.revoked) {
				// A client that lost the response to its refresh may retry once, within the grace window,
				// the token it just rotated (RFC 9700 4.14.2). The pair it lost becomes spent.
				if (saved.rotated_at !== undefined && now() - saved.rotated_at <= REUSE_GRACE) {
					saved.rotated_at = undefined;
					retireLive();
					return issue(state, registered.client_id, saved.resource, saved.scopes, saved.family);
				}
				// Any other spent token coming back means someone holds a copy. End the whole grant (saved before refusing).
				for (const [hash, t] of Object.entries(state.tokens)) if (same(t)) delete state.tokens[hash];
				return null;
			}
			retireLive();
			// Only the token rotated last may be retried; every older spent token is a replay.
			for (const t of Object.values(state.tokens)) if (same(t) && t.kind === "refresh") t.rotated_at = undefined;
			saved.rotated_at = now();
			// Spent refresh tokens stay until they expire, so any replay is caught. A grant with more
			// than the cap ends rather than forget one: a copy could otherwise rotate the evidence away.
			const spent = Object.values(state.tokens).filter((t) => same(t) && t.kind === "refresh" && t.revoked).length;
			if (spent > MAX_SPENT_PER_GRANT) {
				for (const [hash, t] of Object.entries(state.tokens)) if (same(t)) delete state.tokens[hash];
				return "cap" as const;
			}
			return issue(state, registered.client_id, saved.resource, saved.scopes, saved.family);
		});
		if (!result) throw new OAuthError(400, "invalid_grant", "This refresh token was already used. The grant has been revoked; connect again.");
		if (result === "cap") throw new OAuthError(400, "invalid_grant", "This grant refreshed too often and has ended; connect again.");
		return result;
	}
	throw new OAuthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export function revokeGrant(params: URLSearchParams, authorization: string | undefined): void {
	change((state) => {
		const registered = authenticateClient(state, params, authorization);
		const saved = state.tokens[sha(params.get("token") ?? "")];
		if (saved && saved.client_id === registered.client_id) {
			for (const [hash, t] of Object.entries(state.tokens)) if (t.family === saved.family && t.client_id === saved.client_id) delete state.tokens[hash];
		}
	});
}

/** A grant's id as sessions and listings show it: "o-" and 32 hex, never the shape of a static token id. */
const familyId = (family: string) => `o-${family}`;

export interface OAuthCaller {
	id: string;
	name: string;
	scopes: string[];
}

/** The live grant behind an OAuth access token, or undefined. Tokens in query strings are never read. */
export function verifyAccessToken(config: OAuthConfig, token: string): OAuthCaller | undefined {
	if (!/^tko_[A-Za-z0-9_-]{20,200}$/.test(token)) return undefined;
	let state: State;
	try {
		state = load();
	} catch {
		// An unreadable oauth.json authorizes nobody.
		return undefined;
	}
	const saved = state.tokens[sha(token)];
	if (!saved || saved.kind !== "access" || saved.revoked || saved.expires <= now() || saved.resource !== resourceUrl(config)) return undefined;
	const client = state.clients[saved.client_id];
	if (!client) return undefined;
	const name = client.client_name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "oauth";
	return { id: familyId(saved.family), name, scopes: saved.scopes.filter((s) => Object.hasOwn(config.scopes, s)) };
}

/** Ids of grants that still hold an unexpired, unrevoked token; a session whose grant is gone is closed. */
export function liveGrantIds(): Set<string> {
	try {
		const time = now();
		const state = load();
		return new Set(
			Object.values(state.tokens)
				.filter((t) => !t.revoked && t.expires > time && state.clients[t.client_id])
				.map((t) => familyId(t.family)),
		);
	} catch {
		return new Set();
	}
}

// ---------- Consent page ----------

const escape = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function consentPage(config: OAuthConfig, d: ConsentDetails, error?: string): { html: string; headers: Record<string, string> } {
	const boxes = Object.entries(config.scopes)
		.map(
			([scope, { what }]) =>
				`<label class="scope"><input type="checkbox" name="scope" value="${escape(scope)}"${(d.ticked ?? DEFAULT_GRANT).includes(scope) ? " checked" : ""}><span><b>${escape(scope)}</b> ${escape(what)}</span></label>`,
		)
		.join("");
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve Tabkyra access</title>
<style>${pageCss()}</style></head>
<body><main><h1>Allow ${escape(d.clientName)} to use your browser through Tabkyra?</h1>
<p>It will work in its own tab group in your signed-in browser, with the permissions you tick. After you approve, you go back to <strong>${escape(d.redirectHost)}</strong>.</p>
<p>Only approve a connection you started yourself, just now, in your own account. A link someone sent you could connect their account to your browser. This connection registered ${escape(d.registeredAgo)} and returns to <code>${escape(d.redirectUri)}</code>.</p>
${error ? `<p class="error">${escape(error)}</p>` : ""}${d.passcodeSet ? "" : '<p class="error">No passcode is set yet. Run tabkyra token passcode on the computer that runs serve, or tabkyra token approval-code for a one-time connect code.</p>'}
<form method="post" action="/authorize"><input type="hidden" name="request" value="${escape(d.signed)}">
<fieldset><legend>Permissions</legend>${boxes}</fieldset>
<label for="passcode">Passcode or connect code</label><input id="passcode" name="passcode" type="text" class="secret" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore required autofocus>
<div class="row"><button type="submit" name="decision" value="deny" formnovalidate>Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div></form></main></body></html>`;
	return {
		html,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-frame-options": "DENY",
			"referrer-policy": "no-referrer",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${d.redirectOrigin}; frame-ancestors 'none'; base-uri 'none'`,
		},
	};
}
