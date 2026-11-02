/**
 * Small private-file helpers for the config directory: JSON read/write at 0600 with an atomic
 * rename, and an exclusive lock file for read-modify-write across processes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** Run `fn` holding an exclusive lock file next to `path`; gives up after `timeoutMs`. A lock older than 30 seconds is stale. */
export function withFileLock<T>(path: string, fn: () => T, timeoutMs = 10_000): T {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lock = `${path}.lock`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			writeFileSync(lock, String(process.pid), { flag: "wx" });
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
		rmSync(lock, { force: true });
	}
}

/** The Tabkyra config directory. TABKYRA_CONFIG_DIR overrides it (tests use a temp one). */
export function configDir(): string {
	return process.env.TABKYRA_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "tabkyra");
}
