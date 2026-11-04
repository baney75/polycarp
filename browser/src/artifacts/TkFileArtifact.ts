import { i18n } from "@mariozechner/mini-lit";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { ArtifactElement } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DecodedContent } from "./preview/content.js";
import { conversionHint, mimeTypeFor } from "./preview/file-types.js";

@customElement("tk-file-artifact")
export class TkFileArtifact extends ArtifactElement {
	@property({ type: String }) private _content = "";

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		this._content = value;
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

	private renderMessage(): TemplateResult {
		const hint = conversionHint(this.filename);
		if (hint) {
			return html`
				<p class="text-sm">
					${i18n("This {type} can't be previewed here.").replace("{type}", () => hint.name)}
					${i18n("Save it as {format} to preview it, or download it to open it on your computer.").replace("{format}", () => hint.saveAs)}
				</p>
			`;
		}
		return html`
			<p class="text-sm">
				${i18n("Preview not available for this file type.")} ${i18n("Click the download button above to view it on your computer.")}
			</p>
		`;
	}

	override render(): TemplateResult {
		return html`
			<div class="h-full flex items-center justify-center bg-background p-8">
				<div class="text-center max-w-md">
					<div class="text-muted-foreground text-lg mb-4">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							class="h-16 w-16 mx-auto mb-4 text-muted-foreground/50"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
							/>
						</svg>
						<div class="font-medium text-foreground mb-2">${this.filename}</div>
						${this.renderMessage()}
					</div>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"tk-file-artifact": TkFileArtifact;
	}
}
