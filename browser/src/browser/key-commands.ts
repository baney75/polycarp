/**
 * Editing chords for CDP key events. Chromium runs "select all", "undo" and the word
 * and line moves from the operating system's menu or key bindings, not from the key event, so a
 * synthetic Meta+a (macOS) reaches the page's keydown handlers and then does nothing. The
 * `commands` field of Input.dispatchKeyEvent names the editing commands to run with the key.
 *
 * The clipboard chords are not mapped here, and `pressKey` refuses them (see isClipboardChord):
 * on Windows and Linux Blink runs them from a plain key event, so leaving out `commands` is not
 * enough. They read and write the user's real system clipboard, and an agent tab in the
 * background has no business doing either.
 */

const MODIFIERS = new Set(["Alt", "Control", "Meta", "Shift"]);

/** Editing commands that Blink runs for a plain letter chord, keyed by the lower-case letter. */
const LETTER_COMMANDS: Record<string, string> = {
	a: "selectAll",
	z: "undo",
};

const MOVES: Record<string, string> = {
	ArrowLeft: "Left",
	ArrowRight: "Right",
};

/**
 * The editing commands a chord stands for, or [] when it is a plain key event. `mods` are the
 * canonical modifier names (Alt, Control, Meta, Shift) held with `main`.
 *
 * The shortcut key is Meta on macOS and Control elsewhere. Agents write Control+a on a Mac as
 * often as Meta+a and mean select-all by it, so for the select-all, undo and redo chords the
 * other key counts too (macOS has no Control+a "select all"; its Control+a is an Emacs move to
 * the start of the line, which no agent asks for). Moves and deletions follow each platform.
 */
export function editingCommands(mods: string[], main: string, mac: boolean): string[] {
	if (mods.some((m) => !MODIFIERS.has(m))) return [];
	const has = (m: string) => mods.includes(m);
	const shift = has("Shift");
	const alt = has("Alt");
	const meta = has("Meta");
	const ctrl = has("Control");
	// The select-extending variant of a move.
	const extend = (name: string) => (shift ? `${name}AndModifySelection` : name);

	if (main.length === 1) {
		if (alt || meta === ctrl) return [];
		const key = main.toLowerCase();
		if (key === "y" && !shift) return ctrl ? ["redo"] : [];
		if (key === "z" && shift) return ["redo"];
		if (shift) return [];
		const command = LETTER_COMMANDS[key];
		return command ? [command] : [];
	}

	if (mac) {
		if (ctrl) return [];
		if (meta && !alt) {
			if (main === "ArrowLeft") return [extend("moveToBeginningOfLine")];
			if (main === "ArrowRight") return [extend("moveToEndOfLine")];
			if (main === "ArrowUp") return [extend("moveToBeginningOfDocument")];
			if (main === "ArrowDown") return [extend("moveToEndOfDocument")];
			if (main === "Backspace" && !shift) return ["deleteToBeginningOfLine"];
			return [];
		}
		if (alt && !meta) {
			const dir = MOVES[main];
			if (dir) return [extend(`moveWord${dir}`)];
			if (main === "Backspace" && !shift) return ["deleteWordBackward"];
			if (main === "Delete" && !shift) return ["deleteWordForward"];
		}
		return [];
	}

	// Windows and Linux: Chromium already handles Home, End and Shift+arrows from the key event;
	// the Control chords are the ones it takes from the platform's bindings.
	if (!ctrl || alt || meta) return [];
	const dir = MOVES[main];
	if (dir) return [extend(`moveWord${dir}`)];
	if (main === "Home") return [extend("moveToBeginningOfDocument")];
	if (main === "End") return [extend("moveToEndOfDocument")];
	if (main === "Backspace" && !shift) return ["deleteWordBackward"];
	if (main === "Delete" && !shift) return ["deleteWordForward"];
	return [];
}

/** A key chord that would read or replace the user's system clipboard. */
export class ClipboardChordError extends Error {
	constructor(chord: string) {
		super(`${chord} is a clipboard chord; clipboard chords are not supported; use fill or type`);
	}
}

/**
 * Whether a chord is a clipboard operation on any platform: Control or Meta with c, x or v
 * (Shift too for v), Shift+Insert, Control+Insert, Shift+Delete. Blink runs these from a plain
 * key event on Windows and Linux, so the only safe answer is to send no key event at all.
 * `mods` are the canonical modifier names (Alt, Control, Meta, Shift).
 */
export function isClipboardChord(mods: string[], main: string): boolean {
	const has = (m: string) => mods.includes(m);
	const command = has("Control") || has("Meta");
	if (main.length === 1) {
		const key = main.toLowerCase();
		if (!command || has("Alt")) return false;
		if (key === "v") return true;
		return (key === "c" || key === "x") && !has("Shift");
	}
	const only = (...wanted: string[]) => mods.length === wanted.length && wanted.every(has);
	if (main === "Insert") return only("Shift") || only("Control");
	if (main === "Delete") return only("Shift");
	return false;
}

/** Whether the browser runs on macOS, from the service worker's or side panel's navigator. */
export function isMacBrowser(): boolean {
	const nav = (globalThis as { navigator?: { userAgentData?: { platform?: string }; platform?: string } }).navigator;
	const platform = nav?.userAgentData?.platform ?? nav?.platform ?? "";
	return /mac/i.test(platform);
}
