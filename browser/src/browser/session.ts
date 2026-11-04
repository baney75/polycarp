/**
 * BrowserSession: the set of tabs an agent owns.
 *
 * Every agent (a sidepanel chat session or an external harness connected through
 * the bridge) gets one session. The session owns a Chrome tab group in one window,
 * creates its tabs inactive, tracks which tab tools act on, and never touches tabs
 * outside the group. Nothing here changes window focus or the active tab; that is
 * reserved for the explicit `show()` call.
 *
 * State lives in chrome.storage.local so it survives sidepanel reloads, service worker
 * restarts and extension reloads (Chrome's tab groups do too). Tab and group ids that no
 * longer exist are dropped on reconcile, which is what happens after a browser restart.
 *
 * Two extension contexts write the table: the side panel and the service worker (bridge,
 * foreground guard, prune). Storage is the source of truth. Every write runs under one Web
 * Lock shared by all extension contexts, re-reads the table and changes only the stored
 * entry it means to change. A BrowserSession's `state` is a read cache of its entry; it
 * never writes that cache back whole.
 */

import { detachTab, ensureAttached, isRestrictedUrl, releaseAgentViewport } from "./cdp.js";

const STORAGE_KEY = "browser_sessions";
const GROUP_PREFIX = "Tabkyra";
const GROUP_COLORS: `${chrome.tabGroups.Color}`[] = [
	"blue",
	"cyan",
	"green",
	"orange",
	"red",
	"pink",
	"purple",
	"yellow",
];

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	current: boolean;
	favicon?: string;
	/** False when the tab sits outside the session's group (dragged out, or grouping failed). */
	inGroup: boolean;
}

interface PersistedSession {
	id: string;
	label: string;
	color: `${chrome.tabGroups.Color}`;
	windowId: number;
	groupId?: number;
	tabIds: number[];
	currentTabId?: number;
	/** The tab the panel that owns this session was opened on (Claude-style per-tab binding). */
	homeTabId?: number;
	/** Last time a tool touched the session (ms since epoch); drives cleanup of abandoned sessions. */
	lastUsedAt?: number;
	/**
	 * Tabs handed back to the user (tab id -> ms since epoch). Reconcile's group scan must not
	 * re-adopt one that is still in the group while release ungroups it.
	 */
	released?: Record<number, number>;
	/** When the session was first stored (ms since epoch). Absent on records from before 1.2. */
	createdAt?: number;
	/** Bridge sessions: the harness ("claude", "codex"), the project it works in, and its name. */
	agent?: string;
	project?: string;
	name?: string;
	/** A label the agent chose for its group (session_info), shown after the agent's name. */
	agentLabel?: string;
	/**
	 * Tabs seen inside the session's group at least once. A tab on this list that is now outside
	 * the group was moved by the user (dragged out, ungrouped) and is theirs; a tab not on it is
	 * still being grouped and goes (back) in.
	 */
	grouped?: number[];
	/**
	 * Tabs the user gave the agent from their own tab strip (the tab the panel opened on, the tab
	 * in front when they sent, an `@` reference). The agent may use them, but they stay where the
	 * user keeps them: never moved into the agent's group. Only tabs the agent opens are grouped.
	 */
	loose?: number[];
}

/** Who and what a bridge session serves, for its group title and `tabkyra sessions`. */
export interface SessionMeta {
	agent?: string;
	project?: string;
	name?: string;
}

/** The most tabs one agent session may hold; tabs_create past it fails with what to do. */
export const MAX_SESSION_TABS = 15;

export class TabLimitError extends Error {
	constructor() {
		super(
			`Your tab group already has ${MAX_SESSION_TABS} tabs, the most a session may hold. Close tabs you're done with (tabs_close; tabs_context lists them), then try again.`,
		);
	}
}

/** Sessions an agent drives through the bridge, as opposed to side panel chats. */
export function isAgentSession(id: string): boolean {
	return id.startsWith("bridge-");
}

/**
 * Tabs this context is closing or releasing for an agent right now. The worker's gesture
 * listeners skip them: only a change the user made is news to the agent.
 */
const agentTouching = new Set<number>();

export function isAgentTouching(tabId: number): boolean {
	return agentTouching.has(tabId);
}

function touch(tabId: number): () => void {
	agentTouching.add(tabId);
	// Events for the change can arrive after the call returns.
	return () => setTimeout(() => agentTouching.delete(tabId), 2000);
}

const NOTICES_KEY = "browser_session_notices";
const MAX_NOTICES = 10;

/** Something the agent should hear on its next tabs_context or session_info (the user moved a tab, ...). */
export async function addNotice(sessionId: string, text: string): Promise<void> {
	await withTableLock(async () => {
		const data = await chrome.storage.local.get(NOTICES_KEY);
		const all = (data[NOTICES_KEY] as Record<string, Array<{ at: number; text: string }>> | undefined) ?? {};
		all[sessionId] = [...(all[sessionId] ?? []), { at: Date.now(), text }].slice(-MAX_NOTICES);
		await chrome.storage.local.set({ [NOTICES_KEY]: all });
	});
}

/** The session's notices, oldest first, removed as they are read. */
export async function takeNotices(sessionId: string): Promise<string[]> {
	return withTableLock(async () => {
		const data = await chrome.storage.local.get(NOTICES_KEY);
		const all = (data[NOTICES_KEY] as Record<string, Array<{ at: number; text: string }>> | undefined) ?? {};
		const mine = all[sessionId] ?? [];
		if (!mine.length) return [];
		delete all[sessionId];
		await chrome.storage.local.set({ [NOTICES_KEY]: all });
		return mine.map((n) => n.text);
	});
}

/** A tab's title for a notice: quoted, one line, short. */
function tabName(tab: chrome.tabs.Tab | undefined, tabId: number): string {
	const title = (tab?.title || tab?.url || "").replace(/\s+/g, " ").slice(0, 60);
	return title ? `tab ${tabId} (${JSON.stringify(title)})` : `tab ${tabId}`;
}

