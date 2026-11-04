/**
 * The install gate: while the service worker swaps an update in and reloads Tabkyra, no new agent
 * run may start, so nothing runs on a mix of old and new files and no run is cut off by the
 * reload. Two parts:
 *
 * - a Web Lock, shared by the worker and every side panel (same origin). The worker holds it
 *   exclusively from its idle check through the install and the reload; a side panel starting
 *   a run takes it in shared mode, only if it is free, and marks itself busy while it holds it
 *   (reserveRun). So either the worker's idle check sees the run or the panel sees the install,
 *   and two panels never refuse each other.
 * - a fence in chrome.storage.session, written before the install or rollback is sent and kept
 *   until the reload (which clears session storage). A worker that dies mid-install lets go of
 *   the lock with its context; the fence still holds panels off, and the next worker takes the
 *   lock back from it before it lets bridge requests in (src/update/worker.ts).
 */

export const INSTALL_GATE_LOCK = "tabkyra-update-install";
/** chrome.storage.session: { at, action } while an install or rollback may be changing files. */
export const INSTALL_FENCE_KEY = "tabkyra.installFence";
/**
 * A gate or fence older than this is let go (a stuck install must not block runs forever). Longer
 * than the worker's give-up limit for an install or rollback (10 min) plus its reload retries.
 */
export const INSTALL_GATE_MAX_MS = 15 * 60 * 1000;
/** chrome.storage.session: the side panel's heartbeat while a run goes, per window. */
export const BUSY_BEAT_PREFIX = "sidepanel_busy_beat_";
/**
 * A busy flag counts only with a heartbeat this fresh. The panel beats every 15 s and on agent
 * events; a hidden panel's timers may be throttled to once a minute.
 */
export const BUSY_BEAT_MAX_MS = 3 * 60 * 1000;

export interface InstallFence {
	at: number;
	action: string;
}

export function fenceHeld(fence: unknown, now = Date.now()): boolean {
	const at = (fence as InstallFence | undefined)?.at;
	return typeof at === "number" && now - at < INSTALL_GATE_MAX_MS;
}

/**
 * For the side panel, before it starts a run: false when an update is being installed.
 * `markBusy` runs while the panel holds the lock (shared), so the worker's idle check after it
 * takes the lock sees the run.
 */
export async function reserveRun(markBusy: () => Promise<void>): Promise<boolean> {
	const fenced = async () => fenceHeld((await chrome.storage.session.get(INSTALL_FENCE_KEY))[INSTALL_FENCE_KEY]);
	if (!globalThis.navigator?.locks) {
		if (await fenced()) return false;
		await markBusy();
		return true;
	}
	const take = (lock: Lock | null) => async () => {
		if (!lock || (await fenced())) return false;
		await markBusy();
		return true;
	};
	const now = await navigator.locks.request(INSTALL_GATE_LOCK, { mode: "shared", ifAvailable: true }, (lock) =>
		take(lock)(),
	);
	if (now) return true;
	// Not free right now: refuse only if the worker holds it or a fence stands. Otherwise the
	// worker's request is merely queued behind another panel; wait our turn.
	const state = await navigator.locks.query();
	if (state.held?.some((l) => l.name === INSTALL_GATE_LOCK && l.mode === "exclusive") || (await fenced()))
		return false;
	// Wait a few seconds at most: if the worker gets the lock first, the text goes back to the editor.
	try {
		return await navigator.locks.request(
			INSTALL_GATE_LOCK,
			{ mode: "shared", signal: AbortSignal.timeout(3000) },
			(lock) => take(lock)(),
		);
	} catch {
		return false;
	}
}
