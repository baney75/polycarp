/**
 * A hidden extension page that reads PDFs for `get_page_text`. A service worker can't start pdf.js's worker, so the service
 * worker asks this page (chrome.offscreen) instead. It fetches the PDF with the browser's sign-in, as the tab did, and answers
 * with its text, page by page.
 */
import { pdfPages } from "./pdf-pages.js";

export const PDF_TEXT_MESSAGE = "polycarp:pdf-text";

let pdfjs: Promise<typeof import("pdfjs-dist")> | undefined;
function loadPdfjs() {
	pdfjs ??= import("pdfjs-dist").then((lib) => {
		lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
		return lib;
	});
	return pdfjs;
}

const MAX_BYTES = 60 * 1024 * 1024;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
	if (msg?.type !== PDF_TEXT_MESSAGE || sender.id !== chrome.runtime.id) return false;
	(async () => {
		const res = await fetch(String(msg.url), { credentials: "include" });
		if (!res.ok) throw new Error(`The PDF answered ${res.status}.`);
		const size = Number(res.headers.get("content-length") ?? 0);
		if (size > MAX_BYTES) throw new Error(`The PDF is ${Math.round(size / 1048576)} MB, over the 60 MB this reads.`);
		const data = new Uint8Array(await res.arrayBuffer());
		if (data.byteLength > MAX_BYTES) throw new Error("The PDF is over the 60 MB this reads.");
		return pdfPages(
			(await loadPdfjs()) as unknown as Parameters<typeof pdfPages>[0],
			data,
			Number(msg.maxChars) || 50000,
			Number(msg.first) || 1,
			Number(msg.last) || Number.POSITIVE_INFINITY,
		);
	})().then(
		(result) => reply({ ok: true, result }),
		(err) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
	);
	return true;
});
