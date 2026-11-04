/**
 * The CLI's version is the extension's: static/manifest.chrome.json is the one place a release
 * sets it (release.sh). The bundle carries it in __TABKYRA_BUILD__ (cli/scripts/build.mjs);
 * unbundled source (tests under tsx) reads the manifest next to it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD } from "../../src/update/build.ts";
import { repoRoot } from "./paths.ts";

function manifestVersion(): string {
	try {
		const manifest = JSON.parse(readFileSync(join(repoRoot(), "static", "manifest.chrome.json"), "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" ? manifest.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

export const VERSION: string = BUILD?.version ?? manifestVersion();
