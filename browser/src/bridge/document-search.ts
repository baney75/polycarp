/**
 * get_page_text {query}: search the tab's PDF or page instead of reading it whole. A PDF comes back as its matching
 * pages, best first, with numbers and snippets (document-reader.ts, the same search as the panel's extract_document);
 * a page as its matching parts of about 3,000 characters, each with the offset that reads it. A PDF is read once per
 * URL and kept while the extension runs, so a second search or a page read after it costs no second parse.
 */
import { pageText } from "../browser/page.js";
import { isPdfTab, pdfText } from "../offscreen/pdf-client.js";
import { type ParsedDocument, parseExtracted, parsePdfPages, readSearch } from "../tools/document-reader.js";

const KEPT = 6;
const pdfs = new Map<string, ParsedDocument>();

/** Characters of a page's text a search reads: a whole long page, never an unbounded one. */
// The whole document is read for a search: the offscreen reader's own default (50,000 characters) would stop near page 23.
export const SEARCH_CHARS = 5_000_000;

export async function searchTab(
	tabId: number,
	selector: string | undefined,
	query: string,
	max: number,
): Promise<string> {
	const tab = await chrome.tabs.get(tabId);
	const url = (tab.url ?? "").split("#")[0];
	const title = tab.title || url;
	if (!selector && (await isPdfTab(tabId))) {
		let doc = pdfs.get(url);
		if (doc) pdfs.delete(url);
		else doc = parsePdfPages((await pdfText(url, SEARCH_CHARS)).text);
		while (pdfs.size >= KEPT) pdfs.delete(pdfs.keys().next().value as string);
		pdfs.set(url, doc);
		return readSearch(doc, title, query, max, url).text;
	}
	const text = (await pageText(tabId, selector, SEARCH_CHARS)).text;
	const doc = parseExtracted(text, "text");
	// Where each part starts in the page's text, so the hint's offset reads exactly that part.
	let at = 0;
	const starts = doc.units.map((u) => {
		const found = text.indexOf(u.text.slice(0, 60), at);
		at = found >= 0 ? found : at;
		return at;
	});
	return readSearch(
		doc,
		title,
		query,
		max,
		"",
		(top) =>
			`Read part ${top} in full with get_page_text offset ${starts[top - 1]} (where it starts) before you quote it.`,
	).text;
}
