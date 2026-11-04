/**
 * Sign in with ChatGPT for open-source and locally hosted apps, run by the native host.
 * Follows https://developers.openai.com/siwc/token-sharing-open-source and its sub-pages
 * (read 2026-10-28): dynamic registration with `dynamic_agent_client` and no client secret, a
 * stable ext_agent_host_id per host, a loopback callback on 127.0.0.1 with an unchanged path,
 * PKCE S256, ID token checked against OpenAI's JWKS, the plan scope checked before any
 * inference, owner-only credential files, serialized refresh, and revocation on sign-out.
 */

import { createHash, createPublicKey, type JsonWebKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { SIWC } from "../../../src/subscriptions/constants.ts";
import { listJson, readPrivateJson, removeFile, subscriptionsDir, withFileLock, writePrivateJson } from "./store.ts";

export type Fetch = typeof fetch;

/** One credential record per issued client id, in the shape the SIWC sign-in page shows. */
export interface ChatGptRecord {
	email?: string;
	issuer: string;
	subject: string;
	client_id: string;
	ext_agent_host_id: string;
	id_token?: string;
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	expires_in?: number;
	earliest_refresh_at?: number;
	scopes: string[];
	saved_at?: string;
}

export interface ChatGptStatus {
	signedIn: boolean;
	email?: string;
	/** chatgpt.tokens.use.direct was granted: requests may use the ChatGPT plan. */
	planUsage: boolean;
	/** A sign-in was registered before (its client id is reused for the next sign-in). */
	registered: boolean;
}

export class SubscriptionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SubscriptionError";
	}
}

const b64url = (buf: Buffer) => buf.toString("base64url");
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
/** Refresh errors that mean the token set is dead (errors-and-recovery page). */
const DEAD_REFRESH_CODES = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

interface OidcConfig {
	jwks_uri: string;
	revocation_endpoint?: string;
	issuer?: string;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	token_type?: string;
	expires_in?: number;
	scope?: string;
	earliest_refresh_at?: number;
	error?: string;
	error_description?: string;
}

export interface SiwcOptions {
	fetch?: Fetch;
	dir?: string;
	now?: () => number;
	/** Port to try first for the callback; 0 always picks a free one (tests). */
	preferredPort?: number;
}

export interface PendingSignIn {
	authorizeUrl: string;
	redirectUri: string;
	result: Promise<ChatGptStatus>;
	cancel: () => void;
}

type Jwk = JsonWebKey & { kid?: string; alg?: string };

export class Siwc {
	private readonly fetch: Fetch;
	private readonly dir: string;
	private readonly now: () => number;
	private readonly preferredPort: number;
	private oidc?: { config: OidcConfig; at: number };
	private jwks?: { keys: Jwk[]; at: number };
	private refreshing?: Promise<ChatGptRecord>;
	private pending?: PendingSignIn;
	/** Bumped by sign-out: a refresh or sign-in that started before it must not write tokens back. */
	private generation = 0;

	constructor(options: SiwcOptions = {}) {
		this.fetch = options.fetch ?? fetch;
		this.dir = options.dir ?? subscriptionsDir();
		this.now = options.now ?? Date.now;
		this.preferredPort = options.preferredPort ?? SIWC.preferredPort;
	}

	private get accountsDir(): string {
		return join(this.dir, "chatgpt");
	}

	private recordPath(clientId: string): string {
		// Issued ids look like oaiapp_...; anything else can't name a file.
		if (!/^[A-Za-z0-9_.-]{1,128}$/.test(clientId)) throw new SubscriptionError("invalid_client", "Unexpected client id from OpenAI");
		return join(this.accountsDir, `${clientId}.json`);
	}

	/** The host's stable, opaque ext_agent_host_id, created once before the first sign-in. */
	hostId(): string {
		const path = join(this.dir, "chatgpt-host-id.json");
		const saved = readPrivateJson<{ ext_agent_host_id?: string }>(path)?.ext_agent_host_id;
		if (saved?.startsWith("urn:uuid:")) return saved;
		const id = `urn:uuid:${randomUUID()}`;
		writePrivateJson(path, { ext_agent_host_id: id });
		return id;
	}

