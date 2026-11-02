/**
 * Page themes: the consent page and the hub's pages share these colors. Five presets, each with
 * a light and a dark palette, and an optional custom accent (#rrggbb). `theme.json` in the config
 * dir holds the choice. Pages follow prefers-color-scheme; every pair a page draws as text on a
 * background reaches WCAG AA (4.5:1), which cli/test/theme.test.mjs checks for every preset.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonPrivate } from "./files.ts";
import { configDir } from "./oauth.ts";

export interface Palette {
	bg: string;
	panel: string;
	text: string;
	muted: string;
	border: string;
	accent: string;
	/** Text on a button drawn in the accent. */
	accentText: string;
	danger: string;
}

export interface Preset {
	light: Palette;
	dark: Palette;
}

export const PRESETS: Record<string, Preset> = {
	tabkyra: {
		light: { bg: "#f6f5f2", panel: "#ffffff", text: "#1b1b1b", muted: "#5c5850", border: "#d6d2c8", accent: "#e3a93b", accentText: "#1b1b1b", danger: "#a40000" },
		dark: { bg: "#151515", panel: "#222222", text: "#eeeeee", muted: "#b0aca2", border: "#444444", accent: "#e3a93b", accentText: "#151515", danger: "#ff8a8a" },
	},
	slate: {
		light: { bg: "#f1f5f9", panel: "#ffffff", text: "#0f172a", muted: "#475569", border: "#cbd5e1", accent: "#334155", accentText: "#ffffff", danger: "#b91c1c" },
		dark: { bg: "#0f172a", panel: "#1e293b", text: "#e2e8f0", muted: "#a3b0c2", border: "#475569", accent: "#cbd5e1", accentText: "#0f172a", danger: "#fca5a5" },
	},
	forest: {
		light: { bg: "#f1f6f1", panel: "#ffffff", text: "#14261a", muted: "#4a5f50", border: "#c5d6c8", accent: "#1f6a3a", accentText: "#ffffff", danger: "#a40000" },
		dark: { bg: "#0f1a13", panel: "#1a2a20", text: "#e4f0e6", muted: "#a5bba9", border: "#3b5443", accent: "#7fd39a", accentText: "#0f1a13", danger: "#ff9a9a" },
	},
	rose: {
		light: { bg: "#fbf3f4", panel: "#ffffff", text: "#2a1519", muted: "#6b4a50", border: "#e6cdd2", accent: "#b4234a", accentText: "#ffffff", danger: "#9b1c1c" },
		dark: { bg: "#1d1013", panel: "#2c1a1e", text: "#f6e4e8", muted: "#cdaab2", border: "#5a3a41", accent: "#f08ea9", accentText: "#1d1013", danger: "#ffa3a3" },
	},
	midnight: {
		light: { bg: "#eef0fb", panel: "#ffffff", text: "#14173a", muted: "#4a4f7a", border: "#c9cdee", accent: "#3b3fb5", accentText: "#ffffff", danger: "#a40000" },
		dark: { bg: "#0b0d24", panel: "#151839", text: "#e6e8ff", muted: "#a9aedd", border: "#3a3f7a", accent: "#9aa2ff", accentText: "#0b0d24", danger: "#ff9a9a" },
	},
};

export const DEFAULT_PRESET = "tabkyra";

export interface ThemeChoice {
	preset: string;
	accent?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

export const themeFile = () => join(configDir(), "theme.json");

/** The saved choice. A missing, unreadable or unknown file gives the default: a page never fails on its theme. */
export function loadTheme(): ThemeChoice {
	try {
		if (!existsSync(themeFile())) return { preset: DEFAULT_PRESET };
		const raw = JSON.parse(readFileSync(themeFile(), "utf8")) as Partial<ThemeChoice>;
		const preset = typeof raw.preset === "string" && Object.hasOwn(PRESETS, raw.preset) ? raw.preset : DEFAULT_PRESET;
		return { preset, ...(typeof raw.accent === "string" && HEX.test(raw.accent) ? { accent: raw.accent.toLowerCase() } : {}) };
	} catch {
		return { preset: DEFAULT_PRESET };
	}
}

function channel(value: number): number {
	const v = value / 255;
	return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string): number {
	const n = Number.parseInt(hex.slice(1), 16);
	return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two #rrggbb colors, 1 to 21. */
export function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `background`; one of them always reaches 4.5:1 (the worst case, a mid gray, gets 4.58). */
export function textOn(background: string): string {
	return contrast("#000000", background) >= contrast("#ffffff", background) ? "#000000" : "#ffffff";
}

/** The two palettes a choice resolves to, with a custom accent applied to both. */
export function resolveTheme(choice: ThemeChoice = loadTheme()): Preset {
	const base = PRESETS[choice.preset] ?? PRESETS[DEFAULT_PRESET];
	if (!choice.accent || !HEX.test(choice.accent)) return base;
	const accent = choice.accent.toLowerCase();
	return { light: { ...base.light, accent, accentText: textOn(accent) }, dark: { ...base.dark, accent, accentText: textOn(accent) } };
}

const vars = (p: Palette) =>
	`--bg:${p.bg};--panel:${p.panel};--text:${p.text};--muted:${p.muted};--border:${p.border};--accent:${p.accent};--accent-text:${p.accentText};--danger:${p.danger}`;

/** CSS custom properties for both modes, following prefers-color-scheme. */
export function themeCss(choice: ThemeChoice = loadTheme()): string {
	const t = resolveTheme(choice);
	return `:root{color-scheme:light dark;${vars(t.light)}}@media (prefers-color-scheme:dark){:root{${vars(t.dark)}}}`;
}

/** The page chrome every Tabkyra page shares, drawn from the theme variables. */
export function pageCss(choice: ThemeChoice = loadTheme()): string {
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
		writeJsonPrivate(themeFile(), { preset: value, ...(current.accent ? { accent: current.accent } : {}) });
		const choice = out();
		if (!json) console.log(`Theme is ${choice.preset}${choice.accent ? ` with accent ${choice.accent}` : ""}.`);
		return 0;
	}
	if (sub === "accent") {
		if (!value || !HEX.test(value)) {
			console.error("Give the accent as #rrggbb, for example #3b82f6.");
			return 2;
		}
		writeJsonPrivate(themeFile(), { preset: loadTheme().preset, accent: value.toLowerCase() });
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
