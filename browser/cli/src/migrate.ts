/**
 * The one-time move from the folders and names Polycarp's helper had as "tabkyra" to the polycarp ones. Idempotent and
 * safe to call at every start: each step looks at what is on disk and does nothing once it is done.
 *
 *   ~/.config/tabkyra       -> ~/.config/polycarp/browser       (a symlink is left at the old path)
 *   its `tabkyra` and `host` launchers -> `polycarp` and `polycarp-host` (a symlink is left under each old name)
 *   ~/.local/share/tabkyra  -> ~/.local/share/polycarp/browser  (a symlink is left at the old path)
 *   ~/.cache/tabkyra        -> ~/.cache/polycarp                (no symlink; it is a cache)
 *
 * ~/.config/polycarp itself belongs to the Polycarp app (config.toml, theme); the helper lives in its `browser` subfolder,
 * so the target never exists before the move. Services and their logs move in service.ts (`migrateLegacyServices`),
 * because they need the service manager. Only these known paths are touched, and nothing inside them is opened: moving
 * a folder moves its secrets as they are. When the new folder already exists, nothing is moved or merged;
 * `legacyLeftovers` reports it.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { envVar } from "./env.ts";
import { CLI_LAUNCHER_NAME, cacheDir, configDir, configDirOverride, dataDir, HOST_LAUNCHER_NAME, LEGACY_CLI_LAUNCHER_NAME, LEGACY_HOST_LAUNCHER_NAME, legacyCacheDir, legacyConfigDir, legacyDataDir } from "./files.ts";

export interface Migration {
	/** What was moved, as "from -> to". */
	moved: string[];
	/** Old paths left alone because the new one exists too. */
	conflicts: string[];
}

const kind = (path: string): "dir" | "file" | "link" | undefined => {
	try {
		const st = lstatSync(path);
		return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
	} catch {
		return undefined;
	}
};

/**
 * Move `from` to `to` and, when `link` is set, leave a link at `from` so an old binary, a browser registration or an agent
 * entry that still names the old path keeps working. A directory gets a junction on Windows, which needs no special rights.
 * If the link cannot be made the move is undone: a move nothing can follow would strand them, and the old place keeps
 * working. `doctor` then lists the old folder (legacyLeftovers). False if nothing moved.
 */
function move(from: string, to: string, link: boolean): boolean {
	try {
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
	} catch {
		return false; // another process got there first, or the folder is in use (Windows)
	}
	if (!link) return true;
	try {
		if (envVar("TEST_NO_LINK")) throw new Error("links are refused (test)");
		const isDir = kind(to) === "dir";
		if (isDir && process.platform === "win32") symlinkSync(to, from, "junction");
		// A relative target for a file in the same folder keeps the pair valid if the folder moves again.
		else symlinkSync(dirname(from) === dirname(to) ? basename(to) : to, from);
		return true;
	} catch {
		try {
			renameSync(to, from);
		} catch {
			/* it stays at the new place, and the browser registration is repaired by install */
		}
		return false;
	}
}

function moveFolder(from: string, to: string, link: boolean, result: Migration): void {
	if (kind(from) !== "dir") return;
	if (kind(to) !== undefined) result.conflicts.push(from);
	else if (move(from, to, link)) result.moved.push(`${from} -> ${to}`);
}

export function migrateLegacyPaths(): Migration {
	const result: Migration = { moved: [], conflicts: [] };
	try {
		// A chosen folder (POLYCARP_BROWSER_CONFIG_DIR or TABKYRA_CONFIG_DIR) is the person's; only the default location moves.
		if (!configDirOverride()) moveFolder(legacyConfigDir(), configDir(), true, result);
		const dir = configDir();
		for (const [oldName, newName] of [
			[LEGACY_CLI_LAUNCHER_NAME, CLI_LAUNCHER_NAME],
			[LEGACY_HOST_LAUNCHER_NAME, HOST_LAUNCHER_NAME],
		]) {
			const from = join(dir, oldName);
			const to = join(dir, newName);
			if (kind(from) === "file" && kind(to) === undefined && move(from, to, true)) result.moved.push(`${from} -> ${to}`);
		}
		if (!envVar("HOME")) moveFolder(legacyDataDir(), dataDir(), true, result);
		if (!envVar("CACHE_DIR")) moveFolder(legacyCacheDir(), cacheDir(), false, result);
	} catch {
		/* a migration never stops the command it runs before */
	}
	return result;
}

/** Old folders still in place as real folders: the new one exists too (nothing is merged), or a link could not be made. For `doctor`. */
export function legacyLeftovers(): string[] {
	const pairs: Array<[boolean, string]> = [
		[!configDirOverride(), legacyConfigDir()],
		[!envVar("HOME"), legacyDataDir()],
		[!envVar("CACHE_DIR"), legacyCacheDir()],
	];
	return pairs.filter(([default_, from]) => default_ && kind(from) === "dir").map(([, from]) => from);
}
