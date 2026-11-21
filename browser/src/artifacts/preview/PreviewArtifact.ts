import { i18n } from "@mariozechner/mini-lit";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import { ArtifactElement } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
import { base64DecodedSize, decodeBase64Content, PreviewLimitError, readTextContent } from "./content.js";
import { mimeTypeFor } from "./file-types.js";

/**
 * Base for the document previews (pptx, ODF, RTF, notebooks, CSV, media). It holds the content,
 * renders into a container on change, drops a render that a newer one replaced, and shows a
 * readable error instead of a blank panel when a file can't be read.
 */
export abstract class PreviewArtifact extends ArtifactElement {
	private _content = "";
	private renderToken = 0;
	private cleanup: (() => void) | undefined;
	protected containerRef: Ref<HTMLDivElement> = createRef();
	@state() protected error: string | null = null;
	@state() protected loading = false;

	get content(): string {
		return this._content;
	}

	set content(value: string) {
		if (value === this._content) return;
		this._content = value;
		this.error = null;
		this.requestUpdate();
		void this.refresh();
	}

	/** Content is base64 for binary formats; text formats override this. */
	protected get isBinary(): boolean {
		return true;
	}

	protected get errorTitle(): string {
		return i18n("Error loading document");
	}

	/** Draw the preview into `container`. Return a cleanup function for object URLs and observers. */
	protected abstract renderPreview(container: HTMLElement, content: string): Promise<(() => void) | undefined>;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	/** How long a detached viewer keeps its preview before releasing it. */
	static releaseDelayMs = 10_000;
	private releaseTimer?: ReturnType<typeof setTimeout>;
	private released = false;

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.style.height = "100%";
		clearTimeout(this.releaseTimer);
		// Attached again after a release: draw the preview again.
		if (this.released) {
			this.released = false;
			void this.refresh();
		}
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		// The panel detaches and reattaches viewers when it re-renders, so the preview is kept for
		// a while. A viewer that stays detached (its artifact deleted, the session switched)
		// releases its blob URLs, observers and decoded copy.
		clearTimeout(this.releaseTimer);
		this.releaseTimer = setTimeout(() => {
			if (this.isConnected) return;
			this.renderToken++;
			this.cleanup?.();
			this.cleanup = undefined;
			this.containerRef.value?.replaceChildren();
			this.decodeCache = undefined;
			this.textCache = undefined;
			this.released = true;
		}, PreviewArtifact.releaseDelayMs);
	}

	private async refresh(): Promise<void> {
		await this.updateComplete;
		const container = this.containerRef.value;
		if (!container || !this._content) return;
		const token = ++this.renderToken;
		this.cleanup?.();
		this.cleanup = undefined;
		// Each render draws into its own child, so a render that a newer one replaced can be
		// removed whole even if it finishes later.
		const target = container.ownerDocument.createElement("div");
		target.className = "h-full";
		container.replaceChildren(target);
		this.loading = true;
		try {
			const cleanup = await this.renderPreview(target, this._content);
			if (token !== this.renderToken) {
				cleanup?.();
				target.remove();
				return;
			}
			this.cleanup = cleanup;
		} catch (e) {
			target.remove();
			if (token !== this.renderToken) return;
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			if (token === this.renderToken) this.loading = false;
		}
	}

	private decodeCache?: { content: string; bytes: Uint8Array };
	private textCache?: { content: string; text: string };

	/** Text formats name the test that tells the file's text from its base64 form. */
	protected looksLikeText?(text: string): boolean;

	/**
	 * The file's bytes, decoded once per content value and shared by the preview and the
	 * download button. Throws a limit error when the file is larger than `maxBytes`.
	 */
	protected decodedContent(maxBytes: number): Uint8Array {
		// The cache comes first, so a header re-render never rescans a large string.
		const cached = this.decodeCache?.content === this._content ? this.decodeCache.bytes : undefined;
		const size = cached ? cached.length : base64DecodedSize(this._content);
		if (size > maxBytes)
			throw new PreviewLimitError(`File is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
		if (cached) return cached;
		const bytes = decodeBase64Content(this._content, Number.POSITIVE_INFINITY);
		this.decodeCache = { content: this._content, bytes };
		return bytes;
	}

	/** A text format's text, decoded from base64 when it was stored that way. */
	protected fileText(): string {
		if (this.textCache?.content !== this._content) {
			const check = this.looksLikeText?.bind(this);
			this.textCache = {
				content: this._content,
				text: check ? readTextContent(this._content, check) : this._content,
			};
		}
		return this.textCache.text;
	}

	/** The file as saved. Not size-limited: download is the way out for files too large to preview. */
	protected downloadBytes(): Uint8Array | string {
		if (!this.isBinary) return this.fileText();
		try {
			return this.decodedContent(Number.POSITIVE_INFINITY);
		} catch {
			return this._content;
		}
	}

	public getHeaderButtons(): TemplateResult {
		return html`
			<div class="flex items-center gap-1">
				${DownloadButton({
					content: this.downloadBytes(),
					filename: this.filename,
					mimeType: mimeTypeFor(this.filename),
					title: i18n("Download"),
				})}
			</div>
		`;
	}

	override render(): TemplateResult {
		return html`
			<div class="h-full flex flex-col bg-background overflow-auto relative">
				${
					this.error
						? html`<div class="flex-1 flex items-center justify-center p-4">
							<div class="bg-destructive/10 border border-destructive text-destructive p-4 rounded-lg max-w-2xl">
								<div class="font-medium mb-1">${this.errorTitle}</div>
								<div class="text-sm opacity-90">${this.error}</div>
							</div>
						</div>`
						: ""
				}
				${this.loading ? html`<div class="absolute top-2 right-3 text-xs text-muted-foreground">${i18n("Loading...")}</div>` : ""}
				<div ${ref(this.containerRef)} class="flex-1 min-h-0" style="display: ${this.error ? "none" : "block"}"></div>
			</div>
		`;
	}
}
