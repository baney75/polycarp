import { i18n } from "@mariozechner/mini-lit";
import hljs from "highlight.js";
import { customElement } from "lit/decorators.js";
import { marked } from "marked";
import { PREVIEW_LIMITS, PreviewLimitError } from "./preview/content.js";
import {
	attachmentData,
	looksLikeNotebook,
	type NotebookOutput,
	neutralizeRemoteImages,
	parseNotebook,
} from "./preview/notebook.js";
import { PreviewArtifact } from "./preview/PreviewArtifact.js";
import { type NodeBudget, sanitizeHtml } from "./preview/sanitize.js";

const MAX_OUTPUT_CHARS = 200_000;
const MAX_NOTEBOOK_NODES = 200_000;

/**
 * Notebook markdown is untrusted: render it with marked to a string, then rebuild it through the
 * allow-list sanitizer, which keeps only inline data: images and drops raw HTML that could load
 * anything. Safety never depends on predicting how marked tokenizes code spans.
 */
function renderMarkdown(
	doc: Document,
	source: string,
	attachments: Record<string, string>,
	budget: NodeBudget,
): HTMLElement {
	const div = doc.createElement("div");
	div.className =
		"markdown-content text-foreground break-words [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-2 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-1 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:p-2 [&_pre]:bg-muted/50 [&_pre]:rounded [&_pre]:overflow-x-auto [&_code]:font-mono [&_code]:text-xs [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_table]:border-collapse [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_img]:max-w-full";
	const html = marked.parse(neutralizeRemoteImages(clip(source), attachments), { async: false, gfm: true }) as string;
	const resolve = (src: string) => (src.startsWith("attachment:") ? attachmentData(attachments, src) : undefined);
	div.appendChild(sanitizeHtml(html, doc, budget, resolve));
	return div;
}

function clip(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}\n[${i18n("Truncated for display")}]`
		: text;
}

/**
 * Jupyter notebooks: markdown cells, code cells and their saved outputs. Nothing is executed.
 * HTML outputs pass an allow-list sanitizer; images show only from inline data.
 */
@customElement("notebook-artifact")
export class NotebookArtifact extends PreviewArtifact {
	protected override get isBinary(): boolean {
		return false;
	}

	protected override get errorTitle(): string {
		return i18n("Error loading notebook");
	}

	protected override looksLikeText(text: string): boolean {
		return looksLikeNotebook(text);
	}

	protected async renderPreview(container: HTMLElement) {
		const text = this.fileText();
		if (text.length > PREVIEW_LIMITS.maxDocumentBytes) throw new PreviewLimitError("File is too large to preview");
		const nb = parseNotebook(text, PREVIEW_LIMITS.maxCells);
		const doc = container.ownerDocument;
		const urls: string[] = [];
		// One node budget for every markdown cell and HTML output in the notebook.
		const nodeBudget: NodeBudget = { nodes: MAX_NOTEBOOK_NODES };
		const root = doc.createElement("div");
		root.className = "h-full overflow-auto p-3 flex flex-col gap-3 text-sm";
		if (nb.truncated) {
			const note = doc.createElement("div");
			note.className = "text-xs text-muted-foreground";
			note.textContent = i18n("Truncated for display");
			root.appendChild(note);
		}
		if (nb.cells.length < nb.totalCells) {
			const note = doc.createElement("div");
			note.className = "text-xs text-muted-foreground";
			note.textContent = i18n("showing the first {count}").replace("{count}", () => String(nb.cells.length));
			root.appendChild(note);
		}
		for (const cell of nb.cells) {
			const cellEl = doc.createElement("div");
			cellEl.className = "flex flex-col gap-1 min-w-0";
			if (cell.type === "markdown") {
				const md = renderMarkdown(doc, cell.source, cell.attachments, nodeBudget);
				cellEl.appendChild(md);
			} else if (cell.type === "code") {
				const label = doc.createElement("div");
				label.className = "text-xs font-mono text-muted-foreground";
				label.textContent = `In [${cell.executionCount ?? " "}]:`;
				const pre = doc.createElement("pre");
				pre.className = "m-0 p-2 rounded border border-border bg-muted/50 overflow-x-auto text-xs";
				const code = doc.createElement("code");
				code.className = "hljs";
				const source = clip(cell.source);
				if (hljs.getLanguage(nb.language)) {
					// highlight.js escapes the source; its output holds only its own spans.
					code.innerHTML = hljs.highlight(source, { language: nb.language, ignoreIllegals: true }).value;
				} else {
					code.textContent = source;
				}
				pre.appendChild(code);
				cellEl.append(label, pre);
				for (const out of cell.outputs) {
					const o = this.renderOutput(doc, out, urls, nodeBudget);
					if (o) cellEl.appendChild(o);
				}
			} else {
				const pre = doc.createElement("pre");
				pre.className = "m-0 p-2 text-xs text-muted-foreground whitespace-pre-wrap";
				pre.textContent = clip(cell.source);
				cellEl.appendChild(pre);
			}
			root.appendChild(cellEl);
		}
		if (nb.cells.length === 0) {
			root.textContent = i18n("This notebook has no cells.");
		}
		container.appendChild(root);
		return () => {
			for (const u of urls) URL.revokeObjectURL(u);
		};
	}

	private renderOutput(
		doc: Document,
		out: NotebookOutput,
		urls: string[],
		budget: NodeBudget,
	): HTMLElement | undefined {
		const box = doc.createElement("div");
		box.className = "pl-2 border-l-2 border-border min-w-0 overflow-x-auto";
		switch (out.kind) {
			case "stream":
			case "text":
			case "error": {
				const pre = doc.createElement("pre");
				pre.className = `m-0 text-xs whitespace-pre-wrap ${out.kind === "error" || (out.kind === "stream" && out.name === "stderr") ? "text-destructive" : ""}`;
				pre.textContent = clip(out.text);
				box.appendChild(pre);
				break;
			}
			case "image": {
				const img = doc.createElement("img");
				img.src = `data:${out.mime};base64,${out.data}`;
				img.alt = "";
				img.className = "max-w-full h-auto bg-white";
				box.appendChild(img);
				break;
			}
			case "svg": {
				// As an <img>, an SVG cannot run script or load anything else.
				const url = URL.createObjectURL(new Blob([out.svg], { type: "image/svg+xml" }));
				urls.push(url);
				const img = doc.createElement("img");
				img.src = url;
				img.alt = "";
				img.className = "max-w-full h-auto bg-white";
				box.appendChild(img);
				break;
			}
			case "html": {
				const div = doc.createElement("div");
				div.className =
					"notebook-html text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted";
				div.appendChild(sanitizeHtml(out.html, doc, budget));
				box.appendChild(div);
				break;
			}
			case "markdown": {
				const md = renderMarkdown(doc, out.text, {}, budget);
				box.appendChild(md);
				break;
			}
		}
		return box;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"notebook-artifact": NotebookArtifact;
	}
}
