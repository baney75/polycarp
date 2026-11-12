/**
 * The document store's parsers (src/documents/parse.ts) load PDF.js, JSZip and SheetJS the first time a document comes
 * in, not when the panel or the offscreen page opens. The side panel loads the store itself the same way: the first
 * document tool call or a look at Settings > Privacy > Documents brings it in.
 */
import type { Libs, PdfJs, SheetLib, ZipLib } from "../documents/parse.js";
import type { DocumentService } from "../documents/service.js";

let pdfjs: Promise<PdfJs> | undefined;

function loadPdfjs(): Promise<PdfJs> {
	pdfjs ??= import("pdfjs-dist").then(
		(lib) => {
			lib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
			return lib as unknown as PdfJs;
		},
		(error) => {
			// An update can replace the extension's files under an open page. Let the next try load the new ones.
			pdfjs = undefined;
			throw error;
		},
	);
	return pdfjs;
}

export const documentLibs: Libs = {
	pdfjs: loadPdfjs,
	zip: () => import("jszip").then((lib) => lib.default as unknown as ZipLib),
	sheets: () => import("xlsx").then((lib) => lib as unknown as SheetLib),
};

/** The side panel's document store, over IndexedDB, downloading through `proxy()` when a site can't be reached. */
export async function openDocumentStore(proxy: () => string | undefined): Promise<DocumentService> {
	const [{ DocumentService }, { IdbBackend }, { download }] = await Promise.all([
		import("../documents/service.js"),
		import("../documents/store.js"),
		import("../documents/fetch.js"),
	]);
	return new DocumentService({
		backend: new IdbBackend(),
		libs: documentLibs,
		fetch: (url, signal) => download(url, signal, proxy()),
	});
}
