/**
 * The text of a document, read in parts that fit a budget: a range of pages, a search, or the first pages with a note
 * that says what was left out. Pure (no fetch, no parsers), so the tests run it in Node; extract-document.ts fetches
 * and parses with pi-web-ui's loadAttachment and hands the text here.
 *
 * Units are what the format has: pages for a PDF, slides for a PPTX, sheets for an XLSX. A DOCX (and plain text) has
 * no pages in its text, so it is split into parts of about PART_CHARS characters at paragraph breaks.
 */

export type UnitKind = "page" | "slide" | "sheet" | "part";

export interface DocUnit {
	/** 1-based. */
	n: number;
	/** A sheet's name; empty otherwise. */
	name: string;
	text: string;
}

export interface ParsedDocument {
	format: string;
	kind: UnitKind;
	units: DocUnit[];
	totalChars: number;
}

/** A DOCX or text file is cut into parts of about this many characters. */
export const PART_CHARS = 3000;

const decode = (s: string) =>
	s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");

function splitParts(text: string): DocUnit[] {
	const units: DocUnit[] = [];
	let rest = text.trim();
	while (rest.length > 0) {
		let cut = rest.length;
		if (rest.length > PART_CHARS * 1.3) {
			// The last paragraph break, else line break, else space, in the back half of a part.
			const window = rest.slice(0, PART_CHARS);
			const at = window.lastIndexOf("\n\n");
			const line = window.lastIndexOf("\n");
			const space = window.lastIndexOf(" ");
			cut = at > PART_CHARS / 2 ? at : line > PART_CHARS / 2 ? line : space > PART_CHARS / 2 ? space : PART_CHARS;
		}
		units.push({ n: units.length + 1, name: "", text: rest.slice(0, cut).trim() });
		rest = rest.slice(cut).trimStart();
	}
	return units;
}

/** Units from loadAttachment's text: `<page number="N">`, `<slide number="N">`, `<sheet name="X" index="N">`. */
export function parseExtracted(extracted: string, format: string): ParsedDocument {
	let kind: UnitKind = "part";
	let units: DocUnit[] = [];
	if (format === "pdf" || format === "pptx") {
		const tag = format === "pdf" ? "page" : "slide";
		const re = new RegExp(`<${tag} number="(\\d+)">\\n?([\\s\\S]*?)\\n?</${tag}>`, "g");
		for (const m of extracted.matchAll(re)) units.push({ n: Number(m[1]), name: "", text: m[2].trim() });
		if (units.length) kind = tag;
	} else if (format === "xlsx") {
		const re = /<sheet name="([^"]*)" index="(\d+)">\n?([\s\S]*?)\n?<\/sheet>/g;
		for (const m of extracted.matchAll(re)) units.push({ n: Number(m[2]), name: decode(m[1]), text: m[3].trim() });
		if (units.length) kind = "sheet";
	}
	if (!units.length) {
		// DOCX wraps everything in one page; plain text has no wrapper at all.
		const body = extracted
			.replace(/^\s*<(docx|pdf|pptx|excel)[^>]*>\s*/, "")
			.replace(/\s*<\/(docx|pdf|pptx|excel)>\s*$/, "")
			.replace(/^\s*<page number="1">\s*/, "")
			.replace(/\s*<\/page>\s*$/, "");
		units = splitParts(body);
		kind = "part";
	}
	const totalChars = units.reduce((n, u) => n + u.text.length, 0);
	return { format, kind, units, totalChars };
}

/** A PDF as the bridge reads it ("--- Page N of M ---" before each page), as pages. */
export function parsePdfPages(text: string): ParsedDocument {
	const units: DocUnit[] = [];
	for (const m of text.matchAll(/--- Page (\d+) of \d+ ---\n([\s\S]*?)(?=--- Page \d+ of \d+ ---|$)/g)) {
		const body = m[2].trim();
		units.push({ n: Number(m[1]), name: "", text: body === "(no text layer on this page)" ? "" : body });
	}
	return { format: "pdf", kind: "page", units, totalChars: units.reduce((n, u) => n + u.text.length, 0) };
}

