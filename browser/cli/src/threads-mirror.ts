/**
 * The native host's half of the thread mirror: it writes what the extension sends
 * (src/threads/mirror.ts) to ~/.local/share/tabkyra/threads/<browser>/, so any local agent or tool
 * can read past side panel chats as files, even while the browser is closed. Each browser profile
 * (its lasting browserId, from the extension's hello) has its own folder, so two browsers never
 * delete or overwrite each other's copy:
 *
 *   <browser>/<id>.md     front matter and the transcript
 *   <browser>/<id>.json   the thread without binary data
 *   <browser>/index.json  every thread's id, title, times, message count and model, newest first
 *
 * The folder is 0700 and every file 0600; each write goes to a temporary file that is renamed
 * into place. Every field of the message is checked here: an id is letters, digits, - and _
 * only, so nothing is ever written outside the folder.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_FILE = 20 * 1024 * 1024;

export interface ThreadIndexEntry {
	id: string;
	title: string;
	createdAt: string;
	lastModified: string;
	messageCount: number;
	model: string;
}

/** Where the mirror lives: TABKYRA_THREADS_DIR, else $XDG_DATA_HOME/tabkyra/threads, else ~/.local/share/tabkyra/threads. */
export function threadsDir(): string {
	if (process.env.TABKYRA_THREADS_DIR) return process.env.TABKYRA_THREADS_DIR;
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "tabkyra", "threads");
}

/** A thread id that is safe as a file name: no separators, dots or traversal. */
export function safeId(id: unknown): id is string {
	// "index" is the index file's name, never a thread's.
	return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && id !== "index";
}

/** One browser profile's folder; a host that doesn't know its browser uses "default". */
export function browserDir(browser?: string): string {
	return join(threadsDir(), safeId(browser) ? browser : "default");
}

function ensureDir(browser?: string): string {
	const root = threadsDir();
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	const dir = browserDir(browser);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

/** Every browser's folder under the mirror. */
export function mirrorDirs(): string[] {
	const root = threadsDir();
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory() && safeId(e.name))
		.map((e) => join(root, e.name));
}

/** Threads from every browser, newest first; a thread in two folders counts once (the newer copy). */
export function readAllIndexes(): Array<ThreadIndexEntry & { dir: string }> {
	const byId = new Map<string, ThreadIndexEntry & { dir: string }>();
	for (const dir of mirrorDirs())
		for (const t of readIndex(dir)) {
			const had = byId.get(t.id);
			if (!had || String(t.lastModified) > String(had.lastModified)) byId.set(t.id, { ...t, dir });
		}
	return [...byId.values()].sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)));
}

function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
}

export function readIndex(dir: string): ThreadIndexEntry[] {
	try {
		const data = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { threads?: ThreadIndexEntry[] };
		return Array.isArray(data.threads) ? data.threads.filter((t) => safeId(t?.id)) : [];
	} catch {
		return [];
	}
}

function writeIndex(dir: string, threads: ThreadIndexEntry[]): void {
	threads.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
	writeAtomic(join(dir, "index.json"), `${JSON.stringify({ updatedAt: new Date().toISOString(), threads }, null, 2)}\n`);
}

function str(v: unknown, max = 4096): string | undefined {
	return typeof v === "string" && v.length <= max ? v : undefined;
}

function removeFiles(dir: string, id: string): void {
	for (const ext of [".md", ".json"]) rmSync(join(dir, `${id}${ext}`), { force: true });
}

/**
 * Apply one mirror message. Returns what it did, for the host log and the tests; anything
 * malformed is refused whole ("refused: ...") and writes nothing.
 */
export function applyMirror(message: Record<string, unknown>, browser?: string): string {
	const op = message.op;
	if (op === "clear") {
		const dir = browserDir(browser);
		// Only the mirror's own files in this browser's folder; anything else stays (and keeps it).
		for (const name of existsSync(dir) ? readdirSync(dir) : []) if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(md|json)$/.test(name) || name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });
		for (const empty of [dir, threadsDir()])
			try {
				rmdirSync(empty);
			} catch {
				/* not empty: another browser's copy, or someone's own file */
			}
		return "cleared";
	}
	if (op === "delete") {
		if (!safeId(message.id)) return "refused: bad id";
		const dir = browserDir(browser);
		if (!existsSync(dir)) return "deleted";
		removeFiles(dir, message.id);
		writeIndex(dir, readIndex(dir).filter((t) => t.id !== message.id));
		return "deleted";
	}
	if (op === "sync") {
		const ids = message.ids;
		if (!Array.isArray(ids) || !ids.every(safeId)) return "refused: bad ids";
		const keep = new Set(ids as string[]);
		const dir = ensureDir(browser);
		for (const name of readdirSync(dir)) {
			const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.(md|json)$/.exec(name);
			if (m && safeId(m[1]) && !keep.has(m[1])) rmSync(join(dir, name), { force: true });
		}
		writeIndex(dir, readIndex(dir).filter((t) => keep.has(t.id)));
		return `synced ${keep.size}`;
	}
	if (op === "put") {
		const id = message.id;
		const md = str(message.md, MAX_FILE);
		const json = str(message.json, MAX_FILE);
		const meta = (message.meta ?? {}) as Record<string, unknown>;
		if (!safeId(id) || md === undefined || json === undefined || meta.id !== id) return "refused: bad thread";
		const entry: ThreadIndexEntry = {
			id,
			title: str(meta.title) ?? "",
			createdAt: str(meta.createdAt, 64) ?? "",
			lastModified: str(meta.lastModified, 64) ?? "",
			messageCount: typeof meta.messageCount === "number" && Number.isFinite(meta.messageCount) ? meta.messageCount : 0,
			model: str(meta.model, 200) ?? "",
		};
		const dir = ensureDir(browser);
		writeAtomic(join(dir, `${id}.md`), md);
		writeAtomic(join(dir, `${id}.json`), json);
		writeIndex(dir, [...readIndex(dir).filter((t) => t.id !== id), entry]);
		return `wrote ${id}`;
	}
	return "refused: unknown op";
}
