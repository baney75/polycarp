/**
 * When the "in use by an agent" veil shows on a tab. Pure: src/browser/veil.ts feeds it events
 * and carries out the effects it returns.
 *
 * - A tool call on a tab begins or ends: the veil shows on that tab (or stays). The first call a
 *   session makes in a tab is what puts it there, including the navigate that opened the tab.
 * - While a call that sends pointer input (click, type, ...) runs, the pill's one control takes
 *   no pointer events, so the agent's own clicks and hit tests never land on it.
 * - The session goes quiet: `idleMs` after its last call on the tab ended, the veil fades.
 * - The tab stops being the session's (released, taken back by the user, the session ended or
 *   its client left, the tab closed): the veil goes at once, with no fade.
 * - A screenshot or a screencast (a live view or a recording) conceals it while it runs, so no
 *   capture shows it.
 */

/** How long a session has been idle on a tab before its veil fades. Long enough that the gap
 * between two tool calls (the model thinking) never makes it blink. */
export const VEIL_IDLE_MS = 15_000;

/** What the pill says: who is working and on what, in the session's tab group color. */
export interface VeilView {
	/** The agent's name, as shown ("Claude"). */
	agent: string;
	/** The project or session name the group title shows after it, or "". */
	detail: string;
	/** The tab group's color name (chrome.tabGroups.Color). */
	color: string;
}

export interface VeilTab {
	sessionId: string;
	view: VeilView;
	/** Calls on this tab in flight. */
	busy: number;
	/** How many of them send pointer input. */
	input: number;
	/** When the last call on the tab began or ended (ms). */
	lastActiveAt: number;
}

export interface VeilState {
	readonly tabs: Readonly<Record<number, VeilTab>>;
	/** Captures running per tab, kept whether or not a veil shows there yet. */
	readonly concealed: Readonly<Record<number, { shots: number; cast: boolean }>>;
}

export const EMPTY_VEIL: VeilState = { tabs: {}, concealed: {} };

export type VeilEvent =
	| { type: "begin"; tabId: number; sessionId: string; view: VeilView; input: boolean; at: number }
	| { type: "end"; tabId: number; sessionId: string; view: VeilView; input: boolean; at: number }
	| { type: "tick"; at: number; idleMs?: number }
	| { type: "drop"; tabId: number }
	| { type: "dropSession"; sessionId: string }
	| { type: "dropAll" }
	/** The tab loaded a new document: the old veil went with the old one. */
	| { type: "navigated"; tabId: number }
	| { type: "conceal"; tabId: number; reason: "shot" | "cast"; on: boolean };

export type VeilEffect =
	/** Draw (or redraw) the veil with this view; idempotent on the page side. */
	| { kind: "show"; tabId: number; view: VeilView; interactive: boolean; concealed: boolean }
	| { kind: "interactive"; tabId: number; on: boolean }
	| { kind: "conceal"; tabId: number; on: boolean }
	| { kind: "hide"; tabId: number; fade: boolean };

export interface VeilStep {
	state: VeilState;
	effects: VeilEffect[];
	/** When to send the next tick (ms), if a veil is waiting to fade. */
	wakeAt?: number;
}

const sameView = (a: VeilView, b: VeilView) => a.agent === b.agent && a.detail === b.detail && a.color === b.color;

function isConcealed(state: VeilState, tabId: number): boolean {
	const c = state.concealed[tabId];
	return c !== undefined && (c.shots > 0 || c.cast);
}

/** The earliest moment a quiet veil should fade. */
export function nextWake(state: VeilState, idleMs = VEIL_IDLE_MS): number | undefined {
	let wake: number | undefined;
	for (const t of Object.values(state.tabs)) {
		if (t.busy > 0) continue;
		const at = t.lastActiveAt + idleMs;
		if (wake === undefined || at < wake) wake = at;
	}
	return wake;
}

