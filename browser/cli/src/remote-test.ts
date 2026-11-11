/**
 * `remote test`: what a web assistant would see, checked from outside. The public name is resolved through DNS over HTTPS, and
 * every request goes to that public address with the name as TLS SNI and Host, so a ts.net name is never answered from inside
 * the tailnet (where this computer's resolver gives a 100.x address and the fetch never leaves the tailnet).
 *
 * The streaming probe needs a token. It is minted here with the narrowest scope (skills.read: no browser access), used for one
 * request, and deleted in a `finally` and on SIGINT or SIGTERM. It also expires two minutes after it is made, enforced where
 * tokens are checked, so a failed delete heals itself. Its secret is never printed, logged or put in a report.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { DohAnswerError, dohAddresses } from "./doh.ts";
import { createToken, deleteToken } from "./remote.ts";
import { inTailnetRange, METADATA_PATH } from "./remote-state.ts";
import { COMMAND_NAME } from "./self.ts";
import { VERSION } from "./version.ts";

export type ProofName = "dns" | "tls" | "resource_metadata" | "auth_metadata" | "auth_challenge" | "streaming" | "probe_cleanup";

/** One line of `remote test`: ok, warn or fail, and on a failure the one thing to do next. */
export interface ProofCheck {
	name: ProofName;
	status: "ok" | "warn" | "fail";
	detail: string;
	next?: string;
	/** On a failure: true when it is what a new name looks like for its first few minutes (no public address yet, or nothing answers yet). */
	pending?: boolean;
}

/** The first bytes of a streamed answer must arrive this fast. Quick tunnels and buffering proxies hold them back. */
export const STREAM_FIRST_BYTE_MS = 5000;
/** The narrowest scope there is: it grants reading bundled skills and nothing in the browser. */
export const PROBE_SCOPE = "skills.read";
/** The probe token stops working this long after it is made, even if deleting it fails. The probe needs a few seconds. */
export const PROBE_TTL_MS = 2 * 60_000;

const REQUEST_MS = 10_000;

/** Loopback, private, link-local and the tailnet range: addresses the internet can't reach. */
export function privateAddress(address: string): boolean {
	if (isIP(address) === 6) return /^(::1|fe80:|fc|fd)/i.test(address);
	const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address);
	if (!m) return true;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || inTailnetRange(address);
}

/**
 * Test seams, set only by a module a test preloads (test/helpers/remote-test-hooks.mjs) or passed to publicChecks. No
 * environment variable reaches them, so nothing a person sets can make loopback count as public or make the probe fail.
 */
export interface RemoteTestHooks {
	/** True for an address that counts as public although privateAddress says otherwise (a fake server on 127.0.0.1). */
	reachable?: (address: string) => boolean;
	/** Runs right after the probe token is made, before it is used. */
	afterMint?: () => void;
}

const HOOKS = Symbol.for("polycarp.remote-test.hooks");
const preloadedHooks = (): RemoteTestHooks => ((globalThis as Record<symbol, unknown>)[HOOKS] as RemoteTestHooks | undefined) ?? {};

type Lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void;

/** A `lookup` that always gives `address`: the connection goes there whatever this computer's resolver says. */
const pinned =
	(address: string): Lookup =>
	(_hostname, options, callback) => {
		const family = isIP(address) === 6 ? 6 : 4;
		if (options?.all) callback(null, [{ address, family }]);
		else callback(null, address, family);
	};

interface Answer {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
	/** ms from sending the request to the first byte of the body; undefined when none came before the limit. */
	firstByteMs?: number;
}

/**
 * One HTTPS request to `address`, with `url`'s name as SNI and Host and the certificate checked against it. Its deadline is
 * absolute, started before the request opens: bytes that trickle in slowly enough to keep the socket busy don't stretch it.
 * `firstByteMs`: that is the deadline, and the answer is the response as it stands at the first body bytes; when the headers
 * came but no body bytes did, it resolves without `firstByteMs`.
 */
