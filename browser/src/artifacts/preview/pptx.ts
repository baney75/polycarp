/**
 * Reads a .pptx into a plain slide model the panel can draw: positioned text boxes with basic
 * formatting, shapes with fills and outlines, pictures, tables and slide backgrounds. Layout and
 * master inheritance is resolved here; nothing in the file is executed or fetched.
 */
import { browserImageMime, PREVIEW_LIMITS, resolvePartPath, SafeZip } from "./content.js";
import {
	autoNumberLabel,
	type ColorContext,
	colorIn,
	customGeometryPaths,
	emptyLevels,
	type Fill,
	fillIn,
	type LevelStyles,
	type Line,
	lineOf,
	mergeLevels,
	mergePara,
	mergeRun,
	type ParaStyle,
	parseClrMap,
	parseLevels,
	parseParaStyle,
	parseRunStyle,
	parseTheme,
	type RunStyle,
	styleFill,
	styleLine,
	type Theme,
} from "./drawingml.js";
import { attr, child, children, numAttr, parseXml, textOf, type XmlElement } from "./xml.js";

/** EMU per CSS pixel at 96 dpi. */
export const EMU_PER_PX = 9525;

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
	/** Degrees clockwise. */
	rot: number;
	flipH: boolean;
	flipV: boolean;
}

export interface TextRun {
	text: string;
	style: RunStyle;
	/** A line break (a:br) rather than text. */
	br?: boolean;
	/** A slide-number field: drawn as the number of the slide it appears on. */
	slideNumber?: boolean;
}

export interface TextParagraph {
	level: number;
	style: ParaStyle;
	runs: TextRun[];
	/** The bullet or number to draw, if any. */
	bullet?: { text: string; color?: string; font?: string; sizePct?: number };
	/** Size of an empty paragraph, in points, so blank lines keep their height. */
	emptySize?: number;
}

export interface TextBody {
	paragraphs: TextParagraph[];
	anchor: "t" | "ctr" | "b";
	/** Left, top, right, bottom insets in EMU. */
	insets: [number, number, number, number];
	wrap: boolean;
	vertical?: string;
	/** normAutofit scale for font sizes (1 = none). */
	fontScale: number;
	/** normAutofit reduction of line spacing (0 = none). */
	lineReduction: number;
}

export type GeometryPath = { d: string; fill: boolean; stroke: boolean };

export interface ShapeElement {
	kind: "shape";
	box: Box;
	preset?: string;
	adj: Record<string, number>;
	/** Custom geometry in the shape's own EMU box. */
	paths?: GeometryPath[];
	fill?: Fill;
	line?: Line | null;
	text?: TextBody;
	/** Arrow heads on lines. */
	headEnd?: boolean;
	tailEnd?: boolean;
}

export interface PictureElement {
	kind: "picture";
	box: Box;
	/** Zip path of an image the browser can decode. */
	image?: string;
	/** File extension of an embedded image that cannot be shown (emf, wmf, tiff). */
	unsupported?: string;
	/** Fractions cropped from each edge. */
	crop?: { l: number; t: number; r: number; b: number };
	preset?: string;
	line?: Line | null;
}

/**
 * Keep a row's spans inside `width` columns: each span is clamped to what is left and cells past
 * the edge are dropped, so spans can't widen the layout grid past the column limit.
 */
export function fitRow(cells: TableCell[], width: number): TableCell[] {
	const out: TableCell[] = [];
	let column = 0;
	for (const cell of cells) {
		if (column >= width) break;
		const gridSpan = Math.min(cell.gridSpan, width - column);
		column += cell.merged ? 1 : gridSpan;
		out.push(gridSpan === cell.gridSpan ? cell : { ...cell, gridSpan });
	}
	return out;
}

export interface TableCell {
	text?: TextBody;
	fill?: Fill;
	gridSpan: number;
	rowSpan: number;
	/** Covered by a merged neighbor. */
	merged: boolean;
	borders: { l?: Line | null; r?: Line | null; t?: Line | null; b?: Line | null };
}

export interface TableElement {
	kind: "table";
	box: Box;
	columns: number[];
	rows: { height: number; cells: TableCell[] }[];
}

export interface PlaceholderElement {
	kind: "placeholder";
	box: Box;
	label: string;
}

export type SlideElement = ShapeElement | PictureElement | TableElement | PlaceholderElement;

export interface Slide {
	number: number;
	hidden: boolean;
	background?: Fill;
	elements: SlideElement[];
}

export interface Deck {
	width: number;
	height: number;
	slides: Slide[];
	/** Slides in the file, which can be more than `slides` when over the limit. */
	totalSlides: number;
	images: Map<string, { mime: string; data: Uint8Array }>;
}

const MAX_ELEMENTS_PER_SLIDE = 4000;
/** Most drawing commands read from one custom shape. */
const MAX_PATH_COMMANDS = 20_000;
/** Most placeholders indexed per layout or master. */
const MAX_PLACEHOLDERS = 200;
/** Most paragraphs read from one text body. */
const MAX_PARAGRAPHS = 2_000;

/** What a deck may still draw; shared by every slide. */
export interface Budget {
	elements: number;
	runs: number;
	chars: number;
	/** Custom-geometry drawing commands. */
	commands: number;
}

/** Longest text run kept; template text is redrawn on every slide. */
const MAX_RUN_CHARS = 100_000;

interface Rel {
	target: string;
	type: string;
	external: boolean;
}

interface Part {
	path: string;
	root: XmlElement;
	rels: Map<string, Rel>;
}

interface PlaceholderInfo {
	type: string;
	idx?: string;
	sp: XmlElement;
}

interface Template {
	part: Part;
	ctx: ColorContext;
	placeholders: PlaceholderInfo[];
	showMasterShapes: boolean;
}

