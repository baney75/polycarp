/**
 * Paging for the bridge's read tools: each answers with a bounded part and says when it cut, with the call that reads
 * on. Pure, so the tests run it in Node.
 */

/** One console message or network URL is cut to this many characters. */
export const ENTRY_CHARS = 2000;
/** Entries read_console and read_network return by default. */
export const DEFAULT_ENTRIES = 100;

const fmt = (n: number) => n.toLocaleString("en-US");

/** The fields a sliced page read adds: where it was cut, and the call for the rest. */
export function sliceInfo(
	slice: { text: string; offset: number; total: number },
	tool: "get_page_text" | "get_page_html",
): { totalChars: number; offset?: number; truncated?: true; note?: string } {
	const end = slice.offset + slice.text.length;
	const info: { totalChars: number; offset?: number; truncated?: true; note?: string } = { totalChars: slice.total };
	if (slice.offset) info.offset = slice.offset;
	if (end < slice.total) {
		info.truncated = true;
		info.note = `Cut at character ${fmt(end)} of ${fmt(slice.total)}. For the rest, call ${tool} with offset ${end} (or a selector for one part).`;
	} else if (slice.offset > slice.total) {
		info.note = `offset ${fmt(slice.offset)} is past the end: there are ${fmt(slice.total)} characters.`;
	}
	return info;
}

/** The note for a PDF read cut at its character cap: which page it stopped in and the range that reads on. */
export function pdfCutNote(text: string, first: number, last: number): string {
	const seen = [...text.matchAll(/--- Page (\d+) of \d+ ---/g)].map((m) => Number(m[1]));
	const stopped = seen.at(-1) ?? first;
	const next = stopped < last ? `"${stopped}-${last}"` : `"${stopped}"`;
	return `Cut inside page ${stopped} to fit. For the rest, call get_page_text with pages ${next}, or fewer pages at a time.`;
}

/**
 * The newest entries, `limit` of them after skipping the newest `offset`, each with `field` cut to ENTRY_CHARS. Says
 * how many there are and how to read older ones.
 */
export function newestPage<T extends object>(
	entries: T[],
	params: Record<string, unknown>,
	tool: "read_console" | "read_network",
	field: keyof T & string,
): { entries: T[]; total: number; note?: string } {
	const limit = Math.max(1, Math.floor(Number(params.limit) || DEFAULT_ENTRIES));
	const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
	const end = Math.max(0, entries.length - offset);
	const start = Math.max(0, end - limit);
	let cut = 0;
	const page = entries.slice(start, end).map((e) => {
		const value = (e as Record<string, unknown>)[field];
		if (typeof value !== "string" || value.length <= ENTRY_CHARS) return e;
		cut++;
		return {
			...e,
			[field]: `${value.slice(0, ENTRY_CHARS)} [cut: ${fmt(value.length - ENTRY_CHARS)} more characters]`,
		};
	});
	const notes: string[] = [];
	if (start > 0)
		notes.push(
			`${fmt(start)} older ${start === 1 ? "entry is" : "entries are"} not shown: call ${tool} with offset ${entries.length - start} for them.`,
		);
	if (cut) {
		const what = field === "url" ? ["URL was", "URLs were"] : ["message was", "messages were"];
		notes.push(`${cut} long ${cut === 1 ? what[0] : what[1]} cut to ${fmt(ENTRY_CHARS)} characters.`);
	}
	return { entries: page, total: entries.length, ...(notes.length ? { note: notes.join(" ") } : {}) };
}
