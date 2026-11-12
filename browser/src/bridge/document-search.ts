/**
 * get_page_text {query}: search the tab's PDF or page instead of reading it whole. A PDF comes back as its matching
 * pages, best first, with numbers and snippets (document-reader.ts, the same search as the panel's extract_document);
 * a page as its matching parts of about 3,000 characters, each with the offset that reads it. A PDF read whole is kept
 * per URL while the extension runs, so a second search of it costs no second parse (a pages read parses its own range).
 */
import { pageText } from "../browser/page.js";
import { isPdfTab, pdfText } from "../offscreen/pdf-client.js";
import { type ParsedDocument, parseExtracted, parsePdfPages, readSearch } from "../tools/document-reader.js";

const KEPT = 6;
const pdfs = new Map<string, ParsedDocument>();

// The whole document is read for a search: the offscreen reader's own default (50,000 characters) would stop near page 23.
export const SEARCH_CHARS = 5_000_000;

export async function searchTab(
	tabId: number,
	selector: string | undefined,
	query: string,
	max: number,
	range: { first?: number; last?: number } = {},
): Promise<string> {
	const tab = await chrome.tabs.get(tabId);
	const url = (tab.url ?? "").split("#")[0];
	const title = tab.title || url;
	if (!selector && (await isPdfTab(tabId))) {
		const key = range.first || range.last ? `${url}#${range.first ?? 1}-${range.last ?? ""}` : url;
		let doc = pdfs.get(key);
		let note: string | undefined;
		if (doc) pdfs.delete(key);
		else {
			const pdf = await pdfText(url, SEARCH_CHARS, range.first, range.last);
			doc = parsePdfPages(pdf.text);
			// A text cut short is searched for what it holds, says so, and isn't kept as if it were the whole file.
			const lastRead = doc.units.at(-1)?.n ?? 0;
			const end = range.last ?? pdf.pages;
			if (pdf.truncated && lastRead < end)
				note = `Searched pages ${doc.units[0]?.n ?? 1}-${lastRead} of ${pdf.pages}: the text stopped there. Search the rest with get_page_text {"pages":"${lastRead}-${end}","query":${JSON.stringify(query)}}.`;
		}
		if (!note) {
			while (pdfs.size >= KEPT) pdfs.delete(pdfs.keys().next().value as string);
			pdfs.set(key, doc);
		}
		return readSearch(doc, title, query, max, url, { note }).text;
	}
	const text = (await pageText(tabId, selector, SEARCH_CHARS)).text;
	const doc = parseExtracted(text, "text");
	// Where each part starts in the text searched, so a hit's offset reads exactly that part. Parts are the text's own
	// slices, in order, so the next one starts past the end of this one: parts that open alike (table rows) each get their
	// own start.
	let at = 0;
	const starts = doc.units.map((u) => {
		const found = text.indexOf(u.text.slice(0, 60), at);
		const start = found >= 0 ? found : at;
		at = start + Math.max(1, u.text.length);
		return start;
	});
	// The offsets are into the selector's text, so the call that reads one names the selector too.
	const call = `get_page_text {${selector ? `"selector":${JSON.stringify(selector)},` : ""}"offset":N}`;
	return readSearch(doc, title, query, max, "", {
		label: (n) => `Part ${n} (offset ${starts[n - 1]})`,
		readOn: () => `Read a part in full with ${call}, N being the offset on its line, before you quote it.`,
		noHits: `read on through the text with ${call}`,
	}).text;
}
