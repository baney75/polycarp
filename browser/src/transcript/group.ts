/**
 * Lays out a chat transcript as a log: the user's messages and the agent's own text stand
 * alone, and everything between them (tool calls, page changes, reasoning) folds into one
 * compact list of steps. Pure data, no rendering, so it is tested on its own
 * (test/transcript.test.mjs); render.ts draws it.
 */

import { siteOf } from "../storage/stores/domain-match.js";

/** The message shapes this module reads. Kept structural so tests can pass plain objects. */
export interface TMessage {
	role: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: TUsage;
	url?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
}

export interface TUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: { total: number };
}

export interface TToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Reasoning shorter than this (after trimming) says nothing worth a row of its own. */
export const NEAR_EMPTY_THINKING = 40;

export type Step =
	| {
			kind: "tool";
			key: string;
			call: TToolCall;
			result?: TMessage;
			/** The assistant message the call came from. */
			message: TMessage;
			/** Reasoning that led to this call (shown when the row is expanded). */
			thinking?: string;
			/** Usage of the step's model call; set on the message's last step only. */
			usage?: TUsage;
			/** For a navigate call: show the site's skills (first visit to this site in a row). */
			showSkills: boolean;
	  }
	| { kind: "thought"; key: string; thinking: string; usage?: TUsage }
	| { kind: "nav"; key: string; message: TMessage; showSkills: boolean };

export type Block =
	| { kind: "message"; key: string; message: TMessage }
	| { kind: "text"; key: string; text: string; usage?: TUsage }
	| { kind: "steps"; key: string; steps: Step[] }
	| { kind: "status"; key: string; status: "error" | "aborted"; text?: string };

function chunks(m: TMessage): Array<Record<string, unknown>> {
	return Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
}

/**
 * Tool calls that render as full cards, not rows: the artifacts card is how the user opens the
 * output, and the ask_user card is where the user answers (it must never fold away).
 */
export const FULL_CARD_TOOLS = new Set(["artifacts", "ask_user"]);

function navigateUrl(result: TMessage | undefined): string | undefined {
	const details = result?.details as { finalUrl?: unknown; switchedToTab?: unknown } | undefined;
	return typeof details?.finalUrl === "string" ? details.finalUrl : undefined;
}

export interface GroupOptions {
	/** Results by tool call id; built from `messages` when not given. */
	results?: Map<string, TMessage>;
	/** Last site the transcript visited before `messages` (for the live message). */
	lastSite?: string;
}

export interface GroupResult {
	blocks: Block[];
	/** The site of the last page change, so a following live message continues the count. */
	lastSite?: string;
}

/**
 * Group a transcript. Keys are stable across re-renders: a block is keyed by the index of the
 * message that opened it, so a growing transcript only appends and grows its last block.
 */
export function groupTranscript(messages: readonly TMessage[], opts: GroupOptions = {}): GroupResult {
	const results = opts.results ?? new Map<string, TMessage>();
	if (!opts.results) {
		for (const m of messages) if (m.role === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	}
	const blocks: Block[] = [];
	let steps: Step[] | undefined;
	let lastSite = opts.lastSite;
	const openSteps = (key: string): Step[] => {
		if (!steps) {
			steps = [];
			blocks.push({ kind: "steps", key, steps });
		}
		return steps;
	};
	const closeSteps = () => {
		steps = undefined;
	};
	/** A site's skills show on the first page change to it, not on every page within it. */
	const visit = (url: string | undefined): boolean => {
		const site = siteOf(url);
		if (!site) return false;
		const first = site !== lastSite;
		lastSite = site;
		return first;
	};

	messages.forEach((m, index) => {
		switch (m.role) {
			case "artifact":
			case "toolResult":
				return;
			case "navigation":
				openSteps(`steps:${index}`).push({
					kind: "nav",
					key: `nav:${index}`,
					message: m,
					showSkills: visit(m.url),
				});
				return;
			case "assistant":
				break;
			default:
				closeSteps();
				blocks.push({ kind: "message", key: `msg:${index}`, message: m });
				return;
		}

		let thought = "";
		let lastStep: Step | undefined;
		let lastText: Extract<Block, { kind: "text" }> | undefined;
		const flushThought = (at: number) => {
			if (thought.trim().length >= NEAR_EMPTY_THINKING) {
				const step: Step = { kind: "thought", key: `thought:${index}:${at}`, thinking: thought.trim() };
				// Keyed by the chunk that opens it: text can split one message into several step lists.
				openSteps(`steps:${index}:${at}`).push(step);
				lastStep = step;
				lastText = undefined;
			}
			thought = "";
		};
		chunks(m).forEach((c, ci) => {
			if (c.type === "thinking" && typeof c.thinking === "string") {
				thought += thought ? `\n\n${c.thinking}` : c.thinking;
			} else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
				flushThought(ci);
				closeSteps();
				lastText = { kind: "text", key: `text:${index}:${ci}`, text: c.text };
				blocks.push(lastText);
				lastStep = undefined;
			} else if (c.type === "toolCall") {
				const call = c as unknown as TToolCall;
				const result = results.get(call.id);
				const step: Step = {
					kind: "tool",
					key: `tool:${call.id}`,
					call,
					result,
					message: m,
					thinking: thought.trim() || undefined,
					showSkills: call.name === "navigate" ? visit(navigateUrl(result)) : false,
				};
				thought = "";
				openSteps(`steps:${index}:${ci}`).push(step);
				lastStep = step;
				lastText = undefined;
			}
		});
		flushThought(chunks(m).length);

		// Per-step usage goes on the message's last row (shown on hover), never as its own line.
		if (m.usage) {
			if (lastStep && lastStep.kind !== "nav") lastStep.usage = m.usage;
			else if (lastText) lastText.usage = m.usage;
		}
		if (m.stopReason === "error") {
			closeSteps();
			blocks.push({ kind: "status", key: `status:${index}`, status: "error", text: m.errorMessage });
		} else if (m.stopReason === "aborted") {
			closeSteps();
			blocks.push({ kind: "status", key: `status:${index}`, status: "aborted" });
		}
	});
	return { blocks, lastSite };
}

