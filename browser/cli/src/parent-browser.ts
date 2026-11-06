/**
 * Which browser started this native host: its parent process is the browser. The name is the one `browserDirs()` uses
 * (Helium, Chrome, Brave...), so doctor and Polycarp's Settings can say which browser holds a connection. Nothing here
 * reads the browser's files; it asks the system for the parent's executable path. TABKYRA_PARENT_BROWSER names one in tests.
 */

import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { browserNameForApp } from "./install.ts";

/**
 * A browser by its executable's name. On Linux `/proc/<pid>/exe` resolves wrapper scripts to the real binary, so these are the
 * names of the binaries inside the packages (`chrome`, `msedge`, `vivaldi-bin`, `brave`) as well as the wrapper names.
 */
const LINUX: Record<string, string> = {
	helium: "Helium",
	chrome: "Chrome",
	"google-chrome": "Chrome",
	"google-chrome-stable": "Chrome",
	"google-chrome-beta": "Chrome Beta",
	chromium: "Chromium",
	"chromium-browser": "Chromium",
	brave: "Brave",
	"brave-browser": "Brave",
	"brave-browser-stable": "Brave",
	msedge: "Edge",
	"microsoft-edge": "Edge",
	"microsoft-edge-stable": "Edge",
	vivaldi: "Vivaldi",
	"vivaldi-bin": "Vivaldi",
	"vivaldi-stable": "Vivaldi",
	opera: "Opera",
	"opera-stable": "Opera",
};

/** Chrome's binary is plainly `chrome` in every channel; the package folder says which one (`/opt/google/chrome-beta/chrome`). */
const CHROME_FOLDERS: Record<string, string> = {
	chrome: "Chrome",
	"chrome-beta": "Chrome Beta",
};

/** The browser for an executable path, or undefined if it isn't one we know. */
export function browserFromExecutable(path: string): string | undefined {
	const app = path.match(/\/([^/]+)\.app(?:\/|$)/);
	if (app) return browserNameForApp(app[1]);
	if (basename(path).toLowerCase() === "chrome") return CHROME_FOLDERS[basename(dirname(path)).toLowerCase()] ?? "Chrome";
	return LINUX[basename(path).toLowerCase()];
}

export function parentBrowserName(ppid: number = process.ppid): string | undefined {
	if (process.env.TABKYRA_PARENT_BROWSER) return process.env.TABKYRA_PARENT_BROWSER;
	try {
		if (process.platform === "darwin") {
			const path = execFileSync("/bin/ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8", timeout: 2000 }).trim();
			return browserFromExecutable(path);
		}
		if (process.platform === "linux") return browserFromExecutable(readlinkSync(`/proc/${ppid}/exe`));
	} catch {
		/* the parent is gone, or the system won't say */
	}
	return undefined;
}
