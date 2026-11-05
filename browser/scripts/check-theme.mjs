#!/usr/bin/env node
// Fails when a color is written into the panel's CSS or components instead of coming from a token.
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
	"src/components/helm-svg.ts": {
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
		max: 25,
		why: "Overlay injected into the web page being driven, outside the panel's document, where no panel token exists.",
	},
	"src/tools/ask-user-which-element.ts": {
		max: 10,
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
	});
	return found;
}

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
