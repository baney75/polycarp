/**
 * Bounds on what the MCP tools hand an outside agent. A client caps a tool result too (Claude Code warns past about
 * 25,000 tokens), and one result over its window can end the agent's run, so each tool answers with a part and says
 * when it cut and how to read on. OUTPUT_CAP is the net under all of them. Limits are in the characters the result
 * carries: a string field inside JSON is measured as JSON writes it (encodedLength), so escaping never pushes a part
 * past the cap after its "read on from N" note was written.
 */
import { encodedHead, encodedLength } from "../../src/bridge/paging.ts";

/** No MCP text result is longer than this; a longer one keeps its head and tail. */
export const OUTPUT_CAP = 100000;
/** run_js values and page_markdown text return this much by default. */
export const VALUE_CHARS = 50000;
export const MARKDOWN_CHARS = 40000;
/** crawl shows each page's markdown up to this, and up to this in all, so its JSON stays whole under OUTPUT_CAP. */
export const CRAWL_PAGE_CHARS = 3000;
export const CRAWL_TOTAL_CHARS = 60000;

const fmt = (n: number) => n.toLocaleString("en-US");

/** Head and tail of `text` within `max`, and a line in the middle that says what was left out and how to get it. */
export function capOutput(text: string, max = OUTPUT_CAP, hint = "Ask for a smaller part: a selector, a range, an offset or a filter."): string {
	if (text.length <= max) return text;
	const notice = (dropped: number) => `\n\n[Polycarp left out ${fmt(dropped)} of ${fmt(text.length)} characters here. ${hint}]\n\n`;
	const room = Math.max(0, max - notice(text.length).length);
	const head = Math.ceil(room * 0.7);
	const tail = room - head;
	return `${text.slice(0, head)}${notice(text.length - head - tail)}${tail ? text.slice(-tail) : ""}`;
}

/**
 * A JSON value as text within `max`, still valid JSON: the longest string fields are cut first (each says how much it
 * lost), then the longest arrays lose their tail. Only a value with nothing left to cut falls back to capOutput.
 */
export function capJson(value: unknown, max = OUTPUT_CAP): string {
	let json = JSON.stringify(value) ?? "null";
	if (json.length <= max) return json;
	const copy = JSON.parse(json) as unknown;
	type Slot = { holder: Record<string, unknown> | unknown[]; key: string | number; size: number };
	const largest = (want: "string" | "array"): Slot | undefined => {
		let best: Slot | undefined;
		const visit = (v: unknown) => {
			if (!v || typeof v !== "object") return;
			const holder = v as Record<string, unknown> | unknown[];
			for (const [k, child] of Object.entries(holder)) {
				const key = Array.isArray(holder) ? Number(k) : k;
				const size = want === "string" ? (typeof child === "string" ? encodedLength(child) : -1) : Array.isArray(child) ? child.length : -1;
				if (size > (best?.size ?? 0)) best = { holder, key, size };
				visit(child);
			}
		};
		if (want === "array" && Array.isArray(copy) && copy.length > (best?.size ?? 0)) best = { holder: [copy], key: 0, size: copy.length };
		visit(copy);
		return best;
	};
	for (let round = 0; round < 200 && json.length > max; round++) {
		const over = json.length - max;
		const str = largest("string");
		if (str && str.size > 300) {
			const text = (str.holder as Record<string | number, string>)[str.key];
			const kept = encodedHead(text, Math.max(100, str.size - over - 120));
			(str.holder as Record<string | number, unknown>)[str.key] = `${kept} [cut: ${fmt(text.length - kept.length)} more characters, to fit the result]`;
		} else {
			const arr = largest("array");
			if (!arr || arr.size < 2) break;
			const list = (arr.holder as Record<string | number, unknown[]>)[arr.key];
			const keep = Math.max(1, Math.floor(list.length / 2));
			list.splice(keep, list.length - keep, `[${fmt(list.length - keep)} more items left out, to fit the result]`);
		}
		json = JSON.stringify(copy);
	}
	return json.length <= max ? json : capOutput(json, max);
}

/**
 * `max` characters of `text` from `offset`, with a line after them when there is more: the call that reads on.
 * `again` names it, for example "call run_js again with offset". `encoded` measures the part as a JSON string field
 * carries it (page_markdown returns an object), so a page of quotes or backslashes still fits.
 */
