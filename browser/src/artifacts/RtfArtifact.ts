import { i18n } from "@mariozechner/mini-lit";
import { customElement } from "lit/decorators.js";
import { PREVIEW_LIMITS, PreviewLimitError } from "./preview/content.js";
import { PreviewArtifact } from "./preview/PreviewArtifact.js";
import { documentPage } from "./preview/page.js";
import { looksLikeRtf, parseRtf, type RtfParagraph, type RtfRun } from "./preview/rtf.js";
import { fontFamily } from "./preview/slide-render.js";

const PX_PER_PT = 96 / 72;

/** Rich Text Format: formatted paragraphs, simple tables and PNG/JPEG pictures. */
@customElement("rtf-artifact")
export class RtfArtifact extends PreviewArtifact {
	protected override get isBinary(): boolean {
		return false;
	}

	protected override looksLikeText(text: string): boolean {
		return looksLikeRtf(text);
	}

	protected async renderPreview(container: HTMLElement) {
		const text = this.fileText();
		if (text.length > PREVIEW_LIMITS.maxDocumentBytes) throw new PreviewLimitError("File is too large to preview");
		const rtf = parseRtf(text);
		const doc = container.ownerDocument;
		const { scroller, page } = documentPage(doc);
		for (const block of rtf.blocks) {
			if (block.kind === "para") page.appendChild(renderParagraph(doc, block));
			else {
				const table = doc.createElement("table");
				table.style.borderCollapse = "collapse";
				table.style.margin = "4px 0";
				for (const row of block.rows) {
					const tr = doc.createElement("tr");
					for (const cell of row) {
						const td = doc.createElement("td");
						td.style.border = "1px solid #999";
						td.style.padding = "2px 6px";
						td.style.verticalAlign = "top";
						for (const p of cell) td.appendChild(renderParagraph(doc, p));
						tr.appendChild(td);
					}
					table.appendChild(tr);
				}
				page.appendChild(table);
			}
		}
		if (rtf.truncated) {
			const note = doc.createElement("p");
			note.style.color = "#777";
			note.textContent = `[${i18n("Truncated for display")}]`;
			page.appendChild(note);
		}
		container.appendChild(scroller);
		return undefined;
	}
}

function renderRun(doc: Document, run: RtfRun): Node {
	if ("br" in run) return doc.createElement("br");
	if ("image" in run) {
		const img = doc.createElement("img");
		// parseRtf only produces PNG and JPEG data URLs.
		img.src = run.image;
		img.alt = "";
		img.style.maxWidth = "100%";
		img.style.display = "inline-block";
		if (run.width) img.style.width = `${run.width * PX_PER_PT}px`;
		if (run.height && run.width) img.style.height = "auto";
		return img;
	}
	const span = doc.createElement("span");
	span.textContent = run.text;
	const s = run.style;
	if (s.size) span.style.fontSize = `${s.size * PX_PER_PT}px`;
	if (s.font) span.style.fontFamily = fontFamily(s.font);
	if (s.bold) span.style.fontWeight = "700";
	if (s.italic) span.style.fontStyle = "italic";
	const deco = [s.underline ? "underline" : "", s.strike ? "line-through" : ""].filter(Boolean).join(" ");
	if (deco) span.style.textDecoration = deco;
	if (s.color) span.style.color = s.color;
	if (s.background) span.style.background = s.background;
	if (s.script) {
		span.style.verticalAlign = s.script;
		span.style.fontSize = `${(s.size ?? 12) * PX_PER_PT * 0.7}px`;
	}
	if (s.caps === "all") span.style.textTransform = "uppercase";
	if (s.caps === "small") span.style.fontVariant = "small-caps";
	return span;
}

function renderParagraph(doc: Document, p: RtfParagraph): HTMLElement {
	const div = doc.createElement("div");
	div.style.margin = "0";
	div.style.whiteSpace = "pre-wrap";
	div.style.tabSize = "4";
	div.style.minHeight = "1.2em";
	if (p.align) div.style.textAlign = p.align;
	if (p.indentLeft) div.style.paddingLeft = `${p.indentLeft * PX_PER_PT}px`;
	if (p.indentRight) div.style.paddingRight = `${p.indentRight * PX_PER_PT}px`;
	if (p.firstLine) div.style.textIndent = `${p.firstLine * PX_PER_PT}px`;
	if (p.spaceBefore) div.style.paddingTop = `${p.spaceBefore * PX_PER_PT}px`;
	if (p.spaceAfter) div.style.paddingBottom = `${p.spaceAfter * PX_PER_PT}px`;
	for (const r of p.runs) div.appendChild(renderRun(doc, r));
	return div;
}

declare global {
	interface HTMLElementTagNameMap {
		"rtf-artifact": RtfArtifact;
	}
}
