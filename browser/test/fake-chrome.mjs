// An in-memory chrome.* for tests: async, copy-on-read storage like the real one, with random
// delays so interleavings vary. Each test that wants a fresh browser calls installFakeChrome().
// Import a module with a unique `?ctx=` query to get a separate instance of it, standing in for
// another extension context (side panel vs service worker). navigator.locks is Node's own, shared
// by every module instance in the process, as the real one is shared across extension contexts.
// Node 24 has navigator.locks; older Node (CI runs 22) gets a process-wide FIFO stand-in.
if (!globalThis.navigator?.locks) {
	// Exclusive locks only, with the parts of the API Polycarp uses: request(name, [options,]
	// callback) with ifAvailable, and query() for what is held.
	const queues = new Map();
	const held = new Map();
	const locks = {
		request(name, options, callback) {
			if (typeof options === "function") {
				callback = options;
				options = {};
			}
			if (options?.ifAvailable && (held.get(name) ?? 0) > 0) return Promise.resolve().then(() => callback(null));
			const prev = queues.get(name) ?? Promise.resolve();
			const run = prev.then(async () => {
				held.set(name, (held.get(name) ?? 0) + 1);
				try {
					return await callback({ name, mode: "exclusive" });
				} finally {
					held.set(name, held.get(name) - 1);
				}
			});
			queues.set(
				name,
				run.then(
					() => undefined,
					() => undefined,
				),
			);
			return run;
		},
		async query() {
			return { held: [...held.entries()].filter(([, n]) => n > 0).map(([name]) => ({ name, mode: "exclusive" })), pending: [] };
		},
	};
	if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
	else Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true });
}

