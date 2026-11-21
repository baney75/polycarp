// A real PDF for the e2e tests, built in memory: the bridge and the panel read it with pdf.js like any other.

/** A real PDF of `pages` pages, uncompressed, with `line(n, i)` as the text of line i on page n. */
export function makePdf(pages, linesPerPage, line) {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	const kids = [];
	for (let n = 1; n <= pages; n++) {
		const lines = Array.from({ length: linesPerPage }, (_, i) => `(${line(n, i).replace(/[()\\]/g, "")}) Tj T*`).join("\n");
		const stream = `BT /F1 7 Tf 9 TL 20 770 Td\n${lines}\nET`;
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length} 0 R >>`);
		kids.push(`${objects.length} 0 R`);
	}
	objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
	let out = "%PDF-1.4\n";
	const offsets = objects.map((body, i) => {
		const at = out.length;
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
		return at;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

/** Pages of Book VIII, on friendship, in ethicsPdf(); page 300 holds FAR_LINE, which no search for friendship reaches. */
export const FRIENDSHIP_PAGES = [231, 236];
export const FAR_LINE = "FAR-SENTINEL-7Q: courage is a mean with regard to fear and confidence.";

/** A 400-page stand-in for the Nicomachean Ethics, the size of the book that broke the chat. */
export function ethicsPdf() {
	const filler = "Virtue is a settled state of character concerned with choice, lying in a mean relative to us.";
	return makePdf(400, 20, (n, i) => {
		if (n === 300 && i === 0) return FAR_LINE;
		if (n === FRIENDSHIP_PAGES[0] && i === 0) return "BOOK VIII. Friendship is a virtue, or implies virtue, and is most necessary for our life.";
		if (n >= FRIENDSHIP_PAGES[0] && n <= FRIENDSHIP_PAGES[1]) return `The friend is another self; the friendship of good men alike in virtue is perfect, line ${i}.`;
		return `Page ${n} line ${i}. ${filler}`;
	});
}
