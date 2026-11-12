/**
 * The change report: what an action did to the page, so the agent need not read the page again
 * to find out. Input tools look at the page before the action and again after it settles, and
 * return the difference: URL and title, tabs opened or closed, focus, the controls that
 * appeared, went or changed, each with its ref, role and name, and new lines of text. Refs are the ones read_page gives
 * (the same element keeps its ref), so a ref the report lists works at once and a ref that
 * survived stays valid. A new document is summed up, not listed. Decision D42.
 *
 * Page text in the report (names, values) is the page's: quoted, on one line, capped, exactly as
 * read_page shows it. Password values never appear (the snapshot leaves them out).
 */

import { openDialog } from "./cdp.js";
import { maskUrl } from "./mask-body.js";
import { type ChangeLook, changeLook } from "./page.js";

/** Controls compared on each side; a page with more is compared on its first this many. */
const MAX_NODES = 400;
/** Element lines in one report; the rest are counted. */
const MAX_LINES = 12;
/** New lines of page text in one report, and the most of each. */
const MAX_TEXT_LINES = 3;
const TEXT_LINE_CHARS = 100;
/**
 * The most one look may take. Two looks per action, so the report adds at most 2 x LOOK_MS to
 * it; a look that runs out is dropped and the report says it could not compare.
 */
export const LOOK_MS = 750;

/** Why a side has no look: it ran out or was refused, the page is too large, or no tool may read it. */
type Miss = "failed" | "large" | "guarded";

export interface Before {
	tabId: number;
	/** The ref the action went to: focus landing there is the action itself, not news. */
	target?: string;
	tabs: number[];
	look?: ChangeLook;
	/** Set when `look` is missing. */
	miss?: Miss;
	/** The hosts no tool may read (#94): each look checks them in the page before it reads anything. */
	hosts: readonly string[];
}

type Node = ChangeLook["nodes"][number];

/** Page text on one line: no control or line-break character survives. */
const oneLine = (t: string | undefined) => String(t ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, " ");
/** Page text on one line, quoted and capped, as read_page shows it. */
const q = (t: string | undefined, max = 60) => JSON.stringify(oneLine(t).slice(0, max));

function line(n: Node): string {
	let s = `${n.ref} ${n.role.replace(/[^a-z-]/g, "") || "generic"} ${q(n.name)}`;
	if (n.value) s += ` value=${q(n.value, 40)}`;
	if (n.states?.length) s += ` [${n.states.join(", ").replace(/[^\w ,:-]/g, "")}]`;
	return s;
}

/** What changed on a control that kept its ref. */
function delta(a: Node, b: Node): string | undefined {
	const parts: string[] = [];
	if (a.name !== b.name) parts.push(`name ${q(a.name, 40)} -> ${q(b.name, 40)}`);
	if ((a.value ?? "") !== (b.value ?? "")) parts.push(`value ${q(a.value, 40)} -> ${q(b.value, 40)}`);
	const sa = (a.states ?? []).join(", ");
	const sb = (b.states ?? []).join(", ");
	if (sa !== sb) parts.push(`[${sa}] -> [${sb}]`.replace(/[^\w ,:[\]>-]/g, ""));
	return parts.length
		? `${b.ref} ${b.role.replace(/[^a-z-]/g, "") || "generic"} ${q(b.name)}: ${parts.join("; ")}`
		: undefined;
}

async function look(tabId: number, hosts: readonly string[], before: string[] = []): Promise<ChangeLook | Miss> {
	if (openDialog(tabId)) return "failed"; // the page is frozen: the dialog is the report
	// The page goes on with a look that ran out (it can't be cancelled), but the call does not wait.
	const got = await Promise.race([
		changeLook(tabId, MAX_NODES, before, hosts).catch(() => undefined),
		new Promise<undefined>((r) => setTimeout(() => r(undefined), LOOK_MS)),
	]);
	return got ?? "failed";
}

/** Before the action. `tabs` are the session's tabs then. */
export async function beforeAction(
	tabId: number,
	tabs: number[],
	target?: string,
	hosts: readonly string[] = [],
): Promise<Before> {
	const got = await look(tabId, hosts);
	const side = typeof got === "string" ? { miss: got } : { look: got };
	return { tabId, tabs: [...tabs], target, hosts, ...side };
}

/** The note for a report with a side missing: never "nothing changed", which would read as a failed action. */
const UNCOMPARED = "could not be compared; read_page shows it";
const TOO_LARGE = "too large to compare quickly; read_page shows it";

/**
 * After the action (and its settle wait): the report, or "nothing changed". `tabs` are the
 * session's tabs now and `urlOf` reads a tab's URL; `skip` is true for a page no tool may read
 * (the approval page), which then gets no look at all.
 */
