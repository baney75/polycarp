// The browser_sessions table is written by two extension contexts at once: the side panel and
// the service worker (bridge, foreground guard, prune). Each `?ctx=` import below is a separate
// instance of session.ts with its own in-memory sessions, as each context has. Storage must stay
// the source of truth: no writer may put back an older copy of a session and lose a tab.
import assert from "node:assert/strict";
import test from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const load = (ctx) => import(`../src/browser/session.ts?ctx=${ctx}-${Math.random()}`);

test("first save: setLabel and rename fired together leave one record, renamed", async () => {
	let bad = 0;
	for (let run = 0; run < 30; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("panel");
		const home = fake.addTab({ active: true });
		const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
		await s.setHomeTab(home);
		await s.adopt(home, true);
		// The pattern sidepanel.ts used: both calls from one event, neither awaited.
		await Promise.all([s.setLabel("My task"), BrowserSession.rename(`tab-${home}`, "saved-1")]);
		const t = fake.table();
		if (Object.keys(t).join() !== "saved-1" || t["saved-1"].label !== "My task" || s.id !== "saved-1") bad++;
	}
	assert.equal(bad, 0, `${bad}/30 runs left a stale record, lost the label or kept the old id`);
});

test("a tab the user takes back after the first save is no longer agent-owned", async () => {
	let owned = 0;
	for (let run = 0; run < 30; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("panel");
		const home = fake.addTab({ active: true });
		const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
		await s.setHomeTab(home);
		await s.adopt(home, true);
		await Promise.all([s.setLabel("My task"), BrowserSession.rename(`tab-${home}`, "saved-1")]);
		const again = await BrowserSession.open("saved-1", "My task", 1);
		await again.setHomeTab(home);
		await again.adopt(home, false);
		await again.release(home);
		// The foreground guard in the worker decides from storage which tabs are agent-owned.
		const worker = await load("worker");
		if ((await worker.allOwnedTabIds()).has(home)) owned++;
	}
	assert.equal(owned, 0, `${owned}/30 runs: the released tab still counts as agent-owned`);
});

test("a rename in the panel is followed by a worker still holding the old id", async () => {
	let zombies = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open(`tab-${home}`, "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		// The guard opened the session under its unsaved id just before the first save.
		const w = await worker.BrowserSession.open(`tab-${home}`, "chat", 1);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		await Promise.all([panel.BrowserSession.rename(`tab-${home}`, "saved-1"), w.adopt(popup, true)]);
		const t = fake.table();
		if (Object.keys(t).join() !== "saved-1" || !t["saved-1"].tabIds.includes(popup)) zombies++;
	}
	assert.equal(zombies, 0, `${zombies}/20 runs recreated the old record or lost the popup`);
});

test("a popup the worker adopts for a panel session survives the panel's next tab and the worker's prune", async () => {
	const fake = installFakeChrome();
	const panel = await load("panel");
	const worker = await load("worker");
	const home = fake.addTab({ active: true });
	const p = await panel.BrowserSession.open("saved-1", "chat", 1);
	await p.setHomeTab(home);
	await p.adopt(home, true);
	// The foreground guard (worker) adopts a popup opened from the panel's tab.
	const popup = fake.addTab({ url: "https://example.com/popup" });
	const w = await worker.BrowserSession.open("saved-1", "chat", 1);
	await w.adopt(popup, true);
	// The panel's agent opens a new tab, then the worker's periodic prune runs.
	const created = await p.createTab("https://example.com/next");
	const afterCreate = fake.table()["saved-1"].tabIds;
	await worker.pruneSessions(new Set());
	const afterPrune = fake.table()["saved-1"].tabIds;
	assert.ok(afterCreate.includes(popup), `popup lost by the panel's createTab: ${afterCreate}`);
	assert.ok(afterPrune.includes(created.id), `panel's tab lost by the worker's prune: ${afterPrune}`);
	assert.ok(afterPrune.includes(popup), `popup lost by the worker's prune: ${afterPrune}`);
});

