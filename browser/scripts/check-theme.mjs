#!/usr/bin/env node
// Fails when a color is written into the panel's CSS or components instead of coming from a token.
//
// A color literal is also a CSS color name (white, black, red...) given to a color property (`color: white`).
// It is checked in the panel and in the CSS of the consent and hub pages (cli/src: PAGE_CSS in theme.ts and the
// <style> blocks and style="" attributes of oauth.ts and hub-server.ts), where only token definitions may hold a color.
//
// A color literal is a hex color (#rgb, #rrggbb, with or without alpha) or a color function (rgb(),
// rgba(), hsl(), hsla(), hwb(), lab(), lch(), oklab(), oklch()). It is allowed:
//   1. on a line that defines a custom property (`--tk-brass: #e3a93b;`), because that is where tokens live;
//   2. in a file the allowlist below names, up to the count written there, with the reason.
// The allowlist is a ceiling: a new color in an allowed file raises the count and fails until someone
// changes the number here, in a change a reviewer sees. Run from browser/: node scripts/check-theme.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN = ["src", "static"];
const EXT = /\.(ts|css|html|js)$/;

/** file (relative to browser/) -> { max: how many literals, why }. Keep the reasons honest. */
export const ALLOWLIST = {
	"src/appearance/palettes.ts": {
		max: Number.POSITIVE_INFINITY,
		why: "The preset palettes: this file is the token source for the panel and the pages.",
	},
	"src/components/polycarp-svg.ts": {
		max: 21,
		why: "The brand mark (media/brand/BRAND.md): a fixed image, not a theme surface.",
	},
	"src/dialogs/AppearanceTab.ts": {
		max: 3,
		why: "Example text in the accent box's hint and error message, not a style.",
	},
	"src/dialogs/CostsTab.ts": {
		max: 14,
		why: "Chart series colors: categorical data colors that must stay distinct from each other.",
	},
	"src/dialogs/SessionCostDialog.ts": {
		max: 4,
		why: "Chart series colors: categorical data colors that must stay distinct from each other.",
	},
	"src/tools/repl/overlay-content.ts": {
		max: 26,
		why: "Overlay injected into the web page being driven, outside the panel's document, where no panel token exists.",
	},
	"src/tools/ask-user-which-element.ts": {
		max: 13,
		why: "Element picker injected into the web page being driven, outside the panel's document.",
	},
	"src/artifacts/RtfArtifact.ts": { max: 2, why: "Renders a document's own colors." },
	"src/artifacts/OdfArtifact.ts": { max: 2, why: "Renders a document's own colors." },
	"src/artifacts/preview/slide-render.ts": { max: 12, why: "Renders a document's own colors." },
	"src/artifacts/preview/page.ts": {
		max: 3,
		why: "The sandboxed preview page for a document: its own document, no panel tokens.",
	},
	"src/artifacts/preview/drawingml.ts": { max: 1, why: "Renders a document's own colors." },
	"src/artifacts/preview/odf.ts": { max: 7, why: "Renders a document's own colors." },
	"src/tools/default-skills.ts": {
		max: 1,
		why: "Text of skills the agent reads, which mentions colors; not a style.",
	},
	"src/ask/bridge-worker.ts": {
		max: 1,
		why: "Page code run in the web page being driven, outside the panel's document.",
	},
	"static/test.html": { max: 2, why: "A developer test page, never shown to a person." },
};

const COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const NAMES =
	"white|black|red|green|blue|yellow|orange|purple|pink|brown|gray|grey|silver|gold|navy|teal|maroon|olive|lime|aqua|cyan|magenta|fuchsia|indigo|violet|crimson|coral|salmon|tomato|beige|ivory|khaki|lavender|tan|turquoise|whitesmoke|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey|slategray|darkred|darkgreen|darkblue|lightblue|lightgreen|skyblue|royalblue|steelblue|firebrick|rebeccapurple";
const COLOR_PROPERTY =
	"(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration-color|column-rule-color|box-shadow|text-shadow)";
