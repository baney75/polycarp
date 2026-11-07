/**
 * The text of a PDF, page by page, from its text layer. Pure: it takes pdf.js and the file's bytes, so a test can run it
 * in Node. A page with no text layer gets none: nothing here guesses from images.
 */

export interface PdfPages {
	pages: number;
	/** "--- Page N of M ---" before each page's text, cut at `maxChars`. */
	text: string;
	/** Pages whose text layer is empty, by number. */
	empty: number[];
	truncated: boolean;
	/** How many pages were read: the range asked for, inside the PDF. */
	read: number;
}

interface PdfJs {
	getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean }): {
		promise: Promise<{
			numPages: number;
			getPage(
				n: number,
			): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }> }>;
			destroy(): Promise<void>;
		}>;
	};
}

export async function pdfPages(
	pdfjs: PdfJs,
	data: Uint8Array,
	maxChars = 50000,
	first = 1,
	last = Number.POSITIVE_INFINITY,
): Promise<PdfPages> {
	const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
	try {
		const pages = doc.numPages;
		const from = Math.max(1, Math.floor(first));
		const to = Math.min(pages, Math.floor(last));
		let text = "";
		const empty: number[] = [];
		let truncated = false;
		for (let n = from; n <= to; n++) {
			const content = await (await doc.getPage(n)).getTextContent();
			const body = content.items
				.map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : ""))
				.join("")
				.replace(/[ \t]+\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			if (!body) empty.push(n);
			const block = `--- Page ${n} of ${pages} ---\n${body || "(no text layer on this page)"}\n\n`;
			if (text.length + block.length > maxChars) {
				text += block.slice(0, Math.max(0, maxChars - text.length));
				truncated = true;
				break;
			}
			text += block;
		}
		return { pages, text: text.trimEnd(), empty, truncated, read: Math.max(0, to - from + 1) };
	} finally {
		await doc.destroy();
	}
}
