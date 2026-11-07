/**
 * What highlight.js means in the panel (scripts/build.mjs): its core, with all 190-odd languages loading the first time
 * one is asked for. The chat's code blocks register the common ones themselves (mini-lit's CodeBlock), so most chats
 * never load the rest. A block in another language is drawn again once they arrive.
 */
import core from "highlight.js/lib/core";
import plaintext from "highlight.js/lib/languages/plaintext";
import { escapeHtml, redrawAfterLoad } from "./refresh.js";

// A block with no language asks for "text". That shouldn't load everything, and guessing would color plain text.
core.registerLanguage("plaintext", plaintext);

let all: Promise<unknown> | undefined;

function loadAllLanguages() {
	// The full build registers its languages on this same core.
	all ??= import("highlight.js/lib/index.js").then(redrawAfterLoad, () => {
		all = undefined;
	});
}

export default {
	registerLanguage: core.registerLanguage.bind(core),
	/** A block with no language: guessed among the languages loaded so far. */
	highlightAuto: core.highlightAuto.bind(core),
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
