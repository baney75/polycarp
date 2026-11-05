/**
 * How this program starts a copy of itself. From source or the npm bundle that is
 * `node <script> <args>`; inside Polycarp the helper is one compiled executable (`polycarp-browser`,
 * built by spaces/scripts/build-browser.sh with __POLYCARP_COMPILED__ set), so it is `<helper> <args>`
 * and there is no Node and no script path to point at.
 */

import { dirname, join } from "node:path";

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