/** The readable text of an HTML page a URL serves: scripts, styles and tags out, each block on its own line. */
export function htmlText(html: string): string {
	return decode(
		html
			.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(
				/<\/?(p|div|br|li|h[1-6]|tr|section|article|blockquote|pre|table|ul|ol|header|footer|main)\b[^>]*>/gi,
				"\n",
			)
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/g, " ")
			.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))),
	)
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\n[ \n]*/g, (gap) => (gap.split("\n").length > 2 ? "\n\n" : "\n"))
		.trim();
}

const KIND_WORD: Record<UnitKind, [string, string]> = {
	page: ["Page", "pages"],
	slide: ["Slide", "slides"],
	sheet: ["Sheet", "sheets"],
	part: ["Part", "parts"],
};

function header(doc: ParsedDocument, u: DocUnit): string {
	const [word] = KIND_WORD[doc.kind];
	const name = u.name ? ` "${u.name}"` : "";
	return `--- ${word} ${u.n}${name} of ${doc.units.length} ---`;
}

export interface Range {
	first: number;
	last: number;
}

/** "40-55", "40", "p. 40-55", "40 to 55" (an en dash too). Undefined when it isn't a range. */
export function parseRange(spec: string, count: number): Range | undefined {
	const m = /^\s*(?:pp?\.?\s*)?(\d+)\s*(?:(?:-|\u2013|\u2014|to|through)\s*(\d+|end))?\s*$/i.exec(spec);
	if (!m) return undefined;
	const first = Number(m[1]);
	const last = m[2] === undefined ? first : m[2].toLowerCase() === "end" ? count : Number(m[2]);
	if (first < 1 || last < first) return undefined;
	return { first, last: Math.min(last, count) };
}

/** Units in a range, joined with their headers. */
function joinUnits(doc: ParsedDocument, units: DocUnit[]): string {
	return units.map((u) => `${header(doc, u)}\n${u.text || "(no text on this one)"}`).join("\n\n");
}

export interface ReadResult {
	text: string;
}

const fmt = (x: number) => x.toLocaleString("en-US");

function summaryLine(doc: ParsedDocument, fileName: string): string {
	const [, plural] = KIND_WORD[doc.kind];
	const sizeNote = doc.kind === "part" ? ` (parts of about ${fmt(PART_CHARS)} characters)` : "";
	return `${fileName}: ${doc.format.toUpperCase()}, ${fmt(doc.units.length)} ${plural}${sizeNote}, ${fmt(doc.totalChars)} characters of text.`;
}

function emptyNote(doc: ParsedDocument): string {
	if (doc.kind !== "page") return "";
	const empty = doc.units.filter((u) => !u.text).map((u) => u.n);
	if (!empty.length) return "";
	if (empty.length === doc.units.length)
		return "\nThis PDF has no text layer (a scan or images of pages): read it on screen with a screenshot instead.";
	const list = empty.length > 12 ? `${empty.slice(0, 12).join(", ")} and ${empty.length - 12} more` : empty.join(", ");
	return `\n${KIND_WORD[doc.kind][1]} with no text layer (images): ${list}.`;
}

/**
 * A range of units, from character `offset` of the range's text, cut at `budget` characters with a note naming the
 * exact next call.
 */
export function readRange(
	doc: ParsedDocument,
	fileName: string,
	range: Range,
	offset: number,
	budget: number,
): ReadResult {
	const [word, plural] = KIND_WORD[doc.kind];
	const units = doc.units.filter((u) => u.n >= range.first && u.n <= range.last);
	if (!units.length)
		return {
			text: `${summaryLine(doc, fileName)}\nThere is no ${word.toLowerCase()} ${range.first}: this document has ${doc.units.length} ${plural}.`,
		};
	const all = joinUnits(doc, units);
	const start = Math.max(0, Math.min(offset, all.length));
	const head = `${summaryLine(doc, fileName)}\n${plural[0].toUpperCase()}${plural.slice(1)} ${range.first === range.last ? range.first : `${range.first}-${range.last}`}${start ? `, from character ${fmt(start)}` : ""}:\n\n`;
	// The note on how to read on matters more than the last of the body: a tight budget shortens the body, never the note.
	const room = Math.max(100, budget - head.length - 400);
	const body = all.slice(start, start + room);
	const end = start + body.length;
	let note = "";
	if (end < all.length) {
		const spec = range.first === range.last ? `${range.first}` : `${range.first}-${range.last}`;
		note = `\n\n[Cut here to fit the model's context: ${fmt(all.length - end)} more characters in this range. For the rest, call extract_document with pages "${spec}" and offset ${end}, or a smaller range.]`;
	}
	return { text: `${head}${body}${note}` };
}

