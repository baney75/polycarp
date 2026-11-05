/**
 * Page themes: the consent page and the hub's pages share these colors. Five presets, each with
 * a light and a dark palette, and an optional custom accent (#rrggbb). `theme.json` in the config
 * dir holds the choice. Pages follow prefers-color-scheme unless the choice fixes a mode (light or
 * dark, sent from the side panel's Appearance tab); every pair a page draws as text on a
 * background reaches WCAG AA (4.5:1), and the focus ring and control edges reach 3:1 (--ring, --edge),
 * which cli/test/theme.test.mjs checks for every preset.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	accentInk,
	contrast,
	controlEdge,
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
import { type PolycarpTheme, parsePolycarpTheme, polycarpPayload } from "../../src/appearance/polycarp.ts";
import { writeJsonPrivate } from "./files.ts";
import { configDir } from "./oauth.ts";

export const themeFile = () => join(configDir(), "theme.json");

// ---------- the Polycarp theme ----------

/**
 * Polycarp's config folder: POLYCARP_CONFIG_DIR if set and absolute, else $XDG_CONFIG_HOME/polycarp if
 * absolute, else ~/.config/polycarp; on Windows %APPDATA%\\Polycarp. A relative value is skipped.
 */
export function polycarpConfigDir(): string {
	const explicit = process.env.POLYCARP_CONFIG_DIR;
	if (explicit && isAbsolute(explicit)) return explicit;
	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		return appData && isAbsolute(appData) ? join(appData, "Polycarp") : join(homedir(), "AppData", "Roaming", "Polycarp");
	}
	const xdg = process.env.XDG_CONFIG_HOME;
	return xdg && isAbsolute(xdg) ? join(xdg, "polycarp") : join(homedir(), ".config", "polycarp");
}

/** The file `polycarp theme` writes. */
export const polycarpThemeFile = () => join(polycarpConfigDir(), "current", "theme.json");

/** A real theme.json is a few kilobytes; anything past this is not one. */
const MAX_POLYCARP_BYTES = 256 * 1024;