	activeRecord(): ChatGptRecord | undefined {
		const active = readPrivateJson<{ client_id?: string }>(join(this.accountsDir, "active.json"))?.client_id;
		if (active) {
			const record = readPrivateJson<ChatGptRecord>(this.recordPath(active));
			if (record) return record;
		}
		// No pointer: the only record there is, if exactly one.
		const files = listJson(this.accountsDir).filter((f) => f !== "active.json");
		if (files.length === 1) return readPrivateJson<ChatGptRecord>(join(this.accountsDir, files[0]));
		return undefined;
	}

	status(): ChatGptStatus {
		const record = this.activeRecord();
		const signedIn = Boolean(record?.access_token || record?.refresh_token);
		return {
			signedIn,
			...(signedIn && record?.email ? { email: record.email } : {}),
			planUsage: signedIn && Boolean(record?.scopes.includes(SIWC.planScope)),
			registered: Boolean(record),
		};
	}

	/**
	 * Start a sign-in: listener first, then the authorization URL for the browser. A saved
	 * registration is reauthorized with its issued client id; otherwise the app registers
	 * with dynamic_agent_client.
	 */
	async startSignIn(): Promise<PendingSignIn> {
		this.pending?.cancel();
		const saved = this.activeRecord();
		const hostId = saved?.ext_agent_host_id ?? this.hostId();
		const state = b64url(randomBytes(32));
		const nonce = b64url(randomBytes(32));
		const verifier = b64url(randomBytes(48));
		const generation = this.generation;
		const challenge = b64url(createHash("sha256").update(verifier).digest());

		const { server, port } = await this.listen();
		const redirectUri = `http://${SIWC.callbackHost}:${port}${SIWC.callbackPath}`;
		const params = new URLSearchParams();
		params.set("client_id", saved ? saved.client_id : SIWC.dynamicClient);
		if (!saved) params.set("agent_name_hint", SIWC.agentName);
		params.set("ext_agent_host_id", hostId);
		// No id_token_hint: it is optional, and this URL passes through the extension and the
		// browser's history, which must never hold a token. The saved email pre-selects the account.
		if (saved?.email) params.set("login_hint", saved.email);
		params.set("response_type", "code");
		params.set("redirect_uri", redirectUri);
		params.set("scope", SIWC.scope);
		params.set("resource", SIWC.resource);
		params.set("state", state);
		params.set("nonce", nonce);
		params.set("code_challenge_method", "S256");
		params.set("code_challenge", challenge);
		const authorizeUrl = `${SIWC.authorizeUrl}?${params.toString()}`;

		let settle: { resolve: (s: ChatGptStatus) => void; reject: (e: Error) => void } | undefined;
		const result = new Promise<ChatGptStatus>((resolve, reject) => {
			settle = { resolve, reject };
		});
		// The caller may never await a cancelled attempt; don't let it surface as unhandled.
		result.catch(() => undefined);
		let done = false;
		const finish = (error?: Error, status?: ChatGptStatus) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			server.close();
			server.closeIdleConnections?.();
			if (this.pending?.result === result) this.pending = undefined;
			if (error) settle?.reject(error);
			else if (status) settle?.resolve(status);
		};
		const timer = setTimeout(
			() => finish(new SubscriptionError("timeout", "The ChatGPT sign-in timed out. Start it again.")),
			SIGN_IN_TIMEOUT_MS,
		);
		timer.unref?.();