interface MasterTemplate extends Template {
	/** p:txStyles, parsed per slide because colors depend on the slide's color map. */
	txStyles?: XmlElement;
	themePart?: Part;
}

function dirOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

function relsPathFor(path: string): string {
	const dir = dirOf(path);
	const name = path.slice(dir.length ? dir.length + 1 : 0);
	return `${dir ? `${dir}/` : ""}_rels/${name}.rels`;
}

class PptxReader {
	private parts = new Map<string, Part>();
	private masters = new Map<string, MasterTemplate>();
	private layouts = new Map<string, { layout: Template; master: MasterTemplate }>();
	private themes = new Map<string, Theme>();
	readonly images = new Map<string, { mime: string; data: Uint8Array }>();
	private defaultTextXml?: XmlElement;
	readonly budget: Budget = {
		elements: PREVIEW_LIMITS.maxDeckElements,
		runs: PREVIEW_LIMITS.maxTextRuns,
		chars: PREVIEW_LIMITS.maxTextChars,
		commands: PREVIEW_LIMITS.maxDeckCommands,
	};

	constructor(private readonly zip: SafeZip) {}

	async part(path: string): Promise<Part | undefined> {
		const cached = this.parts.get(path);
		if (cached) return cached;
		const text = await this.zip.text(path);
		if (text === undefined) return undefined;
		const root = parseXml(text);
		const rels = new Map<string, Rel>();
		const relsText = await this.zip.text(relsPathFor(path));
		if (relsText) {
			for (const r of children(parseXml(relsText), "Relationship")) {
				const id = attr(r, "Id");
				const target = attr(r, "Target");
				if (!id || target === undefined) continue;
				const external = attr(r, "TargetMode") === "External";
				rels.set(id, {
					target: external ? target : resolvePartPath(dirOf(path), target),
					type: attr(r, "Type") ?? "",
					external,
				});
			}
		}
		const part = { path, root, rels };
		this.parts.set(path, part);
		return part;
	}

	private relOfType(part: Part, suffix: string): Rel | undefined {
		for (const r of part.rels.values()) if (!r.external && r.type.endsWith(suffix)) return r;
		return undefined;
	}

	private async theme(path: string | undefined): Promise<Theme> {
		if (!path) return parseTheme(undefined);
		const cached = this.themes.get(path);
		if (cached) return cached;
		const part = await this.part(path);
		const theme = parseTheme(part?.root);
		this.themes.set(path, theme);
		return theme;
	}

	private placeholders(root: XmlElement): PlaceholderInfo[] {
		const out: PlaceholderInfo[] = [];
		for (const sp of children(child(child(root, "cSld"), "spTree"))) {
			const ph = placeholderOf(sp);
			if (ph) out.push({ type: ph.type, idx: ph.idx, sp });
			// A real layout has a dozen; more only makes every lookup slower.
			if (out.length >= MAX_PLACEHOLDERS) break;
		}
		return out;
	}

	async master(path: string): Promise<MasterTemplate | undefined> {
		const cached = this.masters.get(path);
		if (cached) return cached;
		const part = await this.part(path);
		if (!part) return undefined;
		const themePath = this.relOfType(part, "/theme")?.target;
		const theme = await this.theme(themePath);
		const themePart = themePath ? await this.part(themePath) : undefined;
		const ctx: ColorContext = { theme, clrMap: parseClrMap(child(part.root, "clrMap")) };
		const tx = child(part.root, "txStyles");
		const master: MasterTemplate = {
			part,
			ctx,
			placeholders: this.placeholders(part.root),
			showMasterShapes: true,
			txStyles: tx,
			themePart,
		};
		this.masters.set(path, master);
		return master;
	}

	async layout(path: string): Promise<{ layout: Template; master: MasterTemplate } | undefined> {
		const cached = this.layouts.get(path);
		if (cached) return cached;
		const part = await this.part(path);
		if (!part) return undefined;
		const masterPath = this.relOfType(part, "/slideMaster")?.target;
		const master = masterPath ? await this.master(masterPath) : undefined;
		if (!master) return undefined;
		const override = child(child(part.root, "clrMapOvr"), "overrideClrMapping");
		const ctx: ColorContext = { theme: master.ctx.theme, clrMap: parseClrMap(override, master.ctx.clrMap) };
		const layout: Template = {
			part,
			ctx,
			placeholders: this.placeholders(part.root),
			showMasterShapes: attr(part.root, "showMasterSp") !== "0",
		};
		const entry = { layout, master };
		this.layouts.set(path, entry);
		return entry;
	}

	async read(): Promise<Deck> {
		const presPath = "ppt/presentation.xml";
		const pres = await this.part(presPath);
		if (!pres) throw new Error("Not a PowerPoint file: ppt/presentation.xml is missing");
		const size = child(pres.root, "sldSz");
		const width = numAttr(size, "cx") ?? 9144000;
		const height = numAttr(size, "cy") ?? 6858000;

		// The prefix the file binds to the relationships namespace; "r" by convention, not by rule.
		const relPrefix = relationshipsPrefix(pres.root);
		const slidePaths: string[] = [];
		for (const id of children(child(pres.root, "sldIdLst"), "sldId")) {
			const rid = attr(id, `${relPrefix}:id`);
			const rel = rid ? pres.rels.get(rid) : undefined;
			if (rel && !rel.external) slidePaths.push(rel.target);
		}

		this.defaultTextXml = child(pres.root, "defaultTextStyle");

		const slides: Slide[] = [];
		const limit = Math.min(slidePaths.length, PREVIEW_LIMITS.maxSlides);
		for (let i = 0; i < limit; i++) {
			// One budget for the whole deck: master and layout shapes count on every slide they draw on.
			const b = this.budget;
			if (b.elements <= 0 || b.runs <= 0 || b.chars <= 0 || b.commands <= 0) break;
			const slide = await this.cachedSlide(slidePaths[i], i + 1);
			if (slide) slides.push(slide);
		}
		return { width, height, slides, totalSlides: slidePaths.length, images: this.images };
	}

