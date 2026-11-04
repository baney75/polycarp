/**
 * Minisign signature verification (https://jedisct1.github.io/minisign/), no dependencies.
 * Releases are signed in CI with `minisign -S` (prehashed Ed25519 over BLAKE2b-512).
 * Legacy non-prehashed signatures are refused: CI never makes them.
 */

import { createHash, createPublicKey, verify } from "node:crypto";

export interface MinisignPublicKey {
	keyId: Buffer;
	key: Buffer;
}

export class SignatureError extends Error {}

function lastBase64Line(text: string, what: string): Buffer {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("untrusted comment:"));
	if (lines.length === 0) throw new SignatureError(`${what}: no key data`);
	const raw = Buffer.from(lines[0], "base64");
	if (raw.toString("base64") !== lines[0]) throw new SignatureError(`${what}: not valid base64`);
	return raw;
}

/** Parse a minisign public key (the .pub file, or just its base64 line). */
export function parsePublicKey(text: string): MinisignPublicKey {
	const raw = lastBase64Line(text, "Public key");
	if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
		throw new SignatureError("Public key: not a minisign Ed25519 key");
	}
	return { keyId: raw.subarray(2, 10), key: raw.subarray(10, 42) };
}

/** Key id as minisign prints it (hex, most significant byte first). */
export function keyIdHex(keyId: Buffer): string {
	return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

function ed25519(key: Buffer) {
	return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" });
}

/**
 * Verify `data` against a .minisig file. Returns the trusted comment, which is signed too;
 * callers check it names the release they asked for. Throws SignatureError on any mismatch.
 */
export function verifyMinisign(data: Buffer, signatureText: string, publicKey: MinisignPublicKey): string {
	const lines = signatureText.split(/\r?\n/);
	if (lines.length < 4 || !lines[0].startsWith("untrusted comment:")) throw new SignatureError("Signature: malformed file");
	const sigLine = lines[1].trim();
	const trustedLine = lines[2];
	const globalLine = lines[3].trim();
	if (!trustedLine.startsWith("trusted comment: ")) throw new SignatureError("Signature: no trusted comment");
	const trusted = trustedLine.slice("trusted comment: ".length);

	const sig = Buffer.from(sigLine, "base64");
	if (sig.length !== 74) throw new SignatureError("Signature: wrong length");
	const algorithm = sig.subarray(0, 2).toString("latin1");
	if (algorithm === "Ed") throw new SignatureError("Signature: legacy (non-prehashed) signatures are not accepted");
	if (algorithm !== "ED") throw new SignatureError(`Signature: unknown algorithm ${JSON.stringify(algorithm)}`);
	const keyId = sig.subarray(2, 10);
	if (!keyId.equals(publicKey.keyId)) {
		throw new SignatureError(`Signature: made with key ${keyIdHex(keyId)}, expected ${keyIdHex(publicKey.keyId)}`);
	}
	const signature = sig.subarray(10, 74);
	const pk = ed25519(publicKey.key);
	const digest = createHash("blake2b512").update(data).digest();
	if (!verify(null, digest, pk, signature)) throw new SignatureError("Signature: does not match the file");

	const global = Buffer.from(globalLine, "base64");
	if (global.length !== 64) throw new SignatureError("Signature: trusted comment signature has the wrong length");
	if (!verify(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), pk, global)) {
		throw new SignatureError("Signature: the trusted comment was altered");
	}
	return trusted;
}
