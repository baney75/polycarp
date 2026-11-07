/// <reference path="./utils/i18n-extension.ts" />

// Resolved by scripts/build.mjs from pi-mono's and mini-lit's copies; src/lazy/ only needs these shapes.
declare module "highlight.js/lib/index.js";
declare module "katex" {
	export interface KatexOptions {
		[option: string]: unknown;
	}
	const katex: { renderToString(text: string, options?: KatexOptions): string };
	export default katex;
}
