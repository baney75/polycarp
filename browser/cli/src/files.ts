/**
 * Small private-file helpers for the config directory: JSON read/write at 0600 with an atomic
 * rename, and an exclusive lock file for read-modify-write across processes.
 */

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envVar } from "./env.ts";

/** The parsed JSON file, or `fallback` when it doesn't exist. A file that exists but isn't JSON throws. */
export function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Write JSON with mode 0600 through a temp file, so a reader never sees half a file. */
export function writeJsonPrivate(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** A lock file stayed held past the caller's patience. Request handlers map it to 503. */
export class LockTimeoutError extends Error {}

/**
 * Run `fn` holding an exclusive lock file next to `path`; gives up after `timeoutMs`. A lock older than 30 seconds is stale.
 * The lock records an owner token and is removed only while it still holds that token, so a holder whose lock
 * was taken as stale never deletes the next holder's lock.
 */
export function withFileLock<T>(path: string, fn: () => T, timeoutMs = 10_000): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch {
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > 30_000;
			} catch {
				/* gone */
			}
			if (stale) rmSync(lock, { force: true });
			else if (Date.now() > deadline) throw new LockTimeoutError(`${path} is locked (${lock}).`);
			else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
	try {
		return fn();
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
		} catch {
			/* already gone */
		}
	}
}

/**
 * Like `withFileLock`, for work that awaits while it holds the lock. The wait polls with a timer, so
 * the event loop keeps running meanwhile. Same lock file, same 30-second stale rule, so hold it only
 * for short work (a check and a write), never across a network call or a service manager. The lock
 * records an owner token (pid and a random nonce) and is removed only while it still holds that
 * token, so a holder whose lock was taken as stale never deletes the next holder's lock.
 */
export async function withFileLockAsync<T>(path: string, fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, token, { flag: "wx" });
			break;
		} catch {
			let stale = false;
			try {
				stale = Date.now() - statSync(lock).mtimeMs > 30_000;
			} catch {
				/* gone */
			}
			if (stale) rmSync(lock, { force: true });
			else if (Date.now() > deadline) throw new LockTimeoutError(`${path} is locked (${lock}).`);
			else await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		try {
			if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
		} catch {
			/* already gone */
		}
	}
}

const EXT = process.platform === "win32" ? ".cmd" : "";

/** What the native host launcher is called inside the config folder. */
export const HOST_LAUNCHER_NAME = `polycarp-host${EXT}`;
/** What the agent launcher is called inside the config folder. */
export const CLI_LAUNCHER_NAME = `polycarp${EXT}`;
/** Their names before the rename. The migration leaves a link under each, and an agent entry that names the old path is rewritten. */
export const LEGACY_HOST_LAUNCHER_NAME = `host${EXT}`;
export const LEGACY_CLI_LAUNCHER_NAME = `tabkyra${EXT}`;

/** The folder config lives under: $XDG_CONFIG_HOME, else ~/.config. */
export function configHome(): string {
	return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/** The folder a person chose for the helper's config (POLYCARP_BROWSER_CONFIG_DIR, or the older TABKYRA_CONFIG_DIR), if any. POLYCARP_CONFIG_DIR is the app's folder, not this one. */
export function configDirOverride(): string | undefined {
	return process.env.POLYCARP_BROWSER_CONFIG_DIR || process.env.TABKYRA_CONFIG_DIR || undefined;
}

/** The helper's config directory once migrated: <config>/polycarp/browser, inside the app's own polycarp folder. */
export function newConfigDir(): string {
	return join(configHome(), "polycarp", "browser");
}

/**
 * The helper's config directory. Tests use a temp one through the override. Until the move from the old folder has worked,
 * the old folder stays the one in use (it holds the credentials and settings), so a failed migration strands nothing.
 */
export function configDir(): string {
	const chosen = configDirOverride();
	if (chosen) return chosen;
	const fresh = newConfigDir();
	return !pathExists(fresh) && isRealDir(legacyConfigDir()) ? legacyConfigDir() : fresh;
}

const pathExists = (path: string): boolean => {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
};
const isRealDir = (path: string): boolean => {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** The folder before the rename. Only the one-time migration (migrate.ts) and the old-entry checks read it. */
export function legacyConfigDir(): string {
	return join(configHome(), "tabkyra");
}

/** The folder user data lives under: $XDG_DATA_HOME, else ~/.local/share. */
export function dataHome(): string {
	return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** The helper's data directory once migrated: POLYCARP_HOME (or TABKYRA_HOME), else <data>/polycarp/browser. */
export function newDataDir(): string {
	return envVar("HOME") || join(dataHome(), "polycarp", "browser");
}

/** The helper's data directory (the installed release, thread mirror, Copilot SDK); the old folder stays in use until the move has worked. */
export function dataDir(): string {
	const fresh = newDataDir();
	return !envVar("HOME") && !pathExists(fresh) && isRealDir(legacyDataDir()) ? legacyDataDir() : fresh;
}

/** The data folder before the rename. */
export function legacyDataDir(): string {
	return join(dataHome(), "tabkyra");
}

/** The Polycarp cache directory: POLYCARP_CACHE_DIR (or TABKYRA_CACHE_DIR), else $XDG_CACHE_HOME or ~/.cache, then polycarp. */
export function cacheDir(): string {
	return envVar("CACHE_DIR") || join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "polycarp");
}

/** The cache folder before the rename. */
export function legacyCacheDir(): string {
	return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "tabkyra");
}
