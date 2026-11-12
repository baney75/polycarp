/**
 * A file's text, split into the units the store keeps: pages for a PDF, slides for a PPTX, sheets for an XLSX, and
 * sections (at headings, about PART_CHARS characters at most) for DOCX, EPUB, HTML, Markdown and plain text. Pure: the
 * PDF, ZIP and spreadsheet libraries are passed in, so the tests run it in Node with the same libraries the extension
 * loads on first use (src/documents/libs.ts).
 */

export type UnitKind = "page" | "slide" | "sheet" | "section";
export type Format = "pdf" | "docx" | "xlsx" | "pptx" | "epub" | "html" | "markdown" | "text";

export interface ParsedUnit {
	/** A sheet's or section's name; empty for pages and untitled parts. */
	name: string;
	text: string;
}

export interface OutlineEntry {
	title: string;
	/** 1-based unit the entry points at. */
	unit: number;
	/** 1 for top level. */
	level: number;
}

export interface Parsed {
	format: Format;
	kind: UnitKind;
	title: string;
	units: ParsedUnit[];
	outline: OutlineEntry[];
}

/** Over these the get stops with a message, instead of filling the disk or hanging the panel. */
export const LIMITS = {
	bytes: 60 * 1024 * 1024,
	units: 5000,
	chars: 12_000_000,
	outline: 400,
};

export const PART_CHARS = 3000;

import { DocumentError } from "./errors.js";

export { DocumentError };

// ---- libraries -------------------------------------------------------------------------------

interface PdfTextItem {
	str?: string;
	hasEOL?: boolean;
}
interface PdfOutlineItem {
	title: string;
	dest: string | unknown[] | null;
	items?: PdfOutlineItem[];
}
export interface PdfJs {
	getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean }): {
		promise: Promise<{
			numPages: number;
			getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
			getOutline(): Promise<PdfOutlineItem[] | null>;
			getDestination(name: string): Promise<unknown[] | null>;
			getPageIndex(ref: unknown): Promise<number>;
			getMetadata(): Promise<{ info?: Record<string, unknown> }>;
			destroy(): Promise<void>;
		}>;
	};
}
export interface Zip {
	files: Record<string, unknown>;
	file(name: string): { async(type: "string"): Promise<string> } | null;
}
export interface ZipLib {
	loadAsync(data: Uint8Array): Promise<Zip>;
}
export interface SheetLib {
	read(data: Uint8Array, options: { type: "array" }): { SheetNames: string[]; Sheets: Record<string, unknown> };
	utils: { sheet_to_csv(sheet: unknown): string };
}
export interface Libs {
	pdfjs(): Promise<PdfJs>;
	zip(): Promise<ZipLib>;
	sheets(): Promise<SheetLib>;
}

// ---- what a file is --------------------------------------------------------------------------

const EXT: Record<string, Format> = {
	pdf: "pdf",
	docx: "docx",
	xlsx: "xlsx",
	xls: "xlsx",
	xlsm: "xlsx",
	ods: "xlsx",
	csv: "text",
	tsv: "text",
	pptx: "pptx",
	epub: "epub",
	html: "html",
	htm: "html",
	xhtml: "html",
	md: "markdown",
	markdown: "markdown",
	txt: "text",
	text: "text",
};

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const isPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;

