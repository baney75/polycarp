import { b64urlDecode, json, sha256Hex } from "./util.ts";

export const SIGN_PREFIX = "polycarp-connect/v1";
const SKEW_SECONDS = 300;

export interface Signed {
	/** SHA-256 of the raw 32-byte Ed25519 public key, hex. The only identity the service stores. */
	deviceHash: string;
	nonceKey: string;
	body: string;
}

/**
 * Requests from the app or helper are signed with the device's Ed25519 key:
 *   X-Polycarp-Key   base64url public key (32 bytes)
 *   X-Polycarp-Time  unix seconds
 *   X-Polycarp-Nonce 16 to 64 of A-Z a-z 0-9 _ -
 *   X-Polycarp-Sig   base64url signature over the text from signingText()
 * The nonce is remembered, so a captured request can't be replayed.
 */
export const signingText = (method: string, path: string, time: string, nonce: string, bodyHash: string): string => [SIGN_PREFIX, method, path, time, nonce, bodyHash].join("\n");

export async function verifySigned(request: Request, nowSeconds: number): Promise<Signed | Response> {
	const bad = (reason: string) => json({ status: "unauthorized", message: reason }, 401);
	const key = request.headers.get("x-polycarp-key") ?? "";
	const time = request.headers.get("x-polycarp-time") ?? "";
	const nonce = request.headers.get("x-polycarp-nonce") ?? "";
	const sig = request.headers.get("x-polycarp-sig") ?? "";
	const pub = b64urlDecode(key);
	const signature = b64urlDecode(sig);
	if (!pub || pub.length !== 32) return bad("The device key must be a 32-byte Ed25519 public key.");
	if (!signature || signature.length !== 64) return bad("The signature is missing or the wrong size.");
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return bad("The nonce must be 16 to 64 letters, digits, - or _.");
	if (!/^\d{1,12}$/.test(time) || Math.abs(nowSeconds - Number(time)) > SKEW_SECONDS) return bad("The request time is off by more than five minutes. Check this computer's clock.");
	const body = await request.text();
	if (body.length > 4096) return json({ status: "error", message: "Request too large." }, 413);
	const message = signingText(request.method, new URL(request.url).pathname, time, nonce, await sha256Hex(body));
	let ok = false;
	try {
		const cryptoKey = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
		ok = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signature, new TextEncoder().encode(message));
	} catch {
		ok = false;
	}
	if (!ok) return bad("The signature doesn't match.");
	const deviceHash = await sha256Hex(pub);
	return { deviceHash, nonceKey: `${deviceHash}:${nonce}`, body };
}

/** Remember a nonce. False when it was already used. */
export async function useNonce(db: D1Database, nonceKey: string, nowSeconds: number): Promise<boolean> {
	const r = await db.prepare("INSERT OR IGNORE INTO nonces (nonce, seen_at) VALUES (?, ?)").bind(nonceKey, nowSeconds).run();
	return (r.meta.changes ?? 0) === 1;
}