type SessionTable = Record<string, PersistedSession>;
/** Old id -> new id for sessions renamed on first save, so a context holding the old id follows. */
type RenameTable = Record<string, { to: string; at: number }>;

const RENAMES_KEY = "browser_session_renames";
/** Bumped by every locked write, so a late storage.onChanged can't roll a cache back. */
const REV_KEY = "browser_sessions_rev";
const RENAME_TTL_MS = 60 * 60 * 1000;
const RELEASED_TTL_MS = 10 * 60 * 1000;
/** One lock for the table across the side panel and the service worker (same origin). */
const LOCK_NAME = "tabkyra-browser-sessions";

async function readTable(): Promise<SessionTable> {
	const data = await chrome.storage.local.get(STORAGE_KEY);
	return (data[STORAGE_KEY] as SessionTable | undefined) ?? {};
}

let fallbackChain: Promise<unknown> = Promise.resolve();

/** Run `fn` holding the table lock. Not reentrant: never call it from inside `fn`. */
function withTableLock<T>(fn: () => Promise<T>): Promise<T> {
	const locks = (globalThis.navigator as Navigator | undefined)?.locks;
	// The callback's promise is what request() resolves with; lib.dom types it one level deep.
	if (locks) return locks.request(LOCK_NAME, fn) as unknown as Promise<T>;
	// No Web Locks (not an extension context): serialize within this context only.
	const run = fallbackChain.then(fn, fn);
	fallbackChain = run.catch(() => undefined);
	return run;
}

interface TableTx {
	table: SessionTable;
	renames: RenameTable;
}

/**
 * Read-modify-write the table under the lock. `fn` changes `tx` in place and must not take
 * the lock itself. Every instance in this context is refreshed from what was written.
 */
async function mutateTable<T>(fn: (tx: TableTx) => T | Promise<T>): Promise<T> {
	return withTableLock(async () => {
		const data = await chrome.storage.local.get([STORAGE_KEY, RENAMES_KEY, REV_KEY]);
		// Time-based so it still grows after storage is cleared (a context keeps its last value).
		const rev = Math.max(((data[REV_KEY] as number | undefined) ?? 0) + 1, Date.now() * 1000);
		const tx: TableTx = {
			table: (data[STORAGE_KEY] as SessionTable | undefined) ?? {},
			renames: (data[RENAMES_KEY] as RenameTable | undefined) ?? {},
		};
		const before = JSON.stringify(tx.renames);
		const result = await fn(tx);
		const write: Record<string, unknown> = { [STORAGE_KEY]: tx.table, [REV_KEY]: rev };
		if (JSON.stringify(tx.renames) !== before) write[RENAMES_KEY] = tx.renames;
		await chrome.storage.local.set(write);
		refreshInstances(tx.table, rev);
		return result;
	});
}

/** Read the table under the lock (no write): a decision that must not race a writer. */
function readTableLocked<T>(fn: (table: SessionTable) => T): Promise<T> {
	return withTableLock(async () => fn(await readTable()));
}

/** Newest table revision this context's caches reflect. */
let appliedRev = 0;

/**
 * Point every live instance in this context at its freshly stored entry. A table older than
 * one already applied is ignored (storage.onChanged can arrive after this context's own commit).
 */
function refreshInstances(table: SessionTable, rev: number | undefined): void {
	if (rev !== undefined) {
		if (rev <= appliedRev) return;
		appliedRev = rev;
	}
	for (const inst of live) {
		const stored = table[inst.id];
		if (stored) inst.adoptState(structuredClone(stored));
	}
}

/** Keep this context's caches current when the other context writes. */
if (typeof chrome !== "undefined")
	chrome.storage?.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !(STORAGE_KEY in changes)) return;
		const table = changes[STORAGE_KEY].newValue as SessionTable | undefined;
		if (table) refreshInstances(table, changes[REV_KEY]?.newValue as number | undefined);
	});

function ownedElsewhere(table: SessionTable, selfId: string, tabId: number): boolean {
	return Object.values(table).some((s) => s.id !== selfId && s.tabIds.includes(tabId));
}

/** Add a tab to, or take it off, the session's list of the user's own (ungrouped) tabs. */
function markLoose(s: PersistedSession, tabId: number, loose: boolean): void {
	const rest = (s.loose ?? []).filter((id) => id !== tabId);
	if (loose) {
		rest.push(tabId);
		s.grouped = (s.grouped ?? []).filter((id) => id !== tabId);
	}
	if (rest.length) s.loose = rest;
	else delete s.loose;
}

function fixCurrent(s: PersistedSession): void {
	if (s.currentTabId !== undefined && !s.tabIds.includes(s.currentTabId))
		s.currentTabId = s.tabIds[s.tabIds.length - 1];
}

/** Chromium refuses tab edits while a tab is being dragged or animated; retry briefly. */
async function withGroupRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			await new Promise((r) => setTimeout(r, 250 * (i + 1)));
		}
	}
	throw lastError;
}

/** Tab ids owned by any session. Used by the foreground guard in the service worker. */
export async function allOwnedTabIds(): Promise<Set<number>> {
	const table = await readTable();
	const ids = new Set<number>();
	for (const s of Object.values(table)) for (const id of s.tabIds) ids.add(id);
	return ids;
}

/** Find the session that owns a tab, if any. */
export async function sessionOwningTab(tabId: number): Promise<PersistedSession | undefined> {
	const table = await readTable();
	return Object.values(table).find((s) => s.tabIds.includes(tabId));
}

/** Summaries of all sessions, for UI. */
export async function listSessions(): Promise<PersistedSession[]> {
	return Object.values(await readTable());
}

/** The id of the session whose home tab is `tabId`, if any. */
export async function sessionIdForTab(tabId: number): Promise<string | undefined> {
	const table = await readTable();
	return Object.values(table).find((s) => s.homeTabId === tabId)?.id;
}

