/**
 * Draws the pptx slide model with plain DOM and inline SVG. Text is set through textContent
 * and style properties only, never parsed as HTML, so nothing in a deck can run.
 */
import type { Fill, Line, RunStyle } from "./drawingml.js";
import { isLinePreset, presetPath } from "./drawingml.js";
import {
	type Box,
	type Deck,
	EMU_PER_PX,
	type PictureElement,
	type ShapeElement,
	type Slide,
	type SlideElement,
	type TableElement,
	type TextBody,
	type TextParagraph,
} from "./pptx.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PX_PER_PT = 96 / 72;

let uid = 0;
const nextId = (prefix: string) => `${prefix}-${++uid}`;

const px = (emu: number) => emu / EMU_PER_PX;

/** Blob URLs for the deck's images. Call `revoke` when the preview goes away. */
export function imageUrls(deck: Pick<Deck, "images">): { urls: Map<string, string>; revoke: () => void } {
	const urls = new Map<string, string>();
	for (const [path, img] of deck.images) {
		const copy = new Uint8Array(img.data.length);
		copy.set(img.data);
		urls.set(path, URL.createObjectURL(new Blob([copy.buffer], { type: img.mime })));
	}
	return {
		urls,
		revoke: () => {
			for (const u of urls.values()) URL.revokeObjectURL(u);
		},
	};
}

const SANS_FALLBACK = '"Helvetica Neue", Arial, sans-serif';
const FONT_FALLBACKS: Record<string, string> = {
	calibri: `Carlito, ${SANS_FALLBACK}`,
	"calibri light": `Carlito, ${SANS_FALLBACK}`,
	cambria: "Caladea, Georgia, serif",
	"times new roman": '"Times New Roman", Times, serif',
	georgia: "Georgia, serif",
	garamond: "Garamond, Georgia, serif",
	"courier new": '"Courier New", Courier, monospace',
	consolas: 'Consolas, Menlo, "Courier New", monospace',
	"lucida console": 'Menlo, "Courier New", monospace',
};