/** Sheets the overview names; the rest are counted. */
const SHEET_LIST = 30;

/** The first units up to the budget, with what was left out and how to get it. */
export function readOverview(doc: ParsedDocument, fileName: string, budget: number): ReadResult {
	const [word, plural] = KIND_WORD[doc.kind];
	const sheetList =
		doc.kind === "sheet"
			? `\nSheets: ${doc.units
					.slice(0, SHEET_LIST)
					.map((u) => `${u.n} "${u.name.slice(0, 80)}" (${fmt(u.text.length)} characters)`)
					.join(
						", ",
					)}${doc.units.length > SHEET_LIST ? `, and ${fmt(doc.units.length - SHEET_LIST)} more (read one with pages)` : ""}.`
			: "";
	const head = `${summaryLine(doc, fileName)}${sheetList}${emptyNote(doc)}\n\n`;
	const room = Math.max(100, budget - head.length - 600);
	let body = "";
	let lastWhole = 0;
	for (const u of doc.units) {
		const block = `${body ? "\n\n" : ""}${header(doc, u)}\n${u.text || "(no text on this one)"}`;
		if (body.length + block.length > room) {
			if (!body) body = block.slice(0, room);
			break;
		}
		body += block;
		lastWhole = u.n;
	}
	const shown = Math.min(body.length, doc.totalChars);
	if (lastWhole === doc.units.length) return { text: `${head}${body}` };
	const next = lastWhole + 1;
	const span = Math.max(1, lastWhole);
	const note = `\n\n[This is only the start. ${lastWhole ? `${lastWhole > 1 ? `${plural[0].toUpperCase()}${plural.slice(1)} 1-${lastWhole}` : `${word} 1`} of ${doc.units.length} shown` : `Part of ${word.toLowerCase()} 1 shown`}; ${fmt(Math.max(0, doc.totalChars - shown))} characters left out to fit the model's context. To read on, call extract_document with pages "${next}-${Math.min(doc.units.length, next + span - 1)}". To find a passage, call it with query and a few words from it: that returns the matching ${plural} with their numbers.]`;
	return { text: `${head}${body}${note}` };
}

// ---- search ----------------------------------------------------------------------------------

const STOP = new Set(
	"a an and are as at be but by do does doesn't dont don't for from has have he her his how i if in into is it its me my no not of on or our she so that the their them then there these they this to was we were what when where which who why will with you your says say said where page find go show".split(
		" ",
	),
);

/** A crude stem: enough that "contemplation", "contemplative" and "contemplate" meet. */
export function stem(word: string): string {
	let w = word.toLowerCase();
	for (const suffix of [
		"ations",
		"ation",
		"ative",
		"ively",
		"ingly",
		"ness",
		"ment",
		"ions",
		"ion",
		"ing",
		"ive",
		"ies",
		"ed",
		"es",
		"ly",
		"al",
		"s",
		"e",
	]) {
		if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
			w = w.slice(0, -suffix.length);
			break;
		}
	}
	return w;
}

export function queryTerms(query: string): string[] {
	const words = query.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
	const terms = words.filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
	return [...new Set(terms)];
}

export interface Hit {
	n: number;
	score: number;
	snippet: string;
}