/**
 * Ungroup tabs sitting in "Tabkyra · ..." groups that no live session owns (left behind
 * by an extension reload, which clears session storage but not the browser's groups).
 */
export async function cleanupOrphanGroups(): Promise<number> {
	const table = await readTable();
	const liveGroups = new Set<number>();
	for (const s of Object.values(table)) if (s.groupId !== undefined) liveGroups.add(s.groupId);
	const groups = await chrome.tabGroups.query({}).catch(() => []);
	let released = 0;
	for (const g of groups) {
		if (!g.title?.startsWith(`${GROUP_PREFIX} ·`) || liveGroups.has(g.id)) continue;
		const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
		for (const t of tabs) {
			if (t.id === undefined) continue;
			await chrome.tabs.ungroup(t.id).catch(() => undefined);
			released++;
		}
	}
	return released;
}

function isBlankUrl(url: string | undefined): boolean {
	return (
		!url ||
		url === "about:blank" ||
		url.startsWith("chrome://newtab") ||
		url.startsWith("brave://newtab") ||
		url.startsWith("edge://newtab") ||
		url.startsWith("chrome://new-tab-page")
	);
}

/**
 * Tidy the session table. Dead tab ids are dropped everywhere. Bridge sessions whose
 * client is gone (`liveIds` lacks them) lose their blank tabs, are forgotten once they
 * own nothing, and have their group collapsed after `idleMs` so finished agent work
 * stops cluttering the tab strip (one click on the group closes it). Side-panel sessions
 * are left alone apart from dead ids: their tabs are the user's.
 *
 * Works from the stored entries, never this context's cached copies, and only removes ids
 * it saw dead: a tab another context adds while this runs is kept.
 */
export async function pruneSessions(
	liveIds: Set<string>,
	idleMs = 30 * 60 * 1000,
): Promise<{
	dropped: number;
	closedTabs: number;
}> {
	// Read the table before listing tabs: any id stored by then that the listing lacks is dead.
	const snapshot = await readTable();
	let allTabs: chrome.tabs.Tab[];
	try {
		allTabs = await chrome.tabs.query({});
	} catch {
		// Without a tab list every id would look dead; prune nothing this time.
		return { dropped: 0, closedTabs: 0 };
	}
	const liveTabs = new Map<number, chrome.tabs.Tab>();
	for (const t of allTabs) if (t.id !== undefined) liveTabs.set(t.id, t);
	const dead = new Set<number>();
	for (const s of Object.values(snapshot)) {
		for (const id of s.tabIds) if (!liveTabs.has(id)) dead.add(id);
		if (s.homeTabId !== undefined && !liveTabs.has(s.homeTabId)) dead.add(s.homeTabId);
	}
	// Blank tabs of abandoned bridge sessions get closed (outside the lock: tab calls are slow).
	let closedTabs = 0;
	for (const s of Object.values(snapshot)) {
		if (!s.id.startsWith("bridge-") || liveIds.has(s.id)) continue;
		for (const id of s.tabIds) {
			const tab = liveTabs.get(id);
			if (!tab || !isBlankUrl(tab.url ?? tab.pendingUrl) || tab.active) continue;
			// Tabkyra's own cleanup, not the user closing the group.
			const done = touch(id);
			await chrome.tabs.remove(id).catch(() => undefined);
			done();
			dead.add(id);
			closedTabs++;
		}
	}
	const now = Date.now();
	const toCollapse: number[] = [];
	const droppedIds: string[] = [];
	await mutateTable(({ table }) => {
		for (const s of Object.values(table)) {
			s.tabIds = s.tabIds.filter((id) => !dead.has(id));
			fixCurrent(s);
			if (s.homeTabId !== undefined && dead.has(s.homeTabId)) s.homeTabId = undefined;
			const isBridge = s.id.startsWith("bridge-");
			if (isBridge && !liveIds.has(s.id)) {
				if (s.tabIds.length === 0) {
					delete table[s.id];
					droppedIds.push(s.id);
					continue;
				}
				const userLooking = s.tabIds.some((id) => liveTabs.get(id)?.active);
				if (s.groupId !== undefined && !userLooking && now - (s.lastUsedAt ?? 0) > idleMs)
					toCollapse.push(s.groupId);
			} else if (!isBridge && s.tabIds.length === 0 && s.homeTabId === undefined) {
				delete table[s.id];
				droppedIds.push(s.id);
			}
		}
	});
	// Instances stay: a client may hold one, and its next write recreates the entry.
	for (const groupId of toCollapse) {
		await chrome.tabGroups.update(groupId, { collapsed: true }).catch(() => undefined);
	}
	return { dropped: droppedIds.length, closedTabs };
}

/** "omp", then "omp 2", "omp 3" ...: two agents must not share a group title. */
function uniqueLabel(table: SessionTable, label: string, selfId?: string): string {
	const taken = new Set(
		Object.values(table)
			.filter((s) => s.id !== selfId)
			.map((s) => s.label),
	);
	if (!taken.has(label)) return label;
	for (let n = 2; ; n++) if (!taken.has(`${label} ${n}`)) return `${label} ${n}`;
}

function pickColor(table: SessionTable): `${chrome.tabGroups.Color}` {
	const used = new Set(Object.values(table).map((s) => s.color));
	return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[Object.keys(table).length % GROUP_COLORS.length];
}

async function tabExists(tabId: number): Promise<chrome.tabs.Tab | undefined> {
	try {
		return await chrome.tabs.get(tabId);
	} catch {
		return undefined;
	}
}

/**
 * A label as plain text: no control, format or bidi characters, single spaces, at most 32
 * characters, and never the "Tabkyra ·" prefix, so an agent can't pose as another group.
 */