test("panel and worker adding tabs to one session at once keep both, in one group", async () => {
	let lost = 0;
	let split = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		const w = await worker.BrowserSession.open("saved-1", "chat", 1);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		const [created] = await Promise.all([p.createTab("https://example.com/next"), w.adopt(popup, true)]);
		const stored = fake.table()["saved-1"];
		if (!stored.tabIds.includes(popup) || !stored.tabIds.includes(created.id)) lost++;
		// Both tabs end up in the one group the session records, not one group each.
		if (fake.groupOf(popup) !== stored.groupId || fake.groupOf(created.id) !== stored.groupId) split++;
	}
	assert.equal(lost, 0, `${lost}/20 runs lost one of the two tabs`);
	assert.equal(split, 0, `${split}/20 runs left the tabs in two groups`);
});

test("two bridge sessions creating tabs at once both keep their tabs", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("worker");
		const a = await BrowserSession.open("bridge-claude-a", "claude", 1);
		const b = await BrowserSession.open("bridge-codex-b", "codex", 1);
		const [ta, tb] = await Promise.all([a.createTab("https://a.example/"), b.createTab("https://b.example/")]);
		const t = fake.table();
		if (!t["bridge-claude-a"]?.tabIds.includes(ta.id) || !t["bridge-codex-b"]?.tabIds.includes(tb.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs lost a session's new tab from storage`);
});

test("prune running while the panel opens a tab does not drop that tab", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		// Start the prune at a random point inside createTab.
		const prune = new Promise((r) => setTimeout(r, Math.random() * 20)).then(() => worker.pruneSessions(new Set()));
		const [created] = await Promise.all([p.createTab("https://example.com/next"), prune]);
		if (!fake.table()["saved-1"]?.tabIds.includes(created.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs: prune dropped a tab created while it ran`);
});

test("prune still drops closed tabs and forgets abandoned bridge sessions", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const a = await BrowserSession.open("bridge-claude-a", "claude", 1);
	const tab = await a.createTab("https://a.example/");
	const blank = await a.createTab();
	const b = await BrowserSession.open("bridge-codex-b", "codex", 1);
	const gone = await b.createTab("https://b.example/");
	fake.removeTab(gone.id);
	const result = await pruneSessions(new Set());
	const t = fake.table();
	assert.deepEqual(t["bridge-claude-a"].tabIds, [tab.id], "blank tab of an abandoned session closed");
	assert.equal(fake.hasTab(blank.id), false);
	assert.equal(t["bridge-codex-b"], undefined, "session left with no tabs is forgotten");
	assert.deepEqual(result, { dropped: 1, closedTabs: 1 });
});

test("forgetting an empty session does not drop a tab a client added meanwhile", async () => {
	let lost = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const { BrowserSession } = await load("worker");
		const client = await BrowserSession.open("bridge-claude-abc", "claude", 1);
		// dropEmptyBridgeSessions on worker start, while the reconnected client opens a tab.
		const drop = (async () => {
			const s = await BrowserSession.open("bridge-claude-abc", "claude", 1);
			if (s.closeIfEmpty) await s.closeIfEmpty();
			else await s.close();
		})();
		const [, created] = await Promise.all([drop, client.createTab("https://a.example/")]);
		if (!fake.table()["bridge-claude-abc"]?.tabIds.includes(created.id)) lost++;
	}
	assert.equal(lost, 0, `${lost}/20 runs forgot the session after the client's tab was recorded`);
});

test("a late storage event does not roll back a context's cache", async () => {
	const fake = installFakeChrome();
	const panel = await load("panel");
	const worker = await load("worker");
	const home = fake.addTab({ active: true });
	const p = await panel.BrowserSession.open("saved-1", "chat", 1);
	await p.setHomeTab(home);
	await p.adopt(home, true);
	await new Promise((r) => setTimeout(r, 10));
	fake.holdChanges();
	const popup = fake.addTab({ url: "https://example.com/popup" });
	const w = await worker.BrowserSession.open("saved-1", "chat", 1);
	await w.adopt(popup, true);
	const workerWrites = fake.heldCount();
	const created = await p.createTab("https://example.com/next");
	// The worker's older writes reach the panel only now, before the panel's own.
	fake.releaseChanges(workerWrites);
	assert.ok(p.tabIds.includes(created.id), `panel cache rolled back to an older table: ${p.tabIds}`);
	assert.ok(p.tabIds.includes(popup), `panel cache misses the worker's popup: ${p.tabIds}`);
	fake.releaseChanges();
	await new Promise((r) => setTimeout(r, 10));
	// And the worker's cache picks up the panel's tab from the panel's write.
	assert.ok(w.tabIds.includes(created.id), `worker cache misses the panel's tab: ${w.tabIds}`);
});

test("prune leaves the table alone when the tab list can't be read", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const home = fake.addTab({ active: true });
	const p = await BrowserSession.open("saved-1", "chat", 1);
	await p.setHomeTab(home);
	await p.adopt(home, true);
	const b = await BrowserSession.open("bridge-claude-a", "claude", 1);
	await b.createTab("https://a.example/");
	const before = fake.table();
	fake.setFailQuery(true);
	await pruneSessions(new Set()).catch(() => undefined);
	fake.setFailQuery(false);
	assert.deepEqual(Object.keys(fake.table()).sort(), Object.keys(before).sort(), "sessions were dropped");
	assert.deepEqual(fake.table()["saved-1"].tabIds, before["saved-1"].tabIds);
	assert.deepEqual(fake.table()["bridge-claude-a"].tabIds, before["bridge-claude-a"].tabIds);
});

test("a session a client holds stays current after prune forgets its empty record", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const held = await BrowserSession.open("bridge-claude-abc", "claude", 1);
	const owner = fake.addTab({ url: "https://a.example/" });
	await pruneSessions(new Set());
	// The client's next call opens a tab; then the guard adopts a popup through open().
	await held.adopt(owner, true);
	const popup = fake.addTab({ url: "https://a.example/popup" });
	const guard = await BrowserSession.open("bridge-claude-abc", "claude", 1);
	await guard.adopt(popup, true);
	assert.ok(held.tabIds.includes(popup), `the client's session misses the popup: ${held.tabIds}`);
	assert.equal(held.currentTabId, popup);
});

