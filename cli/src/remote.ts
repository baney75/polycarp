/**
 * Remote MCP: `tabkyra serve` exposes the MCP server over Streamable HTTP for agents that
 * aren't on this machine (cloud agents, another device), and `tabkyra token` manages who
 * may use it. Off unless started. It binds to loopback only; reaching it from elsewhere
 * goes through a tunnel that terminates TLS (`tabkyra tunnel`, tunnel.ts).
 *
 * Every request needs a bearer token. Tokens are per client, scoped, revocable, and stored
 * only as SHA-256 hashes. There is no wildcard: a token lists its scopes, and a session sees
 * only the tools those scopes grant. A tool outside them isn't registered, so it can't be
 * listed or called.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp.ts";
import { MAX_LINK_SESSIONS } from "./link-protocol.ts";
import { handleOAuth, readBody } from "./oauth-http.ts";
import { liveGrantIds, type OAuthConfig, resourceMetadataUrl, verifyAccessToken } from "./oauth.ts";

/** What each scope grants. Acting under the user's sign-in is its own scope, never implied. */
export const SCOPES: Record<string, { tools: string[]; what: string }> = {
	"browser.read": {
		tools: ["status", "tabs_context", "session_info", "read_page", "find", "get_page_text", "get_page_html", "inspect_page", "screenshot", "read_console", "read_network"],
		what: "See the agent's own tabs and read pages",
	},
	"browser.navigate": {
		tools: ["navigate", "tabs_create", "tabs_select", "tabs_close", "tabs_show", "tabs_release", "session_end", "wait"],
		what: "Open and close pages in the agent's own tab group (site permissions still apply)",
	},
	"browser.act": {
		tools: ["click", "type", "fill", "press", "hover", "scroll", "drag", "actions", "handle_dialog"],
		what: "Click and type: can submit forms and act under the user's sign-in",
	},
	"browser.script": {
		tools: ["run_js"],
		// Code runs as the user on the page: it can do anything browser.act can, and more.
		what: "Run any code as you on pages the agent opens: can read, post, send and buy (includes everything browser.act can do)",
	},
	"library.read": { tools: ["library_search", "library_cite"], what: "Search and cite the source library" },
	"library.write": { tools: ["library_add"], what: "Add sources to the library (fetches from doi.org, OpenAlex, Crossref)" },
	"threads.read": {
		tools: ["threads_list", "thread_read", "thread_search"],
		what: "Read your past Tabkyra side panel chats (never private-mode ones)",
	},
	"skills.read": { tools: ["skill_match", "skill_read"], what: "Find the skill for a task and read the bundled skills (never your local edits)" },
	"user.ask": { tools: ["ask_user"], what: "Ask the user multiple-choice questions in the Tabkyra side panel and get their answers" },
	"web.search": { tools: ["search"], what: "Search the web through the user's self-hosted SearXNG (SEARXNG_URL)" },
	"web.scrape": {
		tools: ["page_markdown", "map", "crawl"],
		what: "Read pages as markdown (and optional map/crawl) through the user's self-hosted Firecrawl (FIRECRAWL_API_URL); hosted api.firecrawl.dev is refused",
	},
};

export interface TokenRecord {
	id: string;
	name: string;
	scopes: string[];
	sha256: string;
	createdAt: string;
	revokedAt?: string;
	lastUsedAt?: string;
	/** "link": the token `tabkyra link run` holds for its own loopback serve. Only that serve accepts it (see ServeOptions.acceptLinkTokens). */
	kind?: "link";
}

/**
 * The name of the token a running `link run` holds. Ordinary tokens can't take it: their names are
 * letters, digits, dot, dash and underscore, and this one has a colon.
 */
export const LINK_TOKEN_NAME = "link:run";

function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}

function tokensFile(): string {
	return join(configDir(), "tokens.json");
}

export function loadTokens(): TokenRecord[] {
	if (!existsSync(tokensFile())) return [];
	const data = JSON.parse(readFileSync(tokensFile(), "utf8")) as { tokens?: TokenRecord[] };
	return Array.isArray(data.tokens) ? data.tokens : [];
}