export function sanitizeLabel(label: string): string {
	return label
		.normalize("NFKC")
		.replace(/[\t\n\r\v\f\u2028\u2029]/g, " ")
		.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, "")
		.replace(/\s+/g, " ")
		.replace(/^(tabkyra\s*[·:|-]\s*)+/i, "")
		.trim()
		.slice(0, 32)
		.trim();
}

export class NoTabError extends Error {
	constructor() {
		super(
			"You have no current tab. navigate with a URL opens one in your group; if you had tabs, tabs_context lists them (and says if the user took or closed one) and tabs_select picks one.",
		);
	}
}

/** One live instance per session id in this context, so concurrent clients share state. */
const instances = new Map<string, BrowserSession>();
/**
 * Every instance not yet closed, including one a rename left outside `instances` (another
 * instance already had the new id). All of them are refreshed on each write.
 */
const live = new Set<BrowserSession>();

export class BrowserSession {
	/** Read cache of the stored entry. Writes go through `update`, never by saving this whole. */
	private state: PersistedSession;

	private constructor(state: PersistedSession) {
		this.state = state;
	}

	/** @internal Replace the cache with a stored copy (see refreshInstances). */
	adoptState(state: PersistedSession): void {
		this.state = state;
	}

	get id(): string {
		return this.state.id;
	}

	get label(): string {
		return this.state.label;
	}

	get windowId(): number {
		return this.state.windowId;
	}

	/** Whether a tab is one of the user's own tabs the agent may use (kept out of the group). */
	isLoose(tabId: number): boolean {
		return this.state.loose?.includes(tabId) ?? false;
	}

	get tabIds(): number[] {
		return [...this.state.tabIds];
	}

	get currentTabId(): number | undefined {
		return this.state.currentTabId;
	}

	get homeTabId(): number | undefined {
		return this.state.homeTabId;
	}

	get groupId(): number | undefined {
		return this.state.groupId;
	}

	/** A copy of the stored record, for session_info and `tabkyra sessions`. */
	get record(): Readonly<PersistedSession> {
		return structuredClone(this.state);
	}

	/** True once the session was ended (by the user, the CLI or the agent); a client opens a fresh one. */
	ended = false;

	/** The tab group title this session uses ("Tabkyra · claude"), whether or not it exists yet. */
	get groupName(): string {
		return this.groupTitle();
	}

	/**
	 * Apply `fn` to this session's stored entry under the table lock. Follows a rename made in
	 * any context; recreates the entry from the cache if another context forgot it, minus tabs
	 * another session now owns. `fn` returning false skips the write's timestamp bump.
	 */
	private async update(fn: (s: PersistedSession, table: SessionTable) => unknown): Promise<void> {
		await mutateTable(({ table, renames }) => {
			// Ended: a write still in flight from before must not bring the record (and the tabs
			// just handed to the user) back.
			if (this.ended) return;
			let id = this.state.id;
			for (let hops = 0; !table[id] && renames[id] && hops < 8; hops++) id = renames[id].to;
			if (id !== this.state.id) {
				if (instances.get(this.state.id) === this) instances.delete(this.state.id);
				if (!instances.has(id)) instances.set(id, this);
			}
			let s = table[id];
			if (!s) {
				s = structuredClone({ ...this.state, id });
				s.tabIds = s.tabIds.filter((tabId) => !ownedElsewhere(table, id, tabId));
				fixCurrent(s);
				table[id] = s;
			}
			if (fn(s, table) !== false) s.lastUsedAt = Date.now();
			this.state = structuredClone(s);
		});
	}

	/** Re-read this session's stored entry into the cache. */
	private async refresh(): Promise<void> {
		const data = await chrome.storage.local.get([STORAGE_KEY, RENAMES_KEY, REV_KEY]);
		// A commit in this context finished while we read: our copy is older than the cache.
		if (((data[REV_KEY] as number | undefined) ?? 0) < appliedRev) return;
		const table = (data[STORAGE_KEY] as SessionTable | undefined) ?? {};
		const renames = (data[RENAMES_KEY] as RenameTable | undefined) ?? {};
		let id = this.state.id;
		for (let hops = 0; !table[id] && renames[id] && hops < 8; hops++) id = renames[id].to;
		const stored = table[id];
		if (!stored) return;
		if (id !== this.state.id) {
			if (instances.get(this.state.id) === this) instances.delete(this.state.id);
			if (!instances.has(id)) instances.set(id, this);
		}
		this.state = stored;
	}

	/**
	 * Bind this session to the tab its panel lives on, so reopening the panel there restores
	 * it. Exclusive: any other session that claimed this tab as its home tab gives it up, so a
	 * tab maps to exactly one task (e.g. after "New chat" rebinds the tab to a fresh session).
	 */
	async setHomeTab(tabId: number): Promise<void> {
		await this.update((s, table) => {
			for (const other of Object.values(table)) {
				if (other.id !== s.id && other.homeTabId === tabId) other.homeTabId = undefined;
			}
			s.homeTabId = tabId;
		});
	}

	/**
	 * Open (or re-adopt) a session. `windowId` is where new tabs go; for the sidepanel
	 * that is its own window, for the bridge the last focused normal window.
	 */
	static async open(id: string, label: string, windowId?: number, meta?: SessionMeta): Promise<BrowserSession> {
		const existing = instances.get(id);
		const fallbackWindow =
			windowId === undefined && !existing && !(await readTable())[id] ? await lastFocusedWindowId() : undefined;
		const state = await mutateTable(({ table, renames }) => {
			let s = table[id];
			if (!s) {
				// A new session under an id that was renamed away (New chat on the same tab):
				// nothing may follow the old rename into the saved chat any more.
				delete renames[id];
				s = {
					id,
					label: uniqueLabel(table, existing?.label ?? label),
					color: existing?.state.color ?? pickColor(table),
					windowId: windowId ?? fallbackWindow ?? existing?.windowId ?? 0,
					tabIds: [],
					createdAt: Date.now(),
					...meta,
				};
				table[id] = s;
			} else {
				if (meta) Object.assign(s, meta);
				if (!existing && s.label !== label && !s.label.startsWith(`${label} `))
					s.label = uniqueLabel(table, label, id);
				if (windowId !== undefined) s.windowId = windowId;
			}
			return structuredClone(s);
		});
		let session = instances.get(id);
		if (session) session.state = state;
		else {
			session = new BrowserSession(state);
			instances.set(id, session);
		}
		live.add(session);
		await session.reconcile();
		return session;
	}

