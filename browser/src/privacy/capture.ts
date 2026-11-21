import type { TabkyraAppStorage } from "../storage/app-storage.js";
import { addEntry, BUG_LOG_KEY, BUG_REPORTS_KEY, type BugEntry } from "./bug-reports.js";

/**
 * Every change to the bug-report setting and log goes through one queue, so a capture that
 * started before the user turned reports off can't write its entry after the log was cleared.
 */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
	const next = queue.then(task, task);
	queue = next.catch(() => undefined);
	return next;
}

/** Record one error, if reports are on at the moment it is written. */
export function recordError(storage: TabkyraAppStorage, error: unknown): Promise<void> {
	return serial(async () => {
		if ((await storage.settings.get<boolean>(BUG_REPORTS_KEY)) !== true) return;
		const log = (await storage.settings.get<BugEntry[]>(BUG_LOG_KEY)) ?? [];
		// Another side panel (another window) may have turned reports off meanwhile.
		if ((await storage.settings.get<boolean>(BUG_REPORTS_KEY)) !== true) return;
		await storage.settings.set(BUG_LOG_KEY, addEntry(log, error));
	}).catch(() => undefined);
}

/** Turn reports on or off; off also clears the log, after any capture already queued. */
export function setBugReports(storage: TabkyraAppStorage, on: boolean): Promise<void> {
	return serial(async () => {
		await storage.settings.set(BUG_REPORTS_KEY, on);
		if (!on) await storage.settings.set(BUG_LOG_KEY, []);
	});
}

/**
 * Keep redacted errors from the side panel while the user has bug reports on. Off by
 * default; when off, nothing is recorded. Nothing is sent from here.
 */
export function installBugCapture(storage: TabkyraAppStorage): void {
	window.addEventListener("error", (e) => void recordError(storage, e.error ?? e.message));
	window.addEventListener("unhandledrejection", (e) => void recordError(storage, e.reason));
}
