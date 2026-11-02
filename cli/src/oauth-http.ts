/**
 * The HTTP side of the OAuth endpoints (oauth.ts holds the logic): registration, the consent page,
 * token exchange and revocation, plus the metadata documents. `tabkyra serve --public-url` and
 * `tabkyra hub serve` both answer them through handleOAuth, so there is one copy.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	approveAuthorize,
	authorizationServerMetadata,
	consentPage,
	describeSigned,
	exchangeToken,
	type OAuthConfig,
	OAuthError,
	protectedResourceMetadata,
	registerClient,
	revokeGrant,
	validateAuthorize,
} from "./oauth.ts";

export async function readBody(req: IncomingMessage, limit = 4_000_000): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new Error("Request body too large.");
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(body));
}

/** For rate limits only (oauth.ts): a forged header can spread a flood out, not get past a secret. */
export function requestSource(req: IncomingMessage): string {
	const forwarded = String(req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]).trim();
	return forwarded || req.socket.remoteAddress || "unknown";
}

/** The OAuth endpoints, shared by `serve --public-url` and the hub. Returns false when the path isn't one of them. */
export async function handleOAuth(config: OAuthConfig, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
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
	const source = requestSource(req);
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