export function sliceText(text: string, offset: number | undefined, max: number, again: string, encoded = false): string {
	const from = Math.max(0, Math.floor(offset ?? 0));
	if (from >= text.length && from > 0) return `[offset ${fmt(from)} is past the end: there are ${fmt(text.length)} characters.]`;
	const part = encoded ? encodedHead(text.slice(from, from + max), max) : text.slice(from, from + max);
	const end = from + part.length;
	const head = from ? `[Characters ${fmt(from)} to ${fmt(end)} of ${fmt(text.length)}.]\n` : "";
	const tail = end < text.length ? `\n\n[Cut at character ${fmt(end)} of ${fmt(text.length)}. For the rest, ${again} ${end}.]` : "";
	return `${head}${part}${tail}`;
}

/**
 * A crawl result with each page's markdown cut to CRAWL_PAGE_CHARS and all of it to CRAWL_TOTAL_CHARS, every URL
 * kept, and a note on how to read a page in full.
 */
export function capCrawl(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const data = (result as { data?: unknown }).data;
	if (!Array.isArray(data)) return result;
	let cut = 0;
	let omitted = 0;
	let left = CRAWL_TOTAL_CHARS;
	const pages = data.map((page) => {
		if (!page || typeof page !== "object") return page;
		const md = (page as { markdown?: unknown }).markdown;
		if (typeof md !== "string") return page;
		if (left <= 0 && md) {
			omitted++;
			const { markdown: _md, ...rest } = page as Record<string, unknown>;
			return { ...rest, markdown_left_out: md.length };
		}
		// In the characters the JSON carries: a page of backslashes or newlines takes twice its length.
		const max = Math.min(CRAWL_PAGE_CHARS, left);
		const kept = encodedHead(md, max);
		left -= encodedLength(kept);
		if (kept.length === md.length) return page;
		cut++;
		return { ...page, markdown: `${kept}\n[cut: ${fmt(md.length - kept.length)} more characters]` };
	});
	if (!cut && !omitted) return result;
	const notes = [
		cut ? `${cut} page${cut === 1 ? "'s" : "s'"} markdown cut to ${fmt(CRAWL_PAGE_CHARS)} characters or less.` : "",
		omitted ? `${omitted} page${omitted === 1 ? "'s" : "s'"} markdown left out: the crawl's ${fmt(CRAWL_TOTAL_CHARS)} characters were used up (markdown_left_out gives each one's length).` : "",
	].filter(Boolean);
	return {
		...(result as object),
		data: pages,
		note: `${notes.join(" ")} Read one in full with page_markdown and its URL (it takes offset).`,
	};
}

/**
 * A read_page snapshot cut to its caps, with a note when it was. The caller asks the page for one more element and one
 * more character than it shows, so a cut is known, not guessed from a list that happens to be exactly full. The text
 * comes from read_page's own extraction, whose offsets don't match get_page_text's, so the note names no offset.
 */
export function fitSnapshot<S extends { nodes: unknown[]; text: string }>(snap: S, maxNodes: number, maxTextChars: number): { snap: S; note: string } {
	const notes: string[] = [];
	let out = snap;
	if (snap.nodes.length > maxNodes) {
		out = { ...out, nodes: snap.nodes.slice(0, maxNodes) };
		notes.push(`The element list stopped at ${fmt(maxNodes)}: use find for what you need, filter "interactive", or a larger maxNodes.`);
	}
	if (snap.text.length > maxTextChars) {
		out = { ...out, text: snap.text.slice(0, maxTextChars) };
		notes.push(`The text stopped at ${fmt(maxTextChars)} characters: get_page_text reads all of it, in parts, from the top.`);
	}
	return { snap: out, note: notes.length ? `\n\n[${notes.join(" ")}]` : "" };
}

/** A ranked interactive read's counts (src/browser/page.ts pageSnapshot). */
export interface RankCounts {
	total: number;
	covered: number;
	first: number;
	inView: number;
	near: number;
	far: number;
	offset: number;
	/** Names the ranking a later slice continues (src/browser/page.ts); absent from an extension before it. */
	snapshot?: string;
}

/**
 * The line under a ranked interactive read: which slice this is, what was left out and the exact call for more, so a
 * model that needs a control further down knows it exists and how to get it.
 */