/** The format from the bytes first (a PDF served as text/plain is still a PDF), then the type and the name. */
export function sniff(bytes: Uint8Array, name: string, mime: string): Format | undefined {
	const ext = name.toLowerCase().split(/[?#]/)[0].split(".").pop() ?? "";
	if (isPdf(bytes)) return "pdf";
	if (isZip(bytes)) {
		if (/^(docx|xlsx|xlsm|ods|pptx|epub)$/.test(ext)) return EXT[ext];
		if (mime.includes("wordprocessingml")) return "docx";
		if (mime.includes("spreadsheetml")) return "xlsx";
		if (mime.includes("presentationml")) return "pptx";
		if (mime.includes("epub")) return "epub";
		return undefined; // decided from the archive's contents
	}
	if (ext === "xls" || mime.includes("ms-excel")) return "xlsx";
	if (ext === "doc" || mime === "application/msword" || ext === "ppt") return undefined;
	if (EXT[ext] && !["docx", "xlsx", "pptx", "epub", "pdf"].includes(EXT[ext])) return EXT[ext];
	if (mime.includes("html")) return "html";
	if (mime.includes("markdown")) return "markdown";
	const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
	if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
	if (mime.startsWith("text/") || mime.includes("json") || mime.includes("xml")) return "text";
	// Mostly printable: text.
	const sample = bytes.subarray(0, 4096);
	let odd = 0;
	for (const b of sample) if (b < 9 || (b > 13 && b < 32)) odd++;
	return sample.length && odd / sample.length < 0.02 ? "text" : undefined;
}

const UNSUPPORTED =
	"This file type can't be read as text. Polycarp reads PDF, DOCX, XLSX, PPTX, EPUB, HTML, Markdown and plain text. An old .doc or .ppt file can be saved as .docx or .pptx first.";

export async function parseBytes(bytes: Uint8Array, name: string, mime: string, libs: Libs): Promise<Parsed> {
	if (bytes.byteLength > LIMITS.bytes)
		throw new DocumentError(`The file is ${mb(bytes.byteLength)}, over the ${mb(LIMITS.bytes)} documents can be.`);
	let format = sniff(bytes, name, mime);
	let zip: Zip | undefined;
	if (!format && isZip(bytes)) {
		zip = await (await libs.zip()).loadAsync(bytes);
		if (zip.file("word/document.xml")) format = "docx";
		else if (zip.file("xl/workbook.xml")) format = "xlsx";
		else if (zip.file("ppt/presentation.xml")) format = "pptx";
		else if (zip.file("META-INF/container.xml")) format = "epub";
	}
	if (!format) throw new DocumentError(UNSUPPORTED);
	const base = name.split(/[?#]/)[0].split("/").pop() || "document";
	let parsed: Parsed;
	switch (format) {
		case "pdf":
			parsed = await parsePdf(await libs.pdfjs(), bytes);
			break;
		case "xlsx":
			parsed = parseSheets(await libs.sheets(), bytes);
			break;
		case "docx":
			parsed = await parseDocx(zip ?? (await (await libs.zip()).loadAsync(bytes)));
			break;
		case "pptx":
			parsed = await parsePptx(zip ?? (await (await libs.zip()).loadAsync(bytes)));
			break;
		case "epub":
			parsed = await parseEpub(zip ?? (await (await libs.zip()).loadAsync(bytes)));
			break;
		default:
			parsed = parseText(new TextDecoder().decode(bytes), format);
	}
	if (!parsed.title) parsed.title = base.replace(/\.[a-z0-9]{1,5}$/i, "") || base;
	return checkLimits(parsed);
}

export function checkLimits(parsed: Parsed): Parsed {
	if (parsed.units.length > LIMITS.units)
		throw new DocumentError(
			`The document has ${parsed.units.length.toLocaleString("en-US")} ${parsed.kind}s, over the ${LIMITS.units.toLocaleString("en-US")} the store keeps.`,
		);
	const chars = parsed.units.reduce((n, u) => n + u.text.length, 0);
	if (chars > LIMITS.chars)
		throw new DocumentError(
			`The document has ${chars.toLocaleString("en-US")} characters of text, over the ${LIMITS.chars.toLocaleString("en-US")} the store keeps.`,
		);
	parsed.outline = parsed.outline.slice(0, LIMITS.outline);
	return parsed;
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

// ---- PDF -------------------------------------------------------------------------------------

export async function parsePdf(pdfjs: PdfJs, bytes: Uint8Array): Promise<Parsed> {
	// pdf.js takes ownership of the buffer it reads, so it gets a copy.
	const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: true }).promise;
	try {
		if (doc.numPages > LIMITS.units)
			throw new DocumentError(
				`The PDF has ${doc.numPages.toLocaleString("en-US")} pages, over the ${LIMITS.units.toLocaleString("en-US")} the store keeps.`,
			);
		const units: ParsedUnit[] = [];
		for (let n = 1; n <= doc.numPages; n++) {
			const content = await (await doc.getPage(n)).getTextContent();
			const text = content.items
				.map((i) => (i.str ?? "") + (i.hasEOL ? "\n" : ""))
				.join("")
				.replace(/[ \t]+\n/g, "\n")
				.replace(/\n{3,}/g, "\n\n")
				.trim();
			units.push({ name: "", text });
		}
		const outline: OutlineEntry[] = [];
		const walk = async (items: PdfOutlineItem[] | null | undefined, level: number) => {
			for (const item of items ?? []) {
				if (outline.length >= LIMITS.outline) return;
				let unit = 0;
				try {
					const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
					if (Array.isArray(dest) && dest[0] != null)
						unit = typeof dest[0] === "number" ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
				} catch {
					/* an entry that points nowhere keeps no page */
				}
				const title = clean(item.title);
				if (title && unit) outline.push({ title, unit, level });
				await walk(item.items, level + 1);
			}
		};
		await walk(await doc.getOutline().catch(() => null), 1);
		const info: { info?: Record<string, unknown> } = await doc.getMetadata().catch(() => ({}));
		const title = clean(String(info.info?.Title ?? ""));
		return { format: "pdf", kind: "page", title, units, outline };
	} finally {
		await doc.destroy();
	}
}

// ---- Office and EPUB -------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
		if (e[0] === "#") {
			const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
			return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
		}
		return ENTITIES[e.toLowerCase()] ?? all;
	});
}

