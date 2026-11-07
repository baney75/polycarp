/**
 * What `import hljs from "highlight.js"` means in the panel (scripts/build.mjs): highlight.js's core, with all 190-odd
 * languages loading the first time one is asked for. The chat's code blocks register the common ones themselves
 * (mini-lit's CodeBlock), so most chats never load the rest.
 */
import core from "highlight.js/lib/core";
import { escapeHtml, redrawAfterLoad } from "./refresh.js";

let all: Promise<unknown> | undefined;

function loadAllLanguages() {
	// The full build registers its languages on this same core.
	all ??= import("highlight.js/lib/index.js").then(redrawAfterLoad);
}

export default {
	getLanguage(name: string) {
		const language = core.getLanguage(name);
		if (!language) loadAllLanguages();
		return language;
	},
	highlight(code: string, options: { language: string; ignoreIllegals?: boolean }) {
		if (core.getLanguage(options.language)) return core.highlight(code, options);
		loadAllLanguages();
		return { value: escapeHtml(code), language: options.language };
	},
};