export function rankNote(r: RankCounts, shown: number, text: { maxTextChars: number; cut: boolean } = { maxTextChars: 0, cut: false }): string {
	const from = r.offset + 1;
	const to = r.offset + shown;
	const tiers = [
		r.first ? `${fmt(r.first)} focused or in a dialog` : "",
		`${fmt(r.inView)} in view`,
		r.near ? `${fmt(r.near)} within a screen` : "",
		r.far ? `${fmt(r.far)} further away` : "",
	].filter(Boolean);
	const parts = [
		shown === 0
			? `No controls from ${fmt(from)} on (${fmt(r.total)} in all).`
			: to < r.total || r.offset
				? `Controls ${fmt(from)}-${fmt(to)} of ${fmt(r.total)}, nearest first (${tiers.join(", ")}).`
				: `All ${fmt(r.total)} controls (${tiers.join(", ")}).`,
	];
	if (r.covered) parts.push(`${fmt(r.covered)} covered by something on top are left out: close or dismiss it first.`);
	const more = r.snapshot ? `{"filter":"interactive","offset":${to},"snapshot":"${r.snapshot}"}` : `{"filter":"interactive","offset":${to}}`;
	if (to < r.total) parts.push(`More: read_page ${more}, or find {"query":"..."} for one.`);
	// The text is said as it is: none asked for, cut at the cap, or whole (then nothing to add).
	if (!text.maxTextChars) parts.push("No page text here: get_page_text reads it.");
	else if (text.cut) parts.push(`The text stopped at ${fmt(text.maxTextChars)} characters: get_page_text reads all of it.`);
	return `\n\n[${parts.join(" ")}]`;
}

/**
 * The UTF-8 sequence that starts at byte `i`: its length in bytes and the UTF-16 units it decodes to. A byte that
 * doesn't start a valid sequence (a Latin-1 byte, a stray continuation byte, a cut-off sequence) is one unit, U+FFFD,
 * as TextDecoder reads it: the bytes of the longest valid start of a sequence go together.
 */
function sequenceAt(all: Uint8Array, i: number): { bytes: number; units: number } {
	const b = all[i];
	if (b < 0x80) return { bytes: 1, units: 1 };
	const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;
	if (!need) return { bytes: 1, units: 1 };
	// The second byte's range narrows for some leads (no overlong forms, no surrogates, nothing past U+10FFFF).
	const low = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
	const high = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;
	let n = 1;
	for (; n <= need && i + n < all.length; n++) {
		const c = all[i + n];
		if (n === 1 ? c < low || c > high : (c & 0xc0) !== 0x80) break;
	}
	if (n <= need) return { bytes: n, units: 1 };
	return { bytes: need + 1, units: need === 3 ? 2 : 1 };
}

/** `i`, or the end of the valid UTF-8 sequence `i` falls inside: a window never starts or ends inside a character. */
function boundaryAt(all: Uint8Array, i: number): number {
	for (let back = 1; back <= 3 && i - back >= 0; back++) {
		const lead = all[i - back];
		if ((lead & 0xc0) === 0x80) continue;
		const { bytes } = sequenceAt(all, i - back);
		return i - back + bytes > i ? i - back + bytes : i;
	}
	return i;
}

/**
 * A window of UTF-8 bytes as text: at most `maxBytes` from `offset` and at most `maxChars` characters, both ends on a
 * character boundary, so no character is split and `end` is the exact offset that reads on. Bytes that are not
 * UTF-8 are counted as TextDecoder reads them, one character each, so `end` holds for a Latin-1 file too.
 */
export function utf8Window(all: Uint8Array, offset: number, maxBytes: number, maxChars: number): { text: string; from: number; end: number } {
	const from = boundaryAt(all, Math.min(Math.max(0, Math.floor(offset)), all.length));
	const limit = Math.min(all.length, from + Math.max(1, maxBytes));
	let end = from;
	let units = 0;
	while (end < all.length) {
		const { bytes, units: u } = sequenceAt(all, end);
		// A limit smaller than one character still reads that character, so a reader always moves on.
		if (end > from && (end + bytes > limit || units + u > maxChars)) break;
		end += bytes;
		units += u;
	}
	return { text: new TextDecoder().decode(all.subarray(from, end)), from, end };
}
