// What a build was made from: written as build-info.json next to each build and compiled into
// the bundle as __TABKYRA_BUILD__. The update system compares the running extension, the native
// host and the files on disk with it (docs/updates.md, "Version mismatch").
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** id is new for every build; commit and version say what it was built from. */
export function buildInfo(repo) {
	let commit = "";
	try {
		commit = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// Not a git checkout (an unpacked source archive): the version still identifies it.
	}
	const version = JSON.parse(readFileSync(join(repo, "static", "manifest.chrome.json"), "utf8")).version;
	return { id: randomUUID(), commit, version, builtAt: new Date().toISOString() };
}
