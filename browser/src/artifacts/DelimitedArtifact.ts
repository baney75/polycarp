import { i18n } from "@mariozechner/mini-lit";
import { CopyButton } from "@mariozechner/mini-lit/dist/CopyButton.js";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { PreviewCodeToggle } from "@mariozechner/mini-lit/dist/PreviewCodeToggle.js";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { PREVIEW_LIMITS, PreviewLimitError } from "./preview/content.js";
import { detectDelimiter, looksDelimited, parseDelimited } from "./preview/delimited.js";
import { mimeTypeFor } from "./preview/file-types.js";
import { PreviewArtifact } from "./preview/PreviewArtifact.js";

const MAX_RAW_CHARS = 2_000_000;
/** Longest text shown in one table cell; the raw view has the rest. */
const MAX_CELL_CHARS = 10_000;

/** CSV and TSV as a table, with a toggle to the raw text. */
@customElement("delimited-artifact")
export class DelimitedArtifact extends PreviewArtifact {
	@state() private viewMode: "preview" | "code" = "preview";
	private tableView?: HTMLElement;
	private rawView?: HTMLElement;

	protected override get isBinary(): boolean {
		return false;
	}

	protected override get errorTitle(): string {
		return i18n("Error loading table");
	}

	private setViewMode(mode: "preview" | "code") {
		this.viewMode = mode;
		this.applyMode();
	}

	private applyMode() {
		if (this.tableView) this.tableView.style.display = this.viewMode === "preview" ? "block" : "none";
		if (this.rawView) this.rawView.style.display = this.viewMode === "code" ? "block" : "none";
	}

	public override getHeaderButtons(): TemplateResult {
		const toggle = new PreviewCodeToggle();
		toggle.mode = this.viewMode;
		toggle.title = i18n("Table or raw text");
		toggle.addEventListener("mode-change", (e: Event) => this.setViewMode((e as CustomEvent).detail));
		const copy = new CopyButton();
		copy.text = this.fileText();
		copy.title = i18n("Copy");
		copy.showText = false;
		return html`
			<div class="flex items-center gap-1">
				${toggle} ${copy}
				${DownloadButton({ content: this.fileText(), filename: this.filename, mimeType: mimeTypeFor(this.filename), title: i18n("Download") })}
			</div>
		`;
	}

	protected override looksLikeText(text: string): boolean {
		return looksDelimited(text);
	}

	protected async renderPreview(container: HTMLElement) {
		const text = this.fileText();
		if (text.length > PREVIEW_LIMITS.maxDocumentBytes) throw new PreviewLimitError("File is too large to preview");
		const doc = container.ownerDocument;
		const delimiter = detectDelimiter(text, this.filename);
		const table = parseDelimited(text, delimiter, PREVIEW_LIMITS.maxTableRows + 1, PREVIEW_LIMITS.maxTableColumns);
		const width = table.rows.reduce((m, r) => Math.max(m, r.length), 0);
		// Rows and cells are both bounded, so a very wide file can't flood the panel.
		const rowLimit = Math.min(
			PREVIEW_LIMITS.maxTableRows,
			Math.max(1, Math.floor(PREVIEW_LIMITS.maxTableCells / Math.max(1, width))),
		);
		// The table's text is bounded too, counting each cell as shown (clipped).
		let chars = 0;
		let rowCount = 0;
		for (const r of table.rows.slice(0, rowLimit)) {
			for (const v of r) chars += Math.min(v.length, MAX_CELL_CHARS);
			if (chars > MAX_RAW_CHARS && rowCount > 0) break;
			rowCount++;
		}
		const shown = table.rows.slice(0, rowCount);
		const truncated = table.truncated || table.rows.length > rowCount;

		const tableView = doc.createElement("div");
		tableView.className = "h-full overflow-auto";
		const info = doc.createElement("div");
		info.className = "px-3 py-1 text-xs text-muted-foreground";
		// Counts are the file's own; the parser counts rows and fields past what it keeps.
		const parts = [
			i18n("{rows} rows").replace("{rows}", () => String(Math.max(0, table.totalRows - 1))),
			i18n("{cols} columns").replace("{cols}", () => String(table.totalColumns)),
		];
		if (truncated)
			parts.push(i18n("showing the first {count}").replace("{count}", () => String(Math.max(0, rowCount - 1))));
		if (table.wide)
			parts.push(
				i18n("columns after {count} not shown").replace("{count}", () => String(PREVIEW_LIMITS.maxTableColumns)),
			);
		info.textContent = parts.join(" · ");
		tableView.appendChild(info);
		const el = doc.createElement("table");
		el.className = "border-collapse text-sm text-foreground";
		shown.forEach((row, i) => {
			const tr = doc.createElement("tr");
			if (i % 2 === 0 && i > 0) tr.className = "bg-muted/30";
			for (let c = 0; c < width; c++) {
				const cell = doc.createElement(i === 0 ? "th" : "td");
				const value = row[c] ?? "";
				cell.textContent = value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}\u2026` : value;
				cell.className =
					i === 0
						? "border border-border px-3 py-1.5 text-left font-semibold bg-muted sticky top-0 whitespace-pre-wrap"
						: "border border-border px-3 py-1.5 text-left align-top whitespace-pre-wrap";
				tr.appendChild(cell);
			}
			el.appendChild(tr);
		});
		tableView.appendChild(el);

		const rawView = doc.createElement("pre");
		rawView.className = "h-full overflow-auto m-0 p-4 text-xs font-mono whitespace-pre";
		rawView.textContent =
			text.length > MAX_RAW_CHARS ? `${text.slice(0, MAX_RAW_CHARS)}\n\n[${i18n("Truncated for display")}]` : text;

		container.append(tableView, rawView);
		this.tableView = tableView;
		this.rawView = rawView;
		this.applyMode();
		return () => {
			this.tableView = undefined;
			this.rawView = undefined;
		};
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"delimited-artifact": DelimitedArtifact;
	}
}
