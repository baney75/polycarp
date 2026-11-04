/**
 * One tab's console capture buffer. Turning Runtime back on after a gap makes the browser replay
 * the page's whole console history, so the buffer has to tell a replayed entry from a live one and
 * from one it already holds, using what the browser stamps on each message: its time and the
 * execution context (the page document) it came from. Text alone cannot: pages repeat "ready".
 */

export const MAX_ENTRIES = 300;

export interface ConsoleEntry {
	level: string;
	text: string;
	/** When the page logged it (the browser's timestamp, ms), also for a replayed entry. */
	timestamp: number;
	/** The execution context (document) that logged it. */
	contextId?: number;
	/** The browser replayed it from the page's console history after capture had stopped. */
	replayed?: boolean;
}

export class ConsoleBuffer {
	private items: ConsoleEntry[] = [];
	/**
	 * Entries logged at or before this time were already read and cleared, or trimmed to stay
	 * under the cap: a replay must not bring them back.
	 */
	private cutoff = 0;
	/** Entries stamped at or before this time arrive as a replay of history (-1: none). */
	private replayUntil = -1;
	private markReplayed = false;

	/**
	 * Capture is about to be turned on. Whatever the browser sends stamped before `now` is history.
	 * `afterGap`: the buffer missed time (a detach, a restart), so history it adds is marked replayed.
	 */
	startReplay(now: number, afterGap: boolean): void {
		this.replayUntil = now;
		this.markReplayed = afterGap;
	}

	add(entry: ConsoleEntry): void {
		if (entry.timestamp <= this.replayUntil) {
			if (entry.timestamp <= this.cutoff) return;
			// Already held: the same message of the same document at the same instant.
			const held = this.items.some(
				(e) =>
					e.timestamp === entry.timestamp &&
					e.contextId === entry.contextId &&
					e.level === entry.level &&
					e.text === entry.text,
			);
			if (held) return;
			this.items.push(this.markReplayed ? { ...entry, replayed: true } : entry);
		} else {
			this.items.push(entry);
		}
		this.trim();
	}

	private trim(): void {
		if (this.items.length <= MAX_ENTRIES) return;
		const dropped = this.items.splice(0, this.items.length - MAX_ENTRIES);
		for (const e of dropped) this.cutoff = Math.max(this.cutoff, e.timestamp);
	}

	/** The entries, oldest first. With `clear`, they are forgotten, and a replay will not bring them back. */
	read(clear: boolean, now: number): ConsoleEntry[] {
		const out = this.items.map(({ contextId: _context, ...visible }) => visible);
		if (clear) {
			this.items = [];
			this.cutoff = Math.max(this.cutoff, now);
		}
		return out;
	}
}
