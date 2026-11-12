// Real files for the document store's tests, built in memory: a PDF (with an outline, pages of several lines, and pages
// with no text layer), DOCX, PPTX, EPUB and XLSX. The Nicomachean Ethics excerpts beside this file are F. H. Peters'
// 1893 translation (public domain, Project Gutenberg eBook 8438).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import * as XLSX from "xlsx";

const here = dirname(fileURLToPath(import.meta.url));

export function ethics(book) {
	return readFileSync(join(here, "ethics", `book-${book}.txt`), "utf8");
}

/** Pages of about `size` characters cut at paragraph breaks, the way a printed book's pages fall. */
export function pagesOf(text, size = 2500) {
	const out = [];
	let i = 0;
	while (i < text.length) {
		let j = Math.min(text.length, i + size);
		if (j < text.length) {
			const k = text.lastIndexOf("\n\n", j);
			if (k > i + size / 2) j = k;
		}
		out.push(text.slice(i, j).trim());
		i = j;
	}
	return out;
}

const ascii = (s) =>
	s
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[^\x20-\x7e\n]/g, "?");

function wrap(text, width = 95) {
	const lines = [];
	for (const para of ascii(text).split(/\n/)) {
		let line = "";
		for (const word of para.split(/\s+/).filter(Boolean)) {
			if (line && line.length + word.length + 1 > width) {
				lines.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		lines.push(line);
	}
	return lines;
}

/**
 * A real PDF: one page per string (an empty string is a page with no text layer, like a scan), an optional outline
 * of [title, page] entries, and an optional title in its metadata.
 */
export function makePdf(pages, { outline = [], title } = {}) {
	const objects = [];
	const add = (body) => {
		objects.push(body);
		return objects.length;
	};
	const reserve = () => add("");
	const catalog = reserve();
	const pagesId = reserve();
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids = [];
	for (const text of pages) {
		const lines = text ? wrap(text).map((l) => `(${l.replace(/([()\\])/g, "\\$1")}) Tj T*`) : [];
		const stream = lines.length ? `BT /F1 7 Tf 9 TL 20 770 Td\n${lines.join("\n")}\nET` : "";
		const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
	}
	objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let outlines = "";
	if (outline.length) {
		const root = reserve();
		const items = outline.map(() => reserve());
		outline.forEach(([t, page], i) => {
			const links = [`/Parent ${root} 0 R`];
			if (i > 0) links.push(`/Prev ${items[i - 1]} 0 R`);
			if (i < items.length - 1) links.push(`/Next ${items[i + 1]} 0 R`);
			objects[items[i] - 1] = `<< /Title (${t}) ${links.join(" ")} /Dest [${kids[page - 1]} 0 R /Fit] >>`;
		});
		objects[root - 1] = `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`;
		outlines = ` /Outlines ${root} 0 R`;
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R${outlines} >>`;
	const info = title ? add(`<< /Title (${title}) >>`) : 0;
	let out = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${info ? ` /Info ${info} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(out, "latin1"));
}

/** The three excerpts as one PDF "book", Book X's chapters in the outline. */
export function ethicsPdf() {
	const pages = [...pagesOf(ethics(1)), ...pagesOf(ethics(2)), ...pagesOf(ethics(10))];
	const start10 = pagesOf(ethics(1)).length + pagesOf(ethics(2)).length + 1;
	return { bytes: makePdf(pages, { title: "Nicomachean Ethics (excerpts)", outline: [["Book I", 1], ["Book II", pagesOf(ethics(1)).length + 1], ["Book X", start10]] }), pages };
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** paragraphs: strings, or [level, heading] for a heading. */
export async function makeDocx(paragraphs, title = "") {
	const zip = new JSZip();
	const body = paragraphs
		.map((p) =>
			Array.isArray(p)
				? `<w:p><w:pPr><w:pStyle w:val="Heading${p[0]}"/></w:pPr><w:r><w:t>${xmlEscape(p[1])}</w:t></w:r></w:p>`
				: `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r><w:r><w:tab/><w:t>end.</w:t></w:r></w:p>`,
		)
		.join("");
	zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
	zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
	if (title) zip.file("docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xmlEscape(title)}</dc:title></cp:coreProperties>`);
	return zip.generateAsync({ type: "uint8array" });
}

export async function makePptx(slides) {
	const zip = new JSZip();
	zip.file("ppt/presentation.xml", "<p:presentation/>");
	slides.forEach((lines, i) => {
		const paras = lines.map((l) => `<a:p><a:r><a:t>${xmlEscape(l)}</a:t></a:r></a:p>`).join("");
		zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
	});
	return zip.generateAsync({ type: "uint8array" });
}

/** chapters: [title, text] */
export async function makeEpub(title, chapters) {
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip");
	zip.file("META-INF/container.xml", '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
	const items = chapters.map((_, i) => `<item id="c${i + 1}" href="text/c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join("");
	const spine = chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join("");
	zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package><metadata><dc:title>${xmlEscape(title)}</dc:title></metadata><manifest>${items}</manifest><spine>${spine}</spine></package>`);
	chapters.forEach(([t, text], i) => {
		const paras = text.split(/\n\s*\n/).map((p) => `<p>${xmlEscape(p.trim())}</p>`).join("\n");
		zip.file(`OEBPS/text/c${i + 1}.xhtml`, `<html><head><title>${xmlEscape(t)}</title></head><body><h1>${xmlEscape(t)}</h1>${paras}</body></html>`);
	});
	return zip.generateAsync({ type: "uint8array" });
}

/** sheets: { name: rows[][] } */
export function makeXlsx(sheets) {
	const book = XLSX.utils.book_new();
	for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
	return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
}