export function fontFamily(font: string | undefined): string {
	if (!font) return SANS_FALLBACK;
	const safe = font.replace(/["\\;{}<>]/g, "");
	const fallback = FONT_FALLBACKS[safe.toLowerCase()] ?? SANS_FALLBACK;
	return `"${safe}", ${fallback}`;
}

export function fillCss(fill: Fill | undefined, urls: Map<string, string>): string | undefined {
	if (!fill || fill.type === "none") return undefined;
	if (fill.type === "solid") return fill.color;
	if (fill.type === "gradient") {
		const stops = fill.stops.map((s) => `${s.color} ${Math.round(s.pos * 1000) / 10}%`).join(", ");
		if (fill.radial) return `radial-gradient(circle, ${stops})`;
		return `linear-gradient(${Math.round(fill.angle + 90)}deg, ${stops})`;
	}
	const url = urls.get(fill.image);
	if (!url) return undefined;
	return fill.tile ? `0 0 repeat url("${url}")` : `center / cover no-repeat url("${url}")`;
}

function place(el: HTMLElement, box: Box) {
	el.style.position = "absolute";
	el.style.left = `${px(box.x)}px`;
	el.style.top = `${px(box.y)}px`;
	el.style.width = `${Math.max(0, px(box.w))}px`;
	el.style.height = `${Math.max(0, px(box.h))}px`;
	if (box.rot) el.style.transform = `rotate(${box.rot}deg)`;
}

function dashArray(dash: string | undefined, width: number): string | undefined {
	if (!dash) return undefined;
	const w = Math.max(width, 1);
	switch (dash) {
		case "dot":
		case "sysDot":
			return `${w} ${w * 2}`;
		case "dash":
		case "sysDash":
			return `${w * 4} ${w * 3}`;
		case "lgDash":
			return `${w * 8} ${w * 3}`;
		case "dashDot":
		case "sysDashDot":
			return `${w * 4} ${w * 3} ${w} ${w * 3}`;
		default:
			return `${w * 4} ${w * 3}`;
	}
}

function svgEl<K extends keyof SVGElementTagNameMap>(doc: Document, name: K): SVGElementTagNameMap[K] {
	return doc.createElementNS(SVG_NS, name);
}

function applyStroke(path: SVGElement, line: Line | null | undefined) {
	if (!line) {
		path.setAttribute("stroke", "none");
		return;
	}
	path.setAttribute("stroke", line.color);
	path.setAttribute("stroke-width", String(line.width));
	const dash = dashArray(line.dash, line.width);
	if (dash) path.setAttribute("stroke-dasharray", dash);
}

function applyFill(
	doc: Document,
	svg: SVGSVGElement,
	path: SVGElement,
	fill: Fill | undefined,
	urls: Map<string, string>,
	box: Box,
) {
	if (!fill || fill.type === "none") {
		path.setAttribute("fill", "none");
		return;
	}
	if (fill.type === "solid") {
		path.setAttribute("fill", fill.color);
		return;
	}
	const defs = svg.querySelector("defs") ?? svg.insertBefore(svgEl(doc, "defs"), svg.firstChild);
	const id = nextId("pf");
	if (fill.type === "gradient") {
		const grad = fill.radial ? svgEl(doc, "radialGradient") : svgEl(doc, "linearGradient");
		grad.id = id;
		if (!fill.radial) {
			const rad = (fill.angle * Math.PI) / 180;
			const dx = Math.cos(rad) / 2;
			const dy = Math.sin(rad) / 2;
			grad.setAttribute("x1", String(0.5 - dx));
			grad.setAttribute("y1", String(0.5 - dy));
			grad.setAttribute("x2", String(0.5 + dx));
			grad.setAttribute("y2", String(0.5 + dy));
		}
		for (const s of fill.stops) {
			const stop = svgEl(doc, "stop");
			stop.setAttribute("offset", String(s.pos));
			stop.setAttribute("stop-color", s.color);
			grad.appendChild(stop);
		}
		defs.appendChild(grad);
		path.setAttribute("fill", `url(#${id})`);
		return;
	}
	const url = urls.get(fill.image);
	if (!url) {
		path.setAttribute("fill", "none");
		return;
	}
	const pattern = svgEl(doc, "pattern");
	pattern.id = id;
	pattern.setAttribute("patternUnits", "userSpaceOnUse");
	pattern.setAttribute("width", String(box.w));
	pattern.setAttribute("height", String(box.h));
	const img = svgEl(doc, "image");
	img.setAttribute("href", url);
	img.setAttribute("width", String(box.w));
	img.setAttribute("height", String(box.h));
	img.setAttribute("preserveAspectRatio", "xMidYMid slice");
	pattern.appendChild(img);
	defs.appendChild(pattern);
	path.setAttribute("fill", `url(#${id})`);
}

function arrowMarker(doc: Document, svg: SVGSVGElement, color: string, width: number): string {
	const defs = svg.querySelector("defs") ?? svg.insertBefore(svgEl(doc, "defs"), svg.firstChild);
	const id = nextId("pa");
	const marker = svgEl(doc, "marker");
	marker.id = id;
	marker.setAttribute("viewBox", "0 0 10 10");
	marker.setAttribute("refX", "8");
	marker.setAttribute("refY", "5");
	marker.setAttribute("markerUnits", "userSpaceOnUse");
	const size = Math.max(width * 4, 4 * EMU_PER_PX);
	marker.setAttribute("markerWidth", String(size));
	marker.setAttribute("markerHeight", String(size));
	marker.setAttribute("orient", "auto-start-reverse");
	const tri = svgEl(doc, "path");
	tri.setAttribute("d", "M0 0 L10 5 L0 10 Z");
	tri.setAttribute("fill", color);
	marker.appendChild(tri);
	defs.appendChild(marker);
	return `url(#${id})`;
}

function renderShape(doc: Document, el: ShapeElement, urls: Map<string, string>, slideNumber: number): HTMLElement {
	const wrap = doc.createElement("div");
	place(wrap, el.box);
	// A straight line can have zero width or height; give it one pixel so it still draws.
	const w = Math.max(el.box.w, EMU_PER_PX);
	const h = Math.max(el.box.h, EMU_PER_PX);
	const hasGeometry = (el.fill && el.fill.type !== "none") || el.line;
	if (hasGeometry) {
		const svg = svgEl(doc, "svg");
		svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
		svg.setAttribute("preserveAspectRatio", "none");
		svg.style.position = "absolute";
		svg.style.inset = "0";
		svg.style.width = `${px(w)}px`;
		svg.style.height = `${px(h)}px`;
		svg.style.overflow = "visible";
		const flips: string[] = [];
		if (el.box.flipH) flips.push("scaleX(-1)");
		if (el.box.flipV) flips.push("scaleY(-1)");
		if (flips.length) svg.style.transform = flips.join(" ");
		const paths = el.paths ?? [
			{
				d: presetPath(el.preset ?? "rect", w, h, el.adj) ?? presetPath("rect", w, h) ?? "",
				fill: true,
				stroke: true,
			},
		];
		const line = el.preset && isLinePreset(el.preset);
		for (const p of paths) {
			if (!p.d) continue;
			const path = svgEl(doc, "path");
			path.setAttribute("d", p.d);
			if (p.fill && !line) applyFill(doc, svg, path, el.fill, urls, el.box);
			else path.setAttribute("fill", "none");
			applyStroke(path, p.stroke ? el.line : null);
			path.setAttribute("vector-effect", "none");
			if (line && el.line) {
				if (el.tailEnd) path.setAttribute("marker-end", arrowMarker(doc, svg, el.line.color, el.line.width));
				if (el.headEnd) path.setAttribute("marker-start", arrowMarker(doc, svg, el.line.color, el.line.width));
			}
			svg.appendChild(path);
		}
		wrap.appendChild(svg);
	}
	if (el.text) wrap.appendChild(renderTextBody(doc, el.text, true, slideNumber));
	return wrap;
}

function renderPicture(doc: Document, el: PictureElement, urls: Map<string, string>): HTMLElement {
	const wrap = doc.createElement("div");
	place(wrap, el.box);
	wrap.style.overflow = "hidden";
	if (el.preset === "ellipse") wrap.style.borderRadius = "50%";
	else if (el.preset === "roundRect") wrap.style.borderRadius = `${Math.min(px(el.box.w), px(el.box.h)) * 0.16}px`;
	if (el.line) wrap.style.outline = `${Math.max(1, px(el.line.width))}px solid ${el.line.color}`;
	const flips: string[] = [];
	if (el.box.rot) flips.push(`rotate(${el.box.rot}deg)`);
	if (el.box.flipH) flips.push("scaleX(-1)");
	if (el.box.flipV) flips.push("scaleY(-1)");
	if (flips.length) wrap.style.transform = flips.join(" ");
	const url = el.image ? urls.get(el.image) : undefined;
	if (!url) {
		wrap.style.background = "repeating-linear-gradient(45deg, #eee, #eee 8px, #f6f6f6 8px, #f6f6f6 16px)";
		wrap.style.border = "1px dashed #bbb";
		const label = doc.createElement("div");
		label.textContent = el.unsupported ? `${el.unsupported.toUpperCase()} image` : "Image";
		label.style.cssText =
			"position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#777;font:14px sans-serif";
		wrap.appendChild(label);
		return wrap;
	}
	const img = doc.createElement("img");
	img.src = url;
	img.alt = "";
	img.draggable = false;
	img.style.position = "absolute";
	img.style.maxWidth = "none";
	const c = el.crop ?? { l: 0, t: 0, r: 0, b: 0 };
	const visW = Math.max(0.01, 1 - c.l - c.r);
	const visH = Math.max(0.01, 1 - c.t - c.b);
	const fullW = px(el.box.w) / visW;
	const fullH = px(el.box.h) / visH;
	img.style.width = `${fullW}px`;
	img.style.height = `${fullH}px`;
	img.style.left = `${-c.l * fullW}px`;
	img.style.top = `${-c.t * fullH}px`;
	wrap.appendChild(img);
	return wrap;
}

function borderCss(line: Line | null | undefined): string {
	if (!line) return "none";
	return `${Math.max(1, px(line.width))}px ${line.dash ? "dashed" : "solid"} ${line.color}`;
}

function renderTable(doc: Document, el: TableElement, urls: Map<string, string>, slideNumber: number): HTMLElement {
	const wrap = doc.createElement("div");
	place(wrap, el.box);
	wrap.style.height = "auto";
	const table = doc.createElement("table");
	table.style.borderCollapse = "collapse";
	table.style.tableLayout = "fixed";
	table.style.width = `${px(el.columns.reduce((a, b) => a + b, 0)) || px(el.box.w)}px`;
	const colgroup = doc.createElement("colgroup");
	for (const cw of el.columns) {
		const col = doc.createElement("col");
		col.style.width = `${px(cw)}px`;
		colgroup.appendChild(col);
	}
	table.appendChild(colgroup);
	for (const row of el.rows) {
		const tr = doc.createElement("tr");
		tr.style.height = `${px(row.height)}px`;
		for (const cell of row.cells) {
			if (cell.merged) continue;
			const td = doc.createElement("td");
			if (cell.gridSpan > 1) td.colSpan = cell.gridSpan;
			if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
			td.style.padding = "0";
			td.style.verticalAlign = cell.text?.anchor === "ctr" ? "middle" : cell.text?.anchor === "b" ? "bottom" : "top";
			const bg = fillCss(cell.fill, urls);
			if (bg) td.style.background = bg;
			td.style.borderLeft = borderCss(cell.borders.l);
			td.style.borderRight = borderCss(cell.borders.r);
			td.style.borderTop = borderCss(cell.borders.t);
			td.style.borderBottom = borderCss(cell.borders.b);
			if (cell.text) td.appendChild(renderTextBody(doc, cell.text, false, slideNumber));
			tr.appendChild(td);
		}
		table.appendChild(tr);
	}
	wrap.appendChild(table);
	return wrap;
}

function renderPlaceholder(doc: Document, el: SlideElement): HTMLElement {
	const wrap = doc.createElement("div");
	place(wrap, el.box);
	wrap.style.border = "1px dashed #aaa";
	wrap.style.background = "rgba(127,127,127,0.06)";
	wrap.style.display = "flex";
	wrap.style.alignItems = "center";
	wrap.style.justifyContent = "center";
	wrap.style.color = "#777";
	wrap.style.font = "16px sans-serif";
	wrap.textContent = el.kind === "placeholder" ? `${el.label} (not shown in preview)` : "";
	return wrap;
}

const ALIGN: Record<string, string> = { l: "left", ctr: "center", r: "right", just: "justify", dist: "justify" };

function runCss(span: HTMLElement, style: RunStyle, scale: number) {
	const size = (style.size ?? 18) * scale * PX_PER_PT;
	span.style.fontSize = `${size}px`;
	span.style.fontFamily = fontFamily(style.font);
	if (style.color) span.style.color = style.color;
	if (style.bold) span.style.fontWeight = "700";
	if (style.italic) span.style.fontStyle = "italic";
	const deco = [style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ");
	if (deco) span.style.textDecoration = deco;
	if (style.baseline) {
		span.style.verticalAlign = style.baseline > 0 ? "super" : "sub";
		span.style.fontSize = `${size * 0.7}px`;
	}
	if (style.caps === "all") span.style.textTransform = "uppercase";
	if (style.caps === "small") span.style.fontVariant = "small-caps";
	if (style.highlight) span.style.background = style.highlight;
}

function renderParagraph(doc: Document, p: TextParagraph, body: TextBody, slideNumber: number): HTMLElement {
	const div = doc.createElement("div");
	const s = p.style;
	const scale = body.fontScale;
	const firstSize = (p.runs.find((r) => !r.br)?.style.size ?? p.emptySize ?? s.run.size ?? 18) * scale;
	div.style.textAlign = ALIGN[s.align ?? "l"] ?? "left";
	div.style.margin = "0";
	const marL = px(s.marL ?? 0);
	const indent = px(s.indent ?? 0);
	div.style.paddingLeft = `${marL}px`;
	div.style.textIndent = `${indent}px`;
	const reduction = 1 - body.lineReduction;
	if (s.lineSpacingPts !== undefined) div.style.lineHeight = `${s.lineSpacingPts * PX_PER_PT * reduction}px`;
	else div.style.lineHeight = String(1.2 * (s.lineSpacing ?? 1) * reduction);
	const space = (pts: number | undefined, pct: number | undefined) =>
		pts !== undefined ? pts * PX_PER_PT : pct !== undefined ? pct * firstSize * PX_PER_PT * 1.2 : 0;
	div.style.paddingTop = `${space(s.spaceBefore, s.spaceBeforePct)}px`;
	div.style.paddingBottom = `${space(s.spaceAfter, s.spaceAfterPct)}px`;

	if (p.bullet) {
		const b = doc.createElement("span");
		b.textContent = p.bullet.text;
		const baseStyle = p.runs.find((r) => !r.br)?.style ?? s.run;
		runCss(
			b,
			{
				...baseStyle,
				underline: false,
				strike: false,
				highlight: undefined,
				color: p.bullet.color ?? baseStyle.color,
				font: p.bullet.font ?? baseStyle.font,
			},
			scale * (p.bullet.sizePct ?? 1),
		);
		b.style.display = "inline-block";
		b.style.textIndent = "0";
		if (indent < 0) b.style.width = `${-indent}px`;
		else b.style.marginRight = "0.4em";
		div.appendChild(b);
	}
	if (p.runs.length === 0 || p.emptySize !== undefined) {
		const span = doc.createElement("span");
		span.textContent = "\u00a0";
		runCss(span, { ...s.run, size: p.emptySize ?? s.run.size }, scale);
		div.appendChild(span);
	}
	for (const r of p.runs) {
		if (r.br) {
			div.appendChild(doc.createElement("br"));
			continue;
		}
		if (!r.text) continue;
		const span = doc.createElement("span");
		span.textContent = r.slideNumber ? String(slideNumber) : r.text;
		runCss(span, r.style, scale);
		div.appendChild(span);
	}
	return div;
}

function renderTextBody(doc: Document, body: TextBody, absolute: boolean, slideNumber: number): HTMLElement {
	const box = doc.createElement("div");
	if (absolute) {
		box.style.position = "absolute";
		box.style.inset = "0";
	}
	box.style.display = "flex";
	box.style.flexDirection = "column";
	box.style.justifyContent = body.anchor === "ctr" ? "center" : body.anchor === "b" ? "flex-end" : "flex-start";
	const [l, t, r, b] = body.insets.map(px);
	box.style.padding = `${t}px ${r}px ${b}px ${l}px`;
	box.style.boxSizing = "border-box";
	box.style.whiteSpace = body.wrap ? "pre-wrap" : "pre";
	box.style.overflowWrap = "break-word";
	box.style.color = "#000";
	if (body.vertical) {
		box.style.writingMode = "vertical-rl";
		if (body.vertical === "vert270") box.style.transform = "rotate(180deg)";
	}
	for (const p of body.paragraphs) box.appendChild(renderParagraph(doc, p, body, slideNumber));
	return box;
}

/** One slide at its natural size (1 px = 9525 EMU). The caller scales it to fit. */
export function renderSlide(
	doc: Document,
	deck: Pick<Deck, "width" | "height">,
	slide: Slide,
	urls: Map<string, string>,
): HTMLElement {
	const root = doc.createElement("div");
	root.style.position = "relative";
	root.style.overflow = "hidden";
	root.style.width = `${px(deck.width)}px`;
	root.style.height = `${px(deck.height)}px`;
	root.style.background = fillCss(slide.background, urls) ?? "#fff";
	root.style.color = "#000";
	root.style.lineHeight = "1.2";
	for (const el of slide.elements) {
		switch (el.kind) {
			case "shape":
				root.appendChild(renderShape(doc, el, urls, slide.number));
				break;
			case "picture":
				root.appendChild(renderPicture(doc, el, urls));
				break;
			case "table":
				root.appendChild(renderTable(doc, el, urls, slide.number));
				break;
			case "placeholder":
				root.appendChild(renderPlaceholder(doc, el));
				break;
		}
	}
	return root;
}