function saveTokens(tokens: TokenRecord[]): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const tmp = `${tokensFile()}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ tokens }, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, tokensFile());
}

function hash(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Serialize changes to tokens.json across processes (create and revoke) with an exclusive lock file. */
function withTokensLock<T>(fn: () => T): T {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	const lock = `${tokensFile()}.lock`;
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
			else if (Date.now() > deadline) throw new Error(`tokens.json is locked (${lock}).`);
			else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { force: true });
	}
}

/** A new token for `name` with exactly `scopes`. The secret is returned once and never stored. */
export function createToken(name: string, scopes: string[], kind?: "link"): { record: TokenRecord; token: string } {
	if (kind === "link" ? name !== LINK_TOKEN_NAME : !/^[\w.-]{1,40}$/.test(name)) throw new Error("Token name: letters, digits, dot, dash or underscore, up to 40.");
	if (/^[0-9a-f]{8}$/.test(name)) throw new Error("A token name can't look like a token id (8 hex characters).");
	if (/^(tkc_|o-)/.test(name)) throw new Error("A token name can't start with tkc_ or o-: those name OAuth clients and grants.");

	if (scopes.length === 0) throw new Error(`Name at least one scope: ${Object.keys(SCOPES).join(", ")}. There is no wildcard.`);
	for (const s of scopes) if (!Object.hasOwn(SCOPES, s)) throw new Error(`Unknown scope ${s}. Scopes: ${Object.keys(SCOPES).join(", ")}. There is no wildcard.`);
	return withTokensLock(() => {
		if (loadTokens().some((t) => t.name === name && !t.revokedAt)) throw new Error(`An active token is already named ${name}. Revoke it or pick another name.`);
		const token = `tkr_${randomBytes(32).toString("base64url")}`;
		const record: TokenRecord = { id: randomUUID().slice(0, 8), name, scopes: [...new Set(scopes)], sha256: hash(token), createdAt: new Date().toISOString(), ...(kind ? { kind } : {}) };
		saveTokens([...loadTokens(), record]);
		return { record, token };
	});
}

/** Delete every link-kind record. Only `link run`, holding its pid lock, calls this at start: no other run is alive to need its token. */
export function pruneLinkTokens(): void {
	withTokensLock(() => {
		const tokens = loadTokens();
		if (tokens.some((t) => t.kind === "link")) saveTokens(tokens.filter((t) => t.kind !== "link"));
	});
}

/** End every link-kind token (`link off`). A running `link run` revokes only its own, by id. */
export function revokeLinkTokens(): number {
	return withTokensLock(() => {
		const tokens = loadTokens();
		let n = 0;
		for (const t of tokens) {
			if (t.kind === "link" && !t.revokedAt) {
				t.revokedAt = new Date().toISOString();
				n++;
			}
		}
		saveTokens(tokens);
		return n;
	});
}

export function revokeToken(idOrName: string): number {
	return withTokensLock(() => revokeLocked(idOrName));
}

function revokeLocked(idOrName: string): number {
	const tokens = loadTokens();
	let n = 0;
	for (const t of tokens) {
		if ((t.id === idOrName || t.name === idOrName) && !t.revokedAt) {
			t.revokedAt = new Date().toISOString();
			n++;
		}
	}
	saveTokens(tokens);
	return n;
}

/** The live token record for a presented secret, compared in constant time. Reads the file each time, so a revoke applies at once. */
/** Last use is kept in its own file, so the server never rewrites tokens.json (and never undoes a revoke). */
function usageFile(): string {
	return join(configDir(), "token-usage.json");
}

export function loadUsage(): Record<string, string> {
	try {
		return JSON.parse(readFileSync(usageFile(), "utf8")) as Record<string, string>;
	} catch {
		return {};
	}
}

const lastRecorded = new Map<string, number>();

/** Record a token's use, at most once a minute per token. */
function recordUse(id: string): void {
	const now = Date.now();
	if (now - (lastRecorded.get(id) ?? 0) < 60_000) return;
	lastRecorded.set(id, now);
	try {
		const usage = loadUsage();
		usage[id] = new Date().toISOString();
		const tmp = `${usageFile()}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(usage)}\n`, { mode: 0o600 });
		renameSync(tmp, usageFile());
	} catch {
		/* usage is informational */
	}
}

export function authenticate(header: string | undefined): TokenRecord | undefined {
	const m = /^Bearer (tkr_[A-Za-z0-9_-]{20,})$/.exec(header ?? "");
	if (!m) return undefined;
	const presented = Buffer.from(hash(m[1]), "hex");
	let tokens: TokenRecord[];
	try {
		tokens = loadTokens();
	} catch {
		// An unreadable tokens.json authorizes nobody.
		return undefined;
	}
	return tokens.find((t) => {
		const stored = Buffer.from(String(t.sha256), "hex");
		// A malformed record matches nothing instead of throwing for every request.
		return !t.revokedAt && stored.length === presented.length && timingSafeEqual(stored, presented);
	});
}

export function toolsFor(scopes: string[]): Set<string> {
	return new Set(scopes.flatMap((s) => (Object.hasOwn(SCOPES, s) ? SCOPES[s].tools : [])));
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Who a request acts for: a static token, or an OAuth grant (id "o-<hex>"). */
interface Caller {
	id: string;
	name: string;
	scopes: string[];
	kind?: "link";
}

/** Headers the hub sets on a request to a device: who the caller is and which scopes they hold. The device honors them only from its link token. */
export const HUB_SCOPES_HEADER = "x-tabkyra-hub-scopes";
export const HUB_CALLER_HEADER = "x-tabkyra-hub-caller";

/** The scopes both lists hold, in `cap` order. A scope outside `cap` can never come back through the second list. */
export function intersectScopes(cap: string[], asked: string[]): string[] {
	const wanted = new Set(asked);
	return cap.filter((s) => wanted.has(s) && Object.hasOwn(SCOPES, s));
}

/** The scopes named in a hub header value: known scope names only. */
export function parseScopeHeader(value: string | string[] | undefined): string[] {
	const text = Array.isArray(value) ? value.join(",") : (value ?? "");
	return text.split(",").map((x) => x.trim()).filter((x) => Object.hasOwn(SCOPES, x));
}

/** A caller name safe for a tab group label and a session key. */
export function safeCallerName(value: string | string[] | undefined): string {
	const text = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
	return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

export interface ServeOptions {
	port: number;
	host: string;
	onListen?: (url: string) => void;
	/** With --public-url: OAuth for web connectors, and only these Host headers are served. */
	oauth?: OAuthConfig;
	/** Extra Host values to accept besides the public URL's and loopback (with oauth only). */
	allowedHosts?: string[];
	/**
	 * Accept the link-kind token and honor the hub's scope headers on it. Only `tabkyra link run` sets
	 * this, on its own loopback serve. It can't be combined with oauth (a public route): a link token
	 * must never be usable from the internet.
	 */
	acceptLinkTokens?: boolean;
	/** Called when the number of open or opening sessions changes (the link's heartbeat). */
	onSessionsChange?: (count: number) => void;
}

/** Serve MCP over Streamable HTTP on loopback. Each session is bound to the token that opened it. */
export async function serve(options: ServeOptions): Promise<{ close: () => Promise<void>; url: string; sessionCount: () => number; closeSessions: () => void }> {
	if (!LOOPBACK.has(options.host)) throw new Error(`tabkyra serve binds to loopback only (got ${options.host}). Use tabkyra tunnel to reach it from another device over TLS.`);
	if (options.acceptLinkTokens && options.oauth) throw new Error("A link token is never accepted on a public route: acceptLinkTokens can't be combined with a public URL.");
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; tokenId: string; lastSeen: number }>();
	const IDLE_MS = 30 * 60_000;
	const pending = new Map<string, number>();
	const MAX_SESSIONS_PER_TOKEN = 8;
	// The link token carries every caller the hub sends this device; the hub holds each caller to their own sessions.
	const MAX_SESSIONS_LINK = MAX_LINK_SESSIONS;
	// closeSessions() bumps this; a session still being set up when it did is closed as soon as it exists.
	let generation = 0;
	const notifySessions = () => options.onSessionsChange?.(sessions.size + [...pending.values()].reduce((a, b) => a + b, 0));
	// Close sessions that went quiet or whose token was revoked; a client that vanished without
	// a DELETE would otherwise hold a server and a tab group forever.
	const sweep = setInterval(() => {
		let tokens: TokenRecord[] = [];
		try {
			tokens = loadTokens();
		} catch {
			/* unreadable: treat every token as revoked */
		}
		const live = new Set(tokens.filter((t) => !t.revokedAt).map((t) => t.id));
		if (options.oauth) for (const id of liveGrantIds()) live.add(id);
		for (const [id, s] of sessions) {
			if (!live.has(s.tokenId) || Date.now() - s.lastSeen > IDLE_MS) {
				sessions.delete(id);
				void s.transport.close();
				notifySessions();
			}
		}
	}, 60_000);
	sweep.unref();

	const oauth = options.oauth;
	// Clients find the authorization server from this header (RFC 9728).
	const challenge = oauth ? `Bearer realm="tabkyra", resource_metadata="${resourceMetadataUrl(oauth)}"` : 'Bearer realm="tabkyra"';
	const deny = (res: ServerResponse, status: number, message: string) => {
		res.writeHead(status, { "content-type": "application/json", ...(status === 401 ? { "www-authenticate": challenge } : {}) });
		res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
	};

	/** A static token, or with OAuth on, a live OAuth access token. */
	function caller(header: string | undefined): Caller | undefined {
		const record = authenticate(header);
		// A link token works only on the loopback serve `link run` starts; anywhere else it is no token at all.
		if (record) return record.kind === "link" && !options.acceptLinkTokens ? undefined : record;
		const m = /^Bearer (\S+)$/.exec(header ?? "");
		return oauth && m ? verifyAccessToken(oauth, m[1]) : undefined;
	}

	const http = createServer((req: IncomingMessage, res: ServerResponse) => {
		handle(req, res).catch((err) => {
			process.stderr.write(`[tabkyra serve] ${err instanceof Error ? err.message : String(err)}\n`);
			if (!res.headersSent) deny(res, 500, "Internal error.");
			else res.end();
		});
	});

	async function readJson(req: IncomingMessage): Promise<unknown> {
		return JSON.parse(await readBody(req));
	}

	const port = () => {
		const address = http.address();
		return typeof address === "object" && address ? address.port : options.port;
	};

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://x").pathname;
		if (oauth) {
			// Behind a tunnel only the public name and loopback are ours; anything else is a misdirected or rebound request.
			const host = String(req.headers.host ?? "").toLowerCase();
			const allowed = new Set([new URL(oauth.publicUrl).host, `127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`, ...(options.allowedHosts ?? []).map((h) => h.toLowerCase())]);
			if (!allowed.has(host)) return deny(res, 421, "Misdirected request.");
			if (await handleOAuth(oauth, req, res, path)) return;
		}
		if (path !== "/mcp") return deny(res, 404, "Not found. The MCP endpoint is /mcp.");
		const token = caller(req.headers.authorization);
		if (!token) return deny(res, 401, oauth ? "Connect with OAuth or a valid, unrevoked bearer token." : "A valid, unrevoked bearer token is required (tabkyra token create).");
		const sessionId = req.headers["mcp-session-id"];
		const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
		if (existing) {
			// A session belongs to the token that opened it; another token can't ride on it.
			if (existing.tokenId !== token.id) return deny(res, 403, "This session belongs to another token.");
			existing.lastSeen = Date.now();
			recordUse(token.id);
			return existing.transport.handleRequest(req, res);
		}
		if (typeof sessionId === "string") return deny(res, 404, "Unknown or expired session. Start a new one with an initialize request.");
		if (req.method !== "POST") return deny(res, 400, "Start a session with an initialize POST.");
		let body: unknown;
		try {
			body = await readJson(req);
		} catch {
			return deny(res, 400, "The request body isn't valid JSON.");
		}
		// Only an initialize request creates a server; anything else would leak one per request.
		if (!isInitializeRequest(body)) return deny(res, 400, "Start a session with an initialize request.");
		// Count sessions being set up too, so parallel initializes can't pass the cap together.
		const isLink = token.kind === "link";
		const sessionCap = isLink ? MAX_SESSIONS_LINK : MAX_SESSIONS_PER_TOKEN;
		const open = [...sessions.values()].filter((s) => s.tokenId === token.id).length + (pending.get(token.id) ?? 0);
		if (open >= sessionCap) return deny(res, 429, `This token already has ${sessionCap} open sessions. Close one first.`);
		// Through the hub, the caller's scopes can only narrow the link token's own cap, never widen it. Every other token ignores the hub headers.
		let scopes = token.scopes;
		let label = token.name;
		if (isLink) {
			const asked = req.headers[HUB_SCOPES_HEADER];
			if (asked !== undefined) scopes = intersectScopes(token.scopes, parseScopeHeader(asked));
			label = safeCallerName(req.headers[HUB_CALLER_HEADER]) || token.name;
			if (scopes.length === 0) return deny(res, 403, "None of the caller's permissions are allowed on this device.");
		}
		pending.set(token.id, (pending.get(token.id) ?? 0) + 1);
		notifySessions();
		let reserved = true;
		const release = () => {
			if (!reserved) return;
			reserved = false;
			pending.set(token.id, Math.max(0, (pending.get(token.id) ?? 1) - 1));
			notifySessions();
		};
		const allowed = toolsFor(scopes);
		// Each session gets its own browser session (its own tab group), even under one token.
		const { server, client } = createMcpServer({
			name: `remote-${label}`,
			session: `remote-${token.id}-${randomUUID().slice(0, 8)}`,
			allowedTools: allowed,
			remote: true,
		});
		const born = generation;
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				if (born !== generation) {
					void transport.close();
					release();
					return;
				}
				sessions.set(id, { transport, tokenId: token.id, lastSeen: Date.now() });
				release();
				notifySessions();
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) sessions.delete(transport.sessionId);
			client.close?.();
			notifySessions();
		};
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} finally {
			// Initialization failed or never happened: give the slot back.
			release();
		}
		recordUse(token.id);
	}

	await new Promise<void>((resolve) => http.listen(options.port, options.host, resolve));
	const url = `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${port()}/mcp`;
	options.onListen?.(url);
	return {
		url,
		sessionCount: () => sessions.size + [...pending.values()].reduce((a, b) => a + b, 0),
		/** Close every open session (and any being set up): the link connection that carried them is gone. */
		closeSessions: () => {
			generation++;
			for (const [id, s] of [...sessions]) {
				sessions.delete(id);
				void s.transport.close();
			}
			notifySessions();
		},
		close: () =>
			new Promise<void>((resolve) => {
				clearInterval(sweep);
				for (const { transport } of sessions.values()) void transport.close();
				http.close(() => resolve());
			}),
	};
}
