import { lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledExtensionDir } from "./self.ts";
import { envVar } from "./env.ts";

/**
 * Socket directory: per user, outside $TMPDIR so every process finds the same path.
 * POLYCARP_SOCKET_DIR (or TABKYRA_SOCKET_DIR) overrides it (tests run a private bridge this way).
 */
export function socketDir(): string {
	return socketDirs()[0];
}

/**
 * Where clients look for hosts: the socket directory, then the one a host started by a helper from before the rename made
 * (`tabkyra-bridge-<user>`), so that host is still found while the browser runs it. An override is the only place.
 * Drop the old one once no supported helper predates the rename.
 */
export function socketDirs(): string[] {
	const user = userInfo().username;
	if (process.platform === "win32") return [`\\\\.\\pipe\\polycarp-bridge-${user}`, `\\\\.\\pipe\\tabkyra-bridge-${user}`];
	const override = envVar("SOCKET_DIR");
	if (override) return [override];
	return [`/tmp/polycarp-bridge-${user}`, `/tmp/tabkyra-bridge-${user}`];
}

/**
 * Where a host also listens so a client from before the rename (it looks only in `tabkyra-bridge-<user>`) still finds it,
 * or undefined: on Windows, under an override, or when that folder isn't private to this user (another user may have made
 * it after a reboot cleared /tmp). Drop it with the fallback in socketDirs().
 */
export function legacySocketPath(pid: number): string | undefined {
	if (process.platform === "win32" || envVar("SOCKET_DIR")) return undefined;
	const dir = socketDirs()[1];
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch {
		/* already there: checked below */
	}
	try {
		const st = lstatSync(dir);
		if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o700) return undefined;
	} catch {
		return undefined;
	}
	const path = join(dir, `${pid}.sock`);
	rmSync(path, { force: true });
	return path;
}

export function socketPath(pid: number): string {
	if (process.platform === "win32") return `${socketDir()}-${pid}`;
	return join(socketDir(), `${pid}.sock`);
}

/**
 * Refuse a directory or socket that another user could have planted: it must be
 * ours, not a symlink, and closed to everyone else. Mirrors what Claude Code checks.
 */
export function assertSecurePath(path: string, expected: "dir" | "socket"): void {
	if (process.platform === "win32") return;
	const st = statSync(path, { throwIfNoEntry: true });
	if (st.isSymbolicLink()) throw new Error(`${path} is a symlink`);
	if (st.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
	const mode = st.mode & 0o777;
	if (expected === "dir") {
		if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
		if (mode !== 0o700) throw new Error(`${path} has mode ${mode.toString(8)}, expected 700`);
	} else {
		if (!st.isSocket()) throw new Error(`${path} is not a socket`);
		if (mode & 0o077) throw new Error(`${path} is accessible to other users (mode ${mode.toString(8)})`);
	}
}

/** The repository this CLI was built from (cli/dist/index.js -> repo root). */
export function repoRoot(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The unpacked extension folder users load in the browser. TABKYRA_EXTENSION_DIR overrides it (tests). */
export function extensionDir(): string {
	return envVar("EXTENSION_DIR") || bundledExtensionDir() || join(repoRoot(), "dist-chrome");
}

/** Files a loadable build must have; a half-written dist-chrome unloads the extension. */
export const EXTENSION_FILES = ["manifest.json", "background.js", "sidepanel.js", "sidepanel.html", "app.css"];