export function installFakeChrome() {
	const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
	const store = { local: {}, session: {} };
	const tabs = new Map();
	const groups = new Map();
	let nextTab = 100;
	let nextGroup = 1;
	const win = { id: 1, type: "normal", focused: true };
	const err = (m) => {
		throw new Error(m);
	};
	const event = () => {
		const listeners = [];
		return { listeners, addListener: (fn) => listeners.push(fn), removeListener() {} };
	};
	const onChanged = event();
	// storage.onChanged deliveries held back by holdChanges(), to arrive late on release.
	let held;
	const deliver = (changes, name) => {
		for (const fn of onChanged.listeners) fn(structuredClone(changes), name);
	};
	let failQuery = false;
	let ungroupDelay = 0;
	const area = (name) => ({
		async get(keys) {
			await tick();
			const all = store[name];
			if (keys === undefined || keys === null) return structuredClone(all);
			const out = {};
			for (const k of Array.isArray(keys) ? keys : [keys]) if (k in all) out[k] = all[k];
			return structuredClone(out);
		},
		async set(obj) {
			await tick();
			const changes = {};
			for (const [k, v] of Object.entries(structuredClone(obj))) {
				changes[k] = { oldValue: store[name][k], newValue: v };
				store[name][k] = v;
			}
			if (held) held.push([changes, name]);
			else setTimeout(() => deliver(changes, name), 0);
		},
		async remove(keys) {
			await tick();
			for (const k of Array.isArray(keys) ? keys : [keys]) delete store[name][k];
		},
	});
	const detachCalls = [];
	const badge = { text: "", title: "" };
	const ports = [];
	// Events fire after the call returns, as Chrome's do. Only modules that listen see them.
	const fire = (ev, ...args) => setTimeout(() => {
		for (const fn of ev.listeners) fn(...args);
	}, 0);
	const tabEvents = { onActivated: event(), onCreated: event(), onRemoved: event(), onUpdated: event() };
	/** Chrome removes a group once its last tab leaves. */
	const dropEmptyGroup = (g) => {
		if (g !== -1 && g !== undefined && ![...tabs.values()].some((t) => t.groupId === g)) groups.delete(g);
	};
	const setGroup = (id, g) => {
		const t = tabs.get(id);
		if (!t || t.groupId === g) return;
		const before = t.groupId;
		t.groupId = g;
		dropEmptyGroup(before);
		fire(tabEvents.onUpdated, id, { groupId: g }, { ...t });
	};
	const webNavigation = {
		onCreatedNavigationTarget: event(),
		onTabReplaced: event(),
		onCommitted: event(),
		onDOMContentLoaded: event(),
		onCompleted: event(),
		onReferenceFragmentUpdated: event(),
		onHistoryStateUpdated: event(),
		onErrorOccurred: event(),
	};
	globalThis.chrome = {
		storage: { local: area("local"), session: area("session"), onChanged },
		tabs: {
			async get(id) {
				await tick();
				return tabs.has(id) ? { ...tabs.get(id) } : err(`No tab with id: ${id}`);
			},
			async query(q = {}) {
				await tick();
				if (failQuery) throw new Error("Browser is shutting down");
				return [...tabs.values()]
					.filter(
						(t) =>
							(q.groupId === undefined || t.groupId === q.groupId) &&
							(q.windowId === undefined || t.windowId === q.windowId) &&
							(q.active === undefined || t.active === q.active),
					)
					.map((t) => ({ ...t }));
			},
			async create({ url, windowId, active }) {
				await tick();
				const t = { id: nextTab++, url, windowId: windowId ?? 1, active: !!active, pinned: false, groupId: -1 };
				tabs.set(t.id, t);
				return { ...t };
			},
			async remove(ids) {
				await tick();
				for (const id of Array.isArray(ids) ? ids : [ids]) {
					const t = tabs.get(id);
					if (!t) continue;
					tabs.delete(id);
					dropEmptyGroup(t.groupId);
					fire(tabEvents.onRemoved, id, { windowId: t.windowId, isWindowClosing: false });
				}
			},
			async group({ tabIds, groupId, createProperties }) {
				await tick();
				if (groupId !== undefined && !groups.has(groupId)) err(`No group with id: ${groupId}`);
				const g = groupId ?? nextGroup++;
				if (!groups.has(g))
					groups.set(g, { id: g, windowId: createProperties?.windowId ?? 1, title: "", collapsed: false, color: "grey" });
				for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) setGroup(id, g);
				return g;
			},
			async ungroup(ids) {
				await tick();
				if (ungroupDelay) await new Promise((r) => setTimeout(r, ungroupDelay));
				for (const id of Array.isArray(ids) ? ids : [ids]) setGroup(id, -1);
			},
			async update(id, p) {
				await tick();
				Object.assign(tabs.get(id), p);
				return { ...tabs.get(id) };
			},
			async move() {
				await tick();
			},
			...tabEvents,
		},
		tabGroups: {
			async get(id) {
				await tick();
				return groups.has(id) ? { ...groups.get(id) } : err(`No group with id: ${id}`);
			},
			async query() {
				await tick();
				return [...groups.values()].map((g) => ({ ...g }));
			},
			async update(id, p) {
				await tick();
				Object.assign(groups.get(id), p);
				return { ...groups.get(id) };
			},
		},
		windows: {
			async get(id) {
				await tick();
				return id === 1 ? { ...win } : err("No window");
			},
			async getLastFocused() {
				await tick();
				return { ...win };
			},
			async getAll() {
				return [{ ...win }];
			},
			async create() {
				await tick();
				return { ...win };
			},
			async update() {
				await tick();
				return { ...win };
			},
		},
		debugger: {
			async attach() {},
			async detach(target) {
				detachCalls.push(target.tabId);
			},
			async getTargets() {
				return [];
			},
			async sendCommand() {
				return {};
			},
			onEvent: event(),
			onDetach: event(),
		},
		runtime: {
			id: "fake",
			lastError: undefined,
			getURL: (p) => p,
			getManifest: () => ({ version: "0.0.0-test" }),
			onMessage: event(),
			connectNative() {
				const port = {
					sent: [],
					postMessage(m) {
						port.sent.push(structuredClone(m));
					},
					onMessage: event(),
					onDisconnect: event(),
					disconnect() {},
					/** Deliver a host->extension message. */
					deliver(m) {
						for (const fn of port.onMessage.listeners) fn(structuredClone(m));
					},
				};
				ports.push(port);
				return port;
			},
		},
		alarms: { create() {}, onAlarm: event() },
		action: {
			onClicked: event(),
			async setBadgeText({ text }) {
				badge.text = text;
			},
			async setBadgeBackgroundColor() {},
			async setTitle({ title }) {
				badge.title = title;
			},
		},
		permissions: { async getAll() { return { permissions: [] }; } },
		webNavigation,
		sidePanel: { async getOptions() { return {}; } },
	};
	return {
		table: () => structuredClone(store.local.browser_sessions ?? {}),
		addTab: (t) => {
			const tab = { id: nextTab++, windowId: 1, active: false, pinned: false, groupId: -1, url: "https://example.com/", ...t };
			tabs.set(tab.id, tab);
			return tab.id;
		},
		removeTab: (id) => tabs.delete(id),
		/** A navigation commits in a tab's top frame (a redirect that finished late, say). */
		commitNav: (id, url) => {
			Object.assign(tabs.get(id), { url });
			fire(webNavigation.onCommitted, { tabId: id, frameId: 0, url });
		},
		/** The user closes a tab (fires onRemoved, drops an emptied group). */
		userCloseTab: (id, isWindowClosing = false) => {
			const t = tabs.get(id);
			if (!t) return;
			tabs.delete(id);
			dropEmptyGroup(t.groupId);
			fire(tabEvents.onRemoved, id, { windowId: t.windowId, isWindowClosing });
		},
		/** The user drags a tab out of its group (-1) or into a group. */
		userSetGroup: (id, g) => setGroup(id, g),
		group: (g) => (groups.has(g) ? { ...groups.get(g) } : undefined),
		hasTab: (id) => tabs.has(id),
		detachCalls,
		ports,
		/** The toolbar icon's badge text and title. */
		badge: () => ({ ...badge }),
		/** chrome.storage.session as it is now. */
		session: () => structuredClone(store.session),
		holdChanges: () => {
			held = [];
		},
		heldCount: () => held?.length ?? 0,
		/** Wipe chrome.storage.local, as clearing extension data does. */
		clearLocal: () => {
			store.local = {};
		},
		groupOf: (id) => tabs.get(id)?.groupId,
		/** Deliver the first `n` held events (all by default); later ones stay held. */
		releaseChanges: (n) => {
			const late = (held ?? []).splice(0, n ?? Number.POSITIVE_INFINITY);
			if (n === undefined) held = undefined;
			for (const [changes, name] of late) deliver(changes, name);
		},
		setFailQuery: (v) => {
			failQuery = v;
		},
		/** Make chrome.tabs.ungroup slow (Chrome refuses tab edits during a drag, for one). */
		setUngroupDelay: (ms) => {
			ungroupDelay = ms;
		},
	};
}
