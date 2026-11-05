/**
 * The side panel's colors from a theme choice: mini-lit's tokens (--background, --primary, ...)
 * computed from the same presets the approval and hub pages use (palettes.ts), so all of them
 * match. Pure: test/appearance.test.mjs checks every pair the panel draws as text for WCAG AA.
 */

import { accentInk, controlEdge, mix, type Palette, resolveTheme, type ThemeChoice, textOn } from "./palettes.js";
import type { PolycarpTheme } from "./polycarp.js";

/** The accent the panel draws in this mode: the custom one, or the preset's own. What the color box and swatches show. */
export function effectiveAccent(choice: ThemeChoice, dark: boolean, polycarp?: PolycarpTheme): string {
	return (polycarp?.palettes ?? resolveTheme(choice))[dark ? "dark" : "light"].accent;
}

const ms = (n: number, reduced: boolean) => `${reduced ? 0 : n}ms`;

/**
 * What a Polycarp theme adds beyond color: radii (mini-lit's --radius, the panel's -sm and -lg),
 * the three font stacks (mini-lit's --font-sans, --font-serif and --font-mono) and base size, and
 * motion (three durations and the easing; "reduced" makes every duration 0).
 */
function polycarpShapeVariables(t: PolycarpTheme): Record<string, string> {
	return {
		"--radius": `${t.shape.radius}px`,
		"--tk-radius-sm": `${t.shape.radiusSmall}px`,
		"--tk-radius-lg": `${t.shape.radiusLarge}px`,
		"--font-sans": t.type.ui,
		"--font-serif": t.type.display,
		"--font-mono": t.type.mono,
		"--tk-font-size": `${t.type.size}px`,
		"--tk-motion-fast": ms(t.motion.fast, t.motion.reduced),
		"--tk-motion-normal": ms(t.motion.normal, t.motion.reduced),
		"--tk-motion-slow": ms(t.motion.slow, t.motion.reduced),
		"--tk-ease": t.motion.easing,
	};
}

/**
 * CSS custom properties for one mode, keyed by name (with the leading dashes). A Polycarp theme, when
 * given, replaces the choice's palette and adds shape, type and motion; without one the result is
 * exactly what it was before Polycarp (test/fixtures/appearance-main.snapshot.json).
 */
export function appearanceVariables(
	choice: ThemeChoice,
	dark: boolean,
	polycarp?: PolycarpTheme,
): Record<string, string> {
	const p: Palette = (polycarp?.palettes ?? resolveTheme(choice))[dark ? "dark" : "light"];
	const secondary = mix(p.panel, p.text, 0.05);
	const hover = mix(p.panel, p.text, 0.1);
	const controlOn = accentInk(p.accent, [p.bg, p.panel], p.text, 3);
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
		// Control edges (text boxes, the off switch's track) reach 3:1 against the page and the card; --border stays the soft divider.
		"--input": controlEdge([p.bg, p.panel], p.text),
		"--ring": accentInk(p.accent, [p.bg], p.text),
		// The selected Settings chip: body text color as the fill and the page color as its text, so it
		// stands out from the page at 3:1 or better in every preset and mode, whatever the accent.
		"--tk-selected": p.text,
		"--tk-on-selected": p.bg,
		"--tk-brass": p.accent,
		// Text and glyphs on --tk-brass (the Ask card's primary button and checked marks): the accent's own foreground, not a fixed ink.
		"--tk-on-brass": p.accentText,
		// The accent as a shape (the on switch's track, checkboxes): blended toward the text color until it reaches 3:1 on the page and the card.
		"--tk-brass-deep": controlOn,
		"--tk-control-on": controlOn,
		"accent-color": controlOn,
		"--tk-brass-text": accentInk(p.accent, [p.panel, p.bg, secondary], p.text),
		...(polycarp ? polycarpShapeVariables(polycarp) : {}),
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
	["--tk-on-brass", "--tk-brass"],
	["--destructive-foreground", "--destructive"],
	["--destructive", "--background"],
	["--destructive", "--card"],
	["--tk-on-selected", "--tk-selected"],
	["--tk-brass-text", "--card"],
	["--tk-brass-text", "--background"],
];

/** Pairs that are not text but must stand apart from the page: [shape, background], at 3:1 (WCAG 1.4.11): the selected chip, the focus ring, and control edges (--input, which is also the off switch's track). */
export const SHAPE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["--tk-selected", "--background"],
	["--tk-selected", "--card"],
	["--ring", "--background"],
	["--input", "--background"],
	["--input", "--card"],
	["--tk-control-on", "--background"],
	["--tk-control-on", "--card"],
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