function publicRequest(url: URL, address: string, init: { method: string; headers?: Record<string, string>; body?: string; firstByteMs?: number; limitMs?: number }): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const limit = init.firstByteMs ?? init.limitMs ?? REQUEST_MS;
		let response: IncomingMessage | undefined;
		let body = "";
		let firstByteMs: number | undefined;
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			req.destroy();
			if (err) reject(err);
			else resolve({ status: response?.statusCode ?? 0, headers: response?.headers ?? {}, body, firstByteMs });
		};
		const deadline = setTimeout(() => {
			if (init.firstByteMs && response) finish();
			else finish(new Error(`no answer in ${Math.round(limit / 1000)} seconds`));
		}, limit);
		const req = httpsRequest(
			{
				host: url.hostname,
				port: url.port || 443,
				path: `${url.pathname}${url.search}`,
				method: init.method,
				headers: { "user-agent": `polycarp-browser/${VERSION} (remote test)`, ...init.headers },
				servername: isIP(url.hostname) ? undefined : url.hostname,
				lookup: pinned(address) as never,
				agent: false,
			},
			(res) => {
				response = res;
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					if (firstByteMs === undefined) firstByteMs = Date.now() - started;
					if (body.length < 65_536) body += chunk;
					if (init.firstByteMs) finish();
				});
				res.on("end", () => finish());
				res.on("error", (err) => finish(err));
			},
		);
		req.on("error", (err) => finish(err));
		req.end(init.body);
	});
}

/** The TLS handshake alone, to the public address with the name as SNI: is the certificate valid for the name, and until when? */
function tlsCheck(url: URL, address: string): Promise<ProofCheck> {
	return new Promise((resolve) => {
		const port = Number(url.port || 443);
		const socket = tlsConnect({ host: address, port, servername: url.hostname, timeout: REQUEST_MS });
		const done = (check: ProofCheck) => {
			socket.destroy();
			resolve(check);
		};
		socket.on("secureConnect", () => {
			const cert = socket.getPeerCertificate();
			done({ name: "tls", status: "ok", detail: `${address}:${port} has a valid certificate for ${url.hostname}${cert?.valid_to ? `, until ${cert.valid_to}` : ""}` });
		});
		socket.on("timeout", () => done({ name: "tls", status: "fail", pending: true, detail: `${address}:${port} didn't answer in ${REQUEST_MS / 1000} seconds`, next: `The public address doesn't answer. Run ${COMMAND_NAME} remote fix.` }));
		socket.on("error", (err: NodeJS.ErrnoException) => done(tlsFailure(err, url, address, port)));
	});
}

/** OpenSSL and Node codes for a certificate that was offered and refused: wrong name, expired, self-signed, unknown issuer. */
const CERTIFICATE_CODE = /^(ERR_TLS_CERT|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|ERR_SSL_SSLV3_ALERT_(BAD|UNSUPPORTED|CERTIFICATE)_CERTIFICATE)/;

/** A failed TLS handshake, sorted by its code: refused (nothing listens yet), a refused certificate, not TLS at all, or no route. */
export function tlsFailure(err: NodeJS.ErrnoException, url: URL, address: string, port: number): ProofCheck {
	const code = err.code ?? "";
	const why = `${err.message}${code ? ` (${code})` : ""}`;
	if (code === "ECONNREFUSED" || code === "ECONNRESET") {
		return { name: "tls", status: "fail", pending: true, detail: `${address}:${port} refused the connection (${code})`, next: `Nothing public answers for ${url.host}. Run ${COMMAND_NAME} remote fix.` };
	}
	if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
		return {
			name: "tls",
			status: "fail",
			pending: true,
			detail: `this computer has no route to ${address}:${port} (${code})`,
			next: `That is this computer's network, not the setup. Check its connection (an IPv6 address needs an IPv6 route), then run ${COMMAND_NAME} remote test.`,
		};
	}
	if (CERTIFICATE_CODE.test(code)) {
		return {
			name: "tls",
			status: "fail",
			detail: `the certificate isn't valid for ${url.hostname}: ${why}`,
			next: `Assistants refuse this certificate. On your own front door, give it a certificate for ${url.hostname}; on Tailscale or Cloudflare, run ${COMMAND_NAME} remote fix.`,
		};
	}
	if (/^(ERR_SSL_|ERR_TLS_|EPROTO$)/.test(code)) {
		return { name: "tls", status: "fail", detail: `${address}:${port} answers, but not with HTTPS: ${why}`, next: `Something on ${url.host} speaks plain HTTP or another protocol. Point the name at an HTTPS front door, or run ${COMMAND_NAME} remote fix on Tailscale or Cloudflare.` };
	}
	return { name: "tls", status: "fail", detail: `couldn't connect to ${address}:${port}: ${why}`, next: `${address} can't be reached from here. Check that public DNS for ${url.hostname} points at the right address, or run ${COMMAND_NAME} remote fix on Tailscale or Cloudflare.` };
}

const header = (answer: Answer, name: string) => {
	const value = answer.headers[name];
	return Array.isArray(value) ? value.join(", ") : (value ?? "");
};

