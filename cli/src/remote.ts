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
import {
	approveAuthorize,
	authorizationServerMetadata,
	consentPage,
	describeSigned,
	exchangeToken,
	liveGrantIds,
	type OAuthConfig,
	OAuthError,
	protectedResourceMetadata,
	registerClient,
	resourceMetadataUrl,
	revokeGrant,
	validateAuthorize,
	verifyAccessToken,
} from "./oauth.ts";

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
}

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
export function createToken(name: string, scopes: string[]): { record: TokenRecord; token: string } {
	if (!/^[\w.-]{1,40}$/.test(name)) throw new Error("Token name: letters, digits, dot, dash or underscore, up to 40.");
	if (/^[0-9a-f]{8}$/.test(name)) throw new Error("A token name can't look like a token id (8 hex characters).");
	if (/^(tkc_|o-)/.test(name)) throw new Error("A token name can't start with tkc_ or o-: those name OAuth clients and grants.");

	if (scopes.length === 0) throw new Error(`Name at least one scope: ${Object.keys(SCOPES).join(", ")}. There is no wildcard.`);
	for (const s of scopes) if (!Object.hasOwn(SCOPES, s)) throw new Error(`Unknown scope ${s}. Scopes: ${Object.keys(SCOPES).join(", ")}. There is no wildcard.`);
	return withTokensLock(() => {
		if (loadTokens().some((t) => t.name === name && !t.revokedAt)) throw new Error(`An active token is already named ${name}. Revoke it or pick another name.`);
		const token = `tkr_${randomBytes(32).toString("base64url")}`;
		const record: TokenRecord = { id: randomUUID().slice(0, 8), name, scopes: [...new Set(scopes)], sha256: hash(token), createdAt: new Date().toISOString() };
		saveTokens([...loadTokens(), record]);
		return { record, token };
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
}

export interface ServeOptions {
	port: number;
	host: string;
	onListen?: (url: string) => void;
	/** With --public-url: OAuth for web connectors, and only these Host headers are served. */
	oauth?: OAuthConfig;
	/** Extra Host values to accept besides the public URL's and loopback (with oauth only). */
	allowedHosts?: string[];
}

/** Serve MCP over Streamable HTTP on loopback. Each session is bound to the token that opened it. */
export async function serve(options: ServeOptions): Promise<{ close: () => Promise<void>; url: string }> {
	if (!LOOPBACK.has(options.host)) throw new Error(`tabkyra serve binds to loopback only (got ${options.host}). Use tabkyra tunnel to reach it from another device over TLS.`);
	const sessions = new Map<string, { transport: StreamableHTTPServerTransport; tokenId: string; lastSeen: number }>();
	const IDLE_MS = 30 * 60_000;
	const pending = new Map<string, number>();
	const MAX_SESSIONS_PER_TOKEN = 8;
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
	const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
		res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
		res.end(JSON.stringify(body));
	};

	/** A static token, or with OAuth on, a live OAuth access token. */
	function caller(header: string | undefined): Caller | undefined {
		const record = authenticate(header);
		if (record) return record;
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

	async function readBody(req: IncomingMessage, limit = 4_000_000): Promise<string> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > limit) throw new Error("Request body too large.");
			chunks.push(chunk as Buffer);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	async function readJson(req: IncomingMessage): Promise<unknown> {
		return JSON.parse(await readBody(req));
	}

	const port = () => {
		const address = http.address();
		return typeof address === "object" && address ? address.port : options.port;
	};

	/** The OAuth endpoints. Returns false when the path isn't one of them. */
	async function handleOAuth(config: OAuthConfig, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
		const metadata = { "access-control-allow-origin": "*", "cache-control": "max-age=300" };
		if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
			sendJson(res, 200, protectedResourceMetadata(config), metadata);
			return true;
		}
		if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") {
			sendJson(res, 200, authorizationServerMetadata(config), metadata);
			return true;
		}
		const oauthPaths = ["/register", "/authorize", "/token", "/revoke"];
		// For rate limits only (oauth.ts): a forged header can spread a flood out, not get past the passcode.
		const forwarded = String(req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]).trim();
		const source = forwarded || req.socket.remoteAddress || "unknown";
		if (!oauthPaths.includes(path)) return false;
		const page = (status: number, html: { html: string; headers: Record<string, string> }) => {
			res.writeHead(status, html.headers);
			res.end(html.html);
		};
		const redirect = (to: string) => {
			res.writeHead(302, { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" });
			res.end();
		};
		const errorText = (status: number, message: string) => {
			res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			res.end(`${message}\n`);
		};
		try {
			if (path === "/register" && req.method === "POST") {
				let body: unknown;
				try {
					body = JSON.parse(await readBody(req, 64_000));
				} catch {
					throw new OAuthError(400, "invalid_client_metadata", "The registration body isn't valid JSON.");
				}
				sendJson(res, 201, registerClient(config, body, source));
				return true;
			}
			if (path === "/authorize" && req.method === "GET") {
				const result = validateAuthorize(config, new URL(req.url ?? "/", "http://x").searchParams);
				if ("redirect" in result) redirect(result.redirect);
				else page(200, consentPage(config, result));
				return true;
			}
			if (path === "/authorize" && req.method === "POST") {
				const form = new URLSearchParams(await readBody(req, 64_000));
				try {
					redirect((await approveAuthorize(config, form, source)).redirect);
				} catch (err) {
					// A wrong passcode or no permission ticked: show the form again.
					if (err instanceof OAuthError && (err.status === 401 || err.error === "invalid_scope")) {
						let again: ReturnType<typeof describeSigned> | undefined;
						try {
							again = describeSigned(form.get("request") ?? "", form.getAll("scope"));
						} catch {
							again = undefined;
						}
						if (again) {
							page(err.status, consentPage(config, again, err.description));
							return true;
						}
					}
					throw err;
				}
				return true;
			}
			if (path === "/token" && req.method === "POST") {
				const params = new URLSearchParams(await readBody(req, 64_000));
				sendJson(res, 200, exchangeToken(params, req.headers.authorization));
				return true;
			}
			if (path === "/revoke" && req.method === "POST") {
				const params = new URLSearchParams(await readBody(req, 64_000));
				revokeGrant(params, req.headers.authorization);
				sendJson(res, 200, {});
				return true;
			}
			errorText(405, "Method not allowed.");
			return true;
		} catch (err) {
			if (!(err instanceof OAuthError)) throw err;
			// The authorize page is a browser page; the rest are JSON APIs.
			if (path === "/authorize") errorText(err.status, err.description);
			else sendJson(res, err.status, { error: err.error, error_description: err.description });
			return true;
		}
	}

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
		const open = [...sessions.values()].filter((s) => s.tokenId === token.id).length + (pending.get(token.id) ?? 0);
		if (open >= MAX_SESSIONS_PER_TOKEN) return deny(res, 429, `This token already has ${MAX_SESSIONS_PER_TOKEN} open sessions. Close one first.`);
		pending.set(token.id, (pending.get(token.id) ?? 0) + 1);
		let reserved = true;
		const release = () => {
			if (!reserved) return;
			reserved = false;
			pending.set(token.id, Math.max(0, (pending.get(token.id) ?? 1) - 1));
		};
		const allowed = toolsFor(token.scopes);
		// Each session gets its own browser session (its own tab group), even under one token.
		const { server, client } = createMcpServer({
			name: `remote-${token.name}`,
			session: `remote-${token.id}-${randomUUID().slice(0, 8)}`,
			allowedTools: allowed,
			remote: true,
		});
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id) => {
				sessions.set(id, { transport, tokenId: token.id, lastSeen: Date.now() });
				release();
			},
		});
		transport.onclose = () => {
			if (transport.sessionId) sessions.delete(transport.sessionId);
			client.close?.();
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
		close: () =>
			new Promise<void>((resolve) => {
				clearInterval(sweep);
				for (const { transport } of sessions.values()) void transport.close();
				http.close(() => resolve());
			}),
	};
}