const NAMED = new RegExp(`(?:^|[\\s;{}"'\`])${COLOR_PROPERTY}\\s*:([^;}"'\`]*)`, "gi");
const NAME = new RegExp(`\\b(?:${NAMES})\\b`, "gi");
const DEFINITION = /^\s*(?:["'`]?)--[\w-]+\s*:/;

function* files(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* files(path);
		else if (EXT.test(name)) yield path;
	}
}

/** Color literals in `text` that are not on a custom property definition line: [{ line, text }]. */
export function findColors(text) {
	const found = [];
	text.split("\n").forEach((line, i) => {
		if (DEFINITION.test(line)) return;
		for (const m of line.matchAll(COLOR)) found.push({ line: i + 1, text: m[0] });
		found.push(...namedColors(line.replace(/\/\*.*?\*\//g, "")).map((text) => ({ line: i + 1, text })));
	});
	return found;
}

/** Color names given to a color property in `line`, ignoring var(), url() and calc() contents. */
export function namedColors(line) {
	const found = [];
	for (const m of line.matchAll(NAMED)) {
		const value = m[1].replace(/(?:var|url|calc|env)\([^)]*\)/gi, "");
		for (const n of value.matchAll(NAME)) found.push(n[0]);
	}
	return found;
}

/** The CSS a TypeScript page file builds, as [{ line, css }]: the PAGE_CSS literal, <style> blocks and style="" attributes. */
export function pageCssRegions(text) {
	const out = [];
	const add = (index, css) => out.push({ line: text.slice(0, index).split("\n").length, css });
	for (const m of text.matchAll(/const PAGE_CSS = `([^`]*)`/g)) add(m.index, m[1]);
	for (const m of text.matchAll(/<style>([\s\S]*?)<\/style>/g)) add(m.index, m[1]);
	for (const m of text.matchAll(/\sstyle="([^"]*)"/g)) add(m.index, m[1]);
	return out;
}

/** Color literals in the page CSS of a file; a declaration that defines a custom property (--x: ...) may hold one. */
export function findPageColors(text) {
	const found = [];
	for (const { line, css } of pageCssRegions(text)) {
		const declarations = css.split(/[;{}]/).filter((d) => !DEFINITION.test(d));
		for (const d of declarations) {
			for (const m of d.matchAll(COLOR)) found.push({ line, text: m[0] });
			for (const n of namedColors(`${d};`)) found.push({ line, text: n });
		}
	}
	return found;
}

const PAGE_FILES = ["cli/src/theme.ts", "cli/src/oauth.ts", "cli/src/hub-server.ts"];

export function check() {
	const problems = [];
	const used = new Set();
	for (const top of SCAN) {
		for (const path of files(join(root, top))) {
			const rel = relative(root, path).split("\\").join("/");
			const found = findColors(readFileSync(path, "utf8"));
			if (found.length === 0) continue;
			const allowed = ALLOWLIST[rel];
			if (allowed) {
				used.add(rel);
				if (found.length > allowed.max)
					problems.push(
						`${rel}: ${found.length} color literals, the allowlist says ${allowed.max} (${allowed.why})`,
					);
				continue;
			}
			for (const f of found)
				problems.push(
					`${rel}:${f.line}: ${f.text} is a hard-coded color. Use a token (var(--...)), or define one in src/app.css.`,
				);
		}
	}
	for (const rel of PAGE_FILES) {
		for (const f of findPageColors(readFileSync(join(root, rel), "utf8")))
			problems.push(
				`${rel}:${f.line}: ${f.text} is a hard-coded color in a page's CSS. Use a token (var(--...)), or define one in PAGE_CSS.`,
			);
	}
	for (const rel of Object.keys(ALLOWLIST)) {
		if (!used.has(rel))
			problems.push(`${rel}: on the allowlist but has no color literals (or does not exist). Remove the entry.`);
	}
	return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = check();
	if (problems.length) {
		console.error(`check-theme: ${problems.length} problem(s)\n${problems.join("\n")}`);
		process.exit(1);
	}
	console.log("check-theme: no hard-coded colors outside token definitions and the allowlist");
}