/** Apply one event. Never mutates `state`. */
export function veilStep(state: VeilState, event: VeilEvent, idleMs = VEIL_IDLE_MS): VeilStep {
	const tabs: Record<number, VeilTab> = { ...state.tabs };
	const concealed: Record<number, { shots: number; cast: boolean }> = { ...state.concealed };
	const effects: VeilEffect[] = [];
	const next = (): VeilStep => {
		const s: VeilState = { tabs, concealed };
		return { state: s, effects, wakeAt: nextWake(s, idleMs) };
	};
	const drop = (tabId: number, fade: boolean) => {
		if (!tabs[tabId]) return;
		delete tabs[tabId];
		effects.push({ kind: "hide", tabId, fade });
	};

	switch (event.type) {
		case "begin":
		case "end": {
			const begin = event.type === "begin";
			const old = tabs[event.tabId];
			if (!old) {
				// A call ending on a tab it didn't begin on (the navigate that opened it) shows the veil
				// as if it had begun and ended there.
				const input = begin && event.input ? 1 : 0;
				tabs[event.tabId] = {
					sessionId: event.sessionId,
					view: event.view,
					busy: begin ? 1 : 0,
					input,
					lastActiveAt: event.at,
				};
				effects.push({
					kind: "show",
					tabId: event.tabId,
					view: event.view,
					interactive: input === 0,
					concealed: isConcealed(state, event.tabId),
				});
				return next();
			}
			const t: VeilTab = { ...old, lastActiveAt: Math.max(old.lastActiveAt, event.at) };
			if (old.sessionId !== event.sessionId || !sameView(old.view, event.view)) {
				t.sessionId = event.sessionId;
				t.view = event.view;
				effects.push({
					kind: "show",
					tabId: event.tabId,
					view: event.view,
					interactive: old.input === 0,
					concealed: isConcealed(state, event.tabId),
				});
			}
			if (begin) {
				t.busy = old.busy + 1;
				if (event.input) {
					t.input = old.input + 1;
					if (old.input === 0) effects.push({ kind: "interactive", tabId: event.tabId, on: false });
				}
			} else {
				t.busy = Math.max(0, old.busy - 1);
				if (event.input && old.input > 0) {
					t.input = old.input - 1;
					if (t.input === 0) effects.push({ kind: "interactive", tabId: event.tabId, on: true });
				}
			}
			tabs[event.tabId] = t;
			return next();
		}
		case "tick": {
			const idle = event.idleMs ?? idleMs;
			for (const [id, t] of Object.entries(tabs))
				if (t.busy === 0 && event.at - t.lastActiveAt >= idle) drop(Number(id), true);
			const s: VeilState = { tabs, concealed };
			return { state: s, effects, wakeAt: nextWake(s, idle) };
		}
		case "drop":
			drop(event.tabId, false);
			return next();
		case "dropSession":
			for (const [id, t] of Object.entries(tabs)) if (t.sessionId === event.sessionId) drop(Number(id), false);
			return next();
		case "dropAll":
			for (const id of Object.keys(tabs)) drop(Number(id), false);
			return next();
		case "navigated": {
			const t = tabs[event.tabId];
			if (t)
				effects.push({
					kind: "show",
					tabId: event.tabId,
					view: t.view,
					interactive: t.input === 0,
					concealed: isConcealed(state, event.tabId),
				});
			return next();
		}
		case "conceal": {
			const was = isConcealed(state, event.tabId);
			const c = { ...(concealed[event.tabId] ?? { shots: 0, cast: false }) };
			if (event.reason === "cast") c.cast = event.on;
			else c.shots = Math.max(0, c.shots + (event.on ? 1 : -1));
			if (c.shots === 0 && !c.cast) delete concealed[event.tabId];
			else concealed[event.tabId] = c;
			const now = isConcealed({ tabs, concealed }, event.tabId);
			if (tabs[event.tabId] && now !== was) effects.push({ kind: "conceal", tabId: event.tabId, on: now });
			return next();
		}
	}
}

/** The pill's text for a session: its agent ("claude" -> "Claude") and what the group title says after it. */
export function veilViewFor(record: { label: string; color: string; agent?: string; agentLabel?: string }): VeilView {
	const parts = record.label.split(" · ");
	const agentName = (record.agent || parts[0] || "Agent").trim();
	const rest = record.agent && parts[0] === record.agent ? parts.slice(1) : record.agent ? parts : parts.slice(1);
	const detail = [...rest, record.agentLabel ?? ""].filter(Boolean).join(" · ");
	return {
		agent: agentName.charAt(0).toUpperCase() + agentName.slice(1),
		detail,
		color: record.color,
	};
}
