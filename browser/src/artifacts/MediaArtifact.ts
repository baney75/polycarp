import { i18n } from "@mariozechner/mini-lit";
import { customElement } from "lit/decorators.js";
import { PREVIEW_LIMITS } from "./preview/content.js";
import { getArtifactFileType, mimeTypeFor } from "./preview/file-types.js";
import { PreviewArtifact } from "./preview/PreviewArtifact.js";

/** Audio and video with the browser's own player. The file plays from a local blob URL. */
@customElement("media-artifact")
export class MediaArtifact extends PreviewArtifact {
	private media?: HTMLMediaElement;

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.media?.pause();
	}

	protected override get errorTitle(): string {
		return i18n("Error loading media");
	}

	protected async renderPreview(container: HTMLElement) {
		// The same decoded bytes back the download button; the Blob wraps them without another copy.
		const bytes = this.decodedContent(PREVIEW_LIMITS.maxMediaBytes) as Uint8Array<ArrayBuffer>;
		const url = URL.createObjectURL(new Blob([bytes], { type: mimeTypeFor(this.filename) }));
		const isVideo = getArtifactFileType(this.filename) === "video";
		const doc = container.ownerDocument;
		const wrap = doc.createElement("div");
		wrap.className = "h-full flex flex-col items-center justify-center gap-3 p-4";
		const media = doc.createElement(isVideo ? "video" : "audio");
		media.controls = true;
		media.preload = "metadata";
		media.src = url;
		media.setAttribute("controlsList", "nodownload");
		if (media instanceof HTMLVideoElement) {
			media.className = "max-w-full max-h-full rounded bg-black";
			media.playsInline = true;
		} else {
			media.className = "w-full max-w-xl";
		}
		const name = doc.createElement("div");
		name.className = "text-sm text-muted-foreground break-all text-center";
		name.textContent = this.filename;
		media.addEventListener("error", () => {
			name.textContent = i18n("This browser can't play {filename}. Download it to play it elsewhere.").replace(
				"{filename}",
				() => this.filename,
			);
		});
		wrap.append(media, name);
		container.appendChild(wrap);
		this.media = media;
		// Hidden tabs stay in the DOM with display: none; stop playback when this one is hidden.
		const observer = new IntersectionObserver((entries) => {
			if (entries.some((e) => !e.isIntersecting)) media.pause();
		});
		observer.observe(media);
		return () => {
			observer.disconnect();
			this.media = undefined;
			media.pause();
			media.removeAttribute("src");
			media.load();
			URL.revokeObjectURL(url);
		};
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"media-artifact": MediaArtifact;
	}
}
