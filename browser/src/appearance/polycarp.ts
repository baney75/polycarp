/**
 * The Polycarp theme (themes/README.md in the repo root): `polycarp theme` writes
 * `<config>/current/theme.json`, and Tabkyra reads its `surfaces.browser` section and the top-level
 * mode. Pure: the CLI reads the file and the side panel gets the same JSON from the helper, and both
 * run it through `parsePolycarpTheme`. Anything that is not exactly right gives undefined, so a bad
 * file means no Polycarp theme and never a crash.
 */

import { contrast, DEFAULT_PRESET, type Palette, type Preset } from "./palettes.js";
import { appearanceVariables, SHAPE_PAIRS, TEXT_PAIRS } from "./tokens.js";

export type PolycarpMode = "auto" | "light" | "dark";

export interface PolycarpShape {
	radiusSmall: number;
	radius: number;
	radiusLarge: number;
}

export interface PolycarpType {
	ui: string;
	display: string;
	mono: string;
	size: number;
}

export interface PolycarpMotion {
	fast: number;
	normal: number;
	slow: number;
	easing: string;
	reduced: boolean;
}

/** What Tabkyra uses of a Polycarp theme. */
export interface PolycarpTheme {
	name: string;
	title: string;
	mode: PolycarpMode;
	palettes: Preset;
	shape: PolycarpShape;
	type: PolycarpType;
	motion: PolycarpMotion;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_FONT = 400;
const MAX_TITLE = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A finite number from `lo` to `hi`, a whole number when `whole`. */
function num(value: unknown, lo: number, hi: number, whole: boolean): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < lo || value > hi) return undefined;
	return whole && !Number.isInteger(value) ? undefined : value;
}

function color(value: unknown): string | undefined {
	return typeof value === "string" && HEX.test(value) ? value.toLowerCase() : undefined;
}

/**
 * A font stack the Polycarp validator accepts: names separated by commas, each plain (letters,
 * digits, spaces, hyphens, underscores) or in matching quotes with no quote, backslash, `<`, control
 * character or comment opener inside. Nothing else can reach a style rule: no url(), braces, `;` or parentheses.
 */
