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

import { lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { envVar } from "./env.ts";
import { CLI_LAUNCHER_NAME, cacheDir, configDir, configDirOverride, configHome, dataHome, HOST_LAUNCHER_NAME, LEGACY_CLI_LAUNCHER_NAME, LEGACY_HOST_LAUNCHER_NAME, legacyCacheDir, legacyConfigDir, legacyDataDir, newConfigDir, newDataDir, withFileLock } from "./files.ts";

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
		pauseForTest();
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

/** Tests widen the gap between a check and the move that follows it, to force two processes into the same window. */
function pauseForTest(): void {
	const ms = Number(envVar("TEST_MIGRATE_PAUSE_MS"));
	if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function moveFolder(from: string, to: string, link: boolean, result: Migration): void {
	if (kind(from) !== "dir") return;
	if (kind(to) !== undefined) result.conflicts.push(from);
	else if (move(from, to, link)) result.moved.push(`${from} -> ${to}`);
}

/** Subfolders and files that lived in the home-folder `.config/tabkyra` even when XDG_CONFIG_HOME pointed elsewhere. */
const HOME_ONLY_CONFIG = ["subscriptions", "update.json", "last-update.json", "update-status.json", "update-progress.json"];
/** Likewise for ~/.local/share/tabkyra and XDG_DATA_HOME. */
const HOME_ONLY_DATA = ["app", "previous", "copilot-sdk"];

const homeConfigLegacy = () => join(homedir(), ".config", "tabkyra");
const homeDataLegacy = () => join(homedir(), ".local", "share", "tabkyra");

/** Move what is in a folder the old release kept in the home folder regardless of XDG, when absent in the new one. A link stays behind. */
function moveHomeOnly(oldDir: string, newDir: string, names: string[], result: Migration): void {
	if (kind(oldDir) !== "dir") return;
	for (const name of names) {
		const from = join(oldDir, name);
		const to = join(newDir, name);
		if (kind(from) && kind(from) !== "link" && kind(to) === undefined && move(from, to, true)) result.moved.push(`${from} -> ${to}`);
	}
}

/**
 * The whole migration runs under one lock file outside the folders it moves (in the config home), and every check is made
 * inside it. Two helper processes that start together (the browser's native host and an agent's MCP server) take turns, so
 * the second finds the work done instead of renaming the first one's compatibility link over the new file.
 */
export function migrateLegacyPaths(): Migration {
	const result: Migration = { moved: [], conflicts: [] };
	try {
		withFileLock(join(configHome(), ".polycarp-migration"), () => migrate(result), 20_000);
	} catch {
		/* a migration never stops the command it runs before */
	}
	return result;
}

function migrate(result: Migration): void {
	// A chosen folder (POLYCARP_BROWSER_CONFIG_DIR or TABKYRA_CONFIG_DIR) is the person's; only the default location moves.
	if (!configDirOverride()) {
		moveFolder(legacyConfigDir(), newConfigDir(), true, result);
		// If that did not work, the old folder is still the one in use (configDir), so nothing else is split off from it.
		const stuck = kind(legacyConfigDir()) === "dir" && kind(newConfigDir()) === undefined;
		if (!stuck && homeConfigLegacy() !== legacyConfigDir()) moveHomeOnly(homeConfigLegacy(), newConfigDir(), [...HOME_ONLY_CONFIG, LEGACY_CLI_LAUNCHER_NAME, LEGACY_HOST_LAUNCHER_NAME], result);
	}
	const dir = configDir();
	for (const [oldName, newName] of [
		[LEGACY_CLI_LAUNCHER_NAME, CLI_LAUNCHER_NAME],
		[LEGACY_HOST_LAUNCHER_NAME, HOST_LAUNCHER_NAME],
	]) {
		const from = join(dir, oldName);
		const to = join(dir, newName);
		if (kind(from) === "file" && kind(to) === undefined && move(from, to, true)) result.moved.push(`${from} -> ${to}`);
	}
	if (!envVar("HOME")) {
		moveFolder(legacyDataDir(), newDataDir(), true, result);
		const stuck = kind(legacyDataDir()) === "dir" && kind(newDataDir()) === undefined;
		if (!stuck && homeDataLegacy() !== legacyDataDir()) moveHomeOnly(homeDataLegacy(), newDataDir(), HOME_ONLY_DATA, result);
	}
	if (!envVar("CACHE_DIR")) moveFolder(legacyCacheDir(), cacheDir(), false, result);
}

/** True when a folder holds something that is not just a link left by the migration. */
const holdsRealFiles = (dir: string): boolean => {
	try {
		return readdirSync(dir).some((name) => kind(join(dir, name)) !== "link");
	} catch {
		return false;
	}
};

/**
 * Old folders still in place as real folders: the new one exists too (nothing is merged), or a link could not be made.
 * The home-folder copies of what XDG did not cover are listed only while they still hold something. For `doctor`.
 */
export function legacyLeftovers(): string[] {
	const pairs: Array<[boolean, string]> = [
		[!configDirOverride(), legacyConfigDir()],
		[!envVar("HOME"), legacyDataDir()],
		[!envVar("CACHE_DIR"), legacyCacheDir()],
	];
	const out = pairs.filter(([default_, from]) => default_ && kind(from) === "dir").map(([, from]) => from);
	const homeOnly: Array<[boolean, string, string]> = [
		[!configDirOverride(), homeConfigLegacy(), legacyConfigDir()],
		[!envVar("HOME"), homeDataLegacy(), legacyDataDir()],
	];
	for (const [default_, dir, covered] of homeOnly) if (default_ && dir !== covered && kind(dir) === "dir" && holdsRealFiles(dir)) out.push(dir);
	return out;
}
