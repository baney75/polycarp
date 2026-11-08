/**
 * The service worker's side of PDF reading: is a tab showing a PDF, and its text from the hidden page (pdf-text.ts, in the shared document of document.ts).
 */
import { ensureOffscreen } from "./document.js";
import type { PdfPages } from "./pdf-pages.js";

const PDF_TEXT_MESSAGE = "polycarp:pdf-text";

/** Chrome shows a PDF as a document of that type; a URL ending in .pdf is the fallback when the page can't be asked. */
export async function isPdfTab(tabId: number): Promise<boolean> {
	try {
		const [result] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.contentType });
		if (result?.result === "application/pdf") return true;
		if (typeof result?.result === "string") return false;
	} catch {
		/* the viewer can refuse scripts: fall back to the address */
	}
	const tab = await chrome.tabs.get(tabId);
	try {
		return new URL(tab.url ?? "").pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

export async function pdfText(
	url: string,
	maxChars?: number,
	firstPage?: number,
	lastPage?: number,
): Promise<PdfPages> {
	if (!/^https?:/i.test(url))
		throw new Error(
			"Only PDFs on the web can be read this way. For a file on this computer, open it from a web address or use screenshot.",
		);
	await ensureOffscreen();
	const answer = (await chrome.runtime.sendMessage({
		type: PDF_TEXT_MESSAGE,
		url,
		maxChars,
		first: firstPage,
		last: lastPage,
	})) as { ok: true; result: PdfPages } | { ok: false; error: string } | undefined;
	if (!answer) throw new Error("The PDF reader didn't answer. Try again.");
	if (!answer.ok) throw new Error(answer.error);
	return answer.result;
}
