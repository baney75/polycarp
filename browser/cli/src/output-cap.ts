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
/** crawl shows each page's markdown up to this. */
export const CRAWL_PAGE_CHARS = 3000;

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

/** A crawl result with each page's markdown cut to CRAWL_PAGE_CHARS, the URL kept, and a note on how to read one. */
export function capCrawl(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const data = (result as { data?: unknown }).data;
	if (!Array.isArray(data)) return result;
	let cut = 0;
	const pages = data.map((page) => {
		if (!page || typeof page !== "object") return page;
		const md = (page as { markdown?: unknown }).markdown;
		if (typeof md !== "string" || md.length <= CRAWL_PAGE_CHARS) return page;
		cut++;
		return { ...page, markdown: `${md.slice(0, CRAWL_PAGE_CHARS)}\n[cut: ${fmt(md.length - CRAWL_PAGE_CHARS)} more characters]` };
	});
	if (!cut) return result;
	return {
		...(result as object),
		data: pages,
		note: `${cut} page${cut === 1 ? "'s" : "s'"} markdown cut to ${fmt(CRAWL_PAGE_CHARS)} characters. Read one in full with page_markdown and its URL (it takes offset).`,
	};
}

/** read_page's note when the element list or the text was cut, with how to read on. */
export function snapshotCutNote(snap: { nodes: unknown[]; text: string }, maxNodes: number, maxTextChars: number): string {
	const notes: string[] = [];
	if (snap.nodes.length >= maxNodes)
		notes.push(`The element list stopped at ${fmt(maxNodes)}: use find for what you need, filter "interactive", or a larger maxNodes.`);
	if (maxTextChars > 0 && snap.text.length >= maxTextChars)
		notes.push(`The text stopped at ${fmt(maxTextChars)} characters: get_page_text with offset ${maxTextChars} reads on.`);
	return notes.length ? `\n\n[${notes.join(" ")}]` : "";
}
