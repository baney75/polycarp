/**
 * Puts the saved theme choice on the side panel: sets mini-lit's tokens as inline custom
 * properties on <html>, which win over the stylesheet's, and follows the Light / Dark / System
 * switch (the `dark` class) and the system setting. Applies at once; nothing reloads.
 */

import { connectStatus } from "../connect/client.js";
import { currentMode, pinMode, setMode } from "./mode.js";
import type { ThemeChoice } from "./palettes.js";
import { type PolycarpTheme, parsePolycarpTheme } from "./polycarp.js";
import { APPEARANCE_KEY, appearanceVariables, parseChoice } from "./tokens.js";

let current: ThemeChoice = { preset: "tabkyra" };
let polycarp: PolycarpTheme | undefined;
let applied: string[] = [];
const listeners = new Set<(choice: ThemeChoice) => void>();
const polycarpListeners = new Set<(theme: PolycarpTheme | undefined) => void>();
/** How often a visible panel asks the helper whether the Polycarp theme changed. */
export const POLYCARP_POLL_MS = 5000;

function paint(): void {
	const root = document.documentElement;
	for (const name of applied) root.style.removeProperty(name);
	const vars = appearanceVariables(current, root.classList.contains("dark"), polycarp);
	for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
	applied = Object.keys(vars);
	// "Reduced" motion also stops the panel's animations, not only its transitions.
	root.toggleAttribute("data-tk-reduced-motion", polycarp?.motion.reduced === true);
}

/** The Polycarp theme in force, or undefined. While there is one, the preset and accent below do not decide the colors. */
export function currentPolycarp(): PolycarpTheme | undefined {
	return polycarp;
}

export function onPolycarp(listener: (theme: PolycarpTheme | undefined) => void): () => void {
	polycarpListeners.add(listener);
	return () => polycarpListeners.delete(listener);
}

const same = (a: PolycarpTheme | undefined, b: PolycarpTheme | undefined) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Use this Polycarp theme (or none) now. Nothing happens when it is the one already applied. A theme
 * that fixes light or dark pins the panel to it without saving; "auto" leaves the person's own setting.
 */
export function applyPolycarp(raw: unknown): void {
	const next = parsePolycarpTheme(raw);
	if (same(next, polycarp)) return;
	polycarp = next;
	pinMode(next && next.mode !== "auto" ? next.mode : undefined);
	paint();
	for (const listener of polycarpListeners) listener(next);
}

export function currentAppearance(): ThemeChoice {
	return current;
}

/** Paint this choice now without saving it: the color box fires this while a person drags. */
export function previewAppearance(choice: ThemeChoice): void {
	current = choice;
	paint();
	for (const listener of listeners) listener(choice);
}

/** Use this choice now and keep it in extension storage. */
export async function setAppearance(choice: ThemeChoice): Promise<void> {
	previewAppearance(choice);
	await chrome.storage.local.set({ [APPEARANCE_KEY]: choice });
}

export function onAppearance(listener: (choice: ThemeChoice) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * A panel with no saved choice takes the one `tabkyra theme` saved on this computer, so the first
 * click on Light or Dark (or any later change) starts from what the pages already show. Quiet when the helper is absent; it tries again next load.
 */
async function seedFromHelper(): Promise<void> {
	const { theme } = await connectStatus();
	if ((await chrome.storage.local.get(APPEARANCE_KEY))[APPEARANCE_KEY] !== undefined) return;
	await setAppearance(parseChoice(theme));
	if (theme.mode && localStorage.getItem("theme") === null && currentMode() === "system") setMode(theme.mode);
}

let asking = false;

/**
 * Ask the helper for the Polycarp theme and apply it. No answer (no helper, an old helper, a timeout)
 * changes nothing: the last theme stays, or the panel keeps looking as it did. One question at a time.
 */
export async function refreshPolycarp(): Promise<void> {
	if (asking) return;
	asking = true;
	try {
		applyPolycarp((await connectStatus()).polycarp);
	} catch {
		// Not connected: keep today's behavior.
	} finally {
		asking = false;
	}
}

/** Ask once now, then every POLYCARP_POLL_MS while the panel is visible and nothing while it is hidden. */
function watchPolycarp(): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	const sync = () => {
		if (document.visibilityState === "visible") {
			void refreshPolycarp();
			timer ??= setInterval(() => void refreshPolycarp(), POLYCARP_POLL_MS);
		} else if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
	document.addEventListener("visibilitychange", sync);
	sync();
}

/** Read the saved choice, apply it, and keep it applied when the light/dark switch or the system setting changes. */
export async function startAppearance(): Promise<void> {
	let saved = false;
	try {
		const raw = (await chrome.storage.local.get(APPEARANCE_KEY))[APPEARANCE_KEY];
		saved = raw !== undefined;
		current = parseChoice(raw);
	} catch {
		current = { preset: "tabkyra" };
	}
	paint();
	if (!saved) void seedFromHelper().catch(() => {});
	new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	watchPolycarp();
}