/** Model-written text for a label: one line, quoted, cut at 40 characters. */
function quoted(v: unknown): string {
	if (typeof v !== "string" || !v.trim()) return "";
	const line = v.replace(/\s+/g, " ").trim();
	return `"${line.length > 40 ? `${line.slice(0, 39)}…` : line}"`;
}

/** What a page tool aims at: its ref, a short selector, or a point. */
function targetText(a: Record<string, unknown>): string {
	if (typeof a.ref === "string" && a.ref) return a.ref;
	if (typeof a.selector === "string" && a.selector) return quoted(a.selector);
	if (typeof a.x === "number" && typeof a.y === "number") return `at ${Math.round(a.x)}, ${Math.round(a.y)}`;
	return "";
}

/** An act call's label, by its action: "Click e5", "Type "hi" in e2", "Scroll to bottom". */
function actLabel(a: Record<string, unknown>): string {
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	switch (a.action) {
		case "click":
			return `${Number(a.clickCount) === 2 ? "Double-click" : "Click"} ${targetText(a)}`.trim();
		case "hover":
			return `Hover ${targetText(a)}`.trim();
		case "type":
			return `Type ${quoted(a.text)}${a.ref || a.selector ? ` in ${targetText(a)}` : ""}`.trim();
		case "fill":
			return `Fill ${targetText(a)} with ${quoted(a.value)}`.trim();
		case "press": {
			const times = Number(a.repeat);
			return `Press ${str(a.key) ?? "a key"}${times > 1 ? ` ${times} times` : ""}`;
		}
		case "scroll": {
			const edge = a.edge ?? a.to;
			if (edge === "top" || edge === "bottom") return `Scroll to ${edge}`;
			const dy = Number(a.dy ?? 0);
			if (dy) return `Scroll ${dy > 0 ? "down" : "up"}`;
			if (a.ref || a.selector) return `Scroll to ${targetText(a)}`;
			return "Scroll";
		}
		case "drag":
			return "Drag";
		case "wait":
			if (str(a.text)) return `Wait for ${quoted(a.text)}`;
			if (str(a.urlIncludes)) return `Wait for ${quoted(a.urlIncludes)} in the address`;
			if (str(a.selector)) return "Wait for an element";
			return Number(a.ms) > 0 ? `Wait ${Number(a.ms)} ms` : "Wait";
		case "screenshot":
			return "Screenshot";
		case "steps": {
			const n = Array.isArray(a.steps) ? a.steps.length : 0;
			return n ? `Run ${n} input ${n === 1 ? "step" : "steps"}` : "Run input steps";
		}
		default:
			return "Act on the page";
	}
}

