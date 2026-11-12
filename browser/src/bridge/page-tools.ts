/**
 * The ref tools as the side panel's model sees them: read_page, find, act and the rest, the
 * same layer outside agents get through MCP. Each tool is a name, a short description and a schema,
 * a route onto one bridge handler (src/bridge/tools.ts), and a way to print what the handler returned.
 *
 * Pure data and functions, no chrome APIs: the side panel (src/tools/page-tools.ts) routes calls with
 * them and the service worker runs those on the handlers (src/bridge/panel-calls.ts); the CLI's panel
 * profile (cli/src/panel-profile.ts) runs them through the bridge, so the web benchmark measures the
 * panel's tool surface with the same code. Names match the MCP tools, so the bridge's own messages ("call read_page", "handle_dialog")
 * are right in both places.
 *
 * Left out of the panel, and why: tabs_* (the panel's navigate tool lists, opens, switches, shows and
 * closes its tabs), run_js and get_page_html (the REPL), files (its upload approval is the bridge's
 * own question flow), read_console, read_network, inspect_page and capture (debugging and evidence
 * for outside agents), site_edit and site_script (Settings > Sites), search, crawl, skills, library
 * and threads (the helper's or the panel's own tools).
 */

import { type TSchema, Type } from "@sinclair/typebox";
import { formatNodes, formatSnapshot, type SnapNode, type Snapshot } from "./format.js";

export interface PageToolSpec {
	name: string;
	/** What the transcript calls the tool. */
	label: string;
	description: string;
	parameters: TSchema;
}

const point = Type.Object({ x: Type.Number(), y: Type.Number() });
/** A string from a list, as {type, enum}: Google's API rejects the anyOf a union of literals makes. */
const oneOf = <T extends string>(values: readonly T[]) => Type.Unsafe<T>({ type: "string", enum: [...values] });
const num = (description?: string) => Type.Optional(Type.Number(description ? { description } : {}));
const text = (description?: string) => Type.Optional(Type.String(description ? { description } : {}));

/** What `act` does, and the bridge handler (src/bridge/tools.ts `handlers`) each action runs. */
const ACT_METHOD: Record<string, string> = {
	click: "click",
	type: "type",
	fill: "fill",
	press: "press",
	hover: "hover",
	scroll: "scroll",
	drag: "drag",
	wait: "wait",
	screenshot: "screenshot",
	steps: "actions",
};

export const ACT_ACTIONS: readonly string[] = Object.keys(ACT_METHOD);

/**
 * The order the model sees them in: read first, then act. Input is one tool with an action field:
 * ten input tools of their own cost the panel about 1,500 more tokens a turn (docs/benchmarks.md).
 */
export const PAGE_TOOLS: readonly PageToolSpec[] = [
	{
		name: "read_page",
		label: "Read page",
		description:
			'See your current tab: elements with refs (e1, e2...), roles, names and values, then the page text. Act by ref; refs expire when the page changes, so read again after. {"filter":"interactive"} lists only controls and links.',
		parameters: Type.Object({
			filter: Type.Optional(oneOf(["all", "interactive"])),
			maxNodes: num("Cap on elements"),
			maxTextChars: num("Cap on page text (default 3000)"),
		}),
	},
	{
		name: "find",
		label: "Find",
		description:
			'Find elements by words in their role, label, value or link; returns refs. Cheaper than read_page when you know what you want. {"query":"sign in button"}',
		parameters: Type.Object({ query: Type.String(), limit: num("Max matches (default 20)") }),
	},
	{
		name: "get_page_text",
		label: "Read text",
		description:
			'Readable text of the tab or one element: the cheapest way to read. On a PDF, text by page. {"selector":"article"}',
		parameters: Type.Object({ selector: text(), maxChars: num(), pages: text('PDF pages: "3" or "3-7"') }),
	},
	{
		name: "act",
		label: "Act",
		description: `Act on your current tab with real mouse and key events, then read_page to confirm. Aim with ref (best), selector, or x/y from your latest screenshot.
click {ref} (clickCount 2 doubles, button right)
type {text, ref?, submit?}: clicks the field, types; submit presses Enter
fill {ref, value}: sets an input, select (value or label) or checkbox ("true"/"false")
press {key, repeat?}: Enter, Escape, Tab, ArrowDown, Control+a
hover {ref}
scroll {dy} or {edge:"top"|"bottom"} or {ref}
drag {from:{x,y}, to:{x,y}}
wait {text|selector|urlIncludes, timeoutMs?} or {ms}: instead of reading again and again
screenshot {fullPage?}: for layout and canvas; read_page is cheaper for text
steps {steps:[{click:{ref:"e3"}},{type:"hi"},{press:"Enter"}], screenshot?}: up to 40 input steps, stops at the first failure`,
		parameters: Type.Object({
			action: oneOf(ACT_ACTIONS),
			ref: text(),
			selector: text(),
			x: num(),
			y: num(),
			text: text(),
			value: text(),
			key: text(),
			submit: Type.Optional(Type.Boolean()),
			repeat: num(),
			clickCount: num(),
			button: Type.Optional(oneOf(["left", "right", "middle"])),
			dx: num(),
			dy: num("Positive scrolls down"),
			edge: Type.Optional(oneOf(["top", "bottom"])),
			from: Type.Optional(point),
			to: Type.Optional(point),
			urlIncludes: text(),
			ms: num(),
			timeoutMs: num(),
			fullPage: Type.Optional(Type.Boolean()),
			steps: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
			screenshot: Type.Optional(Type.Boolean()),
		}),
	},
	{
		name: "handle_dialog",
		label: "Answer dialog",
		description:
			"Answer an alert, confirm or prompt box; while one is open the page is frozen and calls fail with dialog_open. accept:false is Cancel (always safe). accept:true is OK: only when the box confirms exactly what the user asked for; otherwise ask them first.",
		parameters: Type.Object({
			accept: Type.Boolean(),
			promptText: text(),
			tabId: num("From the dialog_open error, when several tabs have one"),
		}),
	},
];