const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

interface Block {
	/** Heading level 1-6, or 0 for body text. */
	level: number;
	text: string;
}

export async function parseDocx(zip: Zip): Promise<Parsed> {
	const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
	const blocks: Block[] = [];
	for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
		const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? "";
		const outline = /<w:outlineLvl w:val="(\d)"/.exec(p)?.[1];
		const heading = /^Title$/i.test(style)
			? 1
			: /heading\s*(\d)/i.exec(style)
				? Number(/heading\s*(\d)/i.exec(style)?.[1])
				: outline !== undefined
					? Number(outline) + 1
					: 0;
		let runs = "";
		for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>/g))
			runs += m[1] !== undefined ? m[1] : m[0].startsWith("<w:tab") ? "\t" : "\n";
		const text = decodeEntities(runs);
		if (text.trim()) blocks.push({ level: Math.min(6, heading), text: text.trim() });
	}
	const core = (await zip.file("docProps/core.xml")?.async("string")) ?? "";
	const title = clean(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? "");
	return { format: "docx", kind: "section", title, ...sectionize(blocks) };
}

export async function parsePptx(zip: Zip): Promise<Parsed> {
	const names = Object.keys(zip.files)
		.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
		.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
	const units: ParsedUnit[] = [];
	const outline: OutlineEntry[] = [];
	for (const name of names) {
		const xml = (await zip.file(name)?.async("string")) ?? "";
		const paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>|<a:p [\s\S]*?<\/a:p>/g) ?? [])
			.map((p) =>
				decodeEntities((p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => t.slice(5, -6)).join("")).trim(),
			)
			.filter(Boolean);
		units.push({ name: "", text: paras.join("\n") });
		if (paras[0]) outline.push({ title: paras[0].slice(0, 120), unit: units.length, level: 1 });
	}
	const core = (await zip.file("docProps/core.xml")?.async("string")) ?? "";
	const title = clean(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? "");
	return { format: "pptx", kind: "slide", title, units, outline };
}

export function parseSheets(lib: SheetLib, bytes: Uint8Array): Parsed {
	const book = lib.read(bytes, { type: "array" });
	const units: ParsedUnit[] = [];
	const outline: OutlineEntry[] = [];
	for (const name of book.SheetNames) {
		const csv = lib.utils
			.sheet_to_csv(book.Sheets[name])
			.replace(/(?:^|\n)(?:,*\n)+/g, "\n")
			.trim();
		const parts = split(csv, PART_CHARS * 2);
		outline.push({ title: name, unit: units.length + 1, level: 1 });
		for (const [i, text] of parts.entries())
			units.push({ name: parts.length > 1 ? `${name} (part ${i + 1})` : name, text });
	}
	return { format: "xlsx", kind: "sheet", title: "", units, outline };
}

export async function parseEpub(zip: Zip): Promise<Parsed> {
	const container = (await zip.file("META-INF/container.xml")?.async("string")) ?? "";
	const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
	const opf = opfPath ? ((await zip.file(opfPath)?.async("string")) ?? "") : "";
	if (!opf) throw new DocumentError("This EPUB has no table of contents file (OPF), so its chapters can't be found.");
	const dir = opfPath?.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
	const manifest = new Map<string, string>();
	for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
		const id = /\bid="([^"]+)"/.exec(m[0])?.[1];
		const href = /\bhref="([^"]+)"/.exec(m[0])?.[1];
		if (id && href) manifest.set(id, decodeURIComponent(href));
	}
	const blocks: Block[] = [];
	for (const m of opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/g)) {
		const href = manifest.get(m[1]);
		const html = href ? await zip.file(dir + href)?.async("string") : undefined;
		if (!html) continue;
		const chapter = htmlBlocks(html).blocks;
		// Each spine file starts a section, even without a heading of its own.
		if (chapter.length && chapter[0].level === 0) chapter.unshift({ level: 1, text: "" });
		blocks.push(...chapter);
	}
	const title = clean(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opf)?.[1] ?? "");
	return { format: "epub", kind: "section", title, ...sectionize(blocks) };
}