		server.on("request", (req, res) => {
			const url = new URL(req.url ?? "/", `http://${SIWC.callbackHost}:${port}`);
			if (req.method !== "GET" || url.pathname !== SIWC.callbackPath) {
				res.writeHead(404).end();
				return;
			}
			const page = (status: number, text: string) => {
				res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				res.end(
					`<!doctype html><meta charset="utf-8"><title>Tabkyra</title><body style="font:16px system-ui;margin:3em"><p>${text}</p></body>`,
				);
			};
			// A callback without our state is not ours: answer it and keep waiting for the real one.
			if (url.searchParams.get("state") !== state) {
				page(400, "This sign-in link doesn't match the one Tabkyra started. Start the sign-in again from Tabkyra's settings.");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				page(200, "Sign-in was cancelled. You can close this tab.");
				const declined = error === "access_denied";
				finish(new SubscriptionError(declined ? "declined" : error, declined ? "You declined the ChatGPT sign-in." : `ChatGPT sign-in failed: ${error}`));
				return;
			}
			const code = url.searchParams.get("code");
			const returned = url.searchParams.get("client_id");
			let clientId: string;
			if (saved) {
				// Reauthorization keeps the selected registration; a different id is rejected, never swapped in.
				if (returned && returned !== saved.client_id) {
					page(400, "ChatGPT returned a different app registration. Sign-in stopped.");
					finish(new SubscriptionError("client_mismatch", "ChatGPT returned a different client id; the saved registration was kept."));
					return;
				}
				clientId = saved.client_id;
			} else {
				if (!returned || returned === SIWC.dynamicClient) {
					page(400, "Registration did not complete. Start the sign-in again.");
					finish(new SubscriptionError("registration_incomplete", "ChatGPT did not return an issued client id; registration is incomplete."));
					return;
				}
				clientId = returned;
			}
			if (!code) {
				page(400, "No authorization code came back. Start the sign-in again.");
				finish(new SubscriptionError("no_code", "No authorization code in the callback."));
				return;
			}
			this.complete({ code, clientId, verifier, redirectUri, nonce, hostId, saved, current: () => !done && generation === this.generation }).then(
				(status) => {
					page(200, "Tabkyra is signed in with ChatGPT. You can close this tab.");
					finish(undefined, status);
				},
				(err: Error) => {
					page(400, `Sign-in failed: ${escapeHtml(err.message)}`);
					finish(err);
				},
			);
		});

