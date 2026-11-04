// Test-only minisign signer: a throwaway Ed25519 key and prehashed ("ED") signatures in
// minisign's file format. Releases are signed by the real minisign in CI; this lets the
// tests make releases the CLI must accept or refuse without that binary.
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export function throwawayKey() {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyId = randomBytes(8);
	const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
	const pub = Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64");
	const keyIdHex = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
	return { privateKey, keyId, publicText: `untrusted comment: minisign public key ${keyIdHex}\n${pub}\n` };
}

export function signMinisign(data, key, trustedComment, { legacy = false } = {}) {
	const message = legacy ? data : createHash("blake2b512").update(data).digest();
	const signature = sign(null, message, key.privateKey);
	const line = Buffer.concat([Buffer.from(legacy ? "Ed" : "ED"), key.keyId, signature]).toString("base64");
	const global = sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), key.privateKey).toString("base64");
	return `untrusted comment: signature from minisign secret key\n${line}\ntrusted comment: ${trustedComment}\n${global}\n`;
}
