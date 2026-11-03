/**
 * Page themes: the consent page and the hub's pages share these colors. Five presets, each with
 * a light and a dark palette, and an optional custom accent (#rrggbb). `theme.json` in the config
 * dir holds the choice. Pages follow prefers-color-scheme unless the choice fixes a mode (light or
 * dark, sent from the side panel's Appearance tab); every pair a page draws as text on a
 * background reaches WCAG AA (4.5:1), which cli/test/theme.test.mjs checks for every preset.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	contrast,
	DEFAULT_PRESET,
	isAccent,
	isPreset,
	luminance,
	type Palette,
	type Preset,
	PRESETS,
	resolveTheme as resolvePalettes,
	textOn,
	type ThemeChoice,
} from "../../src/appearance/palettes.ts";
import { writeJsonPrivate } from "./files.ts";
import { configDir } from "./oauth.ts";

export const themeFile = () => join(configDir(), "theme.json");

/** A mode the pages can be pinned to. "system" (follow prefers-color-scheme) is stored as no mode at all. */
export type PageMode = "light" | "dark";
export const isMode = (value: unknown): value is PageMode | "system" => value === "light" || value === "dark" || value === "system";

/** The saved choice: a preset, an optional accent and an optional fixed mode. */
export interface SavedTheme extends ThemeChoice {
	mode?: PageMode;
}

/** The saved choice. A missing, unreadable or unknown file gives the default: a page never fails on its theme. */
export function loadTheme(): SavedTheme {
	try {
		if (!existsSync(themeFile())) return { preset: DEFAULT_PRESET };
		const raw = JSON.parse(readFileSync(themeFile(), "utf8")) as Partial<SavedTheme>;
		const preset = isPreset(raw.preset) ? raw.preset : DEFAULT_PRESET;
		return { preset, ...(isAccent(raw.accent) ? { accent: raw.accent.toLowerCase() } : {}), ...(raw.mode === "light" || raw.mode === "dark" ? { mode: raw.mode } : {}) };
	} catch {
		return { preset: DEFAULT_PRESET };
	}
}

/**
 * Save a choice with the same checks `tabkyra theme` makes. `accent` undefined keeps the saved
 * accent (as `theme set` does), null clears it, a string sets it. `mode` works the same way: undefined
 * keeps the saved mode, "system" clears it, "light" or "dark" pins the pages. Throws on a bad value.
 */
export function saveTheme(preset: string, accent?: string | null, mode?: string): SavedTheme {
	if (!isPreset(preset)) throw new Error(`Pick a preset: ${Object.keys(PRESETS).join(", ")}.`);
	if (typeof accent === "string" && !isAccent(accent)) throw new Error("Give the accent as #rrggbb, for example #3b82f6.");
	if (mode !== undefined && !isMode(mode)) throw new Error("Give the mode as light, dark or system.");
	const current = loadTheme();
	const keptAccent = accent === undefined ? current.accent : accent === null ? undefined : accent.toLowerCase();
	const keptMode = mode === undefined ? current.mode : mode === "system" ? undefined : mode;
	writeJsonPrivate(themeFile(), { preset, ...(keptAccent ? { accent: keptAccent } : {}), ...(keptMode ? { mode: keptMode } : {}) });
	return loadTheme();
}

export { contrast, DEFAULT_PRESET, isAccent, luminance, type Palette, type Preset, PRESETS, textOn, type ThemeChoice };

/** The two palettes a choice resolves to (the saved choice by default). */
export const resolveTheme = (choice: ThemeChoice = loadTheme()): Preset => resolvePalettes(choice);

const vars = (p: Palette) =>
	`--bg:${p.bg};--panel:${p.panel};--text:${p.text};--muted:${p.muted};--border:${p.border};--accent:${p.accent};--accent-text:${p.accentText};--danger:${p.danger}`;

/** CSS custom properties for both modes, following prefers-color-scheme, or for the one mode the choice pins. */
export function themeCss(choice: SavedTheme = loadTheme()): string {
	const t = resolveTheme(choice);
	if (choice.mode === "light" || choice.mode === "dark") return `:root{color-scheme:${choice.mode};${vars(t[choice.mode])}}`;
	return `:root{color-scheme:light dark;${vars(t.light)}}@media (prefers-color-scheme:dark){:root{${vars(t.dark)}}}`;
}

/** The page chrome every Tabkyra page shares, drawn from the theme variables. */
export function pageCss(choice: SavedTheme = loadTheme()): string {
	return `${themeCss(choice)}body{font:16px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text)}main{max-width:560px;margin:6vh auto;padding:28px;background:var(--panel);border-radius:14px;border-top:4px solid var(--accent);box-shadow:0 1px 3px #0002}h1{font-size:1.3rem;margin:0 0 .5rem}p.muted{color:var(--muted)}code{overflow-wrap:anywhere}.scope{display:flex;gap:.6rem;align-items:flex-start;margin:.45rem 0;font-size:.93rem}.scope input{margin-top:.3rem;accent-color:var(--accent)}fieldset{border:1px solid var(--border);border-radius:10px;padding:.6rem .9rem;margin:1rem 0}legend{font-weight:600;padding:0 .3rem}label[for]{display:block;font-weight:600;margin-top:1rem}.secret{-webkit-text-security:disc}input.secret{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text)}.row{display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.2rem}button{font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}.error{color:var(--danger);font-weight:600}`;
}

// ---------- tabkyra theme ----------

/** `tabkyra theme list|set <preset>|accent <#hex>|reset [--json]`. Returns the exit code. */
export function runTheme(args: string[], json: boolean): number {
	const [sub = "list", value] = args;
	const out = (extra: Record<string, unknown> = {}) => {
		const choice = loadTheme();
		if (json) console.log(JSON.stringify({ ...choice, presets: Object.keys(PRESETS), palettes: PRESETS, resolved: resolveTheme(choice), ...extra }, null, 2));
		return choice;
	};
	if (sub === "list") {
		const choice = out();
		if (!json) {
			for (const name of Object.keys(PRESETS)) console.log(`${name === choice.preset ? "*" : " "} ${name}`);
			console.log(choice.accent ? `accent ${choice.accent}` : "accent from the preset");
		}
		return 0;
	}
	if (sub === "set") {
		if (!value || !Object.hasOwn(PRESETS, value)) {
			console.error(`Pick a preset: ${Object.keys(PRESETS).join(", ")}.`);
			return 2;
		}
		const current = loadTheme();
		writeJsonPrivate(themeFile(), { preset: value, ...(current.accent ? { accent: current.accent } : {}), ...(current.mode ? { mode: current.mode } : {}) });
		const choice = out();
		if (!json) console.log(`Theme is ${choice.preset}${choice.accent ? ` with accent ${choice.accent}` : ""}.`);
		return 0;
	}
	if (sub === "accent") {
		if (!value || !isAccent(value)) {
			console.error("Give the accent as #rrggbb, for example #3b82f6.");
			return 2;
		}
		const current = loadTheme();
		writeJsonPrivate(themeFile(), { preset: current.preset, accent: value.toLowerCase(), ...(current.mode ? { mode: current.mode } : {}) });
		const choice = out();
		if (!json) console.log(`Accent is ${choice.accent}; button text is ${textOn(choice.accent ?? value)}.`);
		return 0;
	}
	if (sub === "reset") {
		rmSync(themeFile(), { force: true });
		out();
		if (!json) console.log(`Theme reset to ${DEFAULT_PRESET}.`);
		return 0;
	}
	console.error("Usage: tabkyra theme list | set <preset> | accent <#rrggbb> | reset [--json]");
	return 2;
}
