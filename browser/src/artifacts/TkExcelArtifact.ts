import { i18n } from "@mariozechner/mini-lit";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { ArtifactElement } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import * as XLSX from "xlsx";
import { DecodedContent, PREVIEW_LIMITS, PreviewLimitError } from "./preview/content.js";
import { mimeTypeFor } from "./preview/file-types.js";
import { cappedWorkbookZip, clampSheet, MAX_SHEETS } from "./preview/spreadsheet.js";

const MAX_MERGES = 10_000;
const MAX_CELL_CHARS = 10_000;

@customElement("tk-excel-artifact")
export class TkExcelArtifact extends ArtifactElement {
	private renderToken = 0;
	@property({ type: String }) private _content = "";
	@state() private error: string | null = null;

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		this._content = value;
		this.error = null;
		this.requestUpdate();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
	}

	private decoded = new DecodedContent();

	/** The file for download: decoded once per content, or the content as given if it isn't base64. */
	private downloadContent(): Uint8Array | string {
		return this.decoded.bytes(this._content) ?? this._content;
	}

	private getMimeType(): string {
		return mimeTypeFor(this.filename);
	}

	public getHeaderButtons() {
		return html`
			<div class="flex items-center gap-1">
				${DownloadButton({
					content: this.downloadContent(),
					filename: this.filename,
					mimeType: this.getMimeType(),
					title: i18n("Download"),
				})}
			</div>
		`;
	}

	override async updated(changedProperties: Map<string, any>) {
		super.updated(changedProperties);

		if (changedProperties.has("_content") && this._content && !this.error) {
			await this.renderExcel();
		}
	}

	private async renderExcel() {
		const container = this.querySelector("#excel-container");
		if (!container || !this._content) return;

		const token = ++this.renderToken;
		try {
			// Bounded like the other previews: the file size, then every zip entry through the
			// streaming caps, then rows, columns and cells per sheet.
			// The same decoded bytes back the download button.
			let input = this.decoded.bytes(this._content);
			if (!input) throw new Error("Content is not base64");
			if (input.length > PREVIEW_LIMITS.maxSpreadsheetBytes) {
				throw new PreviewLimitError(`File is larger than ${PREVIEW_LIMITS.maxSpreadsheetBytes / (1024 * 1024)} MB`);
			}
			if (input[0] === 0x50 && input[1] === 0x4b) input = await cappedWorkbookZip(input);
			// A newer content value started its own render while this one waited.
			if (token !== this.renderToken) return;
			const workbook = XLSX.read(input, { type: "array", sheetRows: PREVIEW_LIMITS.maxTableRows });
			workbook.SheetNames = workbook.SheetNames.slice(0, MAX_SHEETS);

			container.innerHTML = "";
			const wrapper = document.createElement("div");
			wrapper.className = "overflow-auto h-full flex flex-col";
			container.appendChild(wrapper);

			// Create tabs for multiple sheets
			if (workbook.SheetNames.length > 1) {
				const tabContainer = document.createElement("div");
				tabContainer.className = "flex gap-2 mb-4 border-b border-border sticky top-0 bg-background z-10";

				const sheetContents: HTMLElement[] = [];
				const builders: (() => void)[] = [];

				workbook.SheetNames.forEach((sheetName, index) => {
					// Create tab button
					const tab = document.createElement("button");
					tab.textContent = sheetName;
					tab.className =
						index === 0
							? "px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary"
							: "px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-b-2 hover:border-border transition-colors";

					// Create sheet content
					const sheetDiv = document.createElement("div");
					sheetDiv.style.display = index === 0 ? "flex" : "none";
					sheetDiv.className = "flex-1 overflow-auto";
					// Sheets build when first shown, so only the open one costs anything.
					let built = false;
					const build = () => {
						if (built) return;
						built = true;
						sheetDiv.appendChild(this.renderExcelSheet(workbook.Sheets[sheetName]));
					};
					if (index === 0) build();
					builders.push(build);
					sheetContents.push(sheetDiv);

					// Tab click handler
					tab.onclick = () => {
						// Update tab styles
						tabContainer.querySelectorAll("button").forEach((btn, btnIndex) => {
							if (btnIndex === index) {
								btn.className = "px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary";
							} else {
								btn.className =
									"px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-b-2 hover:border-border transition-colors";
							}
						});
						builders[index]();
						// Show/hide sheets
						sheetContents.forEach((content, contentIndex) => {
							content.style.display = contentIndex === index ? "flex" : "none";
						});
					};

					tabContainer.appendChild(tab);
				});

				wrapper.appendChild(tabContainer);
				sheetContents.forEach((content) => {
					wrapper.appendChild(content);
				});
			} else {
				// Single sheet
				const sheetName = workbook.SheetNames[0];
				wrapper.appendChild(this.renderExcelSheet(workbook.Sheets[sheetName]));
			}
		} catch (error: any) {
			if (token !== this.renderToken) return;
			console.error("Error rendering Excel:", error);
			this.error = error?.message || i18n("Failed to load spreadsheet");
		}
	}

	/**
	 * The sheet as a table built from cell values with textContent: no HTML from the file is
	 * parsed, and the clamped range bounds the cells.
	 */
	private renderExcelSheet(worksheet: XLSX.WorkSheet): HTMLElement {
		const sheetDiv = document.createElement("div");
		clampSheet(worksheet);
		const ref = worksheet["!ref"];
		if (!ref) return sheetDiv;
		const range = XLSX.utils.decode_range(ref);
		// Merged cells span; the cells they cover are skipped.
		const covered = new Set<string>();
		const spans = new Map<string, { rows: number; cols: number }>();
		for (const m of (worksheet["!merges"] ?? []).slice(0, MAX_MERGES)) {
			const rows = Math.min(m.e.r, range.e.r) - m.s.r + 1;
			const cols = Math.min(m.e.c, range.e.c) - m.s.c + 1;
			if (rows < 1 || cols < 1 || m.s.r < range.s.r || m.s.c < range.s.c) continue;
			// Overlapping merges can't multiply the work: the covered cells are bounded too.
			if (covered.size + rows * cols > PREVIEW_LIMITS.maxTableCells) break;
			spans.set(`${m.s.r}:${m.s.c}`, { rows, cols });
			for (let r = m.s.r; r < m.s.r + rows; r++)
				for (let c = m.s.c; c < m.s.c + cols; c++) if (r !== m.s.r || c !== m.s.c) covered.add(`${r}:${c}`);
		}
		const table = document.createElement("table");
		table.className = "w-full border-collapse text-foreground";
		for (let r = range.s.r; r <= range.e.r; r++) {
			const tr = document.createElement("tr");
			if (r > range.s.r && (r - range.s.r) % 2 === 0) tr.className = "bg-muted/30";
			for (let c = range.s.c; c <= range.e.c; c++) {
				if (covered.has(`${r}:${c}`)) continue;
				const cell = worksheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
				const td = document.createElement("td");
				const text = cell ? (cell.w ?? (cell.v === undefined || cell.v === null ? "" : String(cell.v))) : "";
				td.textContent = text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}\u2026` : text;
				td.className =
					r === range.s.r
						? "border border-border px-3 py-2 text-sm font-semibold bg-muted text-foreground sticky top-0 text-left"
						: "border border-border px-3 py-2 text-sm text-left";
				const span = spans.get(`${r}:${c}`);
				if (span) {
					if (span.cols > 1) td.colSpan = span.cols;
					if (span.rows > 1) td.rowSpan = span.rows;
				}
				tr.appendChild(td);
			}
			table.appendChild(tr);
		}
		sheetDiv.appendChild(table);
		return sheetDiv;
	}

	override render(): TemplateResult {
		if (this.error) {
			return html`
				<div class="h-full flex items-center justify-center bg-background p-4">
					<div class="bg-destructive/10 border border-destructive text-destructive p-4 rounded-lg max-w-2xl">
						<div class="font-medium mb-1">${i18n("Error loading spreadsheet")}</div>
						<div class="text-sm opacity-90">${this.error}</div>
					</div>
				</div>
			`;
		}

		return html`
			<div class="h-full flex flex-col bg-background overflow-auto">
				<div id="excel-container" class="flex-1 overflow-auto"></div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"tk-excel-artifact": TkExcelArtifact;
	}
}
