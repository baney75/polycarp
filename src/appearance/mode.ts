/** Light, dark or follow the system: the same setting mini-lit's theme toggle keeps (localStorage "theme", the `dark` class). */

export type Mode = "light" | "dark" | "system";

export function currentMode(): Mode {
	const saved = localStorage.getItem("theme");
	return saved === "light" || saved === "dark" ? saved : "system";
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function setMode(mode: Mode): void {
	if (mode === "system") localStorage.removeItem("theme");
	else localStorage.setItem("theme", mode);
	document.documentElement.classList.toggle("dark", mode === "dark" || (mode === "system" && systemDark()));
}

/** Follow the system setting while the mode is "system". */
export function followSystem(): void {
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (currentMode() === "system") document.documentElement.classList.toggle("dark", systemDark());
	});
}
