// The op envelope: one edit to one category, written by one device. Ops are the unit that is logged, relayed, acked
// and (from PR 5) signed and sealed.
//
// Trust seam: `author` and `sig` are carried but NOT verified here. This engine trusts the author field as given. PR 5
// adds Ed25519 signatures over canonicalOpBytes(op) and checks them against the signed roster before an op reaches
// receiveOps; until then nothing here may be fed ops from an untrusted source. The narrow-only rule in registry.ts holds
// regardless, because it judges what an op does, not who claims to have sent it, except that an author claiming to be
// the local device is a local op (only the signature check can tell a forgery of that).

import { canonicalize, isCanonicalJson, type Json } from "./canonical.ts";
import { type Hlc, isHlc, type Stamp } from "./hlc.ts";

/** Envelope version. An op with another value is malformed to this engine. */
export const OP_VERSION = 1;

export interface SyncOp {
	v: 1;
	/** Category name from the registry, for example "dictionary". */
	category: string;
	/** Category schema version the writer used. */
	schema: number;
	/** Device id of the writer (dv-<12 hex> in practice). Not verified in this PR; see the note above. */
	author: string;
	/** Per-author sequence number, 1 for a device's first op, then contiguous. */
	seq: number;
	/** Hybrid logical clock reading when the op was written. */
	at: Hlc;
	/** What the op does; valid kinds depend on the category's merge type. */
	kind: string;
	/** Register key, set element key or log stream id. */
	key: string;
	/** Payload, absent for kinds that carry none. */
	value?: Json;
	/** Op ids this op observed (add-wins set: tags it supersedes or removes; log: entries it deletes). Sorted, unique. */
	obs?: string[];
	/** Signature over canonicalOpBytes(op), base64url. Carried and relayed; not checked until PR 5. */
	sig?: string;
}

const DEVICE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CATEGORY = /^[a-z][a-z0-9-]{0,63}$/;
const OP_ID = /^[A-Za-z0-9._-]{1,64}:[1-9][0-9]{0,15}$/;
const FIELDS = new Set(["v", "category", "schema", "author", "seq", "at", "kind", "key", "value", "obs", "sig"]);
const MAX_KEY = 1024;

export function isDeviceId(value: unknown): value is string {
	return typeof value === "string" && DEVICE_ID.test(value);
}

export function isCategoryName(value: unknown): value is string {
	return typeof value === "string" && CATEGORY.test(value);
}

/** An op's id: author and sequence. Ids are unique per author because sequences only grow. */
export function opId(op: Pick<SyncOp, "author" | "seq">): string {
	return `${op.author}:${op.seq}`;
}

export function stampOf(op: Pick<SyncOp, "author" | "at">): Stamp {
	return { wall: op.at.wall, count: op.at.count, device: op.author };
}

/** Bytes a signature covers (PR 5): the canonical op without its sig field. */
export function canonicalOpBytes(op: SyncOp): string {
	const { sig: _sig, ...rest } = op;
	return canonicalize(rest);
}

/** The canonical encoding of the whole op, signature included. */
export function encodeOp(op: SyncOp): string {
	return canonicalize(op);
}

/** Check that an unknown value is a well-formed op; returns the reason it is not, or null. */
export function opProblem(value: unknown): string | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return "op is not an object";
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!FIELDS.has(key)) return `unknown field ${key}`;
	if (v.v !== OP_VERSION) return "unsupported envelope version";
	if (!isCategoryName(v.category)) return "bad category";
	if (!Number.isSafeInteger(v.schema) || (v.schema as number) < 1) return "bad schema";
	if (!isDeviceId(v.author)) return "bad author";
	if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1) return "bad seq";
	if (!isHlc(v.at)) return "bad clock";
	if (typeof v.kind !== "string" || !/^[a-z]{1,16}$/.test(v.kind)) return "bad kind";
	if (typeof v.key !== "string" || v.key.length === 0 || v.key.length > MAX_KEY) return "bad key";
	if ("value" in v && !isCanonicalJson(v.value)) return "value is not canonical JSON";
	if ("obs" in v) {
		if (!Array.isArray(v.obs)) return "obs is not a list";
		for (let i = 0; i < v.obs.length; i++) {
			const id = v.obs[i];
			if (typeof id !== "string" || !OP_ID.test(id)) return "bad obs id";
			if (i > 0 && !((v.obs[i - 1] as string) < id)) return "obs not sorted and unique";
		}
	}
	if ("sig" in v && (typeof v.sig !== "string" || !/^[A-Za-z0-9_-]{0,256}$/.test(v.sig))) return "bad sig";
	return null;
}

export function isOp(value: unknown): value is SyncOp {
	return opProblem(value) === null;
}

/** Parse an op from canonical-or-not JSON text; throws with the reason on a malformed op. */
export function decodeOp(text: string): SyncOp {
	const value: unknown = JSON.parse(text);
	const problem = opProblem(value);
	if (problem) throw new Error(`malformed op: ${problem}`);
	return value as SyncOp;
}

/** Sort and dedupe an obs list. */
export function normalizeObs(ids: Iterable<string>): string[] {
	return [...new Set(ids)].sort();
}

/** Order ops by author then seq, the order deltas and logs use. */
export function compareOpOrder(a: SyncOp, b: SyncOp): number {
	if (a.author !== b.author) return a.author < b.author ? -1 : 1;
	return a.seq - b.seq;
}
