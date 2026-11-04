/**
 * OpenDocument reading for the preview. Text documents (.odt) become a flow of paragraphs,
 * lists, tables and images; presentations (.odp) become the same slide model the pptx
 * preview draws. Styles resolve through automatic styles, named styles and their parents.
 * Pure: no DOM. Links to files outside the package are never followed.
 */
import { browserImageMime, PREVIEW_LIMITS, SafeZip } from "./content.js";
import { autoNumberLabel, type Fill, type Line, type ParaStyle, type RunStyle } from "./drawingml.js";
import {
	type Box,
	type Deck,
	fitRow,
	type PictureElement,
	type ShapeElement,
	type Slide,
	type SlideElement,
	type TableElement,
	type TextBody,
	type TextParagraph,
} from "./pptx.js";
import { attr, child, children, parseXml, type XmlElement, type XmlNode } from "./xml.js";

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const EMU_PER: Record<string, number> = { cm: 360000, mm: 36000, in: 914400, pt: 12700, pc: 152400, px: 9525 };

/** A length such as "2.5cm" in EMU, or undefined. */
export function lengthToEmu(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const m = /^\s*(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?\s*$/.exec(value);
	if (!m) return undefined;
	const n = Number(m[1]);
	if (!Number.isFinite(n)) return undefined;
	return n * EMU_PER[m[2] ?? "pt"];
}

export function lengthToPt(value: string | undefined): number | undefined {
	const emu = lengthToEmu(value);
	return emu === undefined ? undefined : emu / 12700;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

interface StyleDef {
	name: string;
	family: string;
	parent?: string;
	listStyle?: string;
	props: Record<string, Record<string, string>>;
}

interface ListLevel {
	bullet?: string;
	numFormat?: string;
	numPrefix?: string;
	numSuffix?: string;
	start?: number;
	/** EMU from the frame edge to the text. */
	indent?: number;
	/** EMU reserved for the bullet or number. */
	labelWidth?: number;
	color?: string;
	fontSizePct?: number;
}

export class OdfStyles {
	private named = new Map<string, StyleDef>();
	private auto = new Map<string, StyleDef>();
	private defaults = new Map<string, StyleDef>();
	readonly lists = new Map<string, ListLevel[]>();
	readonly fonts = new Map<string, string>();
	readonly masters = new Map<string, XmlElement>();
	readonly pageLayouts = new Map<string, StyleDef>();

	addDocument(root: XmlElement | undefined, kind: "styles" | "content") {
		if (!root) return;
		for (const f of children(child(root, "office:font-face-decls"), "style:font-face")) {
			const name = attr(f, "style:name");
			const family = attr(f, "svg:font-family");
			if (name && family) this.fonts.set(name, family.replace(/^['"]|['"]$/g, ""));
		}
		this.addStyles(child(root, "office:styles"), this.named);
		this.addStyles(child(root, "office:automatic-styles"), kind === "content" ? this.auto : this.named);
		// Automatic styles in styles.xml (used by master pages) live with the named ones.
		for (const m of children(child(root, "office:master-styles"), "style:master-page")) {
			const name = attr(m, "style:name");
			if (name) this.masters.set(name, m);
		}
	}

	private addStyles(container: XmlElement | undefined, target: Map<string, StyleDef>) {
		for (const s of children(container)) {
			if (s.name === "text:list-style") {
				this.addList(s);
				continue;
			}
			if (s.name !== "style:style" && s.name !== "style:default-style" && s.name !== "style:page-layout") continue;
			const props: Record<string, Record<string, string>> = {};
			for (const p of children(s)) {
				if (p.local.endsWith("-properties")) props[p.local] = { ...p.attrs };
				// A graphic style can carry its own list style (presentation outlines).
				if (p.local === "graphic-properties") {
					const list = child(p, "text:list-style");
					if (list) this.addList(list, `__graphic:${attr(s, "style:name")}`);
				}
			}
			const def: StyleDef = {
				name: attr(s, "style:name") ?? "",
				family: attr(s, "style:family") ?? "",
				parent: attr(s, "style:parent-style-name"),
				listStyle: attr(s, "style:list-style-name"),
				props,
			};
			if (s.name === "style:default-style") this.defaults.set(def.family, def);
			else if (s.name === "style:page-layout") this.pageLayouts.set(def.name, def);
			else target.set(`${def.family}:${def.name}`, def);
		}
	}

	private addList(el: XmlElement, nameOverride?: string) {
		const name = nameOverride ?? attr(el, "style:name");
		if (!name) return;
		const levels: ListLevel[] = [];
		for (const lvl of children(el)) {
			const level = Number(attr(lvl, "text:level") ?? "1") - 1;
			if (level < 0 || level > 9) continue;
			const props = child(lvl, "style:list-level-properties");
			const align = child(props, "style:list-level-label-alignment");
			const indent =
				(lengthToEmu(attr(props, "text:space-before")) ?? 0) +
					(lengthToEmu(attr(props, "text:min-label-width")) ?? 0) || lengthToEmu(attr(align, "fo:margin-left"));
			const labelWidth = lengthToEmu(attr(props, "text:min-label-width"));
			const text = child(lvl, "style:text-properties");
			const pct = /^([\d.]+)%$/.exec(attr(text, "fo:font-size") ?? "");
			const color = attr(text, "fo:color");
			if (lvl.local === "list-level-style-bullet") {
				levels[level] = {
					bullet: attr(lvl, "text:bullet-char") ?? "\u2022",
					indent,
					labelWidth,
					color: color && color !== "#000000" ? color : undefined,
					fontSizePct: pct ? Number(pct[1]) / 100 : undefined,
				};
			} else if (lvl.local === "list-level-style-number") {
				levels[level] = {
					numFormat: attr(lvl, "style:num-format") ?? "1",
					numPrefix: attr(lvl, "style:num-prefix") ?? "",
					numSuffix: attr(lvl, "style:num-suffix") ?? "",
					start: Number(attr(lvl, "text:start-value") ?? "1") || 1,
					indent,
					labelWidth,
				};
			} else {
				levels[level] = { indent };
			}
		}
		this.lists.set(name, levels);
	}

	find(family: string, name: string | undefined): StyleDef | undefined {
		if (!name) return undefined;
		return this.auto.get(`${family}:${name}`) ?? this.named.get(`${family}:${name}`);
	}

	/** Properties of one kind (e.g. "text-properties") merged from the default style up through the parents. */
	resolve(family: string, name: string | undefined, kind: string): Record<string, string> {
		const chain: StyleDef[] = [];
		let cur = this.find(family, name);
		const seen = new Set<string>();
		while (cur && !seen.has(cur.name) && chain.length < 32) {
			seen.add(cur.name);
			chain.unshift(cur);
			cur = this.find(family, cur.parent);
		}
		const out: Record<string, string> = { ...(this.defaults.get(family)?.props[kind] ?? {}) };
		for (const s of chain) Object.assign(out, s.props[kind] ?? {});
		return out;
	}

	/** Font size in points, following percentages up the parent chain. */
	fontSize(family: string, name: string | undefined, base = 12): number {
		const chain: StyleDef[] = [];
		let cur = this.find(family, name);
		const seen = new Set<string>();
		while (cur && !seen.has(cur.name) && chain.length < 32) {
			seen.add(cur.name);
			chain.unshift(cur);
			cur = this.find(family, cur.parent);
		}
		let size = sizeFrom(this.defaults.get(family)?.props["text-properties"]?.["fo:font-size"], base);
		for (const s of chain) size = sizeFrom(s.props["text-properties"]?.["fo:font-size"], size);
		return size;
	}

	listStyleOf(family: string, name: string | undefined): string | undefined {
		let cur = this.find(family, name);
		const seen = new Set<string>();
		// At most 32 ancestors, as in resolve() and fontSize().
		while (cur && !seen.has(cur.name) && seen.size < 32) {
			seen.add(cur.name);
			if (cur.listStyle) return cur.listStyle;
			if (this.lists.has(`__graphic:${cur.name}`)) return `__graphic:${cur.name}`;
			cur = this.find(family, cur.parent);
		}
		return undefined;
	}
}

function sizeFrom(value: string | undefined, base: number): number {
	if (!value) return base;
	const pct = /^([\d.]+)%$/.exec(value);
	if (pct) return (base * Number(pct[1])) / 100;
	return lengthToPt(value) ?? base;
}

const COLUMN_GROUPS = new Set(["table:table-columns", "table:table-header-columns", "table:table-column-group"]);
const ROW_GROUPS = new Set(["table:table-rows", "table:table-row-group"]);

/** A table's columns, including those inside column groups, in order. */
function tableColumns(table: XmlElement): XmlElement[] {
	const out: XmlElement[] = [];
	for (const c of children(table)) {
		if (c.name === "table:table-column") out.push(c);
		else if (COLUMN_GROUPS.has(c.name)) out.push(...children(c, "table:table-column"));
	}
	return out;
}

/** A table's rows, header rows first, then the body rows and grouped rows in order. */
function tableRows(table: XmlElement): XmlElement[] {
	const header: XmlElement[] = [];
	const body: XmlElement[] = [];
	for (const c of children(table)) {
		if (c.name === "table:table-row") body.push(c);
		else if (c.name === "table:table-header-rows") header.push(...children(c, "table:table-row"));
		else if (ROW_GROUPS.has(c.name)) body.push(...children(c, "table:table-row"));
	}
	return [...header, ...body];
}

/** A row or column span from the file, kept between 1 and `max`. */
function clampSpan(v: string | undefined, max: number): number {
	return Math.max(1, Math.min(Number(v ?? "1") || 1, max));
}

function colorValue(v: string | undefined): string | undefined {
	if (!v || v === "transparent") return undefined;
	return /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined;
}

/** RunStyle from text properties, with `size` already resolved. */
export function runStyleFrom(props: Record<string, string>, size: number, styles: OdfStyles): RunStyle {
	const s: RunStyle = { size };
	if (props["fo:font-weight"] === "bold" || Number(props["fo:font-weight"]) >= 600) s.bold = true;
	if (props["fo:font-style"] === "italic" || props["fo:font-style"] === "oblique") s.italic = true;
	const ul = props["style:text-underline-style"];
	if (ul && ul !== "none") s.underline = true;
	const lt = props["style:text-line-through-style"];
	if (lt && lt !== "none") s.strike = true;
	const color = colorValue(props["fo:color"]);
	if (color) s.color = color;
	if (props["style:use-window-font-color"] === "true" && !color) s.color = undefined;
	const font = props["style:font-name"]
		? (styles.fonts.get(props["style:font-name"]) ?? props["style:font-name"])
		: props["fo:font-family"];
	if (font) s.font = font.replace(/^['"]|['"]$/g, "");
	const pos = props["style:text-position"];
	if (pos) {
		if (pos.startsWith("super")) s.baseline = 30;
		else if (pos.startsWith("sub")) s.baseline = -25;
		else {
			const m = /^(-?[\d.]+)%/.exec(pos);
			if (m && Number(m[1]) !== 0) s.baseline = Number(m[1]);
		}
	}
	if (props["fo:text-transform"] === "uppercase") s.caps = "all";
	if (props["fo:font-variant"] === "small-caps") s.caps = "small";
	const bg = colorValue(props["fo:background-color"]);
	if (bg) s.highlight = bg;
	return s;
}

const ALIGN: Record<string, string> = { start: "l", left: "l", center: "ctr", end: "r", right: "r", justify: "just" };

function paraStyleFrom(props: Record<string, string>, run: RunStyle): ParaStyle {
	const s: ParaStyle = { run };
	const align = ALIGN[props["fo:text-align"] ?? ""];
	if (align) s.align = align;
	const ml = lengthToEmu(props["fo:margin-left"]);
	if (ml !== undefined) s.marL = ml;
	const ti = lengthToEmu(props["fo:text-indent"]);
	if (ti !== undefined) s.indent = ti;
	const mt = lengthToPt(props["fo:margin-top"]);
	if (mt !== undefined) s.spaceBefore = mt;
	const mb = lengthToPt(props["fo:margin-bottom"]);
	if (mb !== undefined) s.spaceAfter = mb;
	const lh = props["fo:line-height"];
	const pct = lh ? /^([\d.]+)%$/.exec(lh) : null;
	if (pct) s.lineSpacing = Number(pct[1]) / 100;
	else if (lh && lh !== "normal") {
		const pts = lengthToPt(lh);
		if (pts) s.lineSpacingPts = pts;
	}
	return s;
}

// ---------------------------------------------------------------------------
// Inline text
// ---------------------------------------------------------------------------

export type OdfRun =
	| { text: string; style: RunStyle; href?: string }
	| { br: true }
	| { image: string; width?: number; height?: number };

interface InlineContext {
	styles: OdfStyles;
	images: Set<string>;
	zip: SafeZip;
	budget: TextBudget;
}

/** Runs and characters a whole document may still produce. */
interface TextBudget {
	runs: number;
	chars: number;
	exhausted: boolean;
}

function newBudget(): TextBudget {
	return { runs: PREVIEW_LIMITS.maxTextRuns, chars: PREVIEW_LIMITS.maxTextChars, exhausted: false };
}

function pushRun(ctx: InlineContext, out: OdfRun[], run: OdfRun) {
	const b = ctx.budget;
	if (b.runs <= 0 || b.chars <= 0) {
		b.exhausted = true;
		return;
	}
	b.runs--;
	if ("text" in run) b.chars -= run.text.length;
	out.push(run);
}

/** Collapse ODF whitespace: runs of spaces, tabs and newlines in text become one space. */
function collapse(text: string): string {
	return text.replace(/[ \t\r\n]+/g, " ");
}

function readInline(
	nodes: XmlNode[],
	family: string,
	styleName: string | undefined,
	base: RunStyle,
	ctx: InlineContext,
	out: OdfRun[],
	href?: string,
) {
	for (const n of nodes) {
		if (ctx.budget.exhausted) return;
		if (typeof n === "string") {
			const t = collapse(n);
			if (t) pushRun(ctx, out, { text: t, style: base, href });
			continue;
		}
		switch (n.name) {
			case "text:span": {
				const name = attr(n, "text:style-name");
				const props = ctx.styles.resolve("text", name, "text-properties");
				const size = ctx.styles.find("text", name)
					? sizeFrom(props["fo:font-size"], base.size ?? 12)
					: (base.size ?? 12);
				const style = { ...base, ...definedRun(runStyleFrom(props, size, ctx.styles)) };
				readInline(n.children, family, styleName, style, ctx, out, href);
				break;
			}
			case "text:a": {
				const link = attr(n, "xlink:href");
				readInline(
					n.children,
					family,
					styleName,
					{ ...base, underline: true, color: base.color ?? "#1155cc" },
					ctx,
					out,
					link && /^(https?:|mailto:)/i.test(link) ? link : undefined,
				);
				break;
			}
			case "text:s": {
				const c = Math.min(100, Number(attr(n, "text:c") ?? "1") || 1);
				pushRun(ctx, out, { text: " ".repeat(c), style: base, href });
				break;
			}
			case "text:tab":
				pushRun(ctx, out, { text: "\t", style: base, href });
				break;
			case "text:line-break":
				pushRun(ctx, out, { br: true });
				break;
			case "draw:frame": {
				const img = frameImage(n, ctx);
				if (img) pushRun(ctx, out, img);
				else {
					const box = child(n, "draw:text-box");
					if (box) for (const p of children(box)) readInline(p.children, family, styleName, base, ctx, out, href);
				}
				break;
			}
			case "text:note": {
				const cite = child(n, "text:note-citation");
				if (cite) pushRun(ctx, out, { text: collapse(textContent(cite)), style: { ...base, baseline: 30 } });
				break;
			}
			case "office:annotation":
			case "office:annotation-end":
			case "text:bookmark":
			case "text:bookmark-start":
			case "text:bookmark-end":
			case "text:soft-page-break":
			case "text:reference-mark-start":
			case "text:reference-mark-end":
			case "text:sequence-ref":
				break;
			default:
				// Fields (page number, date, title) and unknown inline wrappers: show their text.
				readInline(n.children, family, styleName, base, ctx, out, href);
		}
	}
}

function definedRun(r: RunStyle): RunStyle {
	const out: RunStyle = {};
	for (const [k, v] of Object.entries(r) as [keyof RunStyle, RunStyle[keyof RunStyle]][]) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function textContent(el: XmlElement): string {
	let s = "";
	for (const c of el.children) s += typeof c === "string" ? c : textContent(c);
	return s;
}

function frameImage(frame: XmlElement, ctx: InlineContext): OdfRun | undefined {
	const img = child(frame, "draw:image");
	const href = attr(img, "xlink:href");
	if (!img || !href) return undefined;
	const path = href.replace(/^\.\//, "");
	// Only pictures inside the package; never a URL.
	if (/^[a-z]+:/i.test(path) || path.startsWith("/") || path.includes("..")) return undefined;
	if (!browserImageMime(path) || !ctx.zip.has(path)) return undefined;
	ctx.images.add(path);
	return {
		image: path,
		width: lengthToPt(attr(frame, "svg:width")),
		height: lengthToPt(attr(frame, "svg:height")),
	};
}

// ---------------------------------------------------------------------------
// Text documents
// ---------------------------------------------------------------------------

export interface OdtParagraph {
	kind: "para";
	heading?: number;
	style: ParaStyle;
	background?: string;
	runs: OdfRun[];
}

export interface OdtList {
	kind: "list";
	ordered: boolean;
	start: number;
	bullet?: string;
	items: OdtBlock[][];
}

export interface OdtTable {
	kind: "table";
	columns: (number | undefined)[];
	rows: { cells: { blocks: OdtBlock[]; colSpan: number; rowSpan: number; background?: string; border?: string }[] }[];
}

export type OdtBlock = OdtParagraph | OdtList | OdtTable;

export interface OdtDocument {
	blocks: OdtBlock[];
	images: Map<string, { mime: string; data: Uint8Array }>;
	truncated: boolean;
}

const MAX_BLOCKS = 20_000;

class OdtReader {
	private count = 0;
	truncated = false;
	constructor(private readonly ctx: InlineContext) {}

	private paragraph(p: XmlElement): OdtParagraph {
		const styles = this.ctx.styles;
		const name = attr(p, "text:style-name");
		const size = styles.fontSize("paragraph", name);
		const run = runStyleFrom(styles.resolve("paragraph", name, "text-properties"), size, styles);
		const pprops = styles.resolve("paragraph", name, "paragraph-properties");
		const style = paraStyleFrom(pprops, run);
		const runs: OdfRun[] = [];
		readInline(p.children, "paragraph", name, run, this.ctx, runs);
		// Leading and trailing collapsed spaces are not content.
		const first = runs[0];
		if (first && "text" in first) first.text = first.text.replace(/^ /, "");
		const last = runs[runs.length - 1];
		if (last && "text" in last) last.text = last.text.replace(/ $/, "");
		const out: OdtParagraph = { kind: "para", style, runs };
		if (p.name === "text:h")
			out.heading = Math.min(6, Math.max(1, Number(attr(p, "text:outline-level") ?? "1") || 1));
		const bg = colorValue(pprops["fo:background-color"]);
		if (bg) out.background = bg;
		return out;
	}

	blocks(container: XmlElement | undefined, listStyle?: string, depth = 0): OdtBlock[] {
		const out: OdtBlock[] = [];
		if (!container || depth > 40) return out;
		for (const el of children(container)) {
			if (this.count >= MAX_BLOCKS || this.ctx.budget.exhausted) {
				this.truncated = true;
				break;
			}
			switch (el.name) {
				case "text:p":
				case "text:h":
					this.count++;
					out.push(this.paragraph(el));
					break;
				case "text:list": {
					this.count++;
					const name = attr(el, "text:style-name") ?? listStyle;
					const level = this.ctx.styles.lists.get(name ?? "")?.[0];
					// Every item costs a block, even an empty one, because each draws an <li>.
					const items: OdtBlock[][] = [];
					for (const item of children(el)) {
						if (item.name !== "text:list-item" && item.name !== "text:list-header") continue;
						if (++this.count > MAX_BLOCKS) {
							this.truncated = true;
							break;
						}
						const blocks = this.blocks(item, name, depth + 1);
						if (item.name === "text:list-header") items.unshift(blocks);
						else items.push(blocks);
					}
					out.push({
						kind: "list",
						ordered: !!level?.numFormat && level.numFormat !== "",
						start: level?.start ?? 1,
						bullet: level?.bullet,
						items,
					});
					break;
				}
				case "table:table":
					this.count++;
					out.push(this.table(el, depth));
					break;
				case "text:section":
				case "text:index-body":
				case "text:table-of-content":
				case "text:alphabetical-index":
				case "text:illustration-index":
				case "text:bibliography":
				case "draw:text-box":
					out.push(
						...this.blocks(
							el.name === "text:table-of-content" ? (child(el, "text:index-body") ?? el) : el,
							listStyle,
							depth + 1,
						),
					);
					break;
				case "draw:frame": {
					const img = frameImage(el, this.ctx);
					if (img) out.push({ kind: "para", style: { run: {} }, runs: [img] });
					break;
				}
			}
		}
		return out;
	}

	private table(el: XmlElement, depth: number): OdtTable {
		const styles = this.ctx.styles;
		const columns: (number | undefined)[] = [];
		const colEls = tableColumns(el);
		for (const c of colEls) {
			const width = lengthToPt(
				styles.resolve("table-column", attr(c, "table:style-name"), "table-column-properties")[
					"style:column-width"
				],
			);
			const repeat = Math.min(256, Number(attr(c, "table:number-columns-repeated") ?? "1") || 1);
			for (let i = 0; i < repeat && columns.length < PREVIEW_LIMITS.maxTableColumns; i++) columns.push(width);
		}
		// Each column draws a <col>, so columns cost blocks like cells do.
		this.count += columns.length;
		if (this.count > MAX_BLOCKS) {
			this.truncated = true;
			columns.length = 0;
		}
		const rowEls = tableRows(el);
		const rows: OdtTable["rows"] = [];
		let cellsLeft = PREVIEW_LIMITS.maxTableCells;
		const shownRows = rowEls.slice(0, PREVIEW_LIMITS.maxTableRows);
		for (const [rowIndex, r] of shownRows.entries()) {
			// Every row draws a <tr>, empty or not, so rows cost blocks too.
			if (++this.count > MAX_BLOCKS) {
				this.truncated = true;
				break;
			}
			const cells: OdtTable["rows"][number]["cells"] = [];
			let column = 0;
			for (const c of children(r)) {
				if (c.name !== "table:table-cell") continue;
				// Cells are bounded per row, per table and by the document's block count.
				if (cells.length >= PREVIEW_LIMITS.maxTableColumns || cellsLeft-- <= 0 || ++this.count > MAX_BLOCKS) {
					this.truncated = true;
					break;
				}
				const props = styles.resolve("table-cell", attr(c, "table:style-name"), "table-cell-properties");
				if (column >= PREVIEW_LIMITS.maxTableColumns) break;
				cells.push({
					blocks: this.blocks(c, undefined, depth + 1),
					// Spans stay inside the table as drawn, so they can't widen the layout grid.
					colSpan: clampSpan(attr(c, "table:number-columns-spanned"), PREVIEW_LIMITS.maxTableColumns - column),
					rowSpan: clampSpan(attr(c, "table:number-rows-spanned"), shownRows.length - rowIndex),
					background: colorValue(props["fo:background-color"]),
					border: props["fo:border"] && props["fo:border"] !== "none" ? props["fo:border"] : undefined,
				});
				column += cells[cells.length - 1].colSpan;
			}
			rows.push({ cells });
		}
		return { kind: "table", columns, rows };
	}
}

async function loadImages(zip: SafeZip, paths: Set<string>): Promise<Map<string, { mime: string; data: Uint8Array }>> {
	const images = new Map<string, { mime: string; data: Uint8Array }>();
	for (const p of paths) {
		const mime = browserImageMime(p);
		if (!mime) continue;
		try {
			const data = await zip.bytes(p);
			if (data) images.set(p, { mime, data });
		} catch {
			// Over the limit: the image is left out.
		}
	}
	return images;
}

async function openOdf(bytes: Uint8Array): Promise<{ zip: SafeZip; styles: OdfStyles; content: XmlElement }> {
	const zip = await SafeZip.open(bytes);
	const contentText = await zip.text("content.xml");
	if (!contentText) throw new Error("Not an OpenDocument file: content.xml is missing");
	const content = parseXml(contentText);
	const styles = new OdfStyles();
	const stylesText = await zip.text("styles.xml");
	if (stylesText) styles.addDocument(parseXml(stylesText), "styles");
	styles.addDocument(content, "content");
	return { zip, styles, content };
}

export async function readOdt(bytes: Uint8Array): Promise<OdtDocument> {
	const { zip, styles, content } = await openOdf(bytes);
	const ctx: InlineContext = { styles, images: new Set(), zip, budget: newBudget() };
	const reader = new OdtReader(ctx);
	const body = child(child(content, "office:body"), "office:text");
	if (!body) throw new Error("Not an OpenDocument text file");
	const blocks = reader.blocks(body);
	return { blocks, images: await loadImages(zip, ctx.images), truncated: reader.truncated || ctx.budget.exhausted };
}

// ---------------------------------------------------------------------------
// Presentations
// ---------------------------------------------------------------------------

/** ODF enhanced-geometry types and the DrawingML presets that draw them. */
const GEOMETRY: Record<string, string> = Object.fromEntries(
	"rectangle=rect round-rectangle=roundRect ellipse=ellipse circle=ellipse isosceles-triangle=triangle right-triangle=rtTriangle diamond=diamond parallelogram=parallelogram trapezoid=trapezoid pentagon=pentagon hexagon=hexagon octagon=octagon star5=star5 star4=star4 star8=star8 right-arrow=rightArrow left-arrow=leftArrow up-arrow=upArrow down-arrow=downArrow left-right-arrow=leftRightArrow chevron=chevron pentagon_right=homePlate cross=plus can=can ring=donut flowchart-process=rect flowchart-decision=diamond flowchart-connector=ellipse"
		.split(" ")
		.map((p) => p.split("=")),
);

function graphicFill(props: Record<string, string>, styles: OdfStyles): Fill | undefined {
	const fill = props["draw:fill"];
	if (fill === "none") return { type: "none" };
	if (fill === "solid" || (!fill && props["draw:fill-color"])) {
		const c = colorValue(props["draw:fill-color"]);
		if (c) return { type: "solid", color: c };
	}
	if (fill === "gradient") {
		const c = colorValue(props["draw:fill-color"]);
		if (c) return { type: "solid", color: c };
	}
	void styles;
	return undefined;
}

function graphicLine(props: Record<string, string>): Line | null | undefined {
	const stroke = props["draw:stroke"];
	if (stroke === "none") return null;
	if (!stroke && !props["svg:stroke-color"]) return undefined;
	const color = colorValue(props["svg:stroke-color"]) ?? "#3465a4";
	const width = lengthToEmu(props["svg:stroke-width"]) ?? 9525;
	return { color, width: Math.max(width, 9525), dash: stroke === "dash" ? "dash" : undefined };
}

class OdpReader {
	images = new Set<string>();
	budget = newBudget();
	elementsLeft = PREVIEW_LIMITS.maxDeckElements;
	constructor(
		private readonly styles: OdfStyles,
		private readonly zip: SafeZip,
	) {}

	private ctx(): InlineContext {
		return { styles: this.styles, images: this.images, zip: this.zip, budget: this.budget };
	}

	private textBody(
		container: XmlElement,
		graphicFamily: string,
		graphicStyle: string | undefined,
		gprops: Record<string, string>,
	): TextBody | undefined {
		const styles = this.styles;
		const baseText = styles.resolve(graphicFamily, graphicStyle, "text-properties");
		const baseSize = styles.fontSize(graphicFamily, graphicStyle, 18);
		const baseRun = runStyleFrom(baseText, baseSize, styles);
		const basePara = styles.resolve(graphicFamily, graphicStyle, "paragraph-properties");
		const graphicList = styles.listStyleOf(graphicFamily, graphicStyle);
		const paragraphs: TextParagraph[] = [];
		const counters: number[] = [];
		const visit = (el: XmlElement, level: number, listName: string | undefined, depth: number) => {
			if (depth > 20 || paragraphs.length > 2000) return;
			for (const c of children(el)) {
				// The cap and the run budget apply per paragraph, empty ones included.
				if (paragraphs.length >= 2000 || this.budget.runs <= 0) {
					this.budget.exhausted = this.budget.exhausted || this.budget.runs <= 0;
					return;
				}
				if (c.name === "text:p" || c.name === "text:h") {
					this.budget.runs--;
					const name = attr(c, "text:style-name");
					const pText = styles.find("paragraph", name) ? styles.resolve("paragraph", name, "text-properties") : {};
					const size = styles.find("paragraph", name) ? sizeFrom(pText["fo:font-size"], baseSize) : baseSize;
					const run = { ...baseRun, ...definedRun(runStyleFrom(pText, size, styles)) };
					const pprops = {
						...basePara,
						...(styles.find("paragraph", name) ? styles.resolve("paragraph", name, "paragraph-properties") : {}),
					};
					const style = paraStyleFrom(pprops, run);
					const runs: OdfRun[] = [];
					readInline(c.children, "paragraph", name, run, this.ctx(), runs);
					const first = runs[0];
					if (first && "text" in first) first.text = first.text.replace(/^ /, "");
					const para: TextParagraph = {
						level: Math.max(0, level),
						style,
						runs: runs.flatMap((r) =>
							"text" in r
								? [{ text: r.text, style: r.style }]
								: "br" in r
									? [{ text: "\n", br: true, style: run }]
									: [],
						),
					};
					const hasText = para.runs.some((r) => !r.br && r.text.trim().length > 0);
					if (!hasText) para.emptySize = run.size;
					if (level >= 0 && hasText) {
						const lvl =
							(listName ? styles.lists.get(listName) : undefined)?.[level] ??
							(graphicList ? styles.lists.get(graphicList)?.[level] : undefined);
						if (lvl?.indent !== undefined && lvl.indent > (style.marL ?? 0)) {
							style.marL = lvl.indent;
							style.indent = -Math.min(lvl.indent, lvl.labelWidth ?? 457200 / 2);
						}
						counters.length = level + 1;
						if (lvl?.numFormat) {
							counters[level] = (counters[level] ?? (lvl.start ?? 1) - 1) + 1;
							const n = counters[level];
							const scheme =
								{ a: "alphaLc", A: "alphaUc", i: "romanLc", I: "romanUc" }[lvl.numFormat] ?? "arabic";
							const body = autoNumberLabel(`${scheme}Plain`, n);
							para.bullet = { text: `${lvl.numPrefix ?? ""}${body}${lvl.numSuffix ?? ""}`, color: run.color };
						} else if (lvl?.bullet !== undefined || !lvl) {
							para.bullet = {
								text: lvl?.bullet ?? "•",
								color: lvl?.color ?? run.color,
								sizePct: lvl?.fontSizePct,
							};
						}
					}
					paragraphs.push(para);
				} else if (c.name === "text:list") {
					const name = attr(c, "text:style-name") ?? listName;
					for (const item of children(c)) {
						if (item.name === "text:list-item" || item.name === "text:list-header")
							visit(item, level + 1, name, depth + 1);
					}
				}
			}
		};
		visit(container, -1, undefined, 0);
		if (!paragraphs.some((p) => p.runs.some((r) => !r.br && r.text.trim()))) return undefined;
		const anchor = gprops["draw:textarea-vertical-align"];
		return {
			paragraphs,
			anchor: anchor === "middle" ? "ctr" : anchor === "bottom" ? "b" : "t",
			insets: [
				lengthToEmu(gprops["fo:padding-left"]) ?? 91440,
				lengthToEmu(gprops["fo:padding-top"]) ?? 45720,
				lengthToEmu(gprops["fo:padding-right"]) ?? 91440,
				lengthToEmu(gprops["fo:padding-bottom"]) ?? 45720,
			],
			wrap: gprops["fo:wrap-option"] !== "no-wrap",
			fontScale: 1,
			lineReduction: 0,
		};
	}

	private boxOf(el: XmlElement): Box | undefined {
		const x = lengthToEmu(attr(el, "svg:x")) ?? 0;
		const y = lengthToEmu(attr(el, "svg:y")) ?? 0;
		const w = lengthToEmu(attr(el, "svg:width"));
		const h = lengthToEmu(attr(el, "svg:height"));
		if (w === undefined || h === undefined) return undefined;
		const box: Box = { x, y, w, h, rot: 0, flipH: false, flipV: false };
		const transform = attr(el, "draw:transform");
		if (transform) {
			const rot = /rotate\s*\(\s*(-?[\d.eE+-]+)\s*\)/.exec(transform);
			const tr = /translate\s*\(\s*(-?[\d.]+\w*)\s*,?\s*(-?[\d.]+\w*)\s*\)/.exec(transform);
			if (rot) box.rot = (-Number(rot[1]) * 180) / Math.PI;
			if (tr) {
				// The translate places the rotated shape's origin; recover the unrotated top-left.
				const tx = lengthToEmu(tr[1]) ?? 0;
				const ty = lengthToEmu(tr[2]) ?? 0;
				const a = (box.rot * Math.PI) / 180;
				const cx = tx + (w / 2) * Math.cos(a) - (h / 2) * Math.sin(a);
				const cy = ty + (w / 2) * Math.sin(a) + (h / 2) * Math.cos(a);
				box.x = cx - w / 2;
				box.y = cy - h / 2;
			}
		}
		return box;
	}

	elements(container: XmlElement | undefined, onMaster: boolean, out: SlideElement[], depth = 0) {
		if (!container || depth > 30) return;
		for (const el of children(container)) {
			if (out.length > 4000 || this.elementsLeft <= 0) return;
			this.elementsLeft--;
			if (el.name === "draw:g") {
				this.elements(el, onMaster, out, depth + 1);
				continue;
			}
			if (onMaster && attr(el, "presentation:class")) continue;
			if (attr(el, "presentation:placeholder") === "true") continue;
			const family = attr(el, "presentation:style-name") ? "presentation" : "graphic";
			const styleName = attr(el, "presentation:style-name") ?? attr(el, "draw:style-name");
			const gprops = this.styles.resolve(family, styleName, "graphic-properties");
			if (el.name === "draw:frame") {
				const box = this.boxOf(el);
				if (!box) continue;
				const image = child(el, "draw:image");
				const table = child(el, "table:table");
				const textBox = child(el, "draw:text-box");
				if (table) {
					// Tables come first: their frames also carry a preview image.
					out.push(this.table(table, box));
				} else if (image) {
					const img = frameImage(el, this.ctx());
					const pic: PictureElement = { kind: "picture", box };
					if (img && "image" in img) pic.image = img.image;
					else pic.unsupported = attr(image, "xlink:href")?.split(".").pop()?.toLowerCase();
					out.push(pic);
				} else if (textBox) {
					const shape: ShapeElement = {
						kind: "shape",
						box,
						preset: "rect",
						adj: {},
						fill: graphicFill(gprops, this.styles),
						line: graphicLine(gprops) ?? null,
					};
					const text = this.textBody(textBox, family, styleName, gprops);
					if (text) shape.text = text;
					out.push(shape);
				} else if (child(el, "draw:object") || child(el, "draw:object-ole")) {
					out.push({ kind: "placeholder", box, label: "Embedded object" });
				}
			} else if (
				el.name === "draw:custom-shape" ||
				el.name === "draw:rect" ||
				el.name === "draw:ellipse" ||
				el.name === "draw:circle"
			) {
				const box = this.boxOf(el);
				if (!box) continue;
				const type =
					attr(child(el, "draw:enhanced-geometry"), "draw:type") ??
					(el.name === "draw:rect" ? "rectangle" : el.name === "draw:custom-shape" ? "rectangle" : "ellipse");
				const shape: ShapeElement = {
					kind: "shape",
					box,
					preset: GEOMETRY[type] ?? "rect",
					adj: {},
					fill: graphicFill(gprops, this.styles) ?? { type: "solid", color: "#729fcf" },
					line: graphicLine(gprops) === undefined ? { color: "#3465a4", width: 9525 } : graphicLine(gprops),
				};
				const text = this.textBody(el, family, styleName, gprops);
				if (text) shape.text = text;
				out.push(shape);
			} else if (el.name === "draw:line" || el.name === "draw:connector") {
				const x1 = lengthToEmu(attr(el, "svg:x1")) ?? 0;
				const y1 = lengthToEmu(attr(el, "svg:y1")) ?? 0;
				const x2 = lengthToEmu(attr(el, "svg:x2")) ?? 0;
				const y2 = lengthToEmu(attr(el, "svg:y2")) ?? 0;
				out.push({
					kind: "shape",
					box: {
						x: Math.min(x1, x2),
						y: Math.min(y1, y2),
						w: Math.abs(x2 - x1),
						h: Math.abs(y2 - y1),
						rot: 0,
						flipH: x2 < x1,
						flipV: y2 < y1,
					},
					preset: "line",
					adj: {},
					line: graphicLine(gprops) ?? { color: "#3465a4", width: 9525 },
				});
			}
		}
	}

	private table(el: XmlElement, box: Box): TableElement {
		const styles = this.styles;
		let colCount = 0;
		const cols = tableColumns(el)
			.flatMap((c) => {
				const w =
					lengthToEmu(
						styles.resolve("table-column", attr(c, "table:style-name"), "table-column-properties")[
							"style:column-width"
						],
					) ?? 0;
				const repeat = Math.min(64, Number(attr(c, "table:number-columns-repeated") ?? "1") || 1);
				if (++colCount > PREVIEW_LIMITS.maxTableColumns) return [];
				return Array.from({ length: repeat }, () => w);
			})
			.slice(0, Math.max(0, Math.min(PREVIEW_LIMITS.maxTableColumns, this.elementsLeft)));
		// Each column draws a <col>, so columns cost deck elements like cells do.
		this.elementsLeft -= cols.length;
		const rows: TableElement["rows"] = [];
		const rowEls = tableRows(el);
		let cellsLeft = PREVIEW_LIMITS.maxTableCells;
		for (const r of rowEls.slice(0, 500)) {
			if (cellsLeft <= 0 || this.elementsLeft <= 0) break;
			// Every row draws a <tr>, empty or not.
			this.elementsLeft--;
			const height =
				lengthToEmu(
					styles.resolve("table-row", attr(r, "table:style-name"), "table-row-properties")["style:row-height"],
				) ?? 0;
			rows.push({
				height,
				cells: fitRow(
					children(r)
						.filter((c) => c.name === "table:table-cell" || c.name === "table:covered-table-cell")
						.slice(0, Math.max(0, Math.min(PREVIEW_LIMITS.maxTableColumns, cellsLeft, this.elementsLeft)))
						.map((c) => {
							// Each cell is drawn, so each costs an element of the deck budget.
							cellsLeft--;
							this.elementsLeft--;
							const props = styles.resolve("graphic", attr(c, "table:style-name"), "graphic-properties");
							const cellProps = styles.resolve(
								"table-cell",
								attr(c, "table:style-name"),
								"table-cell-properties",
							);
							const fill =
								graphicFill(props, styles) ??
								(colorValue(cellProps["fo:background-color"])
									? { type: "solid" as const, color: colorValue(cellProps["fo:background-color"]) as string }
									: undefined);
							const border = { color: "#999999", width: 9525 };
							return {
								text: this.textBody(c, "graphic", attr(c, "table:style-name"), props),
								fill,
								gridSpan: clampSpan(attr(c, "table:number-columns-spanned"), PREVIEW_LIMITS.maxTableColumns),
								rowSpan: clampSpan(attr(c, "table:number-rows-spanned"), 500),
								merged: c.name === "table:covered-table-cell",
								borders: { l: border, r: border, t: border, b: border },
							};
						}),
					PREVIEW_LIMITS.maxTableColumns,
				),
			});
		}
		const total = cols.reduce((a, b) => a + b, 0);
		const n = Math.max(1, ...rows.map((r) => r.cells.length));
		return { kind: "table", box, columns: total > 0 ? cols : Array.from({ length: n }, () => box.w / n), rows };
	}

	private masterCache = new Map<
		XmlElement,
		{ elements: SlideElement[]; elementsCost: number; runsCost: number; charsCost: number }
	>();

	/**
	 * A master page's shapes, read once and reused on every page that shows them. Each reuse
	 * still spends what the first reading spent, because each page draws them again.
	 */
	masterElements(master: XmlElement, out: SlideElement[]) {
		let cached = this.masterCache.get(master);
		if (!cached) {
			const before = { elements: this.elementsLeft, runs: this.budget.runs, chars: this.budget.chars };
			const elements: SlideElement[] = [];
			this.elements(master, true, elements);
			cached = {
				elements,
				elementsCost: before.elements - this.elementsLeft,
				runsCost: before.runs - this.budget.runs,
				charsCost: before.chars - this.budget.chars,
			};
			this.masterCache.set(master, cached);
			out.push(...elements);
			return;
		}
		this.elementsLeft -= cached.elementsCost;
		this.budget.runs -= cached.runsCost;
		this.budget.chars -= cached.charsCost;
		if (this.budget.runs <= 0 || this.budget.chars <= 0) this.budget.exhausted = true;
		out.push(...cached.elements);
	}

	background(styleName: string | undefined): Fill | undefined {
		if (!styleName) return undefined;
		const props = this.styles.resolve("drawing-page", styleName, "drawing-page-properties");
		return graphicFill(props, this.styles);
	}
}

export async function readOdp(bytes: Uint8Array): Promise<Deck> {
	const { zip, styles, content } = await openOdf(bytes);
	const body = child(child(content, "office:body"), "office:presentation");
	if (!body) throw new Error("Not an OpenDocument presentation");
	const reader = new OdpReader(styles, zip);
	const pages = children(body, "draw:page");
	let width = 10080000;
	let height = 7560000;
	const firstMaster = styles.masters.get(attr(pages[0], "draw:master-page-name") ?? "");
	const layout = styles.pageLayouts.get(attr(firstMaster, "style:page-layout-name") ?? "");
	const lp = layout?.props["page-layout-properties"];
	if (lp) {
		width = lengthToEmu(lp["fo:page-width"]) ?? width;
		height = lengthToEmu(lp["fo:page-height"]) ?? height;
	}
	const slides: Slide[] = [];
	for (const [i, page] of pages.slice(0, PREVIEW_LIMITS.maxSlides).entries()) {
		if (reader.elementsLeft <= 0 || reader.budget.exhausted) break;
		const master = styles.masters.get(attr(page, "draw:master-page-name") ?? "");
		const elements: SlideElement[] = [];
		const pageProps = styles.resolve("drawing-page", attr(page, "draw:style-name"), "drawing-page-properties");
		if (master && pageProps["presentation:background-objects-visible"] !== "false")
			reader.masterElements(master, elements);
		reader.elements(page, false, elements);
		const background =
			(pageProps["presentation:background-visible"] !== "false"
				? reader.background(attr(page, "draw:style-name"))
				: undefined) ?? reader.background(attr(master, "draw:style-name"));
		slides.push({ number: i + 1, hidden: attr(page, "presentation:visibility") === "hidden", background, elements });
	}
	return { width, height, slides, totalSlides: pages.length, images: await loadImages(zip, reader.images) };
}