export async function afterAction(
	b: Before,
	tabs: number[],
	urlOf: (tabId: number) => Promise<string>,
	skip: (url: string) => boolean,
): Promise<Record<string, unknown> | string> {
	const out: Record<string, unknown> = {};
	const opened = tabs.filter((t) => !b.tabs.includes(t));
	const closed = b.tabs.filter((t) => !tabs.includes(t));
	if (opened.length)
		out.tabsOpened = await Promise.all(
			opened.slice(0, 5).map(async (tabId) => ({ tabId, url: maskUrl(await urlOf(tabId).catch(() => "")) })),
		);
	if (closed.length) out.tabsClosed = closed;
	const gone = !tabs.includes(b.tabId);
	const url = gone ? "" : await urlOf(b.tabId).catch(() => "");
	// No second look when the first is missing: the report can't compare, and the action is not held longer.
	const got: ChangeLook | Miss =
		gone || !b.look
			? (b.miss ?? "failed")
			: skip(url)
				? "guarded"
				: await look(
						b.tabId,
						b.hosts,
						b.look.nodes.map((n) => n.ref),
					);
	if (typeof got === "string" || !b.look) {
		// A report is a diff of two real looks, or it says plainly that it isn't.
		if (!gone && !openDialog(b.tabId)) out.page = got === "large" ? TOO_LARGE : UNCOMPARED;
		return Object.keys(out).length ? out : "nothing changed";
	}
	const a = got;
	if (a.url !== b.look.url) out.url = a.url;
	if (a.title !== b.look.title) out.title = oneLine(a.title).slice(0, 120);
	const byRef = new Map(a.nodes.map((n) => [n.ref, n]));
	const named = (ref: string) => {
		const n = byRef.get(ref);
		return n ? `${n.ref} ${n.role.replace(/[^a-z-]/g, "") || "generic"} ${q(n.name)}` : "";
	};
	if (a.focus !== b.look.focus && !(a.focus && a.focus === b.target))
		out.focus = (a.focus && named(a.focus)) || "nothing listed";
	if (a.doc !== b.look.doc) {
		// A new document: every ref is new, so a list would be the page itself. read_page has it.
		out.page = `new page, ${a.nodes.length}${a.nodes.length >= MAX_NODES ? "+" : ""} controls; read_page lists them`;
		return out;
	}
	// Over the limit, which controls make the first MAX_NODES depends on the scroll: a list would
	// mostly name controls that did not change. Say so, and keep the rest of the report.
	if (a.nodes.length >= MAX_NODES || b.look.nodes.length >= MAX_NODES) {
		textChanges(b.look, a, new Set(), out);
		out.partial = `over ${MAX_NODES} controls, so they were not compared; read_page lists them`;
		return out;
	}
	const old = new Map(b.look.nodes.map((n) => [n.ref, n]));
	const appeared = a.nodes.filter((n) => !old.has(n.ref)).map(line);
	const changed = a.nodes.flatMap((n) => {
		const o = old.get(n.ref);
		const d = o && delta(o, n);
		return d ? [d] : [];
	});
	const goneSet = new Set(a.gone);
	const vanished = b.look.nodes.filter((n) => goneSet.has(n.ref)).map(line);
	let room = MAX_LINES;
	const take = (list: string[], key: string) => {
		if (!list.length) return;
		out[key] = list.slice(0, Math.max(0, room));
		room -= (out[key] as string[]).length;
		if (!(out[key] as string[]).length) delete out[key];
	};
	take(appeared, "appeared");
	take(changed, "changed");
	take(vanished, "gone");
	// A line that is just a listed control's name is already in the report.
	const listed = new Set(
		a.nodes.filter((n) => !old.has(n.ref) || delta(old.get(n.ref) as Node, n)).map((n) => n.name.trim()),
	);
	textChanges(b.look, a, listed, out);
	const more = appeared.length + changed.length + vanished.length - (MAX_LINES - room);
	if (more > 0) out.more = `${more} more; read_page lists them`;
	return Object.keys(out).length ? out : "nothing changed";
}

/** Text the action made appear (a status line, an error, a result), quoted like any page text. */
function textChanges(b: ChangeLook, a: ChangeLook, listed: Set<string>, out: Record<string, unknown>): void {
	const had = new Set(b.text.split("\n").map((l) => l.trim()));
	const added = [...new Set(a.text.split("\n").map((l) => l.trim()))].filter((l) => l && !had.has(l));
	const fresh = added.filter((l) => !listed.has(l));
	// Each line is one JSON string in the result: data, on one line, capped.
	if (fresh.length) out.newText = fresh.slice(0, MAX_TEXT_LINES).map((l) => oneLine(l).slice(0, TEXT_LINE_CHARS));
	// The count stays out of newText, where it would read as a line of the page.
	if (fresh.length > MAX_TEXT_LINES) out.moreText = fresh.length - MAX_TEXT_LINES;
	else if (!added.length && a.text !== b.text) out.text = "changed; get_page_text shows it";
}
