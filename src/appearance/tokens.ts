/**
 * The side panel's colors from a theme choice: mini-lit's tokens (--background, --primary, ...)
 * computed from the same presets the approval and hub pages use (palettes.ts), so all of them
 * match. Pure: test/appearance.test.mjs checks every pair the panel draws as text for WCAG AA.
 */

import { accentInk, mix, type Palette, resolveTheme, type ThemeChoice, textOn } from "./palettes.js";

/** CSS custom properties for one mode, keyed by name (with the leading dashes). */
export function appearanceVariables(choice: ThemeChoice, dark: boolean): Record<string, string> {
	const p: Palette = resolveTheme(choice)[dark ? "dark" : "light"];
	const secondary = mix(p.panel, p.text, 0.05);
	const hover = mix(p.panel, p.text, 0.1);
	return {
		"--background": p.bg,
		"--foreground": p.text,
		"--card": p.panel,
		"--card-foreground": p.text,
		"--popover": p.panel,
		"--popover-foreground": p.text,
		"--primary": p.accent,
		"--primary-foreground": p.accentText,
		"--secondary": secondary,
		"--secondary-foreground": p.text,
		"--muted": secondary,
		"--muted-foreground": p.muted,
		"--accent": hover,
		"--accent-foreground": p.text,
		"--destructive": p.danger,
		"--destructive-foreground": textOn(p.danger),
		"--border": p.border,
		"--input": p.border,
		"--ring": accentInk(p.accent, [p.bg], p.text),
		"--tk-brass": p.accent,
		"--tk-brass-text": accentInk(p.accent, [p.panel, p.bg, secondary], p.text),
	};
}

/** The pairs `appearanceVariables` promises are readable text on a background: [text, background]. */
export const TEXT_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["--foreground", "--background"],
	["--card-foreground", "--card"],
	["--popover-foreground", "--popover"],
	["--secondary-foreground", "--secondary"],
	["--muted-foreground", "--background"],
	["--muted-foreground", "--card"],
	["--muted-foreground", "--secondary"],
	["--foreground", "--accent"],
	["--primary-foreground", "--primary"],
	["--destructive-foreground", "--destructive"],
	["--tk-brass-text", "--card"],
	["--tk-brass-text", "--background"],
];

export const APPEARANCE_KEY = "tabkyra.appearance";

/** The saved choice from storage, or the default for anything that isn't one. */
export function parseChoice(raw: unknown): ThemeChoice {
	const value = (raw ?? {}) as { preset?: unknown; accent?: unknown };
	const preset = typeof value.preset === "string" && /^[a-z]{1,20}$/.test(value.preset) ? value.preset : "tabkyra";
	return {
		preset,
		...(typeof value.accent === "string" && /^#[0-9a-f]{6}$/i.test(value.accent)
			? { accent: value.accent.toLowerCase() }
			: {}),
	};
}
