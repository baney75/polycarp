// The PDF text get_page_text returns: every page marked, a page with no text layer said plainly, and a cut that says so.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const { pdfPages } = await import("../src/offscreen/pdf-pages.ts");

/** A small real PDF: one page of text per string, and an empty string for a page with no text (like a scan). */
function makePdf(pages) {
	const objects = [];
	const add = (body) => {
		objects.push(body);
		return objects.length;
	};
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const pagesId = objects.length + 1 + pages.length * 2;
	const kids = [];
	for (const text of pages) {
		const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
		const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
	}
	add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
	const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
	let out = "%PDF-1.4\n";
	const offsets = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

test("each page's text is marked with its number, and a page without a text layer is said to have none", async () => {
	const r = await pdfPages(pdfjs, makePdf(["The method works.", "", "Results on page three."]));
	assert.equal(r.pages, 3);
	assert.deepEqual(r.empty, [2]);
	assert.match(r.text, /--- Page 1 of 3 ---\nThe method works\./);
	assert.match(r.text, /--- Page 2 of 3 ---\n\(no text layer on this page\)/);
	assert.match(r.text, /--- Page 3 of 3 ---\nResults on page three\./);
	assert.equal(r.truncated, false);
});

test("a page range reads only those pages, and a cap says it cut", async () => {
	const pdf = makePdf(["One.", "Two.", "Three."]);
	const r = await pdfPages(pdfjs, pdf.slice(), 50000, 2, 2);
	assert.equal(r.text, "--- Page 2 of 3 ---\nTwo.");
	const cut = await pdfPages(pdfjs, pdf.slice(), 30);
	assert.equal(cut.truncated, true);
	assert.ok(cut.text.length <= 30);
});

test("a scan has no text on any page, which the caller turns into a plain warning", async () => {
	const r = await pdfPages(pdfjs, makePdf(["", ""]));
	assert.deepEqual(r.empty, [1, 2]);
});

test("a page past the end reads nothing and says how many there are", async () => {
	const r = await pdfPages(pdfjs, makePdf(["One."]), 50000, 40, 40);
	assert.equal(r.read, 0);
	assert.equal(r.pages, 1);
});

test("the built extension has pdf.js's worker where the hidden page looks for it", async () => {
	const { readFileSync } = await import("node:fs");
	const build = readFileSync(new URL("../scripts/build.mjs", import.meta.url), "utf8");
	// pdf-text.js is a top-level entry, and its worker URL is resolved next to it.
	assert.match(build, /"pdf-text": join\(packageRoot, "src\/offscreen\/pdf-text\.ts"\)/);
	assert.match(build, /join\(outDir, "pdfjs-dist\/build"\)/);
	const page = readFileSync(new URL("../src/offscreen/pdf-text.ts", import.meta.url), "utf8");
	assert.match(page, /new URL\("pdfjs-dist\/build\/pdf\.worker\.min\.mjs", import\.meta\.url\)/);
});

