/**
 * Owner-only credential files for the subscription sign-ins. OpenAI's SIWC docs say to keep
 * credentials in protected local storage, written atomically with mode 0600, and never in
 * browser storage, logs or source control; the same rules serve the Copilot token.
 *
 * Layout under ~/.config/tabkyra/subscriptions (TABKYRA_SUBSCRIPTIONS_DIR overrides it, for tests):
 *   chatgpt-host-id            this host's stable ext_agent_host_id
 *   chatgpt/<client_id>.json   one record per issued client id (one ChatGPT account and workspace)
 *   chatgpt/active.json        which record is in use
 *   copilot.json               the GitHub user token from the device flow
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function subscriptionsDir(): string {
	return process.env.TABKYRA_SUBSCRIPTIONS_DIR || join(homedir(), ".config", "tabkyra", "subscriptions");
}

/** Create a directory closed to other users, and refuse one another user could have planted. */
export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (process.platform === "win32") return;
	const st = lstatSync(dir);
	if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
	if (st.uid !== process.getuid?.()) throw new Error(`${dir} is owned by another user`);
	if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Write JSON atomically with owner-only permissions: a temp file in the same folder, then a rename. */
export function writePrivateJson(path: string, value: unknown): void {
	ensurePrivateDir(dirname(path));
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	if (process.platform !== "win32") chmodSync(tmp, 0o600);
	renameSync(tmp, path);
}

export function readPrivateJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	if (process.platform !== "win32") {
		const st = lstatSync(path);
		if (st.isSymbolicLink()) throw new Error(`${path} is a symlink`);
		if (st.uid !== process.getuid?.()) throw new Error(`${path} is owned by another user`);
		// A credential file someone else can read is fixed, not trusted silently.
		if ((st.mode & 0o077) !== 0) chmodSync(path, 0o600);
	}
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function removeFile(path: string): void {
	rmSync(path, { force: true });
}

export function listJson(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

function readLock(path: string): { owner: string; mtimeMs: number } | undefined {
	try {
		return { owner: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
	} catch {
		return undefined;
	}
}

/**
 * Run `work` while holding a lock file, so two hosts (one per browser) never refresh the same
 * rotating refresh token at once. The file holds a random owner token: a holder removes only its
 * own lock, and a lock older than LOCK_STALE_MS (a crashed holder's; every request under it times
 * out well before that) is reclaimed only if it is still the same lock that was found stale.
 */
export async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
	ensurePrivateDir(dirname(path));
	const owner = randomBytes(16).toString("hex");
	const started = Date.now();
	for (;;) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeFileSync(fd, owner);
			closeSync(fd);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const held = readLock(path);
			if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
				const again = readLock(path);
				if (again && again.owner === held.owner && again.mtimeMs === held.mtimeMs) rmSync(path, { force: true });
				continue;
			}
			if (Date.now() - started > LOCK_WAIT_MS) throw new Error("Another Tabkyra process is refreshing the sign-in; try again.");
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	try {
		return await work();
	} finally {
		if (readLock(path)?.owner === owner) rmSync(path, { force: true });
	}
}