/** The parsed file, or undefined when it is missing, too big, not JSON or not a valid theme. Never throws. */
function readPolycarpFile(): unknown {
	try {
		const file = polycarpThemeFile();
		const stat = statSync(file);
		if (!stat.isFile() || stat.size > MAX_POLYCARP_BYTES) return undefined;
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** The Polycarp theme in force: validated, or undefined (no file, unreadable, invalid). It takes priority over the saved choice. */
export function loadPolycarpTheme(): PolycarpTheme | undefined {
	return parsePolycarpTheme(readPolycarpFile());
}

/** The same theme as the JSON the side panel receives (Tabkyra's section only), or undefined. */
export function loadPolycarpPayload(): Record<string, unknown> | undefined {
	return polycarpPayload(readPolycarpFile());
}

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
 * Save a choice with the same checks `tabkyra theme` makes. `preset` undefined keeps the saved preset (a mode-only change). `accent` undefined keeps the saved
 * accent (as `theme set` does), null clears it, a string sets it. `mode` works the same way: undefined
 * keeps the saved mode, "system" clears it, "light" or "dark" pins the pages. Throws on a bad value.
 */
export function saveTheme(presetArg: string | undefined, accent?: string | null, mode?: string): SavedTheme {
	const preset = presetArg ?? loadTheme().preset;
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
	`--bg:${p.bg};--panel:${p.panel};--text:${p.text};--muted:${p.muted};--border:${p.border};--accent:${p.accent};--accent-text:${p.accentText};--danger:${p.danger};--ring:${accentInk(p.accent, [p.bg, p.panel], p.text, 3)};--edge:${controlEdge([p.bg, p.panel], p.text)}`;

/**
 * CSS custom properties for both modes, following prefers-color-scheme, or for the one mode the choice pins.
 * With no argument a Polycarp theme in force wins over the saved choice. Pass a choice to draw that choice.
 */
export function themeCss(choice?: SavedTheme): string {
	const polycarp = choice ? undefined : loadPolycarpTheme();
	if (polycarp) {
		const { light, dark } = polycarp.palettes;
		if (polycarp.mode === "light" || polycarp.mode === "dark") return `:root{color-scheme:${polycarp.mode};${vars(polycarp.palettes[polycarp.mode])}}`;
		return `:root{color-scheme:light dark;${vars(light)}}@media (prefers-color-scheme:dark){:root{${vars(dark)}}}`;
	}
	const saved = choice ?? loadTheme();
	const t = resolveTheme(saved);
	if (saved.mode === "light" || saved.mode === "dark") return `:root{color-scheme:${saved.mode};${vars(t[saved.mode])}}`;
	return `:root{color-scheme:light dark;${vars(t.light)}}@media (prefers-color-scheme:dark){:root{${vars(t.dark)}}}`;
}

/** The page chrome a Polycarp theme changes beyond color: the font, its size, and the corner radii. */
function polycarpShapeCss(t: PolycarpTheme): string {
	const { radius, radiusSmall } = t.shape;
	return `body{font-family:${t.type.ui};font-size:${t.type.size}px}main{border-radius:${radius}px}fieldset{border-radius:${radiusSmall}px}input.secret,button{border-radius:${radiusSmall}px}code{font-family:${t.type.mono}}h1{font-family:${t.type.display}}`;
}

/** The page chrome every Tabkyra page shares, drawn from the theme variables. */
export function pageCss(choice?: SavedTheme): string {
	const polycarp = choice ? undefined : loadPolycarpTheme();
	return `${themeCss(choice)}${PAGE_CSS}${polycarp ? polycarpShapeCss(polycarp) : ""}`;
}

const PAGE_CSS = `body{font:16px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text)}main{max-width:560px;margin:6vh auto;padding:28px;background:var(--panel);border-radius:14px;border-top:4px solid var(--accent);box-shadow:0 1px 3px #0002}h1{font-size:1.3rem;margin:0 0 .5rem}p.muted{color:var(--muted)}code{overflow-wrap:anywhere}.scope{display:flex;gap:.6rem;align-items:flex-start;margin:.45rem 0;font-size:.93rem}.scope input{margin-top:.3rem;accent-color:var(--accent)}fieldset{border:1px solid var(--border);border-radius:10px;padding:.6rem .9rem;margin:1rem 0}legend{font-weight:600;padding:0 .3rem}label[for]{display:block;font-weight:600;margin-top:1rem}.secret{-webkit-text-security:disc}input.secret{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid var(--edge);border-radius:8px;background:var(--bg);color:var(--text)}.row{display:flex;gap:.6rem;justify-content:flex-end;margin-top:1.2rem}button{font:inherit;padding:.55rem 1.1rem;border-radius:8px;border:1px solid var(--edge);background:var(--panel);color:var(--text);cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid var(--ring);outline-offset:2px}.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}.error{color:var(--danger);font-weight:600}`;

// ---------- tabkyra theme ----------

/** Said after a change while a Polycarp theme is in force: the saved choice is kept, but the pages and the panel show the Polycarp theme. */
function polycarpNote(): string {
	const polycarp = loadPolycarpTheme();
	return polycarp ? ` Saved, but the Polycarp theme ${polycarp.name} is in force and takes priority, so pages and the panel do not change. Change it with: polycarp theme set <name>` : "";
}

/** `tabkyra theme list|set <preset>|accent <#hex>|reset [--json]`. Returns the exit code. */
export function runTheme(args: string[], json: boolean): number {
	const [sub = "list", value] = args;
	const out = (extra: Record<string, unknown> = {}) => {
		const choice = loadTheme();
		const polycarp = loadPolycarpTheme();
		if (json) console.log(JSON.stringify({ ...choice, ...(polycarp ? { polycarp: { name: polycarp.name, title: polycarp.title, mode: polycarp.mode } } : {}), presets: Object.keys(PRESETS), palettes: PRESETS, resolved: resolveTheme(choice), ...extra }, null, 2));
		return choice;
	};
	if (sub === "list") {
		const choice = out();
		if (!json) {
			const polycarp = loadPolycarpTheme();
			if (polycarp) console.log(`A Polycarp theme is in force: ${polycarp.name} (${polycarp.title}). It takes priority over the choice below. Change it with: polycarp theme set <name>`);
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
		if (!json) console.log(`Theme is ${choice.preset}${choice.accent ? ` with accent ${choice.accent}` : ""}.${polycarpNote()}`);
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
		if (!json) console.log(`Accent is ${choice.accent}; button text is ${textOn(choice.accent ?? value)}.${polycarpNote()}`);
		return 0;
	}
	if (sub === "reset") {
		rmSync(themeFile(), { force: true });
		out();
		if (!json) console.log(`Theme reset to ${DEFAULT_PRESET}.${polycarpNote()}`);
		return 0;
	}
	console.error("Usage: tabkyra theme list | set <preset> | accent <#rrggbb> | reset [--json]");
	return 2;
}