		this.pending = {
			authorizeUrl,
			redirectUri,
			result,
			cancel: () => finish(new SubscriptionError("cancelled", "Sign-in cancelled.")),
		};
		return this.pending;
	}

	cancelSignIn(): void {
		this.pending?.cancel();
	}

	private listen(): Promise<{ server: Server; port: number }> {
		const attempt = (port: number) =>
			new Promise<{ server: Server; port: number }>((resolve, reject) => {
				const server = createServer();
				server.once("error", reject);
				server.listen(port, SIWC.callbackHost, () => {
					const address = server.address();
					resolve({ server, port: typeof address === "object" && address ? address.port : port });
				});
			});
		// The documented example port first; any free one when it's taken (only the port may vary).
		return this.preferredPort ? attempt(this.preferredPort).catch(() => attempt(0)) : attempt(0);
	}

	private async complete(args: {
		code: string;
		clientId: string;
		verifier: string;
		redirectUri: string;
		nonce: string;
		hostId: string;
		saved?: ChatGptRecord;
		/** False once the attempt was cancelled or the user signed out meanwhile. */
		current: () => boolean;
	}): Promise<ChatGptStatus> {
		const tokens = await this.tokenRequest([
			["grant_type", "authorization_code"],
			["client_id", args.clientId],
			["code", args.code],
			["code_verifier", args.verifier],
			["redirect_uri", args.redirectUri],
			["resource", SIWC.resource],
		]);
		if (tokens.error) {
			if (tokens.error === "invalid_grant")
				throw new SubscriptionError("invalid_grant", "The sign-in code was not accepted. Start the sign-in again.");
			throw new SubscriptionError(tokens.error, `Token exchange failed: ${tokens.error}`);
		}
		if (!tokens.access_token || !tokens.id_token)
			throw new SubscriptionError("bad_token_response", "OpenAI's token response had no access or ID token.");
		const claims = await this.validateIdToken(tokens.id_token, args.clientId, args.nonce);
		if (args.saved && args.saved.subject !== claims.sub)
			throw new SubscriptionError(
				"account_mismatch",
				"That ChatGPT account isn't the one this registration belongs to. Nothing was replaced.",
			);
		const record: ChatGptRecord = {
			issuer: SIWC.issuer,
			subject: claims.sub,
			client_id: args.clientId,
			ext_agent_host_id: args.hostId,
			token_type: tokens.token_type ?? "Bearer",
			expires_in: tokens.expires_in ?? 3600,
			scopes: (tokens.scope ?? "").split(" ").filter(Boolean).sort(),
			saved_at: new Date(this.now()).toISOString(),
		};
		Object.assign(record, pickTokens(tokens));
		if (claims.email) record.email = claims.email;
		if (tokens.earliest_refresh_at) record.earliest_refresh_at = tokens.earliest_refresh_at;
		if (!args.current()) throw new SubscriptionError("cancelled", "Sign-in cancelled.");
		writePrivateJson(this.recordPath(args.clientId), record);
		writePrivateJson(join(this.accountsDir, "active.json"), { client_id: args.clientId });
		return this.status();
	}

	private async tokenRequest(form: Array<[string, string]>): Promise<TokenResponse> {
		const response = await this.fetch(SIWC.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams(form).toString(),
			// Well under the refresh lock's stale age, so a hung request can't outlive its lock.
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const body = (await response.json().catch(() => ({}))) as Omit<TokenResponse, "error"> & {
			error?: string | { code?: string };
		};
		if (!response.ok || body.error) {
			const code = typeof body.error === "string" ? body.error : (body.error?.code ?? `http_${response.status}`);
			return { error: code, error_description: body.error_description };
		}
		return body as TokenResponse;
	}

	private async oidcConfig(): Promise<OidcConfig> {
		if (this.oidc && this.now() - this.oidc.at < 3600_000) return this.oidc.config;
		const response = await this.fetch(SIWC.discoveryUrl, { headers: { Accept: "application/json" } });
		if (!response.ok)
			throw new SubscriptionError("discovery_failed", `OpenAI's sign-in configuration is unavailable (${response.status}).`);
		const config = (await response.json()) as OidcConfig;
		if (!config.jwks_uri?.startsWith("https://"))
			throw new SubscriptionError("discovery_failed", "OpenAI's sign-in configuration has no JWKS.");
		this.oidc = { config, at: this.now() };
		return config;
	}

	private async signingKey(kid: string | undefined): Promise<Jwk> {
		const find = () => this.jwks?.keys.find((k) => (kid ? k.kid === kid : true));
		if (!this.jwks || this.now() - this.jwks.at > 3600_000 || !find()) {
			const response = await this.fetch((await this.oidcConfig()).jwks_uri, { headers: { Accept: "application/json" } });
			if (!response.ok) throw new SubscriptionError("jwks_failed", `OpenAI's signing keys are unavailable (${response.status}).`);
			this.jwks = { keys: ((await response.json()) as { keys?: Jwk[] }).keys ?? [], at: this.now() };
		}
		const key = find();
		if (!key) throw new SubscriptionError("invalid_id_token", "The ID token was signed with an unknown key.");
		return key;
	}

	/** Signature against OpenAI's JWKS, then issuer, audience (the issued client id), expiry and nonce. */
	async validateIdToken(idToken: string, clientId: string, nonce: string): Promise<{ sub: string; email?: string }> {
		const parts = idToken.split(".");
		if (parts.length !== 3) throw new SubscriptionError("invalid_id_token", "Malformed ID token.");
		const [h, p, s] = parts;
		let header: { alg?: string; kid?: string };
		let claims: { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };
		try {
			header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
			claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
		} catch {
			throw new SubscriptionError("invalid_id_token", "Malformed ID token.");
		}
		const algs: Record<string, { hash: string; dsa?: "ieee-p1363" }> = {
			RS256: { hash: "sha256" },
			ES256: { hash: "sha256", dsa: "ieee-p1363" },
		};
		const alg = header.alg ? algs[header.alg] : undefined;
		if (!alg) throw new SubscriptionError("invalid_id_token", `Unsupported ID token algorithm ${header.alg}.`);
		const key = createPublicKey({ key: await this.signingKey(header.kid), format: "jwk" });
		const ok = verifySignature(
			alg.hash,
			Buffer.from(`${h}.${p}`),
			alg.dsa ? { key, dsaEncoding: alg.dsa } : key,
			Buffer.from(s, "base64url"),
		);
		if (!ok) throw new SubscriptionError("invalid_id_token", "The ID token signature is not valid.");
		if (claims.iss !== SIWC.issuer) throw new SubscriptionError("invalid_id_token", "The ID token has the wrong issuer.");
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(clientId)) throw new SubscriptionError("invalid_id_token", "The ID token was issued to another client.");
		if (typeof claims.exp !== "number" || claims.exp * 1000 < this.now() - 60_000)
			throw new SubscriptionError("invalid_id_token", "The ID token has expired.");
		if (claims.nonce !== nonce) throw new SubscriptionError("invalid_id_token", "The ID token's nonce doesn't match this sign-in.");
		if (!claims.sub) throw new SubscriptionError("invalid_id_token", "The ID token has no subject.");
		return { sub: claims.sub, ...(claims.email ? { email: claims.email } : {}) };
	}

	private expiresAt(record: ChatGptRecord): number {
		const saved = record.saved_at ? Date.parse(record.saved_at) : 0;
		return saved + (record.expires_in ?? 3600) * 1000;
	}

	/**
	 * A current access token for inference, refreshed near expiry. Refuses when the plan scope
	 * wasn't granted: a valid sign-in alone does not authorize ChatGPT plan usage.
	 */
	async accessToken(): Promise<string> {
		let record = this.activeRecord();
		if (!record?.access_token && !record?.refresh_token)
			throw new SubscriptionError("not_signed_in", "Sign in with ChatGPT first (Settings).");
		if (!record.scopes.includes(SIWC.planScope))
			throw new SubscriptionError(
				"plan_usage_disabled",
				"ChatGPT plan usage isn't enabled for this sign-in. Choose Continue with ChatGPT again and allow plan usage, or use an API key.",
			);
		if (!record.access_token || this.now() > this.expiresAt(record) - REFRESH_MARGIN_MS) record = await this.refresh();
		if (!record.access_token) throw new SubscriptionError("not_signed_in", "Sign in with ChatGPT again.");
		// A refresh can return a narrower grant; check the token actually being handed out.
		if (!record.scopes.includes(SIWC.planScope))
			throw new SubscriptionError("plan_usage_disabled", "ChatGPT plan usage is no longer enabled for this sign-in. Choose Continue with ChatGPT again, or use an API key.");
		return record.access_token;
	}

	/** Standard refresh near expiry, one at a time per process and per credential file. */
	refresh(): Promise<ChatGptRecord> {
		if (!this.refreshing) {
			this.refreshing = this.refreshLocked().finally(() => {
				this.refreshing = undefined;
			});
		}
		return this.refreshing;
	}

	private async refreshLocked(): Promise<ChatGptRecord> {
		const generation = this.generation;
		const first = this.activeRecord();
		if (!first) throw new SubscriptionError("not_signed_in", "Sign in with ChatGPT first.");
		return withFileLock(`${this.recordPath(first.client_id)}.lock`, async () => {
			// Another host may have refreshed while this one waited for the lock.
			const record = readPrivateJson<ChatGptRecord>(this.recordPath(first.client_id)) ?? first;
			if (record.access_token && this.now() <= this.expiresAt(record) - REFRESH_MARGIN_MS) return record;
			const renewable = record.refresh_token;
			if (!renewable) throw new SubscriptionError("not_signed_in", "Your ChatGPT sign-in expired. Sign in again.");
			const tokens = await this.tokenRequest([
				["grant_type", "refresh_token"],
				["client_id", record.client_id],
				["refresh_token", renewable],
				["resource", SIWC.resource],
			]);
			if (tokens.error) {
				if (DEAD_REFRESH_CODES.has(tokens.error)) {
					this.clearTokens(record);
					throw new SubscriptionError("signed_out", "Your ChatGPT sign-in is no longer valid. Sign in again.");
				}
				if (tokens.error === "invalid_client")
					throw new SubscriptionError("invalid_client", "ChatGPT rejected Tabkyra's registration. Sign in again.");
				throw new SubscriptionError(tokens.error, `Refreshing the ChatGPT sign-in failed (${tokens.error}); try again shortly.`);
			}
			if (!tokens.access_token) throw new SubscriptionError("bad_token_response", "OpenAI's refresh response had no access token.");
			// Access token, expiry, scopes and the rotating refresh token are replaced together.
			const next: ChatGptRecord = {
				...record,
				expires_in: tokens.expires_in ?? 3600,
				scopes: tokens.scope ? tokens.scope.split(" ").filter(Boolean).sort() : record.scopes,
				saved_at: new Date(this.now()).toISOString(),
			};
			Object.assign(next, pickTokens(tokens));
			if (tokens.earliest_refresh_at) next.earliest_refresh_at = tokens.earliest_refresh_at;
			// Signed out while this ran: the new tokens are dropped, never written back.
			if (generation !== this.generation) throw new SubscriptionError("signed_out", "Signed out.");
			writePrivateJson(this.recordPath(record.client_id), next);
			return next;
		});
	}

	private clearTokens(record: ChatGptRecord): void {
		const kept: ChatGptRecord = { ...record, scopes: [] };
		for (const field of TOKEN_FIELDS) delete kept[field];
		writePrivateJson(this.recordPath(record.client_id), kept);
	}

	/**
	 * Sign out: revoke the renewable session, then clear the access, refresh and ID tokens.
	 * The account-to-client mapping and the host id stay for a later sign-in.
	 */
	async signOut(): Promise<{ revoked: boolean }> {
		this.generation++;
		this.pending?.cancel();
		await this.refreshing?.catch(() => undefined);
		const first = this.activeRecord();
		if (!first) return { revoked: true };
		// Under the refresh lock, so another host can't rotate the token while it is revoked and cleared.
		return withFileLock(`${this.recordPath(first.client_id)}.lock`, () => this.revokeAndClear(first.client_id));
	}

	private async revokeAndClear(clientId: string): Promise<{ revoked: boolean }> {
		const record = readPrivateJson<ChatGptRecord>(this.recordPath(clientId));
		if (!record) return { revoked: true };
		const renewable = record.refresh_token;
		let revoked = !renewable;
		if (renewable) {
			for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
				try {
					const endpoint = (await this.oidcConfig()).revocation_endpoint;
					if (!endpoint) break;
					const form: Array<[string, string]> = [
						["token", renewable],
						["token_type_hint", "refresh_token"],
						["client_id", record.client_id],
					];
					const response = await this.fetch(endpoint, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams(form).toString(),
						signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
					});
					if (response.ok) revoked = true;
					else if (response.status < 500) break;
				} catch {
					/* network failure: retry with backoff */
				}
				if (!revoked && attempt < 2) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
			}
		}
		this.clearTokens(record);
		return { revoked };
	}

	/** Forget this host's ChatGPT registrations completely. */
	forgetAll(): void {
		for (const name of listJson(this.accountsDir)) removeFile(join(this.accountsDir, name));
	}
}

const TOKEN_FIELDS = ["id_token", "access_token", "refresh_token"] as const;

/** The three token fields of a token response, when present. */
function pickTokens(tokens: TokenResponse): Partial<Pick<ChatGptRecord, (typeof TOKEN_FIELDS)[number]>> {
	const out: Partial<Pick<ChatGptRecord, (typeof TOKEN_FIELDS)[number]>> = {};
	for (const field of TOKEN_FIELDS) if (tokens[field]) out[field] = tokens[field];
	return out;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
