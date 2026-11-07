/**
 * What `import katex from "katex"` means in the panel (scripts/build.mjs): math rendering, loaded the first time a
 * message holds a formula. Until then the formula shows as plain text for a moment.
 */
import type { KatexOptions } from "katex";
import { escapeHtml, redrawAfterLoad } from "./refresh.js";

let real: { renderToString(text: string, options?: KatexOptions): string } | undefined;
let loading: Promise<unknown> | undefined;

export default {
	renderToString(text: string, options?: KatexOptions) {
		if (real) return real.renderToString(text, options);
		loading ??= import("katex").then((lib) => {
			real = lib.default;
			redrawAfterLoad();
		});
		return `<code>${escapeHtml(text)}</code>`;
	},
};
