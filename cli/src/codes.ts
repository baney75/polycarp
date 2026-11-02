/**
 * One-time codes: `TK-XXXX-XXXX`, Crockford base32, 40 random bits. A connect code enrolls a
 * device on the hub; an approval code stands in for the passcode on the consent page. Both live
 * ten minutes, work once, and are stored only as SHA-256 of the normalized code.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CODE_TTL_MS = 10 * 60_000;

/** Too many codes are already waiting. The only mint failure an answer should call a limit (429). */
export class CodeLimitError extends Error {}

/** How long a request handler waits for a lock file; the event loop is blocked meanwhile. A longer wait answers 503. */
export const REQUEST_LOCK_MS = 200;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHAPE = /^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** A new code from 40 random bits. */
export function newCode(): string {
	const bytes = randomBytes(5);
	let bits = 0n;
	for (const b of bytes) bits = (bits << 8n) | BigInt(b);
	let chars = "";
	for (let i = 7; i >= 0; i--) chars += ALPHABET[Number((bits >> BigInt(i * 5)) & 31n)];
	return `TK-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** What a person typed, as the canonical code (case, spaces and Crockford look-alikes folded), or undefined when it isn't code-shaped. */
export function normalizeCode(input: string): string | undefined {
	if (input.length > 40) return undefined;
	const folded = input.trim().toUpperCase().replace(/\s+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
	const bare = folded.startsWith("TK") ? folded.slice(2).replace(/^-/, "") : undefined;
	if (bare === undefined) return undefined;
	const chars = bare.replace(/-/g, "");
	const code = chars.length === 8 ? `TK-${chars.slice(0, 4)}-${chars.slice(4)}` : "";
	return SHAPE.test(code) ? code : undefined;
}

export function hashCode(code: string): string {
	return createHash("sha256").update(code).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a: string, b: string): boolean {
	const x = Buffer.from(a, "hex");
	const y = Buffer.from(b, "hex");
	return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** A stored code record: hash and expiry (ms since the epoch). */
export interface CodeRecord {
	sha256: string;
	expiresAt: number;
	createdAt: number;
}

/** The records still alive at `time`. */
export const liveCodes = <T extends CodeRecord>(records: T[], time: number): T[] => records.filter((r) => r.expiresAt > time);

/** Index of the live record matching a typed code, or -1. Walks every record so timing doesn't say which matched. */
export function findCode<T extends CodeRecord>(records: T[], typed: string, time: number): number {
	const code = normalizeCode(typed);
	if (!code) return -1;
	const digest = hashCode(code);
	let found = -1;
	records.forEach((r, i) => {
		if (r.expiresAt > time && sameHash(r.sha256, digest)) found = i;
	});
	return found;
}
