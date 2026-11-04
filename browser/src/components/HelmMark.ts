import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { HELM_ICON, HELM_ICON_16, HELM_MARK } from "./helm-svg.js";

/**
 * The Tabkyra helm. `tile` is the brass app icon (below 32 px, the 16 px drawing, which
 * drops the pointer that would blur); `mark` is the bare helm in currentColor.
 */
export function helmMark(size: number, variant: "tile" | "mark" = "tile", className = ""): TemplateResult {
	return html`<span
		class="inline-block shrink-0 [&>svg]:block [&>svg]:w-full [&>svg]:h-full ${className}"
		style="width:${size}px;height:${size}px"
		aria-hidden="true"
		>${unsafeSVG(variant === "mark" ? HELM_MARK : size < 32 ? HELM_ICON_16 : HELM_ICON)}</span
	>`;
}
