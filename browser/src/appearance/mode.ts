/** Light, dark or follow the system: the same setting mini-lit's theme toggle keeps (localStorage "theme", the `dark` class). */

export type Mode = "light" | "dark" | "system";

export function currentMode(): Mode {
	const saved = localStorage.getItem("theme");
	return saved === "light" || saved === "dark" ? saved : "system";
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

/** A mode a Polycarp theme pins (light or dark). Not saved: the person's own setting is kept for when the theme is gone. */
let pinned: "light" | "dark" | undefined;

export function pinMode(mode: "light" | "dark" | undefined): void {
	pinned = mode;
	showMode();
}

/** The mode on screen: the pinned one, else the person's setting. */
function showMode(): void {
	const mode = pinned ?? currentMode();
	document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && systemDark()));
}

export function setMode(mode: Mode): void {
	if (mode === "system") localStorage.removeItem("theme");
	else localStorage.setItem("theme", mode);
	showMode();
}

/** Follow the system setting while the mode is "system". */
export function followSystem(): void {
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (pinned || currentMode() === "system") showMode();
	});
}