test("the foreground guard adopting a popup during the first-save rename lands in the saved chat", async () => {
	let bad = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		// The guard runs in the worker; its session.ts import is the worker's module instance.
		const guard = await import(`../src/browser/foreground-guard.ts?ctx=${Math.random()}`);
		guard.startForegroundGuard();
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open(`tab-${home}`, "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		const popup = fake.addTab({ url: "https://example.com/popup" });
		for (const fn of chrome.webNavigation.onCreatedNavigationTarget.listeners) fn({ tabId: popup, sourceTabId: home });
		await new Promise((r) => setTimeout(r, Math.random() * 15));
		await panel.BrowserSession.rename(`tab-${home}`, "saved-1");
		for (let i = 0; i < 200 && !fake.table()["saved-1"]?.tabIds.includes(popup); i++)
			await new Promise((r) => setTimeout(r, 5));
		await new Promise((r) => setTimeout(r, 30));
		const t = fake.table();
		if (Object.keys(t).join() !== "saved-1" || !t["saved-1"].tabIds.includes(popup)) bad++;
	}
	assert.equal(bad, 0, `${bad}/20 runs recreated the old record or lost the popup`);
});

test("a new chat reusing a renamed id never follows the old rename into the saved chat", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const home = fake.addTab({ active: true });
	const a = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await a.setHomeTab(home);
	await a.adopt(home, true);
	await BrowserSession.rename(`tab-${home}`, "saved-1");
	// New chat on the same tab: a fresh session under the same unsaved id, empty at first.
	const other = await load("panel2");
	const b = await other.BrowserSession.open(`tab-${home}`, "chat", 1);
	// Another panel's startup cleanup forgets it before its first tab.
	const cleaner = (await load("panel3")).BrowserSession;
	if (cleaner.dropIfEmpty) await cleaner.dropIfEmpty(`tab-${home}`);
	else await (await cleaner.open(`tab-${home}`, "chat", 1)).closeIfEmpty();
	const tab = fake.addTab({ url: "https://b.example/" });
	await b.adopt(tab, true);
	const t = fake.table();
	assert.equal(b.id, `tab-${home}`, "chat B was rebound to the saved chat's id");
	assert.ok(!t["saved-1"].tabIds.includes(tab), "chat B's tab went into chat A's session");
	assert.ok(t[`tab-${home}`]?.tabIds.includes(tab));
});