/** A one-line label for a tool call row. */
export function stepLabel(call: TToolCall, result?: TMessage): { label: string; detail?: string } {
	const a = call.arguments ?? {};
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	switch (call.name) {
		case "repl":
			return { label: str(a.title) ?? "Run code" };
		case "navigate": {
			const details = (result?.details ?? {}) as { title?: string; finalUrl?: string; tabs?: unknown[] };
			if (a.listTabs) return { label: "List tabs" };
			if (a.closeTab !== undefined) return { label: `Close tab ${a.closeTab}` };
			if (a.showTab !== undefined) return { label: `Show tab ${a.showTab}` };
			if (a.switchToTab !== undefined) return { label: details.title ?? `Switch to tab ${a.switchToTab}` };
			const url = details.finalUrl ?? str(a.url);
			// A page title needs its site beside it. Without one, the site is the label, once.
			if (details.title) return { label: details.title, detail: siteOf(url) };
			return { label: url ? `Open ${siteOf(url) ?? url}` : "Navigate" };
		}
		case "skill":
			return { label: `Skill ${str(a.action) ?? ""} ${str(a.name) ?? ""}`.replace(/\s+/g, " ").trim() };
		case "extract_document":
			return { label: "Read document", detail: siteOf(str(a.url)) ?? str(a.url) };
		case "extract_image":
			return { label: "Read image" };
		case "ask_user_which_element":
			return { label: "Ask you to pick an element" };
		case "read_page":
		case "get_page_text": {
			const url = (result?.details as { url?: unknown } | undefined)?.url;
			return {
				label: call.name === "read_page" ? "Read page" : "Read text",
				detail: siteOf(typeof url === "string" ? url : undefined),
			};
		}
		case "find":
			return { label: `Find ${quoted(a.query)}`.trim() };
		case "act":
			return { label: actLabel(a) };
		case "handle_dialog":
			return { label: a.accept === true ? "Answer the dialog: OK" : "Answer the dialog: Cancel" };
		case "artifacts":
			return { label: `${str(a.command) ?? "Edit"} ${str(a.filename) ?? ""}`.trim() };
		default:
			return { label: call.name.replace(/_/g, " ") };
	}
}

/** A call without a result is running while the agent runs, and was cut off once it stopped. */
export function stepState(step: Extract<Step, { kind: "tool" }>, agentRunning: boolean): "running" | "done" | "error" {
	if (step.result) return step.result.isError ? "error" : "done";
	if (step.message.stopReason === "aborted" || !agentRunning) return "error";
	return "running";
}

/** Compact usage text for a hover: "↑669 ↓1.0k R48k $0.0009". */
export function usageText(u: TUsage | undefined): string {
	if (!u) return "";
	const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
	const parts = [`↑${k(u.input)}`, `↓${k(u.output)}`];
	if (u.cacheRead) parts.push(`R${k(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${k(u.cacheWrite)}`);
	if (u.cost?.total) parts.push(`$${u.cost.total.toFixed(4)}`);
	return parts.join(" ");
}

/** A long run keeps its last rows in view; earlier ones sit behind one "N earlier steps" row. */
export const VISIBLE_TAIL = 5;
export const COLLAPSE_OVER = 8;

export type StepRow = { kind: "step"; step: Step } | { kind: "more"; key: string; count: number };

/**
 * The rows a step list shows, in time order. Past COLLAPSE_OVER rows only the last VISIBLE_TAIL
 * show, plus every full card (artifacts, ask_user), which never hides. Each run of hidden rows
 * becomes one "N earlier steps" row in its own place, so a pinned card keeps its position.
 */
export function stepRows(steps: readonly Step[], showAll: boolean): StepRow[] {
	const cut = !showAll && steps.length > COLLAPSE_OVER ? steps.length - VISIBLE_TAIL : 0;
	const rows: StepRow[] = [];
	steps.forEach((step, i) => {
		if (i >= cut || (step.kind === "tool" && FULL_CARD_TOOLS.has(step.call.name))) {
			rows.push({ kind: "step", step });
			return;
		}
		const last = rows.at(-1);
		if (last?.kind === "more") last.count++;
		else rows.push({ kind: "more", key: `more:${step.key}`, count: 1 });
	});
	return rows;
}

/**
 * Is a tool call still on its way (arguments streaming, or about to run)? Only in the current
 * run: the live message, or the run's last assistant message before its tools start. A call
 * from an earlier turn with no result was cut off, whatever runs now.
 */
export function callInFlight(
	step: Extract<Step, { kind: "tool" }>,
	opts: { live: boolean; running: boolean; pending: boolean; lastAssistant?: TMessage },
): boolean {
	if (step.result || opts.pending || step.message.stopReason === "aborted") return false;
	return opts.live || (opts.running && step.message === opts.lastAssistant);
}

/**
 * The assistant message whose calls may still be about to run: the last one, unless the user
 * has spoken since (a new turn started; its reply is still streaming and not in the list).
 */
export function currentRunAssistant(messages: readonly TMessage[]): TMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "assistant") return messages[i];
		if (role === "user" || role === "user-with-attachments") return undefined;
	}
	return undefined;
}
