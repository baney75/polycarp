// Version vectors: for each author, the highest sequence number up to which a replica holds every op (contiguous).
// A replica can hold ops past a gap; they count once the gap fills.

import { copyRec, get, type Rec, rec } from "./records.ts";

export type VersionVector = Rec<number>;

export function vvGet(vv: VersionVector, author: string): number {
	return get(vv, author) ?? 0;
}

/** Whether the vector already covers an author's op. */
export function vvCovers(vv: VersionVector, author: string, seq: number): boolean {
	return seq <= vvGet(vv, author);
}

/** Pointwise maximum. */
export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
	const out = copyRec(a);
	for (const author of Object.keys(b)) if (b[author] > vvGet(out, author)) out[author] = b[author];
	return out;
}

/** Whether a covers everything b covers. */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
	for (const author of Object.keys(b)) if (vvGet(a, author) < b[author]) return false;
	return true;
}

/** Pointwise minimum over the authors of `base`, against each vector in `others`. */
export function vvMin(base: VersionVector, others: readonly VersionVector[]): VersionVector {
	const out = rec<number>();
	for (const author of Object.keys(base)) {
		let low = base[author];
		for (const other of others) low = Math.min(low, vvGet(other, author));
		if (low > 0) out[author] = low;
	}
	return out;
}

/** Validate an untrusted vector: device-id-like keys and positive safe integers. Returns a clean copy or null. */
export function parseVv(value: unknown): VersionVector | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const out = rec<number>();
	for (const key of Object.keys(value)) {
		const n = (value as Rec<unknown>)[key];
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || !Number.isSafeInteger(n) || (n as number) < 0) return null;
		if ((n as number) > 0) out[key] = n as number;
	}
	return out;
}
