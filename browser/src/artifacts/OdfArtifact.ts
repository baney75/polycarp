import { i18n } from "@mariozechner/mini-lit";
import { customElement } from "lit/decorators.js";
import { PREVIEW_LIMITS } from "./preview/content.js";
import { mountDeck } from "./preview/deck-view.js";
import { getArtifactFileType } from "./preview/file-types.js";
import { type OdfRun, type OdtBlock, type OdtParagraph, readOdp, readOdt } from "./preview/odf.js";
import { PreviewArtifact } from "./preview/PreviewArtifact.js";
import { documentPage } from "./preview/page.js";
import { fontFamily, imageUrls } from "./preview/slide-render.js";

const PX_PER_PT = 96 / 72;
const EMU_PER_PX = 9525;
const HEADING_SIZE = [0, 2, 1.5, 1.25, 1.1, 1, 0.9];

/** OpenDocument text (.odt) as a page, and presentations (.odp) as slides. */
@customElement("odf-artifact")
export class OdfArtifact extends PreviewArtifact {
	protected override get errorTitle(): string {
		return getArtifactFileType(this.filename) === "odp"
			? i18n("Error loading presentation")
			: i18n("Error loading document");
	}

	protected async renderPreview(container: HTMLElement) {
		const bytes = this.decodedContent(PREVIEW_LIMITS.maxDocumentBytes);
		if (getArtifactFileType(this.filename) === "odp") return mountDeck(container, await readOdp(bytes));

		const odt = await readOdt(bytes);
		const doc = container.ownerDocument;
		const { urls, revoke } = imageUrls(odt);
		const { scroller, page } = documentPage(doc);
		for (const b of odt.blocks) page.appendChild(renderBlock(doc, b, urls));
		if (odt.truncated) {
			const note = doc.createElement("p");
			note.style.color = "#777";
			note.textContent = `[${i18n("Truncated for display")}]`;
			page.appendChild(note);
		}
		container.appendChild(scroller);
		return revoke;
	}
}

function renderRun(doc: Document, run: OdfRun, urls: Map<string, string>): Node {
	if ("br" in run) return doc.createElement("br");
	if ("image" in run) {
		const url = urls.get(run.image);
		if (!url) return doc.createTextNode("[Image]");
		const img = doc.createElement("img");
		img.src = url;
		img.alt = "";
		img.style.maxWidth = "100%";
		img.style.display = "inline-block";
		if (run.width) img.style.width = `${run.width * PX_PER_PT}px`;
		return img;
	}
	const el = doc.createElement(run.href ? "a" : "span");
	el.textContent = run.text;
	if (run.href && el instanceof HTMLAnchorElement) {
		el.href = run.href;
		el.target = "_blank";
		el.rel = "noopener noreferrer";
	}
	const s = run.style;
	if (s.size) el.style.fontSize = `${s.size * PX_PER_PT}px`;
	if (s.font) el.style.fontFamily = fontFamily(s.font);
	if (s.bold) el.style.fontWeight = "700";
	if (s.italic) el.style.fontStyle = "italic";
	const deco = [s.underline ? "underline" : "", s.strike ? "line-through" : ""].filter(Boolean).join(" ");
	if (deco) el.style.textDecoration = deco;
	if (s.color) el.style.color = s.color;
	if (s.highlight) el.style.background = s.highlight;
	if (s.baseline) {
		el.style.verticalAlign = s.baseline > 0 ? "super" : "sub";
		el.style.fontSize = `${(s.size ?? 12) * PX_PER_PT * 0.7}px`;
	}
	if (s.caps === "all") el.style.textTransform = "uppercase";
	if (s.caps === "small") el.style.fontVariant = "small-caps";
	return el;
}

function renderParagraph(doc: Document, p: OdtParagraph, urls: Map<string, string>): HTMLElement {
	const el = doc.createElement(p.heading ? (`h${p.heading}` as "h1") : "p");
	const s = p.style;
	el.style.margin = "0";
	el.style.whiteSpace = "pre-wrap";
	el.style.minHeight = "1.2em";
	if (p.heading) {
		el.style.fontWeight = "700";
		if (!s.run.size || s.run.size <= 12) el.style.fontSize = `${HEADING_SIZE[p.heading]}em`;
	}
	if (s.align) el.style.textAlign = { l: "left", ctr: "center", r: "right", just: "justify" }[s.align] ?? "left";
	if (s.marL) el.style.paddingLeft = `${s.marL / EMU_PER_PX}px`;
	if (s.indent) el.style.textIndent = `${s.indent / EMU_PER_PX}px`;
	el.style.paddingTop = `${(s.spaceBefore ?? 0) * PX_PER_PT}px`;
	el.style.paddingBottom = `${(s.spaceAfter ?? 4) * PX_PER_PT}px`;
	if (s.lineSpacing) el.style.lineHeight = String(1.2 * s.lineSpacing);
	if (p.background) el.style.background = p.background;
	for (const r of p.runs) el.appendChild(renderRun(doc, r, urls));
	return el;
}

function renderBlock(doc: Document, b: OdtBlock, urls: Map<string, string>): HTMLElement {
	if (b.kind === "para") return renderParagraph(doc, b, urls);
	if (b.kind === "list") {
		const list = doc.createElement(b.ordered ? "ol" : "ul");
		list.style.margin = "0 0 4px 0";
		list.style.paddingLeft = "1.6em";
		list.style.listStyleType = b.ordered ? "decimal" : "disc";
		if (b.ordered && b.start !== 1) (list as HTMLOListElement).start = b.start;
		for (const item of b.items) {
			const li = doc.createElement("li");
			for (const child of item) li.appendChild(renderBlock(doc, child, urls));
			list.appendChild(li);
		}
		return list;
	}
	const table = doc.createElement("table");
	table.style.borderCollapse = "collapse";
	table.style.margin = "6px 0";
	if (b.columns.some((c) => c)) {
		const cg = doc.createElement("colgroup");
		for (const c of b.columns) {
			const col = doc.createElement("col");
			if (c) col.style.width = `${c * PX_PER_PT}px`;
			cg.appendChild(col);
		}
		table.appendChild(cg);
	}
	for (const row of b.rows) {
		const tr = doc.createElement("tr");
		for (const cell of row.cells) {
			const td = doc.createElement("td");
			if (cell.colSpan > 1) td.colSpan = cell.colSpan;
			if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
			td.style.border = "1px solid #999";
			td.style.padding = "2px 6px";
			td.style.verticalAlign = "top";
			if (cell.background) td.style.background = cell.background;
			for (const child of cell.blocks) td.appendChild(renderBlock(doc, child, urls));
			tr.appendChild(td);
		}
		table.appendChild(tr);
	}
	return table;
}

declare global {
	interface HTMLElementTagNameMap {
		"odf-artifact": OdfArtifact;
	}
}
