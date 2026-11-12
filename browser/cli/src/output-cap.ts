/**
 * Bounds on what the MCP tools hand an outside agent. A client caps a tool result too (Claude Code warns past about
 * 25,000 tokens), and one result over its window can end the agent's run, so each tool answers with a part and says
 * when it cut and how to read on. OUTPUT_CAP is the net under all of them.
 */

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
 * `max` characters of `text` from `offset`, with a line after them when there is more: the call that reads on.
 * `again` names it, for example "call run_js again with offset".
 */
export function sliceText(text: string, offset: number | undefined, max: number, again: string): string {
	const from = Math.max(0, Math.floor(offset ?? 0));
	if (from >= text.length && from > 0) return `[offset ${fmt(from)} is past the end: there are ${fmt(text.length)} characters.]`;
	const part = text.slice(from, from + max);
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
		const max = Math.min(CRAWL_PAGE_CHARS, left);
		left -= Math.min(md.length, max);
		if (md.length <= max) return page;
		cut++;
		return { ...page, markdown: `${md.slice(0, max)}\n[cut: ${fmt(md.length - max)} more characters]` };
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

/**
 * A window of UTF-8 bytes as text: at most `maxBytes` from `offset` and at most `maxChars` characters, both ends on a
 * character boundary, so no character is split and `end` is the exact offset that reads on.
 */
export function utf8Window(all: Uint8Array, offset: number, maxBytes: number, maxChars: number): { text: string; from: number; end: number } {
	const cont = (i: number) => i < all.length && (all[i] & 0xc0) === 0x80;
	let from = Math.min(Math.max(0, Math.floor(offset)), all.length);
	while (cont(from)) from++;
	let end = Math.min(all.length, from + Math.max(1, maxBytes));
	while (end > from && cont(end)) end--;
	// A limit smaller than one character still reads that character, so a reader always moves on.
	if (end === from && from < all.length) {
		end++;
		while (cont(end)) end++;
	}
	let text = new TextDecoder().decode(all.subarray(from, end));
	if (text.length > maxChars) {
		let cut = maxChars;
		const code = text.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) cut--;
		text = text.slice(0, cut);
		end = from + new TextEncoder().encode(text).length;
	}
	return { text, from, end };
}