test("a tab the user takes back stays theirs while another context reconciles", async () => {
	let bad = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const home = fake.addTab({ active: true });
		const p = await panel.BrowserSession.open("saved-1", "chat", 1);
		await p.setHomeTab(home);
		await p.adopt(home, true);
		await p.createTab("https://example.com/agent");
		fake.setUngroupDelay(40);
		const reconcile = new Promise((r) => setTimeout(r, 5 + Math.random() * 15)).then(() =>
			worker.BrowserSession.open("saved-1", "chat", 1),
		);
		await Promise.all([p.release(home), reconcile]);
		// Any later reconcile must not take it back either.
		await (await worker.BrowserSession.open("saved-1", "chat", 1)).tabs();
		if (fake.table()["saved-1"].tabIds.includes(home) || fake.groupOf(home) !== -1) bad++;
	}
	assert.equal(bad, 0, `${bad}/20 runs: the released tab went back to the agent`);
});

test("dropping an empty record leaves the instance a client holds registered", async () => {
	installFakeChrome();
	const { BrowserSession } = await load("worker");
	const held = await BrowserSession.open("bridge-claude-abc", "claude", 1);
	if (BrowserSession.dropIfEmpty) await BrowserSession.dropIfEmpty("bridge-claude-abc");
	else await (await BrowserSession.open("bridge-claude-abc", "claude", 1)).closeIfEmpty();
	assert.equal(await BrowserSession.open("bridge-claude-abc", "claude", 1), held);
});

test("caches keep following writes after extension storage is cleared", async () => {
	const fake = installFakeChrome();
	const panel = await load("panel");
	const worker = await load("worker");
	const p = await panel.BrowserSession.open("saved-1", "chat", 1);
	for (let i = 0; i < 5; i++) await p.adopt(fake.addTab({}), true);
	fake.clearLocal();
	const w = await worker.BrowserSession.open("saved-1", "chat", 1);
	const tab = fake.addTab({});
	await w.adopt(tab, true);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(p.tabIds.includes(tab), `panel cache stopped following after the wipe: ${p.tabIds}`);
});

test("adoptIfFree: a tab another session took first stays with it, even when both race", async () => {
	let taken = 0;
	for (let run = 0; run < 20; run++) {
		const fake = installFakeChrome();
		const panel = await load("panel");
		const worker = await load("worker");
		const tab = fake.addTab({ active: false });
		const chat = await panel.BrowserSession.open("chat-1", "chat", 1);
		const agent = await worker.BrowserSession.open("bridge-claude", "Claude Code", 1);
		// The bridge agent claims the tab while the panel resolves a reference to it.
		const [, owner] = await Promise.all([agent.adopt(tab, true), chat.adoptIfFree(tab, true)]);
		const t = fake.table();
		const chatHas = t["chat-1"].tabIds.includes(tab);
		const agentHas = t["bridge-claude"].tabIds.includes(tab);
		// Whichever lands first, the agent ends up with the tab: its adopt takes it from the chat,
		// and the chat's adoptIfFree never takes it from the agent. (Plain adopt would, when second.)
		if (!agentHas || chatHas) taken++;
		if (owner !== undefined && owner.id !== "bridge-claude") taken++;
	}
	assert.equal(taken, 0, `${taken}/20 runs: the tab was shared twice, lost, or taken from the agent`);
});

test("adoptIfFree takes an unowned tab and makes it current", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const tab = fake.addTab({ active: false });
	const chat = await BrowserSession.open("chat-2", "chat", 1);
	assert.equal(await chat.adoptIfFree(tab, true), undefined);
	assert.deepEqual(fake.table()["chat-2"].tabIds, [tab]);
	assert.equal(fake.table()["chat-2"].currentTabId, tab);
	const other = await BrowserSession.open("chat-3", "other", 1);
	assert.deepEqual(await other.adoptIfFree(tab, true), { id: "chat-2", label: "chat" });
	assert.deepEqual(fake.table()["chat-2"].tabIds, [tab], "the first chat keeps it");
	assert.deepEqual(fake.table()["chat-3"].tabIds, []);
});

// ---- agent sessions and their tab groups (bridge sessions; ids start with "bridge-") ----

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("an agent session stores who and what it serves, and when it began", async () => {
	installFakeChrome();
	const { BrowserSession } = await load("worker");
	const before = Date.now();
	const s = await BrowserSession.open("bridge-claude-shop-1a2b", "claude · shop", 1, { agent: "claude", project: "shop", name: "shop-1a2b" });
	assert.equal(s.record.agent, "claude");
	assert.equal(s.record.project, "shop");
	assert.equal(s.record.name, "shop-1a2b");
	assert.ok(s.record.createdAt >= before);
	assert.equal(s.groupName, "Tabkyra · claude · shop");
	await s.createTab("https://example.com/");
	assert.equal(s.record.createdAt, (await BrowserSession.open("bridge-claude-shop-1a2b", "claude · shop")).record.createdAt, "a resumed session keeps its start time");
});

