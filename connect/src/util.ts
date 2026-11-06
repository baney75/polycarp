const enc = new TextEncoder();

export const b64urlEncode = (bytes: Uint8Array): string => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const b64urlDecode = (text: string): Uint8Array | undefined => {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
	try {
		const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
		return Uint8Array.from(s, (c) => c.charCodeAt(0));
	} catch {
		return undefined;
	}
};

export const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (data: string | Uint8Array): Promise<string> => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));

export async function hmacHex(key: string, data: string): Promise<string> {
	const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

/** Constant-time comparison of two strings of any length. */
export function safeEqual(a: string, b: string): boolean {
	const x = enc.encode(a);
	const y = enc.encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Random lowercase base32 text of `length` characters. 32 symbols and a 5-bit mask: no modulo bias. */
export function randomBase32(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = "";
	for (const b of bytes) out += BASE32[b & 31];
	return out;
}

const SECURITY = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
export const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type" };

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...SECURITY, ...extra } });
}

export const intVar = (raw: string | undefined, fallback: number): number => {
	const n = Number(raw);
	return raw !== undefined && raw !== "" && Number.isFinite(n) ? Math.trunc(n) : fallback;
};
