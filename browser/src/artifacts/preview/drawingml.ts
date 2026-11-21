/**
 * DrawingML pieces shared by the pptx reader: colors, fills, lines, text styles and preset
 * geometry. Everything here is pure (no DOM) so it runs in unit tests.
 */
import { attr, child, children, type XmlElement } from "./xml.js";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export interface Theme {
	colors: Record<string, string>;
	majorFont?: string;
	minorFont?: string;
	fillStyles: XmlElement[];
	lineStyles: XmlElement[];
	bgFillStyles: XmlElement[];
}

export interface ColorContext {
	theme: Theme;
	/** bg1 -> lt1 and so on, from the master's clrMap and any override. */
	clrMap: Record<string, string>;
	/** The color that stands in for phClr inside a style reference. */
	phClr?: string;
}

const DEFAULT_CLR_MAP: Record<string, string> = {
	bg1: "lt1",
	tx1: "dk1",
	bg2: "lt2",
	tx2: "dk2",
};

export function emptyTheme(): Theme {
	return {
		colors: {
			dk1: "000000",
			lt1: "FFFFFF",
			dk2: "44546A",
			lt2: "E7E6E6",
			accent1: "4472C4",
			accent2: "ED7D31",
			accent3: "A5A5A5",
			accent4: "FFC000",
			accent5: "5B9BD5",
			accent6: "70AD47",
			hlink: "0563C1",
			folHlink: "954F72",
		},
		fillStyles: [],
		lineStyles: [],
		bgFillStyles: [],
	};
}

export function parseTheme(root: XmlElement | undefined): Theme {
	const theme = emptyTheme();
	if (!root) return theme;
	const elements = child(root, "themeElements");
	const scheme = child(elements, "clrScheme");
	for (const c of children(scheme)) {
		const srgb = child(c, "srgbClr");
		const sys = child(c, "sysClr");
		const val = attr(srgb, "val") ?? attr(sys, "lastClr");
		if (val && /^[0-9a-fA-F]{6}$/.test(val)) theme.colors[c.local] = val.toUpperCase();
	}
	const fonts = child(elements, "fontScheme");
	theme.majorFont = attr(child(child(fonts, "majorFont"), "latin"), "typeface") || undefined;
	theme.minorFont = attr(child(child(fonts, "minorFont"), "latin"), "typeface") || undefined;
	const fmt = child(elements, "fmtScheme");
	theme.fillStyles = children(child(fmt, "fillStyleLst"));
	theme.lineStyles = children(child(fmt, "lnStyleLst"));
	theme.bgFillStyles = children(child(fmt, "bgFillStyleLst"));
	return theme;
}

export function parseClrMap(el: XmlElement | undefined, base?: Record<string, string>): Record<string, string> {
	const map: Record<string, string> = { ...(base ?? DEFAULT_CLR_MAP) };
	if (!el) return map;
	for (const [k, v] of Object.entries(el.attrs)) map[k] = v;
	return map;
}

const PRESET_COLORS: Record<string, string> = {
	black: "000000",
	white: "FFFFFF",
	red: "FF0000",
	green: "008000",
	blue: "0000FF",
	yellow: "FFFF00",
	gray: "808080",
	grey: "808080",
	darkGray: "A9A9A9",
	lightGray: "D3D3D3",
	orange: "FFA500",
	purple: "800080",
	navy: "000080",
	teal: "008080",
	silver: "C0C0C0",
	maroon: "800000",
	olive: "808000",
	lime: "00FF00",
	aqua: "00FFFF",
	cyan: "00FFFF",
	magenta: "FF00FF",
	fuchsia: "FF00FF",
	brown: "A52A2A",
	pink: "FFC0CB",
	gold: "FFD700",
};

const SYS_COLORS: Record<string, string> = { windowText: "000000", window: "FFFFFF" };

interface Rgba {
	r: number;
	g: number;
	b: number;
	a: number;
}