export function isFontStack(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_FONT) return false;
	let rest = value;
	for (;;) {
		rest = rest.trimStart();
		let after: string;
		const quote = rest[0];
		if (quote === '"' || quote === "'") {
			const end = rest.indexOf(quote, 1);
			if (end < 0) return false;
			const inner = rest.slice(1, end);
			if (inner.trim() === "" || inner.includes("/*") || /[\\"'<\u0000-\u001f\u007f-\u009f]/.test(inner))
				return false;
			after = rest.slice(end + 1);
		} else {
			const comma = rest.indexOf(",");
			const name = (comma < 0 ? rest : rest.slice(0, comma)).trimEnd();
			if (name === "" || !/^[\p{Alphabetic}\p{N} _-]+$/u.test(name)) return false;
			after = comma < 0 ? "" : rest.slice(comma);
		}
		after = after.trimStart();
		if (after === "") return true;
		if (!after.startsWith(",")) return false;
		rest = after.slice(1);
	}
}

/** ease keywords, or cubic-bezier(a, b, c, d) with the first and third numbers between 0 and 1. */
export function isEasing(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (["ease", "ease-in", "ease-out", "ease-in-out", "linear"].includes(value)) return true;
	const m = /^cubic-bezier\(([^(),]+),([^(),]+),([^(),]+),([^(),]+)\)$/.exec(value);
	if (!m) return false;
	const n = m.slice(1).map((part) => (/^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(part) ? Number(part) : Number.NaN));
	return n.every(Number.isFinite) && n[0] >= 0 && n[0] <= 1 && n[2] >= 0 && n[2] <= 1;
}

/** Map the theme's roles to Tabkyra's palette: background, surface, foreground, muted, border, accent, on_accent, urgent. */
function palette(raw: unknown): Palette | undefined {
	if (!isRecord(raw)) return undefined;
	const bg = color(raw.background);
	const panel = color(raw.surface);
	const text = color(raw.foreground);
	const muted = color(raw.muted);
	const border = color(raw.border);
	const accent = color(raw.accent);
	const accentText = color(raw.on_accent);
	const danger = color(raw.urgent);
	if (!bg || !panel || !text || !muted || !border || !accent || !accentText || !danger) return undefined;
	return { bg, panel, text, muted, border, accent, accentText, danger };
}

/** The result of reading theme.json: the theme, or the one-line reason it was refused. */
export type PolycarpResult = { theme: PolycarpTheme } | { reason: string };

const REFUSED_SHAPE = "it is not a valid theme.json for Tabkyra (schema, name, mode, colors, shape, type or motion)";
const TEXT_MIN = 4.5;
const SHAPE_MIN = 3;

/**
 * The pairs the Polycarp CLI checks (contrast_on in cli/src/theme.rs), as far as Tabkyra's roles go:
 * text and the accent as text on the page and the surface, and on_accent on the accent. [text, background, minimum].
 */
const ROLE_PAIRS: ReadonlyArray<readonly [keyof Palette, keyof Palette, string, string]> = [
	["text", "bg", "foreground", "background"],
	["text", "panel", "foreground", "surface"],
	["muted", "bg", "muted", "background"],
	["muted", "panel", "muted", "surface"],
	["danger", "bg", "urgent", "background"],
	["danger", "panel", "urgent", "surface"],
	["accent", "bg", "accent", "background"],
	["accent", "panel", "accent", "surface"],
	["accentText", "accent", "on_accent", "accent"],
];

/** The first pair in either mode that is too hard to read: the Polycarp CLI's pairs, then every pair the panel draws. */
function unreadable(theme: PolycarpTheme): string | undefined {
	for (const mode of ["light", "dark"] as const) {
		const p = theme.palettes[mode];
		for (const [fg, bg, fgName, bgName] of ROLE_PAIRS) {
			const ratio = contrast(p[fg], p[bg]);
			if (ratio < TEXT_MIN) return `${mode} ${fgName} on ${bgName} is ${ratio.toFixed(2)}:1, needs ${TEXT_MIN}:1`;
		}
		const vars = appearanceVariables({ preset: DEFAULT_PRESET }, mode === "dark", theme);
		for (const [fg, bg] of TEXT_PAIRS) {
			const ratio = contrast(vars[fg], vars[bg]);
			if (ratio < TEXT_MIN) return `${mode} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${TEXT_MIN}:1`;
		}
		for (const [fg, bg] of SHAPE_PAIRS) {
			const ratio = contrast(vars[fg], vars[bg]);
			if (ratio < SHAPE_MIN) return `${mode} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${SHAPE_MIN}:1`;
		}
	}
	return undefined;
}

/** The theme from the parsed contents of theme.json, or the reason it was refused. Never throws. */
export function checkPolycarpTheme(raw: unknown): PolycarpResult {
	const theme = parseStructure(raw);
	if (!theme) return { reason: REFUSED_SHAPE };
	const problem = unreadable(theme);
	return problem ? { reason: `${theme.name} would be unreadable: ${problem}` } : { theme };
}

/** The validated theme from the parsed contents of theme.json, or undefined when anything is missing, out of range or unreadable. */
export function parsePolycarpTheme(raw: unknown): PolycarpTheme | undefined {
	const result = checkPolycarpTheme(raw);
	return "theme" in result ? result.theme : undefined;
}

function parseStructure(raw: unknown): PolycarpTheme | undefined {
	try {
		if (!isRecord(raw) || raw.schema !== 1) return undefined;
		const { name, title, mode } = raw;
		if (typeof name !== "string" || !NAME.test(name)) return undefined;
		if (
			typeof title !== "string" ||
			title.trim() === "" ||
			title.length > MAX_TITLE ||
			/[\u0000-\u001f\u007f-\u009f]/.test(title)
		)
			return undefined;
		if (mode !== "auto" && mode !== "light" && mode !== "dark") return undefined;
		const surfaces = raw.surfaces;
		const s = isRecord(surfaces) ? surfaces.browser : undefined;
		if (!isRecord(s)) return undefined;
		const light = palette(s.light);
		const dark = palette(s.dark);
		if (!light || !dark) return undefined;
		const sh = s.shape;
		const ty = s.type;
		const mo = s.motion;
		if (!isRecord(sh) || !isRecord(ty) || !isRecord(mo)) return undefined;
		const radiusSmall = num(sh.radius_small, 0, 64, true);
		const radius = num(sh.radius, 0, 64, true);
		const radiusLarge = num(sh.radius_large, 0, 64, true);
		const size = num(ty.size, 10, 24, true);
		const fast = num(mo.fast, 0, 1000, true);
		const normal = num(mo.normal, 0, 1000, true);
		const slow = num(mo.slow, 0, 1000, true);
		if (radiusSmall === undefined || radius === undefined || radiusLarge === undefined) return undefined;
		if (size === undefined || fast === undefined || normal === undefined || slow === undefined) return undefined;
		if (!isFontStack(ty.ui) || !isFontStack(ty.display) || !isFontStack(ty.mono)) return undefined;
		if (!isEasing(mo.easing) || typeof mo.reduced !== "boolean") return undefined;
		return {
			name,
			title: title.trim(),
			mode,
			palettes: { light, dark },
			shape: { radiusSmall, radius, radiusLarge },
			type: { ui: ty.ui, display: ty.display, mono: ty.mono, size },
			motion: { fast, normal, slow, easing: mo.easing, reduced: mo.reduced },
		};
	} catch {
		return undefined;
	}
}

/**
 * The part of theme.json worth sending to the panel: Tabkyra's own section and the top-level fields
 * the parser reads. The panel runs it through `parsePolycarpTheme` again.
 */
export function polycarpPayload(raw: unknown): Record<string, unknown> | undefined {
	if (!parsePolycarpTheme(raw)) return undefined;
	const file = raw as Record<string, unknown>;
	return {
		schema: 1,
		name: file.name,
		title: file.title,
		mode: file.mode,
		surfaces: { browser: (file.surfaces as Record<string, unknown>).browser },
	};
}