export const PAGE_TOOL_NAMES: ReadonlySet<string> = new Set(PAGE_TOOLS.map((t) => t.name));

const READ_METHOD: Record<string, string> = {
	read_page: "snapshot",
	find: "find",
	get_page_text: "text",
	handle_dialog: "dialog",
};

/** The handlers the panel's page tools may reach, and no others. */
export const PAGE_TOOL_METHODS: ReadonlySet<string> = new Set([
	...Object.values(READ_METHOD),
	...Object.values(ACT_METHOD),
]);

export class PageToolArgsError extends Error {}

/** "3", "3-7" (a hyphen, en dash or em dash), "p3", "pp. 3-7" as a page range. */
export function pageRange(pages: string): { firstPage: number; lastPage: number } | undefined {
	const m = /^\s*(?:pp?\.?\s*)?(\d+)\s*(?:[-\u2013\u2014]\s*(\d+))?\s*$/i.exec(pages);
	return m ? { firstPage: Number(m[1]), lastPage: Number(m[2] ?? m[1]) } : undefined;
}

/** Only what a handler reads: an act call carries every field its schema allows, mostly unset. */
function defined(args: Record<string, unknown>, drop: readonly string[]): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(args).filter(([k, v]) => v !== undefined && v !== null && !drop.includes(k)),
	);
}

/** One `steps` entry without a tabId, at its top or one level in ({"click":{"ref":"e3","tabId":9}}). */
function stepInSession(step: unknown): unknown {
	if (!step || typeof step !== "object") return step;
	return Object.fromEntries(
		Object.entries(step as Record<string, unknown>)
			.filter(([k]) => k !== "tabId")
			.map(([k, v]) => [
				k,
				v && typeof v === "object" && !Array.isArray(v) ? defined(v as Record<string, unknown>, ["tabId"]) : v,
			]),
	);
}

/** The bridge call for one panel tool call. */
export function routePageTool(
	name: string,
	args: Record<string, unknown>,
): { method: string; params: Record<string, unknown>; action?: string } {
	// The panel works in its current tab (navigate's switchToTab chooses it); only a dialog answer names a tab.
	if (name === "handle_dialog") return { method: "dialog", params: defined(args ?? {}, []) };
	if (name === "act") {
		const action = String(args?.action ?? "");
		const method = ACT_METHOD[action];
		if (!method)
			throw new PageToolArgsError(
				`act needs action, one of ${ACT_ACTIONS.join(", ")}; got ${JSON.stringify(args?.action)}.`,
			);
		// from/to are drag's points; scroll reads any `to` as top or bottom, so only drag keeps them.
		const params = defined(args, ["action", "tabId", "edge", ...(action === "drag" ? [] : ["from", "to"])]);
		if (action === "scroll" && (args.edge === "top" || args.edge === "bottom")) params.to = args.edge;
		if (action === "steps" && Array.isArray(args.steps)) params.steps = args.steps.map(stepInSession);
		return { method, params, action };
	}
	const method = READ_METHOD[name];
	if (!method) throw new PageToolArgsError(`Unknown page tool ${name}`);
	const params = defined(args ?? {}, ["tabId"]);
	if (name === "read_page") params.maxTextChars ??= 3000;
	if (name === "get_page_text" && typeof params.pages === "string") {
		const range = pageRange(params.pages);
		if (!range)
			throw new PageToolArgsError(`pages takes one page or a range, like "3" or "3-7", not "${params.pages}".`);
		delete params.pages;
		Object.assign(params, range);
	}
	return { method, params };
}

