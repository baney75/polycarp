/**
 * Evidence captures an agent asks for: its tab's network traffic as a HAR, a recording of the tab,
 * and a flight recorder that always holds the last minute. This is the part that decides who may
 * do what and for how long; the browser work (debugger events, screencast, the encoder) is a
 * `CaptureBackend`, so the rules run and are tested without a browser.
 *
 * Rules:
 * - A capture belongs to the session that started it. Only that session sees it in `status`, stops
 *   it, saves it or cancels it; another session's id is "not found", the same as an id that never existed.
 * - A capture starts only on a tab the session owns, and ends, keeping what it has, the moment
 *   that stops being true (the tab closed, was given away, or the debugger left it). If that happens
 *   while the browser is still starting it, the start finishes by stopping what it started and
 *   reporting the capture as cancelled: nothing runs without an owner.
 * - Nothing runs for long: 10 minutes for network and recordings, 30 for a flight recorder. An ended
 *   capture stays in memory for 30 minutes so its owner can still save it.
 * - Starting never reads the file's content back to the agent: results carry the file itself for
 *   the helper to write (`file`), and the helper tells the agent only the path and size.
 * - A stop that returned its file is not forgotten until the write is known to have worked: the
 *   answer is kept for RETRY_KEEP_MS, so asking again with the same id returns the same file, and the
 *   helper's `cancel` with that id (sent once the file is on disk) frees it.
 */

import { ERR } from "../bridge/protocol.js";

export type CaptureKind = "network" | "record" | "flight";
export type CaptureAction =
	| "network_start"
	| "network_stop"
	| "record_start"
	| "record_stop"
	| "flight_start"
	| "flight_save"
	| "status"
	| "cancel";

export const CAPTURE_ACTIONS: readonly CaptureAction[] = [
	"network_start",
	"network_stop",
	"record_start",
	"record_stop",
	"flight_start",
	"flight_save",
	"status",
	"cancel",
];

/** Network captures and recordings stop by themselves after this long. */
export const MAX_CAPTURE_MS = 10 * 60 * 1000;
/** A flight recorder waits for something to break, so it runs longer. */
export const MAX_FLIGHT_MS = 30 * 60 * 1000;
/** An ended capture keeps its data this long for its owner to save. */
export const KEEP_ENDED_MS = 30 * 60 * 1000;
/** A stopped capture's file stays here this long, in case the helper could not write it. */
export const RETRY_KEEP_MS = 5 * 60 * 1000;
export const MAX_PER_SESSION = 4;
/** Encoding is the costly part: at most this many videos at once in the whole browser. */
export const MAX_VIDEOS = 2;

export class CaptureError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** What the helper writes to disk: the content never goes back to the agent. */
export interface CaptureFile {
	kind: "har" | "webm";
	encoding: "json" | "base64";
	/** The HAR object, or the video as base64. */
	data: unknown;
	bytes: number;
}

export interface CaptureStats {
	/** Bytes held so far. */
	bytes: number;
	/** Network: requests recorded. */
	entries?: number;
	/** Video: how much time is held, in ms. */
	spanMs?: number;
	/** The size cap was reached; nothing more is recorded. */
	full?: boolean;
}

export interface CaptureOutput {
	file: CaptureFile;
	/** Plain facts about what the file leaves out or cuts short. */
	notes: string[];
	durationMs?: number;
	entries?: number;
}

/** One running capture in the browser. */
export interface Run {
	stats(): Promise<CaptureStats>;
	/** Stop collecting and keep what is held. Safe to call twice. */
	halt(): Promise<void>;
	/** Everything held, as a file, with the capture stopped and released. */
	finish(): Promise<CaptureOutput>;
	/** Flight recorder: the buffer as a file; recording goes on. */
	snapshot?(): Promise<CaptureOutput>;
	/** Stop and throw everything away. */
	discard(): Promise<void>;
}

export interface CaptureBackend {
	startNetwork(tabId: number, id: string, onEnd: (why: string) => void): Promise<Run>;
	startVideo(tabId: number, id: string, mode: "record" | "flight", onEnd: (why: string) => void): Promise<Run>;
	/** Whether the session still owns the tab (the session's record, not the caller's say-so). */
	owns(sessionId: string, tabId: number): Promise<boolean>;
}

/** The part of a browser session the rules look at. */
export interface CaptureSession {
	id: string;
	tabIds: readonly number[];
}

export interface CaptureParams {
	action?: string;
	id?: string;
	tabId?: number;
}