const WORD = /[\p{L}\p{N}']+/gu;

/**
 * Units ranked for a query: each term that appears counts (rarer terms more), a unit with every term near each other
 * more, the exact phrase most. The snippet is the best window around the terms.
 */
export function searchDocument(doc: ParsedDocument, query: string, limit = 5): { terms: string[]; hits: Hit[] } {
	const terms = queryTerms(query);
	if (!terms.length) return { terms, hits: [] };
	const phrase = query.toLowerCase().replace(/\s+/g, " ").trim();
	const tokenized = doc.units.map((u) => {
		const positions = new Map<string, number[]>();
		for (const m of u.text.matchAll(WORD)) {
			const s = stem(m[0]);
			for (const t of terms) {
				if (s === t || (t.length >= 5 && s.startsWith(t)) || (s.length >= 5 && t.startsWith(s))) {
					const list = positions.get(t) ?? [];
					list.push(m.index ?? 0);
					positions.set(t, list);
				}
			}
		}
		return positions;
	});
	const df = new Map<string, number>();
	for (const p of tokenized) for (const t of p.keys()) df.set(t, (df.get(t) ?? 0) + 1);
	const N = doc.units.length;
	const hits: Hit[] = [];
	doc.units.forEach((u, i) => {
		const pos = tokenized[i];
		if (!pos.size) return;
		let score = 0;
		for (const [t, list] of pos) score += (1 + Math.log(list.length)) * Math.log(1 + N / (df.get(t) ?? 1));
		// The tightest window of 300 characters: how many distinct terms it holds.
		const all = [...pos].flatMap(([t, list]) => list.map((at) => ({ t, at }))).sort((a, b) => a.at - b.at);
		let best = { distinct: 0, at: all[0]?.at ?? 0 };
		for (let a = 0, b = 0; b < all.length; b++) {
			while (all[b].at - all[a].at > 300) a++;
			const distinct = new Set(all.slice(a, b + 1).map((x) => x.t)).size;
			if (distinct > best.distinct) best = { distinct, at: all[a].at };
		}
		score *= 1 + best.distinct / terms.length;
		if (pos.size === terms.length) score *= 1.5;
		const lower = u.text.toLowerCase();
		const exact = phrase.length > 8 ? lower.indexOf(phrase) : -1;
		if (exact >= 0) {
			score *= 3;
			best.at = exact;
		}
		const from = Math.max(0, best.at - 80);
		const raw = u.text
			.slice(from, from + 280)
			.replace(/\s+/g, " ")
			.trim();
		hits.push({ n: u.n, score, snippet: `${from > 0 ? "..." : ""}${raw}${from + 280 < u.text.length ? "..." : ""}` });
	});
	hits.sort((a, b) => b.score - a.score || a.n - b.n);
	return { terms, hits: hits.slice(0, limit) };
}

/** The search as the model reads it: ranked units with numbers and snippets, and the next steps. */
export function readSearch(
	doc: ParsedDocument,
	fileName: string,
	query: string,
	budget: number,
	url = "",
	readOn?: (top: number) => string,
): ReadResult {
	const [word, plural] = KIND_WORD[doc.kind];
	const { terms, hits } = searchDocument(doc, query, 8);
	const head = `${summaryLine(doc, fileName)}\nSearch: ${JSON.stringify(query)}${terms.length ? ` (words: ${terms.join(", ")})` : ""}\n`;
	if (!terms.length)
		return {
			text: `${head}No words to search for: give a few distinctive words from the passage.`,
		};
	if (!hits.length)
		return {
			text: `${head}No ${word.toLowerCase()} has these words. Try other words the author would use (a synonym, the original term), or read a range with pages.${emptyNote(doc)}`,
		};
	const lines = hits.map((h, i) => `${i + 1}. ${word} ${h.n}: ${h.snippet}`);
	const top = hits[0].n;
	const open =
		doc.kind === "page" && /^https?:/i.test(url)
			? ` To show the user the page, navigate to ${url.split("#")[0]}#page=${top} (Chrome's PDF viewer opens at that page).`
			: "";
	const read =
		readOn?.(top) ??
		`Read a ${word.toLowerCase()} in full with pages (like "${top}" or "${Math.max(1, top - 1)}-${Math.min(doc.units.length, top + 1)}") before you quote it.`;
	const tail = `\n\nBest match first. ${read}${open}`;
	let text = `${head}\nMatching ${plural}:\n${lines.join("\n")}${tail}`;
	if (text.length > budget) text = `${text.slice(0, Math.max(0, budget - 40))}\n[more matches cut]`;
	return { text };
}
