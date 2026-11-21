import { i18n } from "@mariozechner/mini-lit";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { ArtifactElement } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { DecodedContent } from "./preview/content.js";
import { mimeTypeFor } from "./preview/file-types.js";

@customElement("tk-image-artifact")
export class TkImageArtifact extends ArtifactElement {
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

	private getMimeType(): string {
		return mimeTypeFor(this.filename);
	}

	private getImageUrl(): string {
		// If content is already a data URL, use it directly
		if (this._content.startsWith("data:")) {
			return this._content;
		}
		// Otherwise assume it's base64 and construct data URL
		return `data:${this.getMimeType()};base64,${this._content}`;
	}

	private decoded = new DecodedContent();

	/** The file for download: decoded once per content, or the content as given if it isn't base64. */
	private downloadContent(): Uint8Array | string {
		return this.decoded.bytes(this._content) ?? this._content;
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

	override render(): TemplateResult {
		return html`
			<div class="h-full flex flex-col bg-background overflow-auto">
				<div class="flex-1 flex items-center justify-center p-4">
					<img
						src="${this.getImageUrl()}"
						alt="${this.filename}"
						class="max-w-full max-h-full object-contain"
						@error=${(e: Event) => {
							const target = e.target as HTMLImageElement;
							target.src =
								"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext x='50' y='50' text-anchor='middle' dominant-baseline='middle' fill='%23999'%3EImage Error%3C/text%3E%3C/svg%3E";
						}}
					/>
				</div>
			</div>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"tk-image-artifact": TkImageArtifact;
	}
}