test("labels an agent picks are plain text: no controls, no bidi, no Tabkyra prefix, 32 characters", async () => {
	installFakeChrome();
	const { sanitizeLabel, BrowserSession } = await load("worker");
	assert.equal(sanitizeLabel("  Flight\n\tsearch  "), "Flight search");
	assert.equal(sanitizeLabel("Tabkyra · claude · bank"), "claude · bank");
	assert.equal(sanitizeLabel("evil‮gnp.exe"), "evilgnp.exe");
	assert.equal(sanitizeLabel("x".repeat(80)).length, 32);
	const s = await BrowserSession.open("bridge-claude-x", "claude · x", 1);
	await s.createTab("https://example.com/");
	assert.equal(await s.setAgentLabel("Tabkyra: \u0007Shop"), "Tabkyra · claude · x · Shop");
});

test("an agent session holds at most 15 tabs, and the 16th is refused with what to do", async () => {
	installFakeChrome();
	const { BrowserSession, MAX_SESSION_TABS, TabLimitError } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-cap", "claude", 1);
	for (let i = 0; i < MAX_SESSION_TABS; i++) await s.createTab(`https://example.com/${i}`, { capped: true });
	await assert.rejects(() => s.createTab("https://example.com/x", { capped: true }), (err) => err instanceof TabLimitError && /tabs_close/.test(err.message));
	assert.equal(s.tabIds.length, MAX_SESSION_TABS);
});

test("two clients sharing a session can't open past the cap at once", async () => {
	installFakeChrome();
	const { BrowserSession, MAX_SESSION_TABS } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-cap2", "claude", 1);
	for (let i = 0; i < MAX_SESSION_TABS - 1; i++) await s.createTab(`https://example.com/${i}`, { capped: true });
	const both = await Promise.allSettled([s.createTab("https://example.com/x", { capped: true }), s.createTab("https://example.com/y", { capped: true })]);
	assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
	assert.equal(s.tabIds.length, MAX_SESSION_TABS);
});

test("a tab the user drags out of an agent's group becomes theirs, and the agent is told", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, takeNotices } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-out", "claude", 1);
	const a = (await s.createTab("https://example.com/a")).id;
	const b = (await s.createTab("https://example.com/b")).id;
	assert.equal(s.currentTabId, b);
	// The worker slept through the drag: reconcile is what notices.
	fake.userSetGroup(b, -1);
	await settle();
	await s.reconcile();
	assert.deepEqual(s.tabIds, [a]);
	assert.equal(fake.groupOf(b), -1, "the tab was pulled back into the group");
	assert.equal(s.currentTabId, undefined, "the agent was moved onto another page it didn't choose");
	const [notice] = await takeNotices(s.id);
	assert.match(notice, /The user took tab \d+ .* out of your group; it's theirs now/);
	// Taken means taken: a later reconcile doesn't re-adopt it.
	await s.reconcile();
	assert.deepEqual(s.tabIds, [a]);
});

test("a new tab still on its way into the group is grouped, not handed to the user", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-new", "claude", 1);
	await s.createTab("https://example.com/a");
	// A tab adopted but never seen in the group (grouping failed or hasn't run).
	const loose = fake.addTab({ url: "https://example.com/loose" });
	await s.adopt(loose, false);
	fake.userSetGroup(loose, -1);
	await settle();
	// It was grouped once by adopt; a tab that never made it in is put back.
	const never = fake.addTab({ url: "https://example.com/never" });
	await BrowserSession.open("bridge-claude-new", "claude");
	const table = fake.table();
	table["bridge-claude-new"].tabIds.push(never);
	await chrome.storage.local.set({ browser_sessions: table });
	await s.reconcile();
	assert.ok(s.tabIds.includes(never));
	assert.notEqual(fake.groupOf(never), -1, "a tab that never made it into the group must be grouped");
});