const parse = (body: string): Record<string, unknown> | undefined => {
	try {
		const value = JSON.parse(body) as unknown;
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
};

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "polycarp-remote-test", version: VERSION } } });

/** The probe's one authenticated initialize, whose answer serve streams (text/event-stream). Its first bytes must arrive within STREAM_FIRST_BYTE_MS. */
async function probe(address: string, publicUrl: string, token: string): Promise<ProofCheck> {
	const auth = { authorization: `Bearer ${token}` };
	const mcp = new URL("/mcp", publicUrl);
	const held = {
		name: "streaming" as const,
		status: "fail" as const,
		next: `Assistants time out on a held stream. A quick tunnel (trycloudflare.com) or a buffering proxy does this: use ${COMMAND_NAME} remote setup (Tailscale Funnel or a Cloudflare named tunnel), or turn buffering off in your proxy.`,
	};
	let answer: Answer;
	try {
		answer = await publicRequest(mcp, address, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: initialize,
			firstByteMs: STREAM_FIRST_BYTE_MS,
		});
	} catch (err) {
		return { ...held, detail: `POST /mcp gave nothing in ${STREAM_FIRST_BYTE_MS / 1000} seconds (${err instanceof Error ? err.message : String(err)})` };
	}
	const session = header(answer, "mcp-session-id");
	if (session) {
		// Close the session the probe opened, so it doesn't wait for serve's idle sweep.
		await publicRequest(mcp, address, { method: "DELETE", headers: { ...auth, "mcp-session-id": session }, limitMs: 3000 }).catch(() => undefined);
	}
	if (answer.status === 401 || answer.status === 403) {
		return { name: "streaming", status: "fail", detail: `the probe's own token was refused (${answer.status})`, next: `The public address reaches a serve that doesn't use this computer's tokens. Run ${COMMAND_NAME} remote fix.` };
	}
	if (answer.status !== 200) return { name: "streaming", status: "fail", detail: `POST /mcp answered ${answer.status}`, next: `Run ${COMMAND_NAME} remote fix, then ${COMMAND_NAME} remote test again.` };
	if (!/text\/event-stream/.test(header(answer, "content-type"))) {
		return { name: "streaming", status: "fail", detail: `POST /mcp answered ${header(answer, "content-type") || "no content type"}, not a stream (text/event-stream)`, next: "Something between the internet and serve rewrites the answer. Use Tailscale Funnel or a Cloudflare named tunnel (remote setup)." };
	}
	if (answer.firstByteMs === undefined || answer.firstByteMs > STREAM_FIRST_BYTE_MS) return { ...held, detail: `the stream's first bytes didn't arrive in ${STREAM_FIRST_BYTE_MS / 1000} seconds: something between the internet and serve holds them back` };
	return { name: "streaming", status: "ok", detail: `the stream's first bytes arrived in ${answer.firstByteMs} ms` };
}

/**
 * The streaming check and its token. The token is made for this call with PROBE_SCOPE and a PROBE_TTL_MS expiry, and deleted
 * in a `finally` and on SIGINT or SIGTERM. When deleting it fails, a probe_cleanup failure follows the streaming check: the run
 * exits non-zero and names the token's id (never its secret) and when it stops working on its own.
 */
async function streamingCheck(address: string, publicUrl: string, hooks: RemoteTestHooks): Promise<ProofCheck[]> {
	const minted = createToken(`remote-test-${randomBytes(3).toString("hex")}`, [PROBE_SCOPE], undefined, PROBE_TTL_MS);
	let forgetFailed: string | undefined;
	const forget = () => {
		try {
			deleteToken(minted.record.id);
		} catch (err) {
			forgetFailed = err instanceof Error ? err.message : String(err);
		}
	};
	// Ctrl-C or a stop while the probe waits: the token goes first, then the process.
	const onSignal = (signal: NodeJS.Signals) => {
		forget();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	let streaming: ProofCheck;
	try {
		hooks.afterMint?.();
		streaming = await probe(address, publicUrl, minted.token);
	} catch (err) {
		streaming = { name: "streaming", status: "fail", detail: `the streaming probe didn't run: ${err instanceof Error ? err.message : String(err)}`, next: `Run ${COMMAND_NAME} remote test again.` };
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		forget();
	}
	if (forgetFailed === undefined) return [streaming];
	return [
		streaming,
		{
			name: "probe_cleanup",
			status: "fail",
			detail: `the probe's token ${minted.record.id} couldn't be deleted (${forgetFailed}); it stops working on its own at ${minted.record.expiresAt}`,
			next: `Revoke it now: ${COMMAND_NAME} token revoke ${minted.record.id}`,
		},
	];
}

/**
 * What an assistant needs from the authorization server's metadata, beyond its issuer: where to send the person to sign in
 * (authorization_endpoint) and where to trade the code for a token (token_endpoint), and, when the server offers dynamic client
 * registration (registration_endpoint), where to register. Each must be an https URL on the connector's own origin.
 */
export function authMetadataProblems(body: Record<string, unknown>, publicUrl: string): string[] {
	const origin = new URL(publicUrl).origin;
	const problems: string[] = [];
	const missing = ["authorization_endpoint", "token_endpoint"].filter((field) => typeof body[field] !== "string" || !body[field]);
	if (missing.length) problems.push(`names no ${missing.join(" or ")}`);
	for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
		const value = body[field];
		if (value === undefined || missing.includes(field)) continue;
		if (!URL.canParse(String(value)) || new URL(String(value)).origin !== origin) problems.push(`gives ${field} ${String(value)}, not a URL on ${origin}`);
	}
	return problems;
}