	/**
	 * Open the session that owns `tabId` right now, decided under the lock, so an id read
	 * earlier can't recreate a session that was renamed or forgotten meanwhile.
	 */
	static async openOwnerOf(tabId: number): Promise<BrowserSession | undefined> {
		const state = await readTableLocked((table) => Object.values(table).find((s) => s.tabIds.includes(tabId)));
		if (!state) return undefined;
		let session = instances.get(state.id);
		if (session) session.state = state;
		else {
			session = new BrowserSession(state);
			instances.set(state.id, session);
		}
		live.add(session);
		await session.reconcile();
		return session;
	}

	/**
	 * Forget a session only if its stored entry owns no tabs, decided under the lock. Leaves
	 * any instance alone: a client may hold it, and its next write recreates the entry.
	 */
	static async dropIfEmpty(id: string): Promise<boolean> {
		return mutateTable(({ table }) => {
			const stored = table[id];
			if (!stored || stored.tabIds.length > 0) return false;
			delete table[id];
			return true;
		});
	}

	/** Chrome replaced a tab (prerender/instant pages commit into a new tab): follow it everywhere. */
	static async replaceTab(oldId: number, newId: number): Promise<void> {
		const owned = await mutateTable(({ table }) => {
			let hit = false;
			for (const s of Object.values(table)) {
				if (s.tabIds.includes(oldId)) {
					s.tabIds = s.tabIds.map((id) => (id === oldId ? newId : id));
					hit = true;
				}
				if (s.currentTabId === oldId) s.currentTabId = newId;
				if (s.homeTabId === oldId) s.homeTabId = newId;
			}
			return hit;
		});
		if (owned) await (await BrowserSession.openOwnerOf(newId))?.adopt(newId, false);
	}

	/**
	 * Rename a session in place (a sidepanel session gets its real id on first save). The
	 * in-memory id changes inside the same locked write, so an update queued on this instance
	 * lands on the new entry; other contexts follow the recorded rename.
	 */
	static async rename(oldId: string, newId: string): Promise<void> {
		await mutateTable(({ table, renames }) => {
			const now = Date.now();
			for (const [from, r] of Object.entries(renames)) if (now - r.at > RENAME_TTL_MS) delete renames[from];
			const state = table[oldId];
			if (!state) return;
			delete table[oldId];
			state.id = newId;
			table[newId] = state;
			renames[oldId] = { to: newId, at: now };
			const inst = instances.get(oldId);
			if (inst) {
				instances.delete(oldId);
				inst.state = structuredClone(state);
				instances.set(newId, inst);
			}
		});
	}

	/** Drop tabs that no longer exist and re-find the group if the id went stale. */
	async reconcile(): Promise<void> {
		await this.refresh();
		const seen = this.state;
		const dead = new Set<number>();
		for (const id of seen.tabIds) if (!(await tabExists(id))) dead.add(id);
		const homeDead = seen.homeTabId !== undefined && !(await tabExists(seen.homeTabId));
		// A group belongs to exactly one session. (Re-finding a group by title used to hand a
		// fresh session another agent's group whenever their labels matched.)
		const table = await readTable();
		const claimedElsewhere =
			seen.groupId !== undefined && Object.values(table).some((s) => s.id !== seen.id && s.groupId === seen.groupId);
		const group = claimedElsewhere ? undefined : await this.liveGroup();
		const lostGroup = seen.groupId !== undefined && !group ? seen.groupId : undefined;
		// Chrome puts tabs opened from a grouped tab into that group; those are this agent's.
		const found: number[] = [];
		const groupedNow = new Set<number>();
		if (group) {
			for (const t of await chrome.tabs.query({ groupId: group.id }).catch(() => [] as chrome.tabs.Tab[])) {
				if (t.id !== undefined) groupedNow.add(t.id);
				if (t.id !== undefined && !seen.tabIds.includes(t.id)) found.push(t.id);
			}
		}
		await this.update((s, stored) => {
			// An agent whose current tab is gone gets none, rather than silently another page.
			if (isAgentSession(s.id) && s.currentTabId !== undefined && dead.has(s.currentTabId))
				s.currentTabId = undefined;
			s.tabIds = s.tabIds.filter((id) => !dead.has(id));
			if (s.loose) s.loose = s.loose.filter((id) => !dead.has(id));
			// A shared tab the user dragged into the agent's group is grouped from now on.
			if (group && s.loose?.length) {
				for (const id of s.loose.filter((id) => groupedNow.has(id))) {
					markLoose(s, id, false);
					s.grouped = [...(s.grouped ?? []), id];
				}
			}
			for (const id of found)
				if (!s.tabIds.includes(id) && !s.released?.[id] && !ownedElsewhere(stored, s.id, id)) {
					s.tabIds.push(id);
					s.grouped = [...(s.grouped ?? []), id];
				}
			fixCurrent(s);
			if (homeDead && s.homeTabId === seen.homeTabId) s.homeTabId = undefined;
			if (lostGroup !== undefined && s.groupId === lostGroup) s.groupId = undefined;
		});
		// Tabs that never made it into the group go in, so the user sees an agent's tabs together.
		// A tab of an agent session that was in the group and is now outside it was moved by the
		// user (dragged out, ungrouped, even the last one, which deletes the group): it is theirs.
		for (const id of this.state.tabIds) {
			// The user's own tabs stay where they keep them.
			if (this.state.loose?.includes(id)) continue;
			const tab = await tabExists(id);
			if (!tab || (this.state.groupId !== undefined && tab.groupId === this.state.groupId)) continue;
			// Still in the group this session just lost track of (another record claims it, or
			// the lookup failed): nobody moved it, so it is neither handed over nor regrouped.
			if (lostGroup !== undefined && tab.groupId === lostGroup) continue;
			if (isAgentSession(this.state.id) && this.state.grouped?.includes(id) && !agentTouching.has(id)) {
				await this.userTook(id, tab);
				continue;
			}
			// A side panel chat's tab the user took out of the group stays out: the agent keeps
			// using it, ungrouped. (Putting it back is what made groups re-form on their own.)
			if (!isAgentSession(this.state.id) && this.state.grouped?.includes(id) && !agentTouching.has(id)) {
				await this.update((s) => markLoose(s, id, true));
				continue;
			}
			await this.groupTab(id);
		}
	}