test("a tab the user drags into an agent's group is the agent's", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, takeNotices } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-in", "claude", 1);
	await s.createTab("https://example.com/a");
	const mine = fake.addTab({ url: "https://example.com/user" });
	fake.userSetGroup(mine, fake.table()["bridge-claude-in"].groupId);
	await settle();
	await s.userGave(mine, await chrome.tabs.get(mine));
	assert.ok(s.tabIds.includes(mine));
	assert.match((await takeNotices(s.id))[0], /The user gave you tab \d+/);
});

test("ending a session hands its tabs to the user or closes them, and forgets it", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, takeNotices } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-end", "claude", 1);
	const a = (await s.createTab("https://example.com/a")).id;
	const r = await s.end({ notice: "ended by test" });
	assert.deepEqual(r, { tabs: [a], closed: false });
	assert.equal(s.ended, true);
	assert.equal(fake.table()["bridge-claude-end"], undefined);
	assert.ok(fake.hasTab(a), "handing over must not close the tab");
	assert.equal(fake.groupOf(a), -1);
	assert.deepEqual(await takeNotices("bridge-claude-end"), ["ended by test"]);
	const t = await BrowserSession.open("bridge-claude-end2", "claude", 1);
	const b = (await t.createTab("https://example.com/b")).id;
	await t.end({ close: true });
	assert.equal(fake.hasTab(b), false);
});

test("a write still in flight when a session ends doesn't bring it back with the user's tabs", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-late", "claude", 1);
	const a = (await s.createTab("https://example.com/a")).id;
	const reading = s.tabs();
	await s.end();
	await reading.catch(() => undefined);
	// A request that held this instance before the end writes after it.
	await s.setAgentLabel("late");
	assert.equal(fake.table()["bridge-claude-late"], undefined, "the ended session's record came back");
	const again = await BrowserSession.open("bridge-claude-late", "claude", 1);
	assert.deepEqual(again.tabIds, [], "the next call got the tabs handed to the user");
	assert.ok(fake.hasTab(a));
});

test("a tab still in its group isn't handed to the user when another record claims that group", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, takeNotices } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-claim", "claude", 1);
	const a = (await s.createTab("https://example.com/a")).id;
	await s.tabs();
	const groupId = fake.groupOf(a);
	assert.notEqual(groupId, -1);
	const table = fake.table();
	table["bridge-claude-other"] = { ...table["bridge-claude-claim"], id: "bridge-claude-other", tabIds: [], grouped: [] };
	await chrome.storage.local.set({ browser_sessions: table });
	await s.tabs();
	assert.ok(s.tabIds.includes(a), "a tab nobody moved was handed to the user");
	assert.deepEqual(await takeNotices("bridge-claude-claim"), []);
});

test("when a new tab can't join the agent's group it waits outside, without splitting the group or handing tabs over", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, takeNotices } = await load("worker");
	const s = await BrowserSession.open("bridge-claude-split", "claude", 1);
	const a = (await s.createTab("https://example.com/a")).id;
	const b = (await s.createTab("https://example.com/b")).id;
	await s.tabs();
	const groupId = fake.groupOf(a);
	// The user holds a tab drag: joining an existing group fails for a while.
	const group = chrome.tabs.group;
	chrome.tabs.group = async (opts) => {
		if (opts.groupId !== undefined) throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
		return group(opts);
	};
	let c;
	try {
		c = (await s.createTab("https://example.com/c")).id;
		await s.tabs();
	} finally {
		chrome.tabs.group = group;
	}
	assert.deepEqual([fake.groupOf(a), fake.groupOf(b)], [groupId, groupId], "the agent's tabs left their group");
	assert.deepEqual([...s.tabIds].sort(), [a, b, c].sort(), "tabs nobody moved were handed to the user");
	assert.deepEqual(await takeNotices("bridge-claude-split"), []);
	// The drag is over: the next look puts the new tab in the group.
	await s.tabs();
	assert.equal(fake.groupOf(c), groupId);
});

// Owner, 2026-10-28: "groups keep auto forming even when i dont request it". A side panel chat's
// tab the user takes out of the group stays out; the chat keeps using it (no hand-off notice:
// that rule is for agent sessions).
test("a side panel chat's tab that leaves its group stays out, and the chat keeps it", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const home = fake.addTab({ active: true });
	const s = await BrowserSession.open("saved-chat", "chat", 1);
	await s.adopt(home, true);
	const other = (await s.createTab("https://example.com/x")).id;
	fake.userSetGroup(other, -1);
	await settle();
	await s.reconcile();
	assert.ok(s.tabIds.includes(other));
	assert.equal(fake.groupOf(other), -1);
});

