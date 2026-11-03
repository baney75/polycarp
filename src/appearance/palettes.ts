/**
 * The theme presets, shared by the CLI's pages (consent page, hub pages) and the side panel's
 * Appearance tab. Pure data and color math: no file or browser API, so both import it.
 * Every pair a page draws as text on a background reaches WCAG AA (4.5:1); the tests check it.
 */

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
		light: {
			bg: "#f6f5f2",
			panel: "#ffffff",
			text: "#1b1b1b",
			muted: "#5c5850",
			border: "#d6d2c8",
			accent: "#e3a93b",
			accentText: "#1b1b1b",
			danger: "#a40000",
		},
		dark: {
			bg: "#151515",
			panel: "#222222",
			text: "#eeeeee",
			muted: "#b0aca2",
			border: "#444444",
			accent: "#e3a93b",
			accentText: "#151515",
			danger: "#ff8a8a",
		},
	},
	slate: {
		light: {
			bg: "#f1f5f9",
			panel: "#ffffff",
			text: "#0f172a",
			muted: "#475569",
			border: "#cbd5e1",
			accent: "#334155",
			accentText: "#ffffff",
			danger: "#b91c1c",
		},
		dark: {
			bg: "#0f172a",
			panel: "#1e293b",
			text: "#e2e8f0",
			muted: "#a3b0c2",
			border: "#475569",
			accent: "#cbd5e1",
			accentText: "#0f172a",
			danger: "#fca5a5",
		},
	},
	forest: {
		light: {
			bg: "#f1f6f1",
			panel: "#ffffff",
			text: "#14261a",
			muted: "#4a5f50",
			border: "#c5d6c8",
			accent: "#1f6a3a",
			accentText: "#ffffff",
			danger: "#a40000",
		},
		dark: {
			bg: "#0f1a13",
			panel: "#1a2a20",
			text: "#e4f0e6",
			muted: "#a5bba9",
			border: "#3b5443",
			accent: "#7fd39a",
			accentText: "#0f1a13",
			danger: "#ff9a9a",
		},
	},
	rose: {
		light: {
			bg: "#fbf3f4",
			panel: "#ffffff",
			text: "#2a1519",
			muted: "#6b4a50",
			border: "#e6cdd2",
			accent: "#b4234a",
			accentText: "#ffffff",
			danger: "#9b1c1c",
		},
		dark: {
			bg: "#1d1013",
			panel: "#2c1a1e",
			text: "#f6e4e8",
			muted: "#cdaab2",
			border: "#5a3a41",
			accent: "#f08ea9",
			accentText: "#1d1013",
			danger: "#ffa3a3",
		},
	},
	midnight: {
		light: {
			bg: "#eef0fb",
			panel: "#ffffff",
			text: "#14173a",
			muted: "#4a4f7a",
			border: "#c9cdee",
			accent: "#3b3fb5",
			accentText: "#ffffff",
			danger: "#a40000",
		},
		dark: {
			bg: "#0b0d24",
			panel: "#151839",
			text: "#e6e8ff",
			muted: "#a9aedd",
			border: "#3a3f7a",
			accent: "#9aa2ff",
			accentText: "#0b0d24",
			danger: "#ff9a9a",
		},
	},
};

export const DEFAULT_PRESET = "tabkyra";

export interface ThemeChoice {
	preset: string;
	accent?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Whether a value is a #rrggbb accent. */
export const isAccent = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

export const isPreset = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(PRESETS, value);

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
export function resolveTheme(choice: ThemeChoice): Preset {
	const base = isPreset(choice.preset) ? PRESETS[choice.preset] : PRESETS[DEFAULT_PRESET];
	if (!isAccent(choice.accent)) return base;
	const accent = choice.accent.toLowerCase();
	return {
		light: { ...base.light, accent, accentText: textOn(accent) },
		dark: { ...base.dark, accent, accentText: textOn(accent) },
	};
}

/** Blend `a` toward `b` by `t` (0 to 1), in sRGB, as #rrggbb. */
export function mix(a: string, b: string, t: number): string {
	const pa = Number.parseInt(a.slice(1), 16);
	const pb = Number.parseInt(b.slice(1), 16);
	const part = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
	return `#${((part(16) << 16) | (part(8) << 8) | part(0)).toString(16).padStart(6, "0")}`;
}

/**
 * The accent as text on every one of `surfaces`: the accent itself when it reads at 4.5:1, otherwise blended
 * toward the body text color until it does, or until `target` (3 for a shape such as a switch's on track) (brass #e3a93b is 2.1:1 on white, so it becomes a darker brass).
 */
export function accentInk(accent: string, surfaces: string[], text: string, target = 4.5): string {
	for (let t = 0; t <= 1.0001; t += 0.05) {
		const candidate = mix(accent, text, Math.min(t, 1));
		if (surfaces.every((surface) => contrast(candidate, surface) >= target)) return candidate;
	}
	return text;
}

/**
 * The edge of a control (a text box, a switch track): the body text color blended into the page color
 * until it reaches 3:1 against every one of `surfaces` (WCAG 1.4.11). The preset's own `border` is a
 * soft divider, about 1.4:1, and stays that for dividers.
 */
export function controlEdge(surfaces: string[], text: string): string {
	for (let t = 0; t <= 1.0001; t += 0.01) {
		const candidate = mix(surfaces[0], text, Math.min(t, 1));
		if (surfaces.every((surface) => contrast(candidate, surface) >= 3)) return candidate;
	}
	return text;
}
