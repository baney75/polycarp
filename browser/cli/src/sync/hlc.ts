// Hybrid logical clock (Kulkarni et al.). Time is always passed in as integer milliseconds: this module never reads a
// clock. A stamp is the clock reading plus the device that made it, and stamps are totally ordered by wall, then count,
// then device id (UTF-16 code unit order; device ids are ASCII, see op.ts), so two devices never tie.

/** Ops more than this far ahead of the local wall clock are held, not applied, until the clock catches up. */
export const MAX_AHEAD_MS = 5 * 60 * 1000;

export interface Hlc {
	/** Milliseconds since the Unix epoch, an integer. */
	wall: number;
	/** Logical counter within one wall value, an integer >= 0. */
	count: number;
}

export interface Stamp extends Hlc {
	device: string;
}

export const ZERO_HLC: Hlc = Object.freeze({ wall: 0, count: 0 });

function checkWall(wallMs: number): void {
	if (!Number.isSafeInteger(wallMs) || wallMs < 0)
		throw new RangeError(`wall clock must be a non-negative integer: ${wallMs}`);
}

/** Order two clock readings (no device): negative, zero or positive. */
export function compareHlc(a: Hlc, b: Hlc): number {
	if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
	if (a.count !== b.count) return a.count < b.count ? -1 : 1;
	return 0;
}

/** Total order over stamps, the device id breaking ties. */
export function compareStamp(a: Stamp, b: Stamp): number {
	const byClock = compareHlc(a, b);
	if (byClock !== 0) return byClock;
	if (a.device === b.device) return 0;
	return a.device < b.device ? -1 : 1;
}

/** The clock after a local event (an op this device writes). Returns the new reading, which is also the event's time. */
export function hlcSend(local: Hlc, wallMs: number): Hlc {
	checkWall(wallMs);
	if (wallMs > local.wall) return { wall: wallMs, count: 0 };
	return { wall: local.wall, count: local.count + 1 };
}

/** Alias of hlcSend for a reading that is not attached to an op. */
export const hlcNow = hlcSend;

/** The clock after receiving a remote reading. Callers must check isTooFarAhead first: a held op does not move the clock. */
export function hlcReceive(local: Hlc, remote: Hlc, wallMs: number): Hlc {
	checkWall(wallMs);
	const wall = Math.max(local.wall, remote.wall, wallMs);
	let count: number;
	if (wall === local.wall && wall === remote.wall) count = Math.max(local.count, remote.count) + 1;
	else if (wall === local.wall) count = local.count + 1;
	else if (wall === remote.wall) count = remote.count + 1;
	else count = 0;
	return { wall, count };
}

/** True when a remote reading is more than MAX_AHEAD_MS ahead of the local wall clock: hold its op. */
export function isTooFarAhead(remote: Hlc, wallMs: number): boolean {
	checkWall(wallMs);
	return remote.wall - wallMs > MAX_AHEAD_MS;
}

export function isHlc(value: unknown): value is Hlc {
	if (value === null || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		Object.keys(v).length === 2 &&
		Number.isSafeInteger(v.wall) &&
		(v.wall as number) >= 0 &&
		Number.isSafeInteger(v.count) &&
		(v.count as number) >= 0
	);
}