/**
 * Every check, in order. DNS and TLS come first because nothing after them can run without an address that answers; the rest
 * all run so one report names every problem. `streaming: false` leaves out the probe (and its token).
 */
export async function publicChecks(publicUrl: string, options: { streaming?: boolean; hooks?: RemoteTestHooks } = {}): Promise<ProofCheck[]> {
	const hooks = options.hooks ?? preloadedHooks();
	const reachable = (address: string) => !privateAddress(address) || hooks.reachable?.(address) === true;
	const url = new URL(publicUrl);
	const host = url.hostname;
	const checks: ProofCheck[] = [];
	let address: string;
	if (isIP(host)) {
		address = host;
		checks.push({ name: "dns", status: reachable(host) ? "ok" : "fail", detail: `${host} is an address`, ...(reachable(host) ? {} : { next: "Use a public name for the connector (remote setup)." }) });
	} else {
		let addresses: string[];
		try {
			addresses = await dohAddresses(host);
		} catch (err) {
			// A resolver that answered the lookup with a failure (SERVFAIL, REFUSED) is a fault with the name; one this computer
			// can't reach, or that answers an HTTP error (busy, rate limited), says nothing about the connector, so setup doesn't
			// fail on it.
			if (err instanceof DohAnswerError) checks.push({ name: "dns", status: "fail", detail: err.message, next: `Public DNS can't resolve ${host}. Check its DNS records and DNSSEC with your DNS provider.` });
			else checks.push({ name: "dns", status: "fail", pending: true, detail: `couldn't ask public DNS about ${host}: ${err instanceof Error ? err.message : String(err)}`, next: "Check this computer's internet connection, then run remote test again." });
			return checks;
		}
		const open = addresses.filter(reachable);
		if (!open.length) {
			const tailnetOnly = addresses.length > 0 && addresses.every(inTailnetRange);
			checks.push({
				name: "dns",
				status: "fail",
				...(addresses.length ? {} : { pending: true }),
				detail: addresses.length ? `${host} resolves only to ${addresses.join(", ")}, ${tailnetOnly ? "a tailnet address" : "not a public address"}` : `public DNS has no address for ${host} yet`,
				next: tailnetOnly
					? `Funnel isn't publishing this name. Run ${COMMAND_NAME} remote fix.`
					: addresses.length
						? "Point the name at a public address."
						: "A new name takes a few minutes to appear in public DNS. Wait, then run remote test again.",
			});
			return checks;
		}
		address = open[0];
		checks.push({ name: "dns", status: "ok", detail: `${host} resolves publicly to ${open.join(", ")}` });
	}
	const tls = await tlsCheck(url, address);
	checks.push(tls);
	if (tls.status !== "ok") return checks;

	const metadataUrl = `${publicUrl}${METADATA_PATH}`;
	try {
		const answer = await publicRequest(new URL(METADATA_PATH, publicUrl), address, { method: "GET" });
		const body = parse(answer.body);
		const servers = Array.isArray(body?.authorization_servers) ? body.authorization_servers : [];
		if (answer.status === 421) checks.push({ name: "resource_metadata", status: "fail", detail: `${metadataUrl} answered 421: serve doesn't know this name`, next: `serve was started for another address. Run ${COMMAND_NAME} remote fix.` });
		else if (answer.status !== 200 || !body) checks.push({ name: "resource_metadata", status: "fail", detail: `${metadataUrl} answered ${answer.status}${body ? "" : ", not JSON"}`, next: `The public address reaches something other than this connector. Run ${COMMAND_NAME} remote fix.` });
		else if (body.resource !== `${publicUrl}/mcp` || !servers.includes(publicUrl))
			checks.push({ name: "resource_metadata", status: "fail", detail: `${metadataUrl} names ${String(body.resource)} (authorization server ${servers.map(String).join(", ") || "none"}), not ${publicUrl}/mcp`, next: `Another serve answers this name. Run ${COMMAND_NAME} remote fix.` });
		else checks.push({ name: "resource_metadata", status: "ok", detail: `${metadataUrl} names ${publicUrl}/mcp` });
	} catch (err) {
		checks.push({ name: "resource_metadata", status: "fail", detail: `${metadataUrl} didn't answer: ${err instanceof Error ? err.message : String(err)}`, next: `Run ${COMMAND_NAME} remote fix.` });
	}

	const asUrl = `${publicUrl}/.well-known/oauth-authorization-server`;
	try {
		const answer = await publicRequest(new URL("/.well-known/oauth-authorization-server", publicUrl), address, { method: "GET" });
		const body = parse(answer.body);
		const wrong = body ? authMetadataProblems(body, publicUrl) : [];
		if (answer.status === 200 && body?.issuer === publicUrl && !wrong.length) checks.push({ name: "auth_metadata", status: "ok", detail: `${asUrl} names issuer ${publicUrl} and its sign-in endpoints` });
		else if (answer.status === 200 && body?.issuer === publicUrl) checks.push({ name: "auth_metadata", status: "fail", detail: `${asUrl} ${wrong.join("; ")}`, next: `Assistants can't sign in without these. Run ${COMMAND_NAME} remote fix.` });
		else checks.push({ name: "auth_metadata", status: "fail", detail: `${asUrl} answered ${answer.status}${body ? ` with issuer ${String(body.issuer)}` : ""}, expected issuer ${publicUrl}`, next: `Run ${COMMAND_NAME} remote fix.` });
	} catch (err) {
		checks.push({ name: "auth_metadata", status: "fail", detail: `${asUrl} didn't answer: ${err instanceof Error ? err.message : String(err)}`, next: `Run ${COMMAND_NAME} remote fix.` });
	}

	try {
		const answer = await publicRequest(new URL("/mcp", publicUrl), address, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: initialize });
		const challenge = header(answer, "www-authenticate");
		if (answer.status === 401 && challenge.includes(`resource_metadata="${metadataUrl}"`)) checks.push({ name: "auth_challenge", status: "ok", detail: "POST /mcp without a token answers 401 and points to the metadata" });
		else
			checks.push({
				name: "auth_challenge",
				status: "fail",
				detail: `POST /mcp without a token answered ${answer.status}${challenge ? ` with WWW-Authenticate: ${challenge}` : " with no WWW-Authenticate"}`,
				next: answer.status === 401 ? `serve isn't using OAuth for ${publicUrl}. Run ${COMMAND_NAME} remote fix.` : `Assistants need a 401 with resource_metadata to start signing in. Run ${COMMAND_NAME} remote fix.`,
			});
	} catch (err) {
		checks.push({ name: "auth_challenge", status: "fail", detail: `POST /mcp didn't answer: ${err instanceof Error ? err.message : String(err)}`, next: `Run ${COMMAND_NAME} remote fix.` });
	}

	// The probe only means something once the name reaches this connector.
	if (options.streaming !== false && checks.some((c) => c.name === "resource_metadata" && c.status === "ok")) {
		try {
			checks.push(...(await streamingCheck(address, publicUrl, hooks)));
		} catch (err) {
			// The token couldn't be made, so there is nothing to clean up.
			checks.push({ name: "streaming", status: "fail", detail: `the streaming probe didn't run: ${err instanceof Error ? err.message : String(err)}`, next: `Run ${COMMAND_NAME} remote test again.` });
		}
	}
	return checks;
}

/**
 * A failure that isn't what a new name looks like: a refused certificate, plain HTTP, a 421 or another connector's metadata.
 * Undefined when every failure is pending (no public address yet, or nothing answers yet) or nothing failed.
 */
export const realFault = (checks: ProofCheck[]) => checks.find((c) => c.status === "fail" && !c.pending);

/** The connector answers from outside: public DNS, a valid certificate and this connector's metadata. Past that, a failure is a real fault. */
export const answersFromOutside = (checks: ProofCheck[]) => ["dns", "tls", "resource_metadata"].every((name) => checks.some((c) => c.name === name && c.status === "ok"));