	private async slide(path: string, number: number): Promise<Slide> {
		const part = await this.part(path);
		if (!part) return { number, hidden: false, elements: [] };
		const layoutPath = this.relOfType(part, "/slideLayout")?.target;
		const entry = layoutPath ? await this.layout(layoutPath) : undefined;
		const master = entry?.master;
		const layout = entry?.layout;
		const override = child(child(part.root, "clrMapOvr"), "overrideClrMapping");
		const baseCtx = layout?.ctx ?? master?.ctx ?? { theme: parseTheme(undefined), clrMap: parseClrMap(undefined) };
		const ctx: ColorContext = { theme: baseCtx.theme, clrMap: parseClrMap(override, baseCtx.clrMap) };

		const slide: Slide = { number, hidden: attr(part.root, "show") === "0", elements: [] };
		const bgKey = `${master?.part.path ?? ""}|${JSON.stringify(ctx.clrMap)}`;
		slide.background =
			(await this.background(part, ctx)) ??
			(layout ? await this.templateBackground(layout.part, ctx, bgKey) : undefined) ??
			(master ? await this.templateBackground(master.part, ctx, bgKey) : undefined);

		const showMaster = attr(part.root, "showMasterSp") !== "0";
		const tx = master?.txStyles;
		const ctxKey = `${master?.part.path ?? ""}|${JSON.stringify(ctx.clrMap)}`;
		const keyed = { ctx, ctxKey };
		const scope: Scope = {
			reader: this,
			ctx,
			ctxKey,
			defaultText: levelsOf(this.defaultTextXml, keyed),
			titleStyle: levelsOf(child(tx, "titleStyle"), keyed),
			bodyStyle: levelsOf(child(tx, "bodyStyle"), keyed),
			otherStyle: levelsOf(child(tx, "otherStyle"), keyed),
			master,
			layout,
			elements: slide.elements,
		};
		if (showMaster && master && layout?.showMasterShapes !== false) await this.templateShapes(master.part, scope);
		if (showMaster && layout) await this.templateShapes(layout.part, scope);
		await this.walkTree(child(child(part.root, "cSld"), "spTree"), part, ctx, scope, IDENTITY, false);
		return slide;
	}

	/** The master behind a slide, layout or master part. */
	private async masterOf(part: Part): Promise<MasterTemplate | undefined> {
		if (this.masters.has(part.path)) return this.masters.get(part.path);
		const layoutRel = this.relOfType(part, "/slideLayout");
		if (layoutRel) return (await this.layout(layoutRel.target))?.master;
		const masterRel = this.relOfType(part, "/slideMaster");
		return masterRel ? this.master(masterRel.target) : undefined;
	}

	private templateCache = new Map<string, { elements: SlideElement[]; cost: Budget }>();

	/**
	 * A layout's or master's own shapes, read once per color map and reused on every slide. Each
	 * reuse still spends what the first reading spent, because each slide draws them again.
	 */
	private async templateShapes(part: Part, scope: Scope): Promise<void> {
		const key = `${part.path}|${scope.ctxKey}`;
		let cached = this.templateCache.get(key);
		if (!cached) {
			const before = { ...this.budget };
			const elements: SlideElement[] = [];
			const tree = child(child(part.root, "cSld"), "spTree");
			await this.walkTree(tree, part, scope.ctx, { ...scope, elements }, IDENTITY, true);
			const cost: Budget = {
				elements: before.elements - this.budget.elements,
				runs: before.runs - this.budget.runs,
				chars: before.chars - this.budget.chars,
				commands: before.commands - this.budget.commands,
			};
			cached = { elements, cost };
			this.templateCache.set(key, cached);
			scope.elements.push(...elements);
			return;
		}
		if (this.replay(cached.cost)) scope.elements.push(...cached.elements);
	}

	/**
	 * Spend a cached reading's cost again. When the budget can't cover it, nothing is drawn and
	 * the budget is spent, so no reuse draws past the limit.
	 */
	private replay(cost: Budget): boolean {
		const keys = ["elements", "runs", "chars", "commands"] as const;
		if (keys.some((k) => cost[k] > this.budget[k])) {
			for (const k of keys) this.budget[k] = Math.min(this.budget[k], 0);
			return false;
		}
		for (const k of keys) this.budget[k] -= cost[k];
		return true;
	}

	private slideCache = new Map<string, { slide: Slide; cost: Budget }>();

	/**
	 * A slide part, read once however many times the deck lists it. Each listing keeps its own
	 * number (slide-number fields are filled in when drawn) and spends the budget again.
	 */
	private async cachedSlide(path: string, number: number): Promise<Slide | undefined> {
		const cached = this.slideCache.get(path);
		if (cached) {
			const drawn = this.replay(cached.cost) ? cached.slide.elements : [];
			return { ...cached.slide, number, elements: drawn };
		}
		const before = { ...this.budget };
		const slide = await this.slide(path, number);
		this.slideCache.set(path, {
			slide,
			cost: {
				elements: before.elements - this.budget.elements,
				runs: before.runs - this.budget.runs,
				chars: before.chars - this.budget.chars,
				commands: before.commands - this.budget.commands,
			},
		});
		return slide;
	}

	private backgroundCache = new Map<string, Fill | undefined>();