export type PageContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PageToolDetails {
	/** The page the tool read, when it says. */
	url?: string;
	title?: string;
	/** Elements listed (read_page) or matched (find). */
	count?: number;
}

interface Shot {
	data: string;
	mimeType: string;
	width: number;
	height: number;
}

const SHOT_NOTE = "Give act x/y in this image's pixels; they are mapped to the page for you.";

function shotContent(shot: Shot): PageContent[] {
	return [
		{ type: "image", data: shot.data, mimeType: shot.mimeType },
		{ type: "text", text: `${shot.width}x${shot.height} screenshot. ${SHOT_NOTE}` },
	];
}

/** What the model reads back from one panel tool call. */
export function formatPageResult(
	name: string,
	result: unknown,
	action?: string,
): { content: PageContent[]; details: PageToolDetails } {
	const r = (result ?? {}) as Record<string, unknown>;
	const text = (t: string): PageContent[] => [{ type: "text", text: t }];
	switch (name === "act" ? action : name) {
		case "read_page": {
			const snap = r as unknown as Snapshot;
			return {
				content: text(formatSnapshot(snap, "act")),
				details: { url: snap.url, title: snap.title, count: snap.nodes.length },
			};
		}
		case "find": {
			const matches = (r.matches ?? []) as SnapNode[];
			return {
				content: text(
					matches.length ? formatNodes(matches, "") : "No elements match. Try read_page or other words.",
				),
				details: { count: matches.length },
			};
		}
		case "get_page_text": {
			const pdf = r.pdf as { pages: number; truncated?: boolean; note?: string } | undefined;
			const head = `Page: ${String(r.title ?? "")} | ${String(r.url ?? "")}`;
			const pdfLine = pdf
				? `\nPDF, ${pdf.pages} pages${pdf.truncated ? " (cut short)" : ""}.${pdf.note ? ` ${pdf.note}` : ""}`
				: "";
			return {
				content: text(`${head}${pdfLine}\n\n${String(r.text ?? "")}`),
				details: { url: String(r.url ?? ""), title: String(r.title ?? "") },
			};
		}
		case "screenshot":
			return { content: shotContent(r as unknown as Shot), details: {} };
		case "steps": {
			const shot = r.screenshot as Shot | undefined;
			const done: PageContent = {
				type: "text",
				text: `${String(r.steps)} steps done.${r.note ? ` ${String(r.note)}` : ""}`,
			};
			return { content: shot ? [done, ...shotContent(shot)] : [done], details: {} };
		}
		default:
			return {
				content: text(JSON.stringify(result ?? null)),
				details:
					typeof r.url === "string"
						? { url: r.url, title: typeof r.title === "string" ? r.title : undefined }
						: {},
			};
	}
}

/** The system prompt's part about these tools: the loop, briefly. */
export const PAGE_TOOLS_PROMPT = `# Working on Pages
Loop: read_page {"filter":"interactive"} (refs) -> act {"action":"click","ref":"e5"} (or type, fill...) -> read_page again to confirm. Refs expire when the page changes. find gets refs by words; get_page_text reads; act wait beats reading again and again; act screenshot only for layout or canvas. A click that opens a dialog worked: answer it with handle_dialog, never click again. If a call fails with interrupted, read_page before you repeat it. Use the repl for data work and page scripts, not to click or type.`;

/** The side panel's request to the service worker (src/bridge/panel-calls.ts): one bridge method on its session. */
export const PANEL_CALL = "polycarp-page-tool";
/** The panel's stop button: abort the call with this `callId`. */
export const PANEL_ABORT = "polycarp-page-tool-abort";

export interface PanelCallMessage {
	type: typeof PANEL_CALL;
	callId: string;
	sessionId: string;
	method: string;
	params: Record<string, unknown>;
}
export interface PanelAbortMessage {
	type: typeof PANEL_ABORT;
	callId: string;
}
/** The worker's answer: the handler's result, or the error text the model reads (code first). */
export type PanelCallReply = { ok: true; result: unknown } | { ok: false; message: string };