test("an idle agent group collapses; one in use, or one the user is looking at, doesn't", async () => {
	const fake = installFakeChrome();
	const { BrowserSession, pruneSessions } = await load("worker");
	const idle = await BrowserSession.open("bridge-claude-idle", "claude · idle", 1);
	await idle.createTab("https://example.com/idle");
	const live = await BrowserSession.open("bridge-claude-live", "claude · live", 1);
	await live.createTab("https://example.com/live");
	const watched = await BrowserSession.open("bridge-claude-watched", "claude · watched", 1);
	const w = (await watched.createTab("https://example.com/watched")).id;
	await chrome.tabs.update(w, { active: true });
	await pruneSessions(new Set(["bridge-claude-live"]), 0);
	const t = fake.table();
	assert.equal(fake.group(t["bridge-claude-idle"].groupId).collapsed, true);
	assert.equal(fake.group(t["bridge-claude-live"].groupId).collapsed, false, "a connected agent's group was folded");
	assert.equal(fake.group(t["bridge-claude-watched"].groupId).collapsed, false, "the group the user is looking at was folded");
});

test("tabs the user shares stay out of any group; only tabs the agent opens are grouped", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	// The tab the panel opened on, and a tab in front when the user sent a message.
	const home = fake.addTab({ active: true, url: "https://mail.example/" });
	const other = fake.addTab({ url: "https://news.example/" });
	const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await s.setHomeTab(home);
	await s.adopt(home, true, { group: false });
	assert.equal(await s.adoptIfFree(other, true, { group: false }), undefined);
	assert.equal(fake.groupOf(home), -1, "the panel's own tab was put in a group");
	assert.equal(fake.groupOf(other), -1, "the shared tab was put in a group");
	assert.deepEqual(s.tabIds.sort(), [home, other].sort(), "the agent can use both");
	// Reconcile (run on every tool call) must not pull them into a group later.
	await s.reconcile();
	assert.equal(fake.groupOf(home), -1, "reconcile grouped the user's tab");
	assert.equal(fake.groupOf(other), -1, "reconcile grouped the user's tab");
	// A tab the agent opens itself is grouped, as before.
	const opened = await s.createTab("https://shop.example/");
	assert.notEqual(fake.groupOf(opened.id), -1, "the agent's own tab is not grouped");
	// The user drags a shared tab into the agent's group: from then on it is grouped like the rest.
	fake.userSetGroup(other, fake.groupOf(opened.id));
	await s.reconcile();
	assert.equal(s.isLoose(other), false);
	assert.equal(s.isLoose(home), true);
	// Released tabs leave the loose list too.
	await s.release(home);
	assert.equal(s.isLoose(home), false);
});

test("a panel tab the user takes out of the group stays out, and the agent keeps using it", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const home = fake.addTab({ active: true, url: "https://mail.example/" });
	const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await s.adopt(home, true); // what earlier versions did: grouped
	assert.notEqual(fake.groupOf(home), -1);
	fake.userSetGroup(home, -1); // the user ungroups it
	await s.reconcile();
	assert.equal(fake.groupOf(home), -1, "reconcile put it back in a group");
	assert.ok(s.tabIds.includes(home), "the agent lost access to it");
	await s.reconcile();
	assert.equal(fake.groupOf(home), -1, "a later reconcile put it back");
});

test("the agent's own grouped tab stays grouped when the user references it", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await load("panel");
	const home = fake.addTab({ active: true, url: "https://mail.example/" });
	const s = await BrowserSession.open(`tab-${home}`, "chat", 1);
	await s.adopt(home, true, { group: false });
	const opened = await s.createTab("https://shop.example/");
	const g = fake.groupOf(opened.id);
	assert.notEqual(g, -1);
	// "@" reference or the tab in front on send: both adopt with { group: false }.
	assert.equal(await s.adoptIfFree(opened.id, true, { group: false }), undefined);
	await s.adopt(opened.id, false, { group: false });
	await s.reconcile();
	assert.equal(fake.groupOf(opened.id), g, "the agent's tab left its group");
	assert.equal(s.isLoose(opened.id), false);
});