function hexToRgba(hex: string): Rgba {
	const n = Number.parseInt(hex, 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

function rgbToHsl({ r, g, b }: Rgba): [number, number, number] {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
	else if (max === gn) h = (bn - rn) / d + 2;
	else h = (rn - gn) / d + 4;
	return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
	if (s === 0) {
		const v = Math.round(l * 255);
		return { r: v, g: v, b: v, a };
	}
	const hue = (p: number, q: number, t: number) => {
		let tt = t;
		if (tt < 0) tt += 1;
		if (tt > 1) tt -= 1;
		if (tt < 1 / 6) return p + (q - p) * 6 * tt;
		if (tt < 1 / 2) return q;
		if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return {
		r: Math.round(hue(p, q, h + 1 / 3) * 255),
		g: Math.round(hue(p, q, h) * 255),
		b: Math.round(hue(p, q, h - 1 / 3) * 255),
		a,
	};
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const toLinear = (v: number) => {
	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (l: number) => {
	const c = clamp01(l);
	return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

function mapLinear(c: Rgba, f: (l: number) => number): Rgba {
	return { r: toSrgb(f(toLinear(c.r))), g: toSrgb(f(toLinear(c.g))), b: toSrgb(f(toLinear(c.b))), a: c.a };
}

function applyModifiers(base: Rgba, el: XmlElement): Rgba {
	let c = { ...base };
	for (const m of children(el)) {
		const v = Number(attr(m, "val") ?? "0") / 100000;
		switch (m.local) {
			case "alpha":
				c.a = clamp01(v);
				break;
			case "lumMod": {
				const [h, s, l] = rgbToHsl(c);
				c = hslToRgb(h, s, clamp01(l * v), c.a);
				break;
			}
			case "lumOff": {
				const [h, s, l] = rgbToHsl(c);
				c = hslToRgb(h, s, clamp01(l + v), c.a);
				break;
			}
			case "satMod": {
				const [h, s, l] = rgbToHsl(c);
				c = hslToRgb(h, clamp01(s * v), l, c.a);
				break;
			}
			// Office applies tint and shade in linear light, not to the sRGB values.
			case "tint":
				c = mapLinear(c, (l) => l * v + (1 - v));
				break;
			case "shade":
				c = mapLinear(c, (l) => l * v);
				break;
		}
	}
	return c;
}

function rgbaToCss(c: Rgba): string {
	const hex = (v: number) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, "0");
	if (c.a >= 1) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
	return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * 1000) / 1000})`;
}

/** The CSS color of one color element (srgbClr, schemeClr, sysClr, prstClr, scrgbClr). */
export function colorOf(el: XmlElement | undefined, ctx: ColorContext): string | undefined {
	if (!el) return undefined;
	let hex: string | undefined;
	switch (el.local) {
		case "srgbClr":
			hex = attr(el, "val");
			break;
		case "schemeClr": {
			const val = attr(el, "val") ?? "";
			if (val === "phClr") {
				if (!ctx.phClr) return undefined;
				hex = ctx.phClr.replace("#", "");
				if (!/^[0-9a-fA-F]{6}$/.test(hex)) return ctx.phClr;
			} else {
				const mapped = ctx.clrMap[val] ?? val;
				hex = ctx.theme.colors[mapped];
			}
			break;
		}
		case "sysClr":
			hex = attr(el, "lastClr") ?? SYS_COLORS[attr(el, "val") ?? ""];
			break;
		case "prstClr":
			hex = PRESET_COLORS[attr(el, "val") ?? ""];
			break;
		case "scrgbClr": {
			const comp = (n: string) => Math.round(clamp01(Number(attr(el, n) ?? "0") / 100000) ** (1 / 2.2) * 255);
			hex = [comp("r"), comp("g"), comp("b")].map((v) => v.toString(16).padStart(2, "0")).join("");
			break;
		}
		default:
			return undefined;
	}
	if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	return rgbaToCss(applyModifiers(hexToRgba(hex), el));
}

const COLOR_NAMES = new Set(["srgbClr", "schemeClr", "sysClr", "prstClr", "scrgbClr"]);

/** The color held directly inside a container such as solidFill, buClr or a style reference. */
export function colorIn(container: XmlElement | undefined, ctx: ColorContext): string | undefined {
	for (const c of children(container)) if (COLOR_NAMES.has(c.local)) return colorOf(c, ctx);
	return undefined;
}

// ---------------------------------------------------------------------------
// Fills and lines
// ---------------------------------------------------------------------------

const MAX_GRADIENT_STOPS = 64;

export type Fill =
	| { type: "none" }
	| { type: "solid"; color: string }
	| { type: "gradient"; angle: number; radial: boolean; stops: { pos: number; color: string }[] }
	| { type: "image"; image: string; tile?: boolean };

export interface Line {
	color: string;
	/** Width in EMU. */
	width: number;
	dash?: string;
}

/** A fill from the first fill element among `container`'s children (spPr, bgPr, tcPr). */
export function fillIn(
	container: XmlElement | undefined,
	ctx: ColorContext,
	resolveImage?: (rid: string) => string | undefined,
): Fill | undefined {
	for (const c of children(container)) {
		const f = fillOf(c, ctx, resolveImage);
		if (f) return f;
	}
	return undefined;
}

export function fillOf(
	el: XmlElement,
	ctx: ColorContext,
	resolveImage?: (rid: string) => string | undefined,
): Fill | undefined {
	switch (el.local) {
		case "noFill":
			return { type: "none" };
		case "solidFill": {
			const color = colorIn(el, ctx);
			return color ? { type: "solid", color } : undefined;
		}
		case "gradFill": {
			// A real gradient has a few stops; more only multiply the work on every slide.
			const stops = children(child(el, "gsLst"), "gs")
				.slice(0, MAX_GRADIENT_STOPS)
				.map((gs) => ({ pos: Number(attr(gs, "pos") ?? "0") / 100000, color: colorIn(gs, ctx) }))
				.filter((s): s is { pos: number; color: string } => !!s.color)
				.sort((a, b) => a.pos - b.pos);
			if (stops.length === 0) return undefined;
			if (stops.length === 1) return { type: "solid", color: stops[0].color };
			const lin = child(el, "lin");
			const angle = lin ? Number(attr(lin, "ang") ?? "0") / 60000 : 90;
			return { type: "gradient", angle, radial: !!child(el, "path") && !lin, stops };
		}
		case "blipFill": {
			// A duotone image is recolored into two theme shades; its darker shade stands in for it.
			const duotone = child(child(el, "blip"), "duotone");
			if (duotone) {
				const shade = children(duotone)
					.map((c) => colorOf(c, ctx))
					.find((c) => !!c);
				if (shade) return { type: "solid", color: shade };
			}
			const rid = attr(child(el, "blip"), "embed");
			const image = rid && resolveImage ? resolveImage(rid) : undefined;
			return image ? { type: "image", image, tile: !!child(el, "tile") } : undefined;
		}
		case "grpFill":
			return undefined;
	}
	return undefined;
}

export function lineOf(ln: XmlElement | undefined, ctx: ColorContext): Line | null | undefined {
	if (!ln) return undefined;
	if (child(ln, "noFill")) return null;
	const color =
		colorIn(child(ln, "solidFill"), ctx) ?? colorIn(child(child(child(ln, "gradFill"), "gsLst"), "gs"), ctx);
	if (!color) return undefined;
	const width = Number(attr(ln, "w") ?? "12700");
	const dash = attr(child(ln, "prstDash"), "val");
	return { color, width: Number.isFinite(width) ? width : 12700, dash: dash && dash !== "solid" ? dash : undefined };
}

/** Theme fill style for a fillRef or bgRef index, with phClr bound to the reference's color. */
export function styleFill(
	theme: Theme,
	idx: number,
	ctx: ColorContext,
	resolveImage?: (rid: string) => string | undefined,
): Fill | undefined {
	if (idx === 0) return { type: "none" };
	const list = idx >= 1000 ? theme.bgFillStyles : theme.fillStyles;
	const el = list[(idx >= 1000 ? idx - 1001 : idx - 1) | 0];
	if (!el) return ctx.phClr ? { type: "solid", color: ctx.phClr } : undefined;
	return fillOf(el, ctx, resolveImage) ?? (ctx.phClr ? { type: "solid", color: ctx.phClr } : undefined);
}

export function styleLine(theme: Theme, idx: number, ctx: ColorContext): Line | null | undefined {
	if (idx === 0) return null;
	const el = theme.lineStyles[idx - 1];
	if (!el) return ctx.phClr ? { color: ctx.phClr, width: 12700 } : undefined;
	return lineOf(el, ctx);
}

// ---------------------------------------------------------------------------
// Text styles
// ---------------------------------------------------------------------------

export interface RunStyle {
	/** Font size in points. */
	size?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strike?: boolean;
	color?: string;
	font?: string;
	/** Percent raise: positive is superscript. */
	baseline?: number;
	caps?: "all" | "small";
	highlight?: string;
}

export type Bullet =
	| { kind: "none" }
	| { kind: "char"; char: string; font?: string; color?: string; sizePct?: number }
	| { kind: "autonum"; scheme: string; startAt: number; color?: string; sizePct?: number };

export interface ParaStyle {
	align?: string;
	/** EMU. */
	marL?: number;
	/** EMU, usually negative for a hanging bullet. */
	indent?: number;
	/** Line spacing as a multiple (1 = single) or points when `lineSpacingPts` is set. */
	lineSpacing?: number;
	lineSpacingPts?: number;
	/** Space before and after, in points, or as a percent of the font size when the Pct variant is set. */
	spaceBefore?: number;
	spaceBeforePct?: number;
	spaceAfter?: number;
	spaceAfterPct?: number;
	bullet?: Bullet;
	bulletColor?: string;
	bulletFont?: string;
	bulletSizePct?: number;
	run: RunStyle;
}

const isTrue = (v: string | undefined) => v === "1" || v === "true" || v === "on";

export function resolveFont(face: string | undefined, theme: Theme): string | undefined {
	if (!face) return undefined;
	if (face.startsWith("+mj")) return theme.majorFont;
	if (face.startsWith("+mn")) return theme.minorFont;
	return face;
}

export function parseRunStyle(rPr: XmlElement | undefined, ctx: ColorContext): RunStyle {
	const s: RunStyle = {};
	if (!rPr) return s;
	const sz = attr(rPr, "sz");
	if (sz) s.size = Number(sz) / 100;
	const b = attr(rPr, "b");
	if (b !== undefined) s.bold = isTrue(b);
	const i = attr(rPr, "i");
	if (i !== undefined) s.italic = isTrue(i);
	const u = attr(rPr, "u");
	if (u !== undefined) s.underline = u !== "none";
	const strike = attr(rPr, "strike");
	if (strike !== undefined) s.strike = strike !== "noStrike";
	const baseline = attr(rPr, "baseline");
	if (baseline !== undefined) s.baseline = Number(baseline) / 1000;
	const cap = attr(rPr, "cap");
	if (cap === "all" || cap === "small") s.caps = cap;
	const fill = child(rPr, "solidFill");
	if (fill) s.color = colorIn(fill, ctx);
	else if (child(rPr, "noFill")) s.color = "transparent";
	else {
		const grad = child(rPr, "gradFill");
		if (grad) s.color = colorIn(child(child(grad, "gsLst"), "gs"), ctx);
	}
	const latin = attr(child(rPr, "latin"), "typeface");
	const font = resolveFont(latin, ctx.theme);
	if (font) s.font = font;
	const hl = colorIn(child(rPr, "highlight"), ctx);
	if (hl) s.highlight = hl;
	return s;
}

function spacing(el: XmlElement | undefined): { pts?: number; pct?: number } {
	if (!el) return {};
	const pts = attr(child(el, "spcPts"), "val");
	if (pts !== undefined) return { pts: Number(pts) / 100 };
	const pct = attr(child(el, "spcPct"), "val");
	if (pct !== undefined) return { pct: Number(pct) / 100000 };
	return {};
}

export function parseParaStyle(pPr: XmlElement | undefined, ctx: ColorContext): ParaStyle {
	const s: ParaStyle = { run: {} };
	if (!pPr) return s;
	const algn = attr(pPr, "algn");
	if (algn) s.align = algn;
	const marL = attr(pPr, "marL");
	if (marL !== undefined) s.marL = Number(marL);
	const indent = attr(pPr, "indent");
	if (indent !== undefined) s.indent = Number(indent);
	const ln = spacing(child(pPr, "lnSpc"));
	if (ln.pct !== undefined) s.lineSpacing = ln.pct;
	if (ln.pts !== undefined) s.lineSpacingPts = ln.pts;
	const before = spacing(child(pPr, "spcBef"));
	if (before.pts !== undefined) s.spaceBefore = before.pts;
	if (before.pct !== undefined) s.spaceBeforePct = before.pct;
	const after = spacing(child(pPr, "spcAft"));
	if (after.pts !== undefined) s.spaceAfter = after.pts;
	if (after.pct !== undefined) s.spaceAfterPct = after.pct;
	if (child(pPr, "buNone")) s.bullet = { kind: "none" };
	const buChar = child(pPr, "buChar");
	if (buChar) s.bullet = { kind: "char", char: attr(buChar, "char") ?? "•" };
	const buAuto = child(pPr, "buAutoNum");
	if (buAuto) {
		s.bullet = {
			kind: "autonum",
			scheme: attr(buAuto, "type") ?? "arabicPeriod",
			startAt: Number(attr(buAuto, "startAt") ?? "1") || 1,
		};
	}
	const buClr = child(pPr, "buClr");
	if (buClr) s.bulletColor = colorIn(buClr, ctx);
	const buFont = attr(child(pPr, "buFont"), "typeface");
	if (buFont) s.bulletFont = resolveFont(buFont, ctx.theme);
	const buSz = attr(child(pPr, "buSzPct"), "val");
	if (buSz) s.bulletSizePct = Number(buSz) / 100000;
	s.run = parseRunStyle(child(pPr, "defRPr"), ctx);
	return s;
}

function defined<T extends object>(o: T): Partial<T> {
	const out: Partial<T> = {};
	for (const k of Object.keys(o) as (keyof T)[]) if (o[k] !== undefined) out[k] = o[k];
	return out;
}

export function mergeRun(base: RunStyle, over: RunStyle): RunStyle {
	return { ...base, ...defined(over) };
}

export function mergePara(base: ParaStyle, over: ParaStyle): ParaStyle {
	const { run: overRun, ...rest } = over;
	const merged: ParaStyle = { ...base, ...defined(rest), run: mergeRun(base.run, overRun) };
	// A size or spacing in points replaces a percentage from an earlier level and vice versa.
	if (rest.lineSpacingPts !== undefined) merged.lineSpacing = undefined;
	if (rest.lineSpacing !== undefined) merged.lineSpacingPts = undefined;
	if (rest.spaceBefore !== undefined) merged.spaceBeforePct = undefined;
	if (rest.spaceBeforePct !== undefined) merged.spaceBefore = undefined;
	if (rest.spaceAfter !== undefined) merged.spaceAfterPct = undefined;
	if (rest.spaceAfterPct !== undefined) merged.spaceAfter = undefined;
	return merged;
}

/** Nine levels of paragraph style from an lstStyle, titleStyle, bodyStyle or defaultTextStyle. */
export type LevelStyles = ParaStyle[];

export function emptyLevels(): LevelStyles {
	return Array.from({ length: 9 }, () => ({ run: {} }));
}

export function parseLevels(list: XmlElement | undefined, ctx: ColorContext): LevelStyles {
	const levels = emptyLevels();
	if (!list) return levels;
	const def = child(list, "defPPr");
	const defStyle = def ? parseParaStyle(def, ctx) : undefined;
	for (let i = 0; i < 9; i++) {
		const lvl = child(list, `lvl${i + 1}pPr`);
		let s = lvl ? parseParaStyle(lvl, ctx) : { run: {} };
		if (defStyle) s = mergePara(defStyle, s);
		levels[i] = s;
	}
	return levels;
}

export function mergeLevels(base: LevelStyles, over: LevelStyles): LevelStyles {
	return base.map((b, i) => mergePara(b, over[i] ?? { run: {} }));
}

// ---------------------------------------------------------------------------
// Auto numbering
// ---------------------------------------------------------------------------

function toRoman(n: number): string {
	const table: [number, string][] = [
		[1000, "m"],
		[900, "cm"],
		[500, "d"],
		[400, "cd"],
		[100, "c"],
		[90, "xc"],
		[50, "l"],
		[40, "xl"],
		[10, "x"],
		[9, "ix"],
		[5, "v"],
		[4, "iv"],
		[1, "i"],
	];
	let out = "";
	let v = Math.max(1, Math.min(3999, n));
	for (const [num, sym] of table) {
		while (v >= num) {
			out += sym;
			v -= num;
		}
	}
	return out;
}

function toAlpha(n: number): string {
	let v = Math.max(1, n);
	let out = "";
	while (v > 0) {
		v--;
		out = String.fromCharCode(97 + (v % 26)) + out;
		v = Math.floor(v / 26);
	}
	return out;
}

/** The label for item `n` of a buAutoNum scheme such as arabicPeriod or romanUcParenR. */
export function autoNumberLabel(scheme: string, n: number): string {
	let body: string;
	if (scheme.startsWith("alphaLc")) body = toAlpha(n);
	else if (scheme.startsWith("alphaUc")) body = toAlpha(n).toUpperCase();
	else if (scheme.startsWith("romanLc")) body = toRoman(n);
	else if (scheme.startsWith("romanUc")) body = toRoman(n).toUpperCase();
	else body = String(n);
	if (scheme.endsWith("ParenBoth")) return `(${body})`;
	if (scheme.endsWith("ParenR")) return `${body})`;
	if (scheme.endsWith("Plain")) return body;
	if (scheme.endsWith("Minus")) return `- ${body} -`;
	return `${body}.`;
}

// ---------------------------------------------------------------------------
// Preset geometry
// ---------------------------------------------------------------------------

const f = (v: number) => Math.round(v * 100) / 100;

/** A closed polygon from flat x, y pairs. */
function polygon(xy: number[]): string {
	let d = "";
	for (let i = 0; i + 1 < xy.length; i += 2) d += `${i === 0 ? "M" : "L"}${f(xy[i])} ${f(xy[i + 1])} `;
	return `${d}Z`;
}

function regular(n: number, w: number, h: number, rotate = -Math.PI / 2): string {
	const pts: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = rotate + (i * 2 * Math.PI) / n;
		pts.push(w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a));
	}
	return polygon(pts);
}

function star(n: number, w: number, h: number, inner = 0.38): string {
	const pts: number[] = [];
	for (let i = 0; i < n * 2; i++) {
		const a = -Math.PI / 2 + (i * Math.PI) / n;
		const r = i % 2 === 0 ? 1 : inner;
		pts.push(w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a));
	}
	return polygon(pts);
}

/**
 * An SVG path for a preset shape in a w x h box, or undefined when the preset is not drawn
 * (the caller then falls back to a rectangle). `adj` holds the shape's adjust values (adj, adj1, ...).
 */
export function presetPath(preset: string, w: number, h: number, adj: Record<string, number> = {}): string | undefined {
	const ss = Math.min(w, h);
	const a = (name: string, dflt: number) => (adj[name] ?? dflt) / 100000;
	switch (preset) {
		case "rect":
		case "flowChartProcess":
		case "frame":
			return polygon([0, 0, w, 0, w, h, 0, h]);
		case "roundRect":
		case "flowChartAlternateProcess": {
			const r = ss * Math.min(0.5, a("adj", 16667));
			return `M${f(r)} 0 H${f(w - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w)} ${f(r)} V${f(h - r)} A${f(r)} ${f(r)} 0 0 1 ${f(w - r)} ${f(h)} H${f(r)} A${f(r)} ${f(r)} 0 0 1 0 ${f(h - r)} V${f(r)} A${f(r)} ${f(r)} 0 0 1 ${f(r)} 0 Z`;
		}
		case "ellipse":
		case "flowChartConnector":
			return `M0 ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 ${f(w)} ${f(h / 2)} A${f(w / 2)} ${f(h / 2)} 0 1 1 0 ${f(h / 2)} Z`;
		case "triangle":
		case "flowChartExtract": {
			const x = w * a("adj", 50000);
			return polygon([x, 0, w, h, 0, h]);
		}
		case "rtTriangle":
			return polygon([0, 0, w, h, 0, h]);
		case "diamond":
		case "flowChartDecision":
			return polygon([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]);
		case "parallelogram":
		case "flowChartInputOutput": {
			const x = ss * a("adj", 25000);
			return polygon([x, 0, w, 0, w - x, h, 0, h]);
		}
		case "trapezoid": {
			const x = ss * a("adj", 25000);
			return polygon([x, 0, w - x, 0, w, h, 0, h]);
		}
		case "pentagon":
		case "homePlate": {
			if (preset === "pentagon") return regular(5, w, h);
			const x = w - ss * a("adj", 50000);
			return polygon([0, 0, x, 0, w, h / 2, x, h, 0, h]);
		}
		case "chevron": {
			const x = ss * a("adj", 50000);
			return polygon([0, 0, w - x, 0, w, h / 2, w - x, h, 0, h, x, h / 2]);
		}
		case "hexagon": {
			const x = ss * a("adj", 25000);
			return polygon([x, 0, w - x, 0, w, h / 2, w - x, h, x, h, 0, h / 2]);
		}
		case "octagon": {
			const x = ss * a("adj", 29289);
			return polygon([x, 0, w - x, 0, w, x, w, h - x, w - x, h, x, h, 0, h - x, 0, x]);
		}
		case "star5":
			return star(5, w, h);
		case "rightArrow":
		case "leftArrow": {
			const shaft = h * a("adj1", 50000);
			const head = ss * a("adj2", 50000);
			const top = (h - shaft) / 2;
			const pts = [0, top, w - head, top, w - head, 0, w, h / 2, w - head, h, w - head, top + shaft, 0, top + shaft];
			return polygon(preset === "rightArrow" ? pts : pts.map((v, i) => (i % 2 === 0 ? w - v : v)));
		}
		case "upArrow":
		case "downArrow": {
			const shaft = w * a("adj1", 50000);
			const head = ss * a("adj2", 50000);
			const left = (w - shaft) / 2;
			const pts = [left, h, left, head, 0, head, w / 2, 0, w, head, left + shaft, head, left + shaft, h];
			return polygon(preset === "upArrow" ? pts : pts.map((v, i) => (i % 2 === 1 ? h - v : v)));
		}
		case "leftRightArrow": {
			const shaft = h * a("adj1", 50000);
			const head = ss * a("adj2", 50000);
			const top = (h - shaft) / 2;
			return polygon([
				0,
				h / 2,
				head,
				0,
				head,
				top,
				w - head,
				top,
				w - head,
				0,
				w,
				h / 2,
				w - head,
				h,
				w - head,
				top + shaft,
				head,
				top + shaft,
				head,
				h,
			]);
		}
		case "plus":
		case "mathPlus": {
			const t = ss * a("adj", 25000);
			return polygon([
				t,
				0,
				w - t,
				0,
				w - t,
				t,
				w,
				t,
				w,
				h - t,
				w - t,
				h - t,
				w - t,
				h,
				t,
				h,
				t,
				h - t,
				0,
				h - t,
				0,
				t,
				t,
				t,
			]);
		}
		case "line":
		case "straightConnector1":
			return `M0 0 L${f(w)} ${f(h)}`;
		case "bentConnector2":
			return `M0 0 H${f(w)} V${f(h)}`;
		case "bentConnector3": {
			const x = w * a("adj1", 50000);
			return `M0 0 H${f(x)} V${f(h)} H${f(w)}`;
		}
		case "curvedConnector3": {
			const x = w * a("adj1", 50000);
			return `M0 0 C${f(x)} 0 ${f(x)} ${f(h)} ${f(w)} ${f(h)}`;
		}
	}
	return undefined;
}

/** Whether a preset is drawn as an open stroke rather than a filled outline. */
export function isLinePreset(preset: string): boolean {
	return preset === "line" || preset.includes("Connector");
}

/**
 * Convert a DrawingML custGeom path list to SVG paths, scaled into a w x h box. Returns one
 * entry per a:path, with whether that path is filled and stroked.
 */
export function customGeometryPaths(
	custGeom: XmlElement,
	w: number,
	h: number,
	maxCommands = Number.POSITIVE_INFINITY,
): { paths: { d: string; fill: boolean; stroke: boolean }[]; commands: number } {
	const out: { d: string; fill: boolean; stroke: boolean }[] = [];
	let used = 0;
	for (const p of children(child(custGeom, "pathLst"), "path")) {
		if (used >= maxCommands) break;
		const pw = Number(attr(p, "w") ?? "0") || w;
		const ph = Number(attr(p, "h") ?? "0") || h;
		const sx = w / pw;
		const sy = h / ph;
		// Coordinates are numbers or, in some files, the names of built-in guides.
		const guide = (v: string | undefined, horizontal: boolean): number => {
			const num = Number(v ?? "0");
			if (Number.isFinite(num)) return num;
			const size = horizontal ? pw : ph;
			if (v === "w" || v === "r" || v === "b" || v === "h") return size;
			if (v === "hc" || v === "vc" || v === "wd2" || v === "hd2") return size / 2;
			return 0;
		};
		const pt = (el: XmlElement | undefined): [number, number] => [
			guide(attr(el, "x"), true) * sx,
			guide(attr(el, "y"), false) * sy,
		];
		let d = "";
		let cur: [number, number] = [0, 0];
		for (const cmd of children(p)) {
			if (used >= maxCommands) break;
			used++;
			const pts = children(cmd, "pt");
			switch (cmd.local) {
				case "moveTo":
					cur = pt(pts[0]);
					d += `M${f(cur[0])} ${f(cur[1])} `;
					break;
				case "lnTo":
					cur = pt(pts[0]);
					d += `L${f(cur[0])} ${f(cur[1])} `;
					break;
				case "cubicBezTo": {
					const [a1, a2, a3] = pts.map(pt);
					if (a1 && a2 && a3) {
						d += `C${f(a1[0])} ${f(a1[1])} ${f(a2[0])} ${f(a2[1])} ${f(a3[0])} ${f(a3[1])} `;
						cur = a3;
					}
					break;
				}
				case "quadBezTo": {
					const [a1, a2] = pts.map(pt);
					if (a1 && a2) {
						d += `Q${f(a1[0])} ${f(a1[1])} ${f(a2[0])} ${f(a2[1])} `;
						cur = a2;
					}
					break;
				}
				case "arcTo": {
					const wR = Number(attr(cmd, "wR") ?? "0") * sx;
					const hR = Number(attr(cmd, "hR") ?? "0") * sy;
					const st = ((Number(attr(cmd, "stAng") ?? "0") / 60000) * Math.PI) / 180;
					const sw = ((Number(attr(cmd, "swAng") ?? "0") / 60000) * Math.PI) / 180;
					const cx = cur[0] - wR * Math.cos(st);
					const cy = cur[1] - hR * Math.sin(st);
					const end: [number, number] = [cx + wR * Math.cos(st + sw), cy + hR * Math.sin(st + sw)];
					const large = Math.abs(sw) > Math.PI ? 1 : 0;
					const sweep = sw > 0 ? 1 : 0;
					d += `A${f(wR)} ${f(hR)} 0 ${large} ${sweep} ${f(end[0])} ${f(end[1])} `;
					cur = end;
					break;
				}
				case "close":
					d += "Z ";
					break;
			}
		}
		out.push({
			d: d.trim(),
			fill: attr(p, "fill") !== "none",
			stroke: attr(p, "stroke") !== "0" && attr(p, "stroke") !== "false",
		});
	}
	return { paths: out, commands: used };
}