// ---- HTML, Markdown and text -----------------------------------------------------------------

/** Readable blocks of an HTML page: headings and paragraphs, without scripts, styles, navigation or forms. */
export function htmlBlocks(html: string): { title: string; blocks: Block[] } {
	const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
	const body = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|template|svg|head|nav|footer|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(br|hr)\b[^>]*>/gi, "\n")
		.replace(
			/<\/?(p|div|section|article|li|tr|table|ul|ol|blockquote|pre|figure|figcaption|dd|dt|main)\b[^>]*>/gi,
			"\n\n",
		)
		.replace(/<\/?t[dh]\b[^>]*>/gi, " | ")
		.replace(/<h([1-6])\b[^>]*>/gi, "\n\n\u0002$1")
		.replace(/<\/h[1-6]\s*>/gi, "\n\n")
		.replace(/<[^>]+>/g, "");
	const blocks: Block[] = [];
	for (const raw of decodeEntities(body).split(/\n\s*\n/)) {
		const text = raw
			.replace(/[ \t ]+/g, " ")
			.replace(/\n /g, "\n")
			.trim();
		if (!text) continue;
		const h = /^\u0002([1-6])\s*/.exec(text);
		if (h) blocks.push({ level: Number(h[1]), text: text.slice(h[0].length).replace(/\s+/g, " ") });
		else blocks.push({ level: 0, text: text.replace(/\u0002[1-6]/g, "") });
	}
	return { title, blocks };
}

export function parseText(text: string, format: "html" | "markdown" | "text" | Format): Parsed {
	if (format === "html") {
		const { title, blocks } = htmlBlocks(text);
		return { format: "html", kind: "section", title, ...sectionize(blocks) };
	}
	const blocks: Block[] = [];
	let title = "";
	for (const para of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
		const t = para.trim();
		if (!t) continue;
		const h = format === "markdown" ? /^(#{1,6})\s+(.+)$/.exec(t.split("\n")[0]) : null;
		if (h) {
			blocks.push({ level: h[1].length, text: h[2].replace(/#+\s*$/, "").trim() });
			if (!title && h[1].length === 1) title = h[2].trim();
			const rest = t.split("\n").slice(1).join("\n").trim();
			if (rest) blocks.push({ level: 0, text: rest });
		} else blocks.push({ level: 0, text: t });
	}
	return { format: format === "markdown" ? "markdown" : "text", kind: "section", title, ...sectionize(blocks) };
}

/** Units of at most about PART_CHARS characters, cut at paragraph, then line, then word breaks. */
export function split(text: string, size = PART_CHARS): string[] {
	const out: string[] = [];
	let rest = text.trim();
	while (rest.length > 0) {
		let cut = rest.length;
		if (rest.length > size * 1.3) {
			const window = rest.slice(0, size);
			const para = window.lastIndexOf("\n\n");
			const line = window.lastIndexOf("\n");
			const space = window.lastIndexOf(" ");
			cut = para > size / 2 ? para : line > size / 2 ? line : space > size / 2 ? space : size;
		}
		out.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trimStart();
	}
	return out;
}

/** Sections the size of a page: a heading starts one once the current one has some text, long ones are split. */
const MIN_SECTION = 600;

export function sectionize(blocks: Block[]): { units: ParsedUnit[]; outline: OutlineEntry[] } {
	const units: ParsedUnit[] = [];
	const outline: OutlineEntry[] = [];
	let name = "";
	let body: string[] = [];
	let size = 0;
	const flush = () => {
		const text = body.join("\n\n").trim();
		if (!text) return;
		const parts = split(text);
		for (const [i, t] of parts.entries())
			units.push({ name: name && parts.length > 1 && i ? `${name} (cont.)` : name, text: t });
		body = [];
		size = 0;
	};
	for (const b of blocks) {
		if (b.level > 0) {
			if (size >= MIN_SECTION || (b.level === 1 && size > 0)) {
				flush();
				name = b.text;
			} else if (!size) name = b.text || name;
			if (b.text) {
				outline.push({ title: b.text.slice(0, 160), unit: units.length + 1, level: b.level });
				body.push(b.text);
				size += b.text.length;
			}
			continue;
		}
		body.push(b.text);
		size += b.text.length;
		if (size > PART_CHARS * 1.3) {
			const keep = name;
			flush();
			name = keep;
		}
	}
	flush();
	return { units, outline };
}
