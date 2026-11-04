/**
 * Read the side panel's threads from the service worker. Both share the extension's IndexedDB
 * ("tabkyra-storage", stores "sessions-metadata" and "sessions"), so threads can be served while
 * no panel is open. Read-only, and never creates the database: opening a name that doesn't exist
 * yet would make an empty version-1 database before the panel's own upgrade.
 */

import type { ThreadData, ThreadMeta } from "./render.js";

const DB_NAME = "tabkyra-storage";

async function openDb(): Promise<IDBDatabase | undefined> {
	const known = await indexedDB.databases?.().catch(() => undefined);
	if (known && !known.some((d) => d.name === DB_NAME)) return undefined;
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME);
		// No upgrade from here: if one is needed, the panel hasn't made the stores yet.
		req.onupgradeneeded = () => {
			req.transaction?.abort();
			resolve(undefined);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => (req.error?.name === "AbortError" ? resolve(undefined) : reject(req.error));
	});
}

function all<T>(db: IDBDatabase, store: string): Promise<T[]> {
	return new Promise((resolve, reject) => {
		if (!db.objectStoreNames.contains(store)) return resolve([]);
		const req = db.transaction(store, "readonly").objectStore(store).getAll();
		req.onsuccess = () => resolve(req.result as T[]);
		req.onerror = () => reject(req.error);
	});
}

function one<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		if (!db.objectStoreNames.contains(store)) return resolve(undefined);
		const req = db.transaction(store, "readonly").objectStore(store).get(key);
		req.onsuccess = () => resolve(req.result as T | undefined);
		req.onerror = () => reject(req.error);
	});
}

/** Where threads come from: the extension's IndexedDB, or what a test puts in its place. */
export interface ThreadSource {
	list(): Promise<ThreadMeta[]>;
	read(id: string): Promise<{ meta?: ThreadMeta; data?: ThreadData }>;
}

let source: ThreadSource | undefined;

/** Tests read from memory instead of IndexedDB (Node has none). */
export function setThreadSource(next: ThreadSource | undefined): void {
	source = next;
}

/** Every thread's metadata, newest first. Private threads included: callers filter them. */
export async function listThreadMeta(): Promise<ThreadMeta[]> {
	if (source) return source.list();
	const db = await openDb();
	if (!db) return [];
	try {
		const list = await all<ThreadMeta>(db, "sessions-metadata");
		return list.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
	} finally {
		db.close();
	}
}

/** One thread's full data and metadata. */
export async function readThread(id: string): Promise<{ meta?: ThreadMeta; data?: ThreadData }> {
	if (source) return source.read(id);
	const db = await openDb();
	if (!db) return {};
	try {
		const [meta, data] = await Promise.all([
			one<ThreadMeta>(db, "sessions-metadata", id),
			one<ThreadData>(db, "sessions", id),
		]);
		return { meta, data };
	} finally {
		db.close();
	}
}

/**
 * When this build first ran. Chats saved in private mode before then carry no private mark, so
 * nothing created before it is shown to agents unless the user says so (SHARE_OLDER_KEY).
 */
export const SHARED_SINCE_KEY = "threads.sharedSince";
/** chrome.storage.local: true when the user lets agents read chats from before SHARED_SINCE_KEY too. */
export const SHARE_OLDER_KEY = "threads.shareOlder";

/** Record the cutoff once (the worker calls this at start, before any chat of this build is saved). */
export async function markSharingStart(now = new Date().toISOString()): Promise<string | undefined> {
	if (typeof chrome === "undefined" || !chrome.storage?.local) return undefined;
	const got = (await chrome.storage.local.get(SHARED_SINCE_KEY)) as Record<string, unknown>;
	if (typeof got[SHARED_SINCE_KEY] === "string") return got[SHARED_SINCE_KEY] as string;
	await chrome.storage.local.set({ [SHARED_SINCE_KEY]: now });
	return now;
}

/**
 * Which threads agents may see: never a private one, and none created before the cutoff unless
 * the user shared older chats. A thread without a creation time counts as older.
 */
export async function agentsMayRead(): Promise<(meta?: ThreadMeta, data?: ThreadData) => boolean> {
	if (typeof chrome === "undefined" || !chrome.storage?.local) return (meta, data) => !isPrivate(meta, data);
	const got = (await chrome.storage.local.get([SHARED_SINCE_KEY, SHARE_OLDER_KEY])) as Record<string, unknown>;
	const since =
		typeof got[SHARED_SINCE_KEY] === "string" ? (got[SHARED_SINCE_KEY] as string) : await markSharingStart();
	const older = got[SHARE_OLDER_KEY] === true;
	return (meta, data) => {
		if (isPrivate(meta, data)) return false;
		if (older || !since) return true;
		const created = meta?.createdAt ?? data?.createdAt;
		return typeof created === "string" && created >= since;
	};
}

/** Private threads are never mirrored or served; either record carrying the mark is enough. */
export function isPrivate(meta?: ThreadMeta, data?: ThreadData): boolean {
	return meta?.tabkyraPrivate === true || data?.tabkyraPrivate === true;
}
