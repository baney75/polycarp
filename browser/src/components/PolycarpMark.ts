import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { POLYCARP_ICON, POLYCARP_ICON_16, POLYCARP_MARK } from "./polycarp-svg.js";

/**
 * The Polycarp logo. `tile` is the moss app icon (below 24 px, the drawing without the pointer, which would blur);
 * `mark` is the bare branch in currentColor.
 */
export function polycarpMark(size: number, variant: "tile" | "mark" = "tile", className = ""): TemplateResult {
	return html`<span
		class="inline-block shrink-0 [&>svg]:block [&>svg]:w-full [&>svg]:h-full ${className}"
		style="width:${size}px;height:${size}px"
		aria-hidden="true"
		>${unsafeSVG(variant === "mark" ? POLYCARP_MARK : size < 24 ? POLYCARP_ICON_16 : POLYCARP_ICON)}</span
	>`;
}
