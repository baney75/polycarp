/**
 * Paging for the bridge's read tools: each answers with a bounded part and says when it cut, with the call that reads
 * on. Pure, so the tests run it in Node. Notes name parameters only, never a tool: the same bridge serves the MCP tools
 * (get_page_text) and the pi extension's (browser_text), so "call again with offset N" is right for both.
 */

/** One console message or network URL is cut to this many characters. */
export const ENTRY_CHARS = 2000;
/** Entries read_console and read_network return by default. */
export const DEFAULT_ENTRIES = 100;
/** Characters a PDF read returns by default, as the PDF reader's own default. */
export const PDF_DEFAULT_CHARS = 50000;
/**
 * The most a text, HTML or PDF read returns in one call, whatever maxChars asks. It keeps an answer under the MCP
 * output cap (100,000 characters with its JSON), so the cap's head and tail cut never drops the middle of a part whose
 * note says to read on from its end.
 */
export const READ_MAX_CHARS = 50000;

/** maxChars as a read uses it: a positive number held to READ_MAX_CHARS; anything else (none, 0, negative) is `def`. */
export function readChars(value: unknown, def?: number): number | undefined {
	const n = Math.floor(Number(value));
	return Number.isFinite(n) && n > 0 ? Math.min(n, READ_MAX_CHARS) : def;
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** The fields a sliced page read adds: where it was cut, and the call for the rest. */
export function sliceInfo(slice: { text: string; offset: number; total: number }): {
	totalChars: number;
	offset?: number;
	truncated?: true;
	note?: string;
} {
	const end = slice.offset + slice.text.length;
	const info: { totalChars: number; offset?: number; truncated?: true; note?: string } = { totalChars: slice.total };
	if (slice.offset) info.offset = slice.offset;
	if (end < slice.total) {
		info.truncated = true;
		info.note = `Cut at character ${fmt(end)} of ${fmt(slice.total)}. For the rest, call again with offset ${end} (or a selector for one part).`;
	} else if (slice.offset > slice.total) {
		info.note = `offset ${fmt(slice.offset)} is past the end: there are ${fmt(slice.total)} characters.`;
	}
	return info;
}

/** A PDF read's window: `max` characters of the page stream from `offset`, from a read of offset + max characters. */
export function pdfWindow(
	pdf: { text: string; truncated: boolean },
	offset: number,
	max: number,
): { text: string; truncated: boolean; next?: number } {
	const text = pdf.text.slice(offset, offset + max);
	// More follows when the reader stopped at its cap or this window ends before what it read.
	const truncated = pdf.truncated || offset + text.length < pdf.text.length;
	// A window that read nothing names no offset to read on from: the same one would read nothing again.
	return { text, truncated, ...(truncated && text.length ? { next: offset + text.length } : {}) };
}

/** The note for a PDF read cut at its character cap: which page it stopped in and the offset that reads on exactly. */
export function pdfCutNote(text: string, first: number, next: number): string {
	const seen = [...text.matchAll(/--- Page (\d+) of \d+ ---/g)].map((m) => Number(m[1]));
	const stopped = seen.at(-1) ?? first;
	return `Cut inside page ${stopped} to fit. For the rest, call again with offset ${next} and the same pages.`;
}

/**
 * The newest entries, `limit` of them after skipping the newest `offset`, each with `field` cut to ENTRY_CHARS. Says
 * how many there are and how to read older ones (or, after clear, that they are gone).
 */
export function newestPage<T extends object>(
	entries: T[],
	params: Record<string, unknown>,
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
	if (start > 0) {
		const older = `${fmt(start)} older ${start === 1 ? "entry is" : "entries are"} not shown`;
		// clear empties the buffer as it reads, so the older entries are gone, not waiting on a later call.
		notes.push(
			params.clear === true
				? `${older}, and clear removed them: they can't be read again.`
				: `${older}: call again with offset ${entries.length - start} for them.`,
		);
	}
	if (cut) {
		const what = field === "url" ? ["URL was", "URLs were"] : ["message was", "messages were"];
		notes.push(`${cut} long ${cut === 1 ? what[0] : what[1]} cut to ${fmt(ENTRY_CHARS)} characters.`);
	}
	return { entries: page, total: entries.length, ...(notes.length ? { note: notes.join(" ") } : {}) };
}