	/** The user moved one of this agent's tabs out of its group: hand it over and tell the agent. */
	async userTook(tabId: number, tab?: chrome.tabs.Tab): Promise<void> {
		await this.refresh();
		if (!this.state.tabIds.includes(tabId)) return;
		await this.update((s) => {
			s.tabIds = s.tabIds.filter((id) => id !== tabId);
			s.grouped = (s.grouped ?? []).filter((id) => id !== tabId);
			// Never slide the agent onto another page it didn't choose: it has no current tab until
			// it picks one (tabs_select) or navigates.
			if (s.currentTabId === tabId) s.currentTabId = undefined;
			s.released = { ...(s.released ?? {}), [tabId]: Date.now() };
		});
		await detachTab(tabId, true);
		await addNotice(
			this.state.id,
			`The user took ${tabName(tab, tabId)} out of your group; it's theirs now and you can't use it.`,
		);
	}

	/** The user put one of their tabs into this agent's group: it's the agent's now. */
	async userGave(tabId: number, tab?: chrome.tabs.Tab): Promise<void> {
		await this.refresh();
		if (this.state.tabIds.includes(tabId)) return;
		await this.adopt(tabId, false);
		await addNotice(
			this.state.id,
			`The user gave you ${tabName(tab, tabId)} by moving it into your group; you can use it now.`,
		);
	}

	private groupTitle(): string {
		return `${GROUP_PREFIX} · ${this.state.label}${this.state.agentLabel ? ` · ${this.state.agentLabel}` : ""}`;
	}

	/** Record who and what the session serves (agent, project, name). */
	async setMeta(meta: SessionMeta): Promise<void> {
		await this.update((s) => {
			Object.assign(s, meta);
			return false;
		});
	}

	/** Name the group from the agent's side (session_info label); "" clears it. Sanitized as text. */
	async setAgentLabel(label: string): Promise<string> {
		const clean = sanitizeLabel(label);
		await this.update((s) => {
			s.agentLabel = clean || undefined;
		});
		if (this.state.groupId !== undefined)
			await chrome.tabGroups.update(this.state.groupId, { title: this.groupTitle() }).catch(() => undefined);
		return this.groupTitle();
	}

	/** Change the label; updates the tab group title. */
	async setLabel(label: string): Promise<void> {
		await this.update((s) => {
			s.label = label;
		});
		if (this.state.groupId !== undefined) {
			try {
				await chrome.tabGroups.update(this.state.groupId, { title: this.groupTitle() });
			} catch {
				/* group gone */
			}
		}
	}

	/** The session's group if it still exists. */
	private async liveGroup(): Promise<chrome.tabGroups.TabGroup | undefined> {
		if (this.state.groupId === undefined) return undefined;
		try {
			return await chrome.tabGroups.get(this.state.groupId);
		} catch {
			return undefined;
		}
	}