interface Capture {
	id: string;
	kind: CaptureKind;
	sessionId: string;
	tabId: number;
	startedAt: number;
	/** When it stops by itself. */
	deadline: number;
	state: "starting" | "running" | "ended";
	endedAt?: number;
	endedBy?: string;
	saves: number;
	run?: Run;
	/** A stop, save or cancel is under way. */
	busy: boolean;
}

/** A stop that returned its file, kept for a retry. */
interface Stopped {
	sessionId: string;
	kind: CaptureKind;
	at: number;
	answer: Record<string, unknown>;
}

export interface CaptureManagerOptions {
	now?: () => number;
	/** Called when the first capture starts and when the last one goes: the owner runs `sweep` on a timer between. */
	onActive?: (active: boolean) => void;
	newId?: () => string;
}

let counter = 0;
const defaultId = (): string =>
	`cap-${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const START: Partial<Record<CaptureAction, CaptureKind>> = {
	network_start: "network",
	record_start: "record",
	flight_start: "flight",
};
const END: Partial<Record<CaptureAction, CaptureKind>> = {
	network_stop: "network",
	record_stop: "record",
	flight_save: "flight",
};

export class CaptureManager {
	private captures = new Map<string, Capture>();
	private stopped = new Map<string, Stopped>();
	private readonly now: () => number;
	private readonly newId: () => string;
	private active = false;

	constructor(
		private readonly backend: CaptureBackend,
		private readonly options: CaptureManagerOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.newId = options.newId ?? defaultId;
	}

	/** Captures in the browser now, whoever owns them (for the debug page; never shown to an agent). */
	get size(): number {
		return this.captures.size;
	}

	async run(session: CaptureSession, params: CaptureParams): Promise<Record<string, unknown>> {
		const action = params.action as CaptureAction | undefined;
		if (!action || !CAPTURE_ACTIONS.includes(action))
			throw new CaptureError(ERR.BAD_PARAMS, `action must be one of ${CAPTURE_ACTIONS.join(", ")}`);
		const starting = START[action];
		if (starting) return this.start(session, starting, params);
		const ending = END[action];
		if (ending) return this.end(session, ending, action === "flight_save", params);
		if (action === "status") return this.status(session);
		return this.cancel(session, params);
	}

	private mine(session: CaptureSession): Capture[] {
		return [...this.captures.values()].filter((c) => c.sessionId === session.id);
	}

	/** The capture an id names, only if it is this session's; the same answer for another's and for none. */
	private owned(session: CaptureSession, id: string): Capture {
		const c = this.captures.get(id);
		if (!c || c.sessionId !== session.id)
			throw new CaptureError(ERR.NOT_FOUND, `No capture ${id} in your session. status lists yours.`);
		return c;
	}

	private async start(
		session: CaptureSession,
		kind: CaptureKind,
		params: CaptureParams,
	): Promise<Record<string, unknown>> {
		const tabId = params.tabId;
		if (tabId === undefined) throw new CaptureError(ERR.NO_TAB, "You have no tab yet: navigate opens one.");
		if (!session.tabIds.includes(tabId))
			throw new CaptureError(ERR.NOT_FOUND, `Tab ${tabId} is not one of your tabs. tabs_context lists them.`);
		const mine = this.mine(session);
		const video = kind !== "network";
		if (mine.some((c) => c.tabId === tabId && (c.kind === "network") === !video && c.state !== "ended"))
			throw new CaptureError(
				ERR.BAD_PARAMS,
				`Tab ${tabId} already has a ${video ? "recording or flight recorder" : "network capture"} running. status lists it.`,
			);
		if (mine.filter((c) => c.state !== "ended").length >= MAX_PER_SESSION)
			throw new CaptureError(
				ERR.BAD_PARAMS,
				`You have ${MAX_PER_SESSION} captures running. Stop or cancel one first.`,
			);
		if (
			video &&
			[...this.captures.values()].filter((c) => c.kind !== "network" && c.state !== "ended").length >= MAX_VIDEOS
		)
			throw new CaptureError(
				ERR.BAD_PARAMS,
				`${MAX_VIDEOS} videos are being recorded in this browser already. Try again when one is stopped.`,
			);
		const now = this.now();
		const capture: Capture = {
			id: this.newId(),
			kind,
			sessionId: session.id,
			tabId,
			startedAt: now,
			deadline: now + (kind === "flight" ? MAX_FLIGHT_MS : MAX_CAPTURE_MS),
			state: "starting",
			saves: 0,
			busy: false,
		};
		this.captures.set(capture.id, capture);
		this.activity();
		let run: Run;
		try {
			const onEnd = (why: string) => this.ended(capture, why);
			run =
				kind === "network"
					? await this.backend.startNetwork(tabId, capture.id, onEnd)
					: await this.backend.startVideo(tabId, capture.id, kind, onEnd);
		} catch (err) {
			if (this.captures.get(capture.id) === capture) {
				this.captures.delete(capture.id);
				this.activity();
			}
			throw err;
		}
		// The owner may have gone while the browser was starting it (the tab was released or closed,
		// the debugger left, or the capture was cancelled). `ended` had no run to halt then, so the run
		// that just came back would collect with nobody to stop it: stop it now and say so.
		if (capture.state !== "starting" || this.captures.get(capture.id) !== capture) {
			const why = capture.endedBy ?? "it was cancelled";
			if (this.captures.get(capture.id) === capture) {
				this.captures.delete(capture.id);
				this.activity();
			}
			await run.discard().catch(() => undefined);
			throw new CaptureError(
				ERR.NOT_FOUND,
				`The capture was cancelled before it started: ${why}. Nothing was recorded.`,
			);
		}
		capture.run = run;
		capture.state = "running";
		return {
			id: capture.id,
			kind,
			tabId,
			startedAt: new Date(now).toISOString(),
			stopsBy: new Date(capture.deadline).toISOString(),
			note:
				kind === "network"
					? "Recording this tab's requests. network_stop writes the HAR and returns its path."
					: kind === "record"
						? "Recording this tab's video, without sound. record_stop writes the file and returns its path."
						: "Keeping the last 60 seconds of this tab's video. flight_save writes them to a file when something breaks.",
		};
	}

	private async end(
		session: CaptureSession,
		kind: CaptureKind,
		keepRunning: boolean,
		params: CaptureParams,
	): Promise<Record<string, unknown>> {
		if (!keepRunning) {
			const again = this.stoppedFor(session, kind, params.id);
			if (again) return again.answer;
		}
		const capture = this.pick(session, params.id, kind);
		if (capture.busy)
			throw new CaptureError(ERR.BAD_PARAMS, `Capture ${capture.id} is being saved. Try again in a moment.`);
		const run = capture.run;
		if (!run)
			throw new CaptureError(ERR.BAD_PARAMS, `Capture ${capture.id} is still starting. Try again in a moment.`);
		capture.busy = true;
		try {
			const out = keepRunning ? await (run.snapshot ?? run.finish).call(run) : await run.finish();
			if (keepRunning) capture.saves++;
			const notes = [...out.notes];
			if (capture.endedBy) notes.unshift(`The capture had ended early: ${capture.endedBy}. This is what it held.`);
			const answer = {
				id: capture.id,
				kind: capture.kind,
				tabId: capture.tabId,
				...(out.durationMs !== undefined ? { durationMs: Math.round(out.durationMs) } : {}),
				...(out.entries !== undefined ? { entries: out.entries } : {}),
				...(keepRunning ? { stillRecording: capture.state !== "ended" } : {}),
				file: out.file,
				...(notes.length ? { notes } : {}),
			};
			if (!keepRunning) {
				// The browser let go of the data when it finished; this is the only copy until the file is written.
				this.captures.delete(capture.id);
				this.stopped.set(capture.id, { sessionId: capture.sessionId, kind: capture.kind, at: this.now(), answer });
				this.activity();
			}
			return answer;
		} finally {
			capture.busy = false;
		}
	}

	/** A stop this session already did whose file may not have been written: by id, else its only one of that kind when none is running. */
	private stoppedFor(session: CaptureSession, kind: CaptureKind, id: string | undefined): Stopped | undefined {
		if (id !== undefined) {
			const s = this.stopped.get(id);
			return s && s.sessionId === session.id && s.kind === kind ? s : undefined;
		}
		if (this.mine(session).some((c) => c.kind === kind)) return undefined;
		const held = [...this.stopped.values()].filter((s) => s.sessionId === session.id && s.kind === kind);
		return held.length === 1 ? held[0] : undefined;
	}

	/** The capture a stop or save means: by id, else the session's only one of that kind. */
	private pick(session: CaptureSession, id: string | undefined, kind: CaptureKind): Capture {
		if (id !== undefined) {
			const c = this.owned(session, id);
			if (c.kind !== kind)
				throw new CaptureError(
					ERR.BAD_PARAMS,
					`Capture ${id} is a ${c.kind === "network" ? "network capture" : c.kind === "record" ? "recording" : "flight recorder"}, not ${kind === "network" ? "a network capture" : kind === "record" ? "a recording" : "a flight recorder"}.`,
				);
			return c;
		}
		const of = this.mine(session).filter((c) => c.kind === kind);
		if (of.length === 1) return of[0];
		throw new CaptureError(
			ERR.BAD_PARAMS,
			of.length === 0
				? `You have no ${kind === "network" ? "network capture" : kind === "record" ? "recording" : "flight recorder"} running.`
				: `You have ${of.length}: pass id (${of.map((c) => c.id).join(", ")}).`,
		);
	}

	private async status(session: CaptureSession): Promise<Record<string, unknown>> {
		const captures = await Promise.all(
			this.mine(session).map(async (c) => {
				const stats = c.run && !c.busy ? await c.run.stats().catch(() => undefined) : undefined;
				return {
					id: c.id,
					kind: c.kind,
					tabId: c.tabId,
					state: c.state === "ended" ? "ended" : "running",
					startedAt: new Date(c.startedAt).toISOString(),
					...(c.state === "ended"
						? {
								endedBy: c.endedBy,
								keptUntil: new Date((c.endedAt ?? c.startedAt) + KEEP_ENDED_MS).toISOString(),
							}
						: { stopsBy: new Date(c.deadline).toISOString() }),
					...(stats ?? {}),
					...(c.saves ? { saves: c.saves } : {}),
				};
			}),
		);
		return { captures };
	}

	private async cancel(session: CaptureSession, params: CaptureParams): Promise<Record<string, unknown>> {
		if (params.id !== undefined) {
			// The helper says the file is on disk: the kept copy is no longer needed.
			const held = this.stopped.get(params.id);
			if (held && held.sessionId === session.id) {
				this.stopped.delete(params.id);
				this.activity();
				return { cancelled: [params.id] };
			}
		} else this.forgetStopped(session.id);
		const targets = params.id !== undefined ? [this.owned(session, params.id)] : this.mine(session);
		for (const c of targets) await this.drop(c);
		return { cancelled: targets.map((c) => c.id) };
	}

	private async drop(c: Capture): Promise<void> {
		this.captures.delete(c.id);
		this.activity();
		await c.run?.discard().catch(() => undefined);
	}

	private forgetStopped(sessionId: string): void {
		for (const [id, s] of this.stopped) if (s.sessionId === sessionId) this.stopped.delete(id);
		this.activity();
	}

	/**
	 * A capture stopped on its own (debugger detached, tab closed, page replaced): keep what it has.
	 * While it is still starting there is nothing to halt yet: `start` stops it when the browser answers.
	 */
	private ended(c: Capture, why: string): void {
		if (c.state === "ended") return;
		c.state = "ended";
		c.endedAt = this.now();
		c.endedBy ??= why;
		void c.run?.halt().catch(() => undefined);
	}

	/** The tab is gone from the browser, or no longer the session's. */
	tabClosed(tabId: number, why = "the tab was closed"): void {
		for (const c of this.captures.values()) if (c.tabId === tabId) this.ended(c, why);
	}

	/** Enforce the time limits and the ownership rule; call it every couple of seconds while `onActive(true)`. */
	async sweep(): Promise<void> {
		const now = this.now();
		for (const [id, s] of this.stopped) if (now - s.at >= RETRY_KEEP_MS) this.stopped.delete(id);
		this.activity();
		for (const c of [...this.captures.values()]) {
			if (c.state === "ended") {
				if (now - (c.endedAt ?? now) >= KEEP_ENDED_MS && !c.busy) await this.drop(c);
				continue;
			}
			if (c.state !== "running") continue;
			if (now >= c.deadline)
				this.ended(
					c,
					`it reached its ${Math.round((c.kind === "flight" ? MAX_FLIGHT_MS : MAX_CAPTURE_MS) / 60000)} minute limit`,
				);
			else if (!(await this.backend.owns(c.sessionId, c.tabId).catch(() => false)))
				this.ended(c, "the tab is no longer one of the session's");
		}
	}

	/** Drop every capture of a session that is gone, with its data. */
	async sessionGone(sessionId: string): Promise<void> {
		this.forgetStopped(sessionId);
		for (const c of [...this.captures.values()]) if (c.sessionId === sessionId) await this.drop(c);
	}

	private activity(): void {
		const active = this.captures.size > 0 || this.stopped.size > 0;
		if (active === this.active) return;
		this.active = active;
		this.options.onActive?.(active);
	}
}