	/** A layout's or master's background, resolved once per color map. */
	private async templateBackground(part: Part, ctx: ColorContext, key: string): Promise<Fill | undefined> {
		const k = `${part.path}|${key}`;
		if (!this.backgroundCache.has(k)) this.backgroundCache.set(k, await this.background(part, ctx));
		return this.backgroundCache.get(k);
	}

	private async background(part: Part, ctx: ColorContext): Promise<Fill | undefined> {
		const bg = child(child(part.root, "cSld"), "bg");
		if (!bg) return undefined;
		const bgPr = child(bg, "bgPr");
		if (bgPr) return fillIn(bgPr, ctx, (rid) => this.imageFor(part, rid));
		const bgRef = child(bg, "bgRef");
		if (bgRef) {
			const phClr = colorIn(bgRef, ctx);
			const idx = numAttr(bgRef, "idx") ?? 0;
			const themePart = (await this.masterOf(part))?.themePart;
			return styleFill(
				ctx.theme,
				idx,
				{ ...ctx, phClr },
				themePart ? (rid) => this.imageFor(themePart, rid) : undefined,
			);
		}
		return undefined;
	}

	/** Zip path of an embedded image, registering it for the renderer. Undefined for external or missing images. */
	imageFor(part: Part, rid: string): string | undefined {
		const rel = part.rels.get(rid);
		if (!rel || rel.external) return undefined;
		if (!browserImageMime(rel.target) || !this.zip.has(rel.target)) return undefined;
		if (!this.images.has(rel.target)) this.pendingImages.add(rel.target);
		return rel.target;
	}

	unsupportedImage(part: Part, rid: string): string | undefined {
		const rel = part.rels.get(rid);
		if (!rel || rel.external) return undefined;
		return rel.target.split(".").pop()?.toLowerCase();
	}

	pendingImages = new Set<string>();

	async loadImages(): Promise<void> {
		for (const path of this.pendingImages) {
			const mime = browserImageMime(path);
			if (!mime) continue;
			try {
				const data = await this.zip.bytes(path);
				if (data) this.images.set(path, { mime, data });
			} catch {
				// An image over the limit is left out; its box still draws.
			}
		}
		this.pendingImages.clear();
	}

	async walkTree(
		tree: XmlElement | undefined,
		part: Part,
		ctx: ColorContext,
		scope: Scope,
		transform: Transform,
		templateOnly: boolean,
	): Promise<void> {
		for (const raw of children(tree)) {
			if (scope.elements.length >= MAX_ELEMENTS_PER_SLIDE || this.budget.elements <= 0) return;
			const el = raw.local === "AlternateContent" ? alternateContent(raw) : [raw];
			for (const node of el) {
				// Every node visited costs budget, drawn or not, so empty shapes and groups can't
				// make each slide re-walk a huge tree for free.
				this.budget.elements--;
				switch (node.local) {
					case "sp":
					case "cxnSp": {
						// Placeholders on layouts and masters only show through the slide's own copies.
						if (templateOnly && placeholderOf(node)) continue;
						const shape = readShape(node, part, ctx, scope, transform, templateOnly);
						if (shape) scope.elements.push(shape);
						break;
					}
					case "pic": {
						if (templateOnly && placeholderOf(node)) continue;
						const pic = readPicture(node, part, ctx, scope, transform);
						if (pic) scope.elements.push(pic);
						break;
					}
					case "graphicFrame": {
						const frame = readGraphicFrame(node, part, ctx, scope, transform);
						if (frame) scope.elements.push(frame);
						break;
					}
					case "grpSp": {
						const xfrm = child(child(node, "grpSpPr"), "xfrm");
						await this.walkTree(node, part, ctx, scope, compose(transform, groupTransform(xfrm)), templateOnly);
						break;
					}
				}
			}
		}
	}
}

interface Scope {
	reader: PptxReader;
	ctx: ColorContext;
	defaultText: LevelStyles;
	titleStyle: LevelStyles;
	bodyStyle: LevelStyles;
	otherStyle: LevelStyles;
	/** Identifies the theme and color map, for caches of resolved colors. */
	ctxKey: string;
	master?: MasterTemplate;
	layout?: Template;
	elements: SlideElement[];
}

const RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function relationshipsPrefix(root: XmlElement): string {
	for (const [key, value] of Object.entries(root.attrs)) {
		if (key.startsWith("xmlns:") && value === RELATIONSHIPS_NS) return key.slice("xmlns:".length);
	}
	return "r";
}