	/**
	 * Put a tab into the session group, creating the group in the tab's window. A tab in
	 * another window is moved next to the group first (a group cannot span windows). If the
	 * existing group refuses the tab, a fresh group is made rather than leaving it loose.
	 */
	private async groupTab(tabId: number): Promise<void> {
		try {
			let tab = await chrome.tabs.get(tabId);
			if (tab.pinned) return; // pinned tabs cannot be grouped
			const win = await chrome.windows.get(tab.windowId).catch(() => undefined);
			if (win && win.type !== "normal") return; // popups and app windows have no tab strip
			const group = await this.liveGroup();
			const seenGroupId = this.state.groupId;
			if (group && tab.groupId === group.id) return await this.markGrouped(tabId);
			if (group) {
				try {
					if (group.windowId !== tab.windowId) {
						await withGroupRetry(() => chrome.tabs.move(tabId, { windowId: group.windowId, index: -1 }));
						tab = await chrome.tabs.get(tabId);
					}
					await withGroupRetry(() => chrome.tabs.group({ tabIds: [tabId], groupId: group.id }));
					return await this.markGrouped(tabId);
				} catch (err) {
					// The group is still there with the agent's other tabs: a second group would split
					// them (and the next reconcile would read the first group's tabs as moved out by
					// the user). The tab stays owned and ungrouped; the next reconcile tries again.
					console.warn("[BrowserSession] joining group failed, will retry:", err);
					return;
				}
			}
			if (tab.groupId !== undefined && tab.groupId !== -1) await chrome.tabs.ungroup(tabId).catch(() => undefined);
			const groupId = await withGroupRetry(() =>
				chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } }),
			);
			const windowId = tab.windowId;
			// Another writer may have made the session's group meanwhile; then join that one and
			// let ours empty out (Chrome removes an empty group).
			let theirs: number | undefined;
			await this.update((s) => {
				if (s.groupId !== undefined && s.groupId !== seenGroupId && s.groupId !== groupId) {
					theirs = s.groupId;
					return false;
				}
				s.groupId = groupId;
				s.windowId = windowId;
			});
			if (theirs !== undefined) {
				const target = theirs;
				try {
					await withGroupRetry(() => chrome.tabs.group({ tabIds: [tabId], groupId: target }));
					return await this.markGrouped(tabId);
				} catch {
					await this.update((s) => {
						if (s.groupId === target) {
							s.groupId = groupId;
							s.windowId = windowId;
						}
					});
				}
			}
			await chrome.tabGroups.update(groupId, { title: this.groupTitle(), color: this.state.color });
			await this.markGrouped(tabId);
		} catch (err) {
			// A closing window or a tab being dragged must not fail the tool; the tab stays owned.
			console.warn("[BrowserSession] group failed:", err);
		}
	}

	/** Record that a tab made it into the group, so a later move out of it reads as the user's. */
	private async markGrouped(tabId: number): Promise<void> {
		// Side panel chats track this too: a tab the user later takes out stays out (reconcile).
		if (this.state.grouped?.includes(tabId)) return;
		await this.update((s) => {
			if (!s.tabIds.includes(tabId)) return false;
			s.grouped = [...(s.grouped ?? []).filter((id) => s.tabIds.includes(id)), tabId];
			return false;
		});
	}

	/** Window for new tabs: the group's window when it exists, else the session window. */
	private async targetWindowId(): Promise<number> {
		const group = await this.liveGroup();
		if (group) return group.windowId;
		try {
			const win = await chrome.windows.get(this.state.windowId);
			if (win.type === "normal") return this.state.windowId;
		} catch {
			/* window gone */
		}
		const windowId = await lastFocusedWindowId();
		await this.update((s) => {
			s.windowId = windowId;
			return false;
		});
		return windowId;
	}

	/**
	 * Create a new inactive tab in the session's group and make it current. With a url the
	 * tab loads it directly (callers wait for the load); without one it starts blank.
	 */
	async createTab(url?: string, options: { capped?: boolean } = {}): Promise<chrome.tabs.Tab> {
		if (!options.capped) return this.openTab(url);
		await this.refresh();
		// Clients sharing a session share this instance: count the tabs still being opened too.
		if (this.state.tabIds.length + this.opening >= MAX_SESSION_TABS) throw new TabLimitError();
		this.opening++;
		try {
			return await this.openTab(url);
		} finally {
			this.opening--;
		}
	}

	/** Tabs being opened for a capped create and not adopted yet. */
	private opening = 0;

	private async openTab(url?: string): Promise<chrome.tabs.Tab> {
		const windowId = await this.targetWindowId();
		const tab = await chrome.tabs.create({ url: url ?? "about:blank", windowId, active: false });
		if (tab.id === undefined) throw new Error("Failed to create tab");
		await this.adopt(tab.id);
		return tab;
	}

	/** Take ownership of an existing tab (user handed it over, or a popup opened from an owned tab). */
	async adopt(tabId: number, makeCurrent = true, options: { group?: boolean } = {}): Promise<void> {
		const group = options.group !== false;
		await this.update((s, table) => {
			// A tab belongs to one session; take it away from whoever had it before.
			for (const other of Object.values(table)) {
				if (other.id === s.id || !other.tabIds.includes(tabId)) continue;
				other.tabIds = other.tabIds.filter((id) => id !== tabId);
				markLoose(other, tabId, false);
				other.grouped = (other.grouped ?? []).filter((id) => id !== tabId);
				fixCurrent(other);
			}
			// A tab this session already has keeps its place: the agent's own grouped tab stays
			// grouped when the user references it, a shared tab stays where the user keeps it.
			if (!s.tabIds.includes(tabId)) {
				s.tabIds.push(tabId);
				markLoose(s, tabId, !group);
			}
			if (makeCurrent) s.currentTabId = tabId;
			if (s.released) delete s.released[tabId];
		});
		if (group) await this.groupTab(tabId);
	}

	/**
	 * Take a tab the user handed over by reference, unless another session owns it: the check
	 * and the claim happen under one lock, so an agent that takes the tab meanwhile keeps it.
	 * Returns that other session when it owns the tab (nothing changes then).
	 */
	async adoptIfFree(
		tabId: number,
		makeCurrent = true,
		options: { group?: boolean } = {},
	): Promise<{ id: string; label: string } | undefined> {
		const group = options.group !== false;
		let owner: { id: string; label: string } | undefined;
		await this.update((s, table) => {
			const other = Object.values(table).find((o) => o.id !== s.id && o.tabIds.includes(tabId));
			if (other) {
				owner = { id: other.id, label: other.label };
				return false;
			}
			if (!s.tabIds.includes(tabId)) {
				s.tabIds.push(tabId);
				markLoose(s, tabId, !group);
			}
			if (makeCurrent) s.currentTabId = tabId;
			if (s.released) delete s.released[tabId];
		});
		if (!owner && group && !this.state.loose?.includes(tabId)) await this.groupTab(tabId);
		return owner;
	}

	/** Release a tab without closing it. */
	async release(tabId: number, options: { clearCurrent?: boolean } = {}): Promise<void> {
		const done = touch(tabId);
		await this.update((s) => {
			s.grouped = (s.grouped ?? []).filter((id) => id !== tabId);
			markLoose(s, tabId, false);
			s.tabIds = s.tabIds.filter((id) => id !== tabId);
			// An agent that gave its current tab away picks the next page itself.
			if (options.clearCurrent && s.currentTabId === tabId) s.currentTabId = undefined;
			fixCurrent(s);
			const now = Date.now();
			const released: Record<number, number> = {};
			for (const [id, at] of Object.entries(s.released ?? {}))
				if (now - at < RELEASED_TTL_MS) released[Number(id)] = at;
			released[tabId] = now;
			s.released = released;
		});
		await detachTab(tabId, true);
		try {
			await chrome.tabs.ungroup(tabId);
		} catch {
			/* tab gone */
		}
		done();
	}

	async closeTab(tabId: number): Promise<void> {
		await this.refresh();
		if (!this.state.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by this session`);
		const done = touch(tabId);
		await this.release(tabId);
		try {
			await chrome.tabs.remove(tabId);
		} catch {
			/* already closed */
		}
		done();
	}

	/**
	 * End the session: close its tabs (`close`) or hand them to the user, and forget it. A client
	 * still holding it opens a fresh one on its next call; `notice` tells that agent why.
	 */
	async end(options: { close?: boolean; notice?: string } = {}): Promise<{ tabs: number[]; closed: boolean }> {
		await this.refresh();
		const tabs = [...this.state.tabIds];
		for (const id of tabs) {
			const done = touch(id);
			await detachTab(id, true);
			if (options.close) await chrome.tabs.remove(id).catch(() => undefined);
			else await chrome.tabs.ungroup(id).catch(() => undefined);
			done();
		}
		await mutateTable(({ table }) => {
			delete table[this.state.id];
			this.ended = true;
		});
		this.forget();
		if (options.notice) await addNotice(this.state.id, options.notice);
		return { tabs, closed: Boolean(options.close) };
	}

	/** The stored session with this id, without creating one; undefined when there is none. */
	static async existing(id: string): Promise<BrowserSession | undefined> {
		const state = await readTableLocked((table) => table[id]);
		if (!state) return undefined;
		let session = instances.get(id);
		if (session) session.state = state;
		else {
			session = new BrowserSession(state);
			instances.set(id, session);
		}
		live.add(session);
		return session;
	}

	/** Every instance in this context for `id`, so a rename or end reaches whoever holds one. */
	static instance(id: string): BrowserSession | undefined {
		return instances.get(id);
	}

	/** Make an owned tab the one tools act on. Does not focus anything. */
	async setCurrent(tabId: number): Promise<chrome.tabs.Tab> {
		await this.refresh();
		if (!this.state.tabIds.includes(tabId)) throw new Error(`Tab ${tabId} is not owned by this session`);
		const tab = await tabExists(tabId);
		if (!tab) {
			await this.reconcile();
			throw new Error(`Tab ${tabId} no longer exists`);
		}
		await this.update((s) => {
			if (s.tabIds.includes(tabId)) s.currentTabId = tabId;
		});
		return tab;
	}

	/** The tab tools act on, or undefined when the session has no tabs yet. */
	async currentTab(): Promise<chrome.tabs.Tab | undefined> {
		await this.refresh();
		if (this.state.currentTabId === undefined) return undefined;
		const tab = await tabExists(this.state.currentTabId);
		if (!tab) {
			await this.reconcile();
			return this.state.currentTabId === undefined ? undefined : await tabExists(this.state.currentTabId);
		}
		return tab;
	}

	/**
	 * Current tab for tools that need a page. An empty session does not get a blank tab
	 * conjured up (those piled up as empty tabs); the model is told to navigate first.
	 */
	async requireCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.currentTab();
		if (tab) return tab;
		throw new NoTabError();
	}

	/** Current tab with the debugger attached, for CDP-based tools. */
	async attachedCurrentTab(): Promise<chrome.tabs.Tab> {
		const tab = await this.requireCurrentTab();
		if (tab.id === undefined) throw new Error("Tab has no id");
		if (tab.url && isRestrictedUrl(tab.url)) {
			throw new Error(
				`Cannot control ${tab.url}: browser-internal pages are protected. Navigate to a website first.`,
			);
		}
		await ensureAttached(tab.id);
		return tab;
	}

	/** Owned tabs with live titles and urls. */
	async tabs(): Promise<TabInfo[]> {
		await this.reconcile();
		const out: TabInfo[] = [];
		for (const id of this.state.tabIds) {
			const tab = await tabExists(id);
			if (!tab) continue;
			out.push({
				id,
				url: tab.url ?? tab.pendingUrl ?? "",
				title: tab.title ?? "",
				current: id === this.state.currentTabId,
				favicon: tab.favIconUrl,
				inGroup: this.state.groupId !== undefined && tab.groupId === this.state.groupId,
			});
		}
		return out;
	}

	/** The one focus-changing operation: bring an owned tab to the front for the user. */
	async show(tabId?: number): Promise<void> {
		await this.refresh();
		const id = tabId ?? this.state.currentTabId;
		if (id === undefined) return;
		if (!this.state.tabIds.includes(id)) throw new Error(`Tab ${id} is not owned by this session`);
		const tab = await tabExists(id);
		if (!tab) return;
		await releaseAgentViewport(id);
		await chrome.tabs.update(id, { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });
	}

	/** Detach debuggers but keep the record, so a reconnecting client re-adopts its tabs. */
	async suspend(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id);
	}

	/** Detach debuggers and forget the session; tabs stay open for the user. */
	async close(): Promise<void> {
		for (const id of this.state.tabIds) await detachTab(id, true);
		await mutateTable(({ table }) => {
			delete table[this.state.id];
		});
		this.forget();
	}

	/**
	 * Forget the session only if its stored entry owns no tabs, decided under the lock (a
	 * client or the foreground guard may have just added one). True when it was forgotten.
	 */
	async closeIfEmpty(): Promise<boolean> {
		const closed = await mutateTable(({ table }) => {
			const stored = table[this.state.id];
			if (stored && stored.tabIds.length > 0) return false;
			delete table[this.state.id];
			return true;
		});
		if (closed) this.forget();
		return closed;
	}

	private forget(): void {
		if (instances.get(this.state.id) === this) instances.delete(this.state.id);
		live.delete(this);
	}
}

async function lastFocusedWindowId(): Promise<number> {
	try {
		const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
		if (win.id !== undefined) return win.id;
	} catch {
		/* no window */
	}
	const win = await chrome.windows.create({ url: "about:blank", focused: false, type: "normal" });
	if (win?.id === undefined) throw new Error("Failed to create a window");
	return win.id;
}
