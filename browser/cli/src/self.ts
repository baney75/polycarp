import { realpathSync } from "node:fs";
/**
 * How this program starts a copy of itself. From source or the npm bundle that is
 * `node <script> <args>`; inside Polycarp the helper is one compiled executable (`polycarp-browser`,
 * built by spaces/scripts/build-browser.sh with __POLYCARP_COMPILED__ set), so it is `<helper> <args>`
 * and there is no Node and no script path to point at.
 */

import { delimiter, dirname, join } from "node:path";

declare const __POLYCARP_COMPILED__: boolean | undefined;

/** True in the single-executable build. */
export const COMPILED: boolean = typeof __POLYCARP_COMPILED__ !== "undefined" && __POLYCARP_COMPILED__ === true;

/** The file a launcher or manifest must run: the helper itself when compiled, else Node. */
export function selfExec(): string {
	return process.execPath;
}

/** The arguments that make `selfExec()` run this program, before the command's own. */
export function selfPrefix(script: string | undefined = process.argv[1]): string[] {
	return COMPILED || !script ? [] : [script];
}

/** Where the bundled extension folder sits: next to the helper (Polycarp.app/Contents/Resources/browser/extension). */
export function bundledExtensionDir(): string | undefined {
	return COMPILED ? join(dirname(process.execPath), "extension") : undefined;
}

/** The command a person types for this program: `polycarp browser` inside the app, `polycarp-browser` for an npm link or a checkout. */
export const COMMAND_NAME: string = COMPILED ? "polycarp browser" : !linkedAs("polycarp-browser") && linkedAs("tabkyra") ? "tabkyra" : "polycarp-browser";

/** Whether `name` on PATH is this program. An npm link made before the rename answers only to `tabkyra`. */
function linkedAs(name: string): boolean {
	const script = process.argv[1];
	if (!script) return false;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		try {
			if (realpathSync(join(dir, name)) === realpathSync(script)) return true;
		} catch {
			/* not in this folder */
		}
	}
	return false;
}