function alternateContent(el: XmlElement): XmlElement[] {
	const fallback = child(el, "Fallback");
	if (fallback) return children(fallback);
	return children(child(el, "Choice"));
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

interface Transform {
	ox: number;
	oy: number;
	sx: number;
	sy: number;
}

const IDENTITY: Transform = { ox: 0, oy: 0, sx: 1, sy: 1 };

function groupTransform(xfrm: XmlElement | undefined): Transform {
	if (!xfrm) return IDENTITY;
	const off = child(xfrm, "off");
	const ext = child(xfrm, "ext");
	const chOff = child(xfrm, "chOff");
	const chExt = child(xfrm, "chExt");
	const cx = numAttr(chExt, "cx") || numAttr(ext, "cx") || 1;
	const cy = numAttr(chExt, "cy") || numAttr(ext, "cy") || 1;
	const sx = (numAttr(ext, "cx") ?? cx) / cx;
	const sy = (numAttr(ext, "cy") ?? cy) / cy;
	return {
		ox: (numAttr(off, "x") ?? 0) - (numAttr(chOff, "x") ?? 0) * sx,
		oy: (numAttr(off, "y") ?? 0) - (numAttr(chOff, "y") ?? 0) * sy,
		sx,
		sy,
	};
}

/** Apply `inner` (a group's child space) then `outer`. */
function compose(outer: Transform, inner: Transform): Transform {
	return {
		ox: outer.ox + inner.ox * outer.sx,
		oy: outer.oy + inner.oy * outer.sy,
		sx: outer.sx * inner.sx,
		sy: outer.sy * inner.sy,
	};
}

function boxFrom(xfrm: XmlElement | undefined, t: Transform): Box | undefined {
	if (!xfrm) return undefined;
	const off = child(xfrm, "off");
	const ext = child(xfrm, "ext");
	if (!off && !ext) return undefined;
	return {
		x: t.ox + (numAttr(off, "x") ?? 0) * t.sx,
		y: t.oy + (numAttr(off, "y") ?? 0) * t.sy,
		w: (numAttr(ext, "cx") ?? 0) * t.sx,
		h: (numAttr(ext, "cy") ?? 0) * t.sy,
		rot: (numAttr(xfrm, "rot") ?? 0) / 60000,
		flipH: attr(xfrm, "flipH") === "1",
		flipV: attr(xfrm, "flipV") === "1",
	};
}

// ---------------------------------------------------------------------------
// Placeholders and inheritance
// ---------------------------------------------------------------------------

function placeholderOf(sp: XmlElement): { type: string; idx?: string } | undefined {
	const nv = children(sp).find((c) => c.local.startsWith("nv"));
	const ph = child(child(nv, "nvPr"), "ph");
	if (!ph) return undefined;
	return { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") };
}

function normalizeType(type: string): string {
	if (type === "ctrTitle") return "title";
	if (type === "subTitle" || type === "obj" || type === "body") return "body";
	return type;
}

function findPlaceholder(
	list: PlaceholderInfo[] | undefined,
	ph: { type: string; idx?: string },
): XmlElement | undefined {
	if (!list) return undefined;
	if (ph.idx !== undefined) {
		const byIdx = list.find(
			(p) => p.idx === ph.idx && (ph.type === "obj" || normalizeType(p.type) === normalizeType(ph.type)),
		);
		if (byIdx) return byIdx.sp;
		const loose = list.find((p) => p.idx === ph.idx);
		if (loose && ph.type === "obj") return loose.sp;
	}
	const type = normalizeType(ph.type);
	return (
		list.find((p) => p.type === ph.type)?.sp ??
		list.find((p) => normalizeType(p.type) === type)?.sp ??
		(ph.idx !== undefined ? list.find((p) => p.idx === ph.idx)?.sp : undefined)
	);
}

function textStyleFor(type: string, scope: Scope): LevelStyles {
	if (!scope.master) return emptyLevels();
	const t = normalizeType(type);
	if (t === "title") return scope.titleStyle;
	if (t === "body") return scope.bodyStyle;
	return scope.otherStyle;
}

interface Inherited {
	/** The same shape on the layout, then the master, nearest first. */
	chain: XmlElement[];
	levels: LevelStyles;
}

function inheritance(sp: XmlElement, scope: Scope, templateOnly: boolean): Inherited {
	const ph = placeholderOf(sp);
	if (!ph || templateOnly) {
		const levels = mergeLevels(scope.defaultText, scope.otherStyle);
		return { chain: [], levels };
	}
	const layoutSp = findPlaceholder(scope.layout?.placeholders, ph);
	const layoutPh = layoutSp ? tpl(layoutSp).ph : undefined;
	// Master placeholders match by type only: their idx values are unrelated to the layout's.
	const masterType = normalizeType((layoutPh ?? ph).type);
	const masterSp = scope.master?.placeholders.find((p) => normalizeType(p.type) === masterType)?.sp;
	const chain = [layoutSp, masterSp].filter((x): x is XmlElement => !!x);
	let levels = textStyleFor(layoutPh?.type ?? ph.type, scope);
	if (masterSp) levels = mergeLevels(levels, levelsOf(tpl(masterSp).lstStyle, scope));
	if (layoutSp) levels = mergeLevels(levels, levelsOf(tpl(layoutSp).lstStyle, scope));
	return { chain, levels };
}

/** A text body's bodyPr with its autofit choice found once. */
interface BodyPr {
	el?: XmlElement;
	autofit?: XmlElement;
}

function bodyPrOf(txBody: XmlElement | undefined): BodyPr {
	const el = child(txBody, "bodyPr");
	return { el, autofit: child(el, "normAutofit") ?? child(el, "noAutofit") ?? child(el, "spAutoFit") };
}

/** What slides inherit from a layout or master shape, read from its XML once. */
interface TemplateShape {
	ph?: { type: string; idx?: string };
	spPr?: XmlElement;
	xfrm?: XmlElement;
	/** The spPr, when it holds a preset or custom geometry. */
	geomSpPr?: XmlElement;
	bodyPr: BodyPr;
	lstStyle?: XmlElement;
	/** Fills and outlines resolved per color map. */
	fills: Map<string, Fill | undefined>;
	lines: Map<string, Line | null | undefined>;
}

const templateShapes = new WeakMap<XmlElement, TemplateShape>();

function tpl(sp: XmlElement): TemplateShape {
	let t = templateShapes.get(sp);
	if (!t) {
		const spPr = spPrOf(sp);
		const txBody = child(sp, "txBody");
		t = {
			ph: placeholderOf(sp),
			spPr,
			xfrm: child(spPr, "xfrm"),
			geomSpPr: child(spPr, "prstGeom") || child(spPr, "custGeom") ? spPr : undefined,
			bodyPr: bodyPrOf(txBody),
			lstStyle: child(txBody, "lstStyle"),
			fills: new Map(),
			lines: new Map(),
		};
		templateShapes.set(sp, t);
	}
	return t;
}

function memo<T>(cache: Map<string, T>, key: string, make: () => T): T {
	if (cache.has(key)) return cache.get(key) as T;
	const v = make();
	cache.set(key, v);
	return v;
}

const levelCache = new WeakMap<XmlElement, Map<string, LevelStyles>>();

/** An lstStyle's levels, parsed once per element and color map. */
function levelsOf(list: XmlElement | undefined, scope: Pick<Scope, "ctx" | "ctxKey">): LevelStyles {
	if (!list) return emptyLevels();
	let byKey = levelCache.get(list);
	if (!byKey) {
		byKey = new Map();
		levelCache.set(list, byKey);
	}
	return memo(byKey, scope.ctxKey, () => parseLevels(list, scope.ctx));
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function spPrOf(sp: XmlElement): XmlElement | undefined {
	return child(sp, "spPr");
}

function readShape(
	sp: XmlElement,
	part: Part,
	ctx: ColorContext,
	scope: Scope,
	transform: Transform,
	templateOnly: boolean,
): ShapeElement | undefined {
	const inh = inheritance(sp, scope, templateOnly);
	// Layout and master shapes come through tpl(), read once per file however many slides use them.
	const chain = inh.chain.map(tpl);
	const spPr = spPrOf(sp);
	const xfrm = child(spPr, "xfrm") ?? chain.find((c) => c.xfrm)?.xfrm;
	const box = boxFrom(xfrm, transform);
	if (!box) return undefined;

	const ownGeom = child(spPr, "prstGeom") || child(spPr, "custGeom") ? spPr : undefined;
	const geomSource = ownGeom ?? chain.find((c) => c.geomSpPr)?.geomSpPr;
	const prst = child(geomSource, "prstGeom");
	const cust = child(geomSource, "custGeom");
	const adj: Record<string, number> = {};
	for (const gd of children(child(prst, "avLst"), "gd")) {
		const m = /^val\s+(-?\d+)/.exec(attr(gd, "fmla") ?? "");
		const name = attr(gd, "name");
		if (m && name) adj[name] = Number(m[1]);
	}
	const style = child(sp, "style");
	const resolveImage = (rid: string) => scope.reader.imageFor(part, rid);

	let fill = fillIn(spPr, ctx, resolveImage);
	if (!fill) {
		for (const c of chain) {
			fill = memo(c.fills, scope.ctxKey, () => fillIn(c.spPr, ctx));
			if (fill) break;
		}
	}
	if (!fill && style) {
		const ref = child(style, "fillRef");
		fill = styleFill(ctx.theme, numAttr(ref, "idx") ?? 0, { ...ctx, phClr: colorIn(ref, ctx) });
	}

	let line = lineOf(child(spPr, "ln"), ctx);
	if (line === undefined) {
		for (const c of chain) {
			line = memo(c.lines, scope.ctxKey, () => lineOf(child(c.spPr, "ln"), ctx));
			if (line !== undefined) break;
		}
	}
	if (line === undefined && style) {
		const ref = child(style, "lnRef");
		line = styleLine(ctx.theme, numAttr(ref, "idx") ?? 0, { ...ctx, phClr: colorIn(ref, ctx) });
		const w = numAttr(child(spPr, "ln"), "w");
		if (line && w) line = { ...line, width: w };
	}

	const shape: ShapeElement = { kind: "shape", box, adj, fill, line };
	if (prst) shape.preset = attr(prst, "prst") ?? "rect";
	else if (cust) {
		// Path commands come out of one deck-wide budget, since template shapes redraw on every slide.
		const budget = scope.reader.budget;
		const geometry = customGeometryPaths(
			cust,
			box.w,
			box.h,
			Math.min(MAX_PATH_COMMANDS, Math.max(0, budget.commands)),
		);
		shape.paths = geometry.paths;
		budget.commands -= geometry.commands;
		budget.elements -= shape.paths.length;
	} else shape.preset = "rect";
	const ln = child(spPr, "ln");
	shape.headEnd = isArrow(child(ln, "headEnd"));
	shape.tailEnd = isArrow(child(ln, "tailEnd"));

	const txBody = child(sp, "txBody");
	if (txBody) {
		const fontColor = style ? colorIn(child(style, "fontRef"), ctx) : undefined;
		const fontFace = style ? attr(child(style, "fontRef"), "idx") : undefined;
		const base: RunStyle = {};
		if (fontColor) base.color = fontColor;
		if (fontFace === "major" && ctx.theme.majorFont) base.font = ctx.theme.majorFont;
		const bodyChain = [bodyPrOf(txBody), ...chain.map((c) => c.bodyPr)];
		const text = readTextBody(txBody, inh.levels, bodyChain, ctx, base, scope.reader.budget);
		if (text.paragraphs.some((p) => p.runs.some((r) => r.text.trim().length > 0))) shape.text = text;
	}
	return shape;
}

function isArrow(el: XmlElement | undefined): boolean {
	const type = attr(el, "type");
	return !!type && type !== "none";
}

function readPicture(
	pic: XmlElement,
	part: Part,
	ctx: ColorContext,
	scope: Scope,
	transform: Transform,
): PictureElement | undefined {
	const spPr = child(pic, "spPr");
	const inh = placeholderOf(pic) ? inheritance(pic, scope, false) : { chain: [] as XmlElement[] };
	const xfrm = child(spPr, "xfrm") ?? inh.chain.map((c) => child(spPrOf(c), "xfrm")).find((x) => !!x);
	const box = boxFrom(xfrm, transform);
	if (!box) return undefined;
	const blipFill = child(pic, "blipFill");
	const rid = attr(child(blipFill, "blip"), "embed");
	const out: PictureElement = { kind: "picture", box, line: lineOf(child(spPr, "ln"), ctx) };
	if (rid) {
		out.image = scope.reader.imageFor(part, rid);
		if (!out.image) out.unsupported = scope.reader.unsupportedImage(part, rid);
	}
	const src = child(blipFill, "srcRect");
	if (src) {
		const p = (n: string) => (numAttr(src, n) ?? 0) / 100000;
		out.crop = { l: p("l"), t: p("t"), r: p("r"), b: p("b") };
	}
	const prst = attr(child(spPr, "prstGeom"), "prst");
	if (prst && prst !== "rect") out.preset = prst;
	return out;
}

function readGraphicFrame(
	frame: XmlElement,
	part: Part,
	ctx: ColorContext,
	scope: Scope,
	transform: Transform,
): SlideElement | undefined {
	const box = boxFrom(child(frame, "xfrm"), transform);
	if (!box) return undefined;
	const data = child(child(frame, "graphic"), "graphicData");
	const uri = attr(data, "uri") ?? "";
	const tbl = child(data, "tbl");
	if (tbl) return readTable(tbl, box, ctx, scope);
	// An embedded object usually carries a picture of itself.
	const ole = child(data, "oleObj") ?? child(child(child(data, "AlternateContent"), "Fallback"), "oleObj");
	const olePic = child(ole, "pic");
	if (olePic) {
		const rid = attr(child(child(olePic, "blipFill"), "blip"), "embed");
		const image = rid ? scope.reader.imageFor(part, rid) : undefined;
		if (image) return { kind: "picture", box, image };
	}
	let label = "Embedded object";
	if (uri.endsWith("/chart") || uri.includes("chart")) label = "Chart";
	else if (uri.endsWith("/diagram")) label = "SmartArt diagram";
	return { kind: "placeholder", box, label };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const PLAIN_TABLE_STYLES = new Set([
	"{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
	"{5940675A-B579-460E-94D1-54222C63F5DA}",
]);

function readTable(tbl: XmlElement, box: Box, ctx: ColorContext, scope: Scope): TableElement {
	const columns = children(child(tbl, "tblGrid"), "gridCol")
		.slice(0, PREVIEW_LIMITS.maxTableColumns)
		.map((c) => numAttr(c, "w") ?? 0);
	scope.reader.budget.elements -= columns.length;
	const tblPr = child(tbl, "tblPr");
	const styleId = textOf(child(tblPr, "tableStyleId")).trim();
	const styled = !!styleId && !PLAIN_TABLE_STYLES.has(styleId);
	const gridLines = styleId === "{5940675A-B579-460E-94D1-54222C63F5DA}";
	const firstRow = attr(tblPr, "firstRow") === "1";
	const bandRow = attr(tblPr, "bandRow") === "1";
	const explicitFill = fillIn(tblPr, ctx);
	const accent = ctx.theme.colors.accent1 ?? "4472C4";
	const tint = (pct: number) => {
		const n = Number.parseInt(accent, 16);
		const mix = (v: number) => Math.round(v + (255 - v) * (1 - pct));
		const r = mix((n >> 16) & 255);
		const g = mix((n >> 8) & 255);
		const b = mix(n & 255);
		return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
	};
	const levels = mergeLevels(scope.defaultText, scope.otherStyle);
	const rows: TableElement["rows"] = [];
	const budget = scope.reader.budget;
	let cellsLeft = PREVIEW_LIMITS.maxTableCells;
	children(tbl, "tr")
		.slice(0, PREVIEW_LIMITS.maxTableRows)
		.forEach((tr, rowIndex) => {
			if (cellsLeft <= 0 || budget.elements <= 0) return;
			const header = firstRow && rowIndex === 0;
			const body = firstRow ? rowIndex - 1 : rowIndex;
			const tcs = children(tr, "tc").slice(0, Math.min(PREVIEW_LIMITS.maxTableColumns, cellsLeft));
			cellsLeft -= tcs.length;
			// Every cell is drawn, so every cell costs an element.
			budget.elements -= tcs.length;
			const cells: TableCell[] = tcs.map((tc) => {
				const tcPr = child(tc, "tcPr");
				let fill = fillIn(tcPr, ctx) ?? explicitFill;
				const base: RunStyle = {};
				if (!fill && styled) {
					if (header) {
						fill = { type: "solid", color: `#${accent}` };
						base.color = `#${ctx.theme.colors.lt1 ?? "FFFFFF"}`;
						base.bold = true;
					} else {
						fill = { type: "solid", color: bandRow && body % 2 === 0 ? tint(0.4) : tint(0.2) };
					}
				}
				const insets: [number, number, number, number] = [
					numAttr(tcPr, "marL") ?? 91440,
					numAttr(tcPr, "marT") ?? 45720,
					numAttr(tcPr, "marR") ?? 91440,
					numAttr(tcPr, "marB") ?? 45720,
				];
				const txBody = child(tc, "txBody");
				const text = txBody
					? readTextBody(txBody, levels, [bodyPrOf(txBody)], ctx, base, scope.reader.budget)
					: undefined;
				if (text) {
					text.insets = insets;
					const anchor = attr(tcPr, "anchor");
					text.anchor = anchor === "ctr" || anchor === "b" ? anchor : "t";
					text.wrap = true;
				}
				const border = (name: string): Line | null | undefined => {
					const own = lineOf(child(tcPr, name), ctx);
					if (own !== undefined) return own;
					if (styled) return { color: `#${ctx.theme.colors.lt1 ?? "FFFFFF"}`, width: 12700 };
					if (gridLines) return { color: `#${ctx.theme.colors.dk1 ?? "000000"}`, width: 12700 };
					return undefined;
				};
				return {
					text,
					fill,
					gridSpan: Math.min(Math.max(1, numAttr(tc, "gridSpan") ?? 1), Math.max(1, columns.length)),
					rowSpan: Math.min(Math.max(1, numAttr(tc, "rowSpan") ?? 1), PREVIEW_LIMITS.maxTableRows),
					merged: attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1",
					borders: { l: border("lnL"), r: border("lnR"), t: border("lnT"), b: border("lnB") },
				};
			});
			// Every row draws a <tr>, empty or not, so every row costs an element.
			budget.elements--;
			rows.push({ height: numAttr(tr, "h") ?? 0, cells: fitRow(cells, PREVIEW_LIMITS.maxTableColumns) });
		});
	return { kind: "table", box, columns, rows };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function readTextBody(
	txBody: XmlElement,
	inheritedLevels: LevelStyles,
	bodyPrChain: BodyPr[],
	ctx: ColorContext,
	base: RunStyle,
	budget: Budget,
): TextBody {
	// Nearest bodyPr wins per attribute.
	const bodyAttr = (name: string): string | undefined => {
		for (const b of bodyPrChain) {
			const v = attr(b.el, name);
			if (v !== undefined) return v;
		}
		return undefined;
	};
	const bodyChild = (name: string): XmlElement | undefined => {
		for (const b of bodyPrChain) {
			if (b.autofit) return b.autofit.local === name ? b.autofit : undefined;
		}
		return undefined;
	};
	const anchorAttr = bodyAttr("anchor");
	const anchor = anchorAttr === "ctr" || anchorAttr === "b" ? anchorAttr : "t";
	const num = (name: string, dflt: number) => {
		const v = Number(bodyAttr(name));
		return Number.isFinite(v) && bodyAttr(name) !== undefined ? v : dflt;
	};
	const norm = bodyChild("normAutofit");
	const fontScale = norm ? (numAttr(norm, "fontScale") ?? 100000) / 100000 : 1;
	const lineReduction = norm ? (numAttr(norm, "lnSpcReduction") ?? 0) / 100000 : 0;
	const vert = bodyAttr("vert");

	let levels = inheritedLevels;
	const own = child(txBody, "lstStyle");
	if (own && children(own).length > 0) levels = mergeLevels(levels, parseLevels(own, ctx));

	const paragraphs: TextParagraph[] = [];
	const counters: number[] = [];
	for (const p of children(txBody, "p")) {
		// Each paragraph costs a run, even an empty one, and a body holds at most MAX_PARAGRAPHS.
		if (budget.runs <= 0 || paragraphs.length >= MAX_PARAGRAPHS) break;
		budget.runs--;
		const pPr = child(p, "pPr");
		const level = Math.min(8, Math.max(0, numAttr(pPr, "lvl") ?? 0));
		let style = levels[level] ?? { run: {} };
		// Text with no font named anywhere uses the theme's body font.
		style = { ...style, run: mergeRun(mergeRun({ font: ctx.theme.minorFont }, style.run), base) };
		style = mergePara(style, parseParaStyle(pPr, ctx));
		const runs: TextRun[] = [];
		for (const r of children(p)) {
			if (budget.runs <= 0) break;
			if (r.local === "r" || r.local === "br" || r.local === "fld") budget.runs--;
			if (r.local === "r" || r.local === "fld") {
				let text = textOf(child(r, "t"));
				if (text.length > MAX_RUN_CHARS) text = text.slice(0, MAX_RUN_CHARS);
				budget.chars -= text.length;
				if (budget.chars < 0) break;
				const isSlideNumber = r.local === "fld" && attr(r, "type") === "slidenum";
				runs.push({
					text: isSlideNumber ? "#" : text,
					style: mergeRun(style.run, parseRunStyle(child(r, "rPr"), ctx)),
					...(isSlideNumber ? { slideNumber: true } : {}),
				});
			} else if (r.local === "br") {
				runs.push({ text: "\n", br: true, style: mergeRun(style.run, parseRunStyle(child(r, "rPr"), ctx)) });
			}
		}
		const para: TextParagraph = { level, style, runs };
		const hasText = runs.some((r) => r.text.length > 0 && !r.br);
		if (!hasText) {
			const end = parseRunStyle(child(p, "endParaRPr"), ctx);
			para.emptySize = end.size ?? style.run.size;
		}
		// Numbering restarts after a paragraph at a shallower level or without numbering.
		counters.length = Math.min(counters.length, level + 1);
		const bullet = style.bullet;
		if (hasText && bullet && bullet.kind !== "none") {
			const color = style.bulletColor ?? style.run.color ?? runs[0]?.style.color;
			if (bullet.kind === "char") {
				para.bullet = { text: bullet.char, color, font: style.bulletFont, sizePct: style.bulletSizePct };
				counters[level] = 0;
			} else {
				const n = counters[level] ? counters[level] + 1 : bullet.startAt;
				counters[level] = n;
				para.bullet = { text: autoNumberLabel(bullet.scheme, n), color, sizePct: style.bulletSizePct };
			}
		} else if (hasText) {
			counters[level] = 0;
		}
		paragraphs.push(para);
	}
	return {
		paragraphs,
		anchor,
		insets: [num("lIns", 91440), num("tIns", 45720), num("rIns", 91440), num("bIns", 45720)],
		wrap: bodyAttr("wrap") !== "none",
		vertical: vert && vert !== "horz" ? vert : undefined,
		fontScale,
		lineReduction,
	};
}

/** Read a .pptx file into slides. Throws on files that are not presentations. */
export async function readPptx(bytes: Uint8Array): Promise<Deck> {
	const zip = await SafeZip.open(bytes);
	const reader = new PptxReader(zip);
	const deck = await reader.read();
	await reader.loadImages();
	return deck;
}
