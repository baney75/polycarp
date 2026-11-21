// The side panel's display helpers: readable model and provider names, prices that stay
// prices, how the active tab reaches the agent, and the starter chips.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { escapeCurrency } from "../src/transcript/currency.ts";
import { modelDisplayName, modelLabelParts, providerDisplayName } from "../src/models/display.ts";
import { installFakeChrome } from "./fake-chrome.mjs";

test("a discovered model whose name is its id gets a readable name", () => {
	assert.equal(modelDisplayName({ id: "deepseek/deepseek-v4.1-flash-1017", name: "deepseek/deepseek-v4.1-flash-1017" }), "DeepSeek V4.1 Flash");
	assert.equal(modelDisplayName({ id: "qwen3-8b-nothink" }), "Qwen3 8B Nothink");
	assert.equal(modelDisplayName({ id: "gpt-4o-mini-2024-07-18" }), "GPT-4o Mini");
	assert.equal(modelDisplayName({ id: "claude-3-5-haiku-20241022" }), "Claude 3 5 Haiku");
	assert.equal(modelDisplayName({ id: "o4-mini" }), "o4 Mini");
	assert.equal(modelDisplayName({ id: "meta-llama/llama-3.3-70b-instruct:free" }), "Llama 3.3 70B Instruct (free)");
});

test("a curated name wins, without the vendor prefix the provider already names", () => {
	assert.equal(modelDisplayName({ id: "deepseek/deepseek-chat", name: "DeepSeek: DeepSeek V3" }), "DeepSeek V3");
	assert.equal(modelDisplayName({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }), "Claude Haiku 4.5");
});

test("provider names: known ones spelled right, custom ones kept as typed", () => {
	assert.equal(providerDisplayName("openrouter"), "OpenRouter");
	assert.equal(providerDisplayName("xai"), "xAI");
	assert.equal(providerDisplayName("vercel-ai-gateway"), "Vercel AI Gateway");
	assert.equal(providerDisplayName("Local"), "Local");
	assert.equal(providerDisplayName("My LM Box"), "My LM Box");
	assert.equal(providerDisplayName("some-new-cloud"), "Some New Cloud");
});

test("the composer's label keeps the full id in its tooltip", () => {
	const parts = modelLabelParts({ id: "deepseek/deepseek-v4.1-flash-1017", name: "deepseek/deepseek-v4.1-flash-1017", provider: "openrouter" });
	assert.equal(parts.name, "DeepSeek V4.1 Flash");
	assert.equal(parts.provider, "OpenRouter");
	assert.match(parts.title, /OpenRouter · deepseek\/deepseek-v4\.1-flash-1017/);
});

test("dollar amounts are escaped so they render as prices, math and code are not", () => {
	assert.equal(
		escapeCurrency("The C3 is $89, a hand grinder; the Opus is $4 less."),
		"The C3 is \\$89, a hand grinder; the Opus is \\$4 less.",
	);
	assert.equal(escapeCurrency("From $1,299.99 to $2.5M."), "From \\$1,299.99 to \\$2.5M.");
	assert.equal(escapeCurrency("Euler: $2^{10}$ and $3x+1$"), "Euler: $2^{10}$ and $3x+1$");
	assert.equal(escapeCurrency("Run `echo $5` then\n```\nprice=$9\n```\nok $7"), "Run `echo $5` then\n```\nprice=$9\n```\nok \\$7");
	assert.equal(escapeCurrency("already \\$5 and $$x$$"), "already \\$5 and $$x$$");
});

test("the tab the user is looking at goes to the agent with their message, no button needed", async () => {
	const fake = installFakeChrome();
	const { shareActiveTab, tabToShare } = await import(`../src/browser/share-tab.ts?${Math.random()}`);
	const task = fake.addTab({ url: "https://shop.example/" });
	const other = fake.addTab({ active: true, url: "https://news.example/" });
	const adopted = [];
	const session = (heldBy) => ({
		tabIds: [task],
		adoptIfFree: async (id, makeCurrent) => {
			if (heldBy) return { id: "bridge-x", label: heldBy };
			adopted.push([id, makeCurrent]);
		},
	});
	// Sending from another tab hands that tab over and makes it the agent's page.
	assert.deepEqual(await shareActiveTab(session(), 1, true), { tabId: other });
	assert.deepEqual(adopted, [[other, true]]);
	// "Send now" mid-run adds it without swapping the run's page.
	await shareActiveTab(session(), 1, false);
	assert.deepEqual(adopted.at(-1), [other, false]);
	// A tab another agent is driving stays with it.
	assert.deepEqual(await shareActiveTab(session("claude · shop"), 1, true), { tabId: other, heldBy: "claude · shop" });
	// The agent's own tab in front: nothing to do.
	assert.equal(await tabToShare(1, [task, other]), undefined);
	// Browser pages never go to the agent; a blank new tab does.
	for (const [url, shared] of [
		["chrome://settings/", false],
		["chrome-extension://abc/sidepanel.html", false],
		["https://chromewebstore.google.com/detail/x", false],
		["chrome://newtab/", true],
		["about:blank", true],
	]) {
		const f = installFakeChrome();
		const id = f.addTab({ active: true, url });
		assert.equal(await tabToShare(1, []), shared ? id : undefined, url);
	}
	assert.equal(await tabToShare(undefined, []), undefined);
});

test("a message sent mid-run queues, so the tab joins without becoming the run's page", () => {
	const src = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	const hook = src.slice(src.indexOf("onBeforeSend: async"), src.indexOf("steerContext: async"));
	assert.match(hook, /shareActiveTabOnSend\(agent\?\.state\.isStreaming !== true\)/);
	const steer = src.slice(src.indexOf("steerContext: async"), src.indexOf("onCostClick"));
	assert.match(steer, /shareActiveTabOnSend\(false\)/);
});

test("the header has no always-on share button, and every icon button has a tooltip", () => {
	const src = readFileSync(new URL("../src/sidepanel.ts", import.meta.url), "utf8");
	const header = src.slice(src.indexOf("const renderApp = () => {"), src.indexOf("${updateNotice()}"));
	// No share control at all: the active tab goes with the message.
	assert.doesNotMatch(header, /Share this tab|data-share-tab/);
	assert.doesNotMatch(header, /icon\(Link/);
	for (const call of header.matchAll(/headerButton\("([^"]+)"/g)) assert.ok(call[1].length > 2, `empty label: ${call[0]}`);
	assert.match(src, /function headerButton[\s\S]*?aria-label=\$\{label\} data-tip=\$\{label\}/);
});

test("starter chips: four, each a task that runs, none of the old odd ones", async () => {
	const { starters } = await import("../src/tutorials.ts");
	assert.deepEqual(
		starters.map((s) => s.label),
		["Summarize page", "Research a topic", "Fill a form", "Compare tabs"],
	);
	for (const s of starters) {
		assert.ok(s.prompt.length > 20 && s.hint && s.icon, s.label);
		assert.ok(s.mode === "send" || s.mode === "compose", s.label);
	}
	// "Compare tabs" ends in "@" so the composer opens its tab menu.
	assert.match(starters.find((s) => s.label === "Compare tabs").prompt, /@$/);
});

test("pages that paint the theme background also set the theme text color, so dialogs on <body> stay readable", () => {
	// Dialogs mount on <body>, outside the panel's own text-foreground wrapper. Without a body
	// color, unstyled text fell back to black: near-invisible on the dark theme's ink.
	for (const page of ["static/sidepanel.html", "static/debug.html"]) {
		const body = readFileSync(new URL(`../${page}`, import.meta.url), "utf8").match(/<body class="([^"]*)"/)?.[1] ?? "";
		assert.match(body, /\bbg-background\b/, page);
		assert.match(body, /\btext-foreground\b/, page);
	}
});

test("the Claude and Gemini MCP setup commands render as readable command blocks with a copy button", () => {
	const source = readFileSync(new URL("../src/subscriptions/SubscriptionsSection.ts", import.meta.url), "utf8");
	assert.match(source, /this\.command\("Claude Code", cliMcpSetup\("claude", hostCommand\(\)\)\)/);
	assert.match(source, /this\.command\("Gemini CLI", cliMcpSetup\("gemini", hostCommand\(\)\)\)/);
	const block = source.slice(source.indexOf("private command("), source.indexOf("private row("));
	// The look is shared with Settings > Connect (src/components/command-box.ts): it wraps anywhere, so a long command can't run off the panel.
	assert.match(block, /<code class=\$\{COMMAND_BOX_CLASS\}>/);
	const codeClass = readFileSync(new URL("../src/components/command-box.ts", import.meta.url), "utf8").match(/COMMAND_BOX_CLASS =\s*"([^"]*)"/)?.[1] ?? "";
	assert.match(codeClass, /\btext-foreground\b/);
	assert.match(codeClass, /\bfont-mono\b/);
	assert.match(codeClass, /\[overflow-wrap:anywhere\]/);
	assert.match(block, /@click=\$\{\(\) => this\.copy\(text\)\}/);
});

test("settings tabs sit in an even grid until one row fits, so no tab is left alone on a line", () => {
	const patch = readFileSync(new URL("../patches/pi-mono.patch", import.meta.url), "utf8");
	const dialog = patch.slice(patch.indexOf("b/packages/web-ui/src/dialogs/SettingsDialog.ts"));
	assert.match(dialog, /\+\s*<div class="@container md:hidden/);
	assert.match(dialog, /\+\s*class="grid gap-1 @\[28rem\]:flex @\[28rem\]:flex-wrap"/);
	assert.match(dialog, /grid-template-columns: repeat\(\$\{this\.tabs\.length > 3 \? Math\.ceil\(this\.tabs\.length \/ 2\) : this\.tabs\.length\}/);
});

test("native controls follow the theme: dark mode declares color-scheme dark", () => {
	const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
	const dark = css.slice(css.indexOf(".dark {"), css.indexOf("}", css.indexOf(".dark {")));
	assert.match(dark, /color-scheme: dark;/);
	assert.match(dark, /accent-color: var\(--tk-brass\);/);
});

test("Settings > Providers reads top to bottom: Free mode, API keys with their search and list, subscriptions, custom providers", () => {
	const tab = readFileSync(new URL("../src/dialogs/ApiKeysTab.ts", import.meta.url), "utf8");
	const order = ["Free mode: use the best free model", ">API keys</h3>", 'placeholder="Find a provider"', "<tabkyra-provider-key", "<tabkyra-subscriptions>", "${this.custom}"].map((s) => tab.indexOf(s));
	assert.ok(order.every((i) => i > 0), JSON.stringify(order));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("subscription commands are copyable blocks, and a failed copy is a toast that can't overwrite or outlive the section's notice", () => {
	const source = readFileSync(new URL("../src/subscriptions/SubscriptionsSection.ts", import.meta.url), "utf8");
	assert.match(source, /this\.command\("Install the Copilot SDK", `\$\{hostCommand\(\)\} copilot-sdk install`\)/);
	assert.match(source, /this\.command\("Set up Polycarp", `\$\{hostCommand\(\)\} setup`\)/);
	assert.doesNotMatch(source, /run <code>/, "no bare inline commands left");
	const copy = source.slice(source.indexOf("private copy("), source.indexOf("private command("));
	assert.match(copy, /Toast\.error\(/);
	assert.doesNotMatch(copy, /this\.notice/);
});

test("a provider's key error reads as a sentence and says whether the key itself is bad", async () => {
	const { keyFailure } = await import("../src/models/key-reason.ts");
	assert.deepEqual(keyFailure('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), {
		kind: "rejected",
		reason: "the provider turned it down (invalid x-api-key).",
	});
	// A free OpenRouter key has no credit: the provider knows the key, so it's saved with a note.
	const broke = keyFailure('402 {"error":{"message":"Insufficient credits"}}');
	assert.equal(broke.kind, "limited");
	assert.match(broke.reason, /out of credit or over its limit \(Insufficient credits\)/);
	assert.equal(keyFailure('429 {"error":{"message":"Rate limit reached"}}').kind, "limited");
	// No network says nothing about the key: "Couldn't check", with Save anyway.
	assert.deepEqual(keyFailure("Failed to fetch"), { kind: "unchecked", reason: "Failed to fetch." });
	assert.deepEqual(keyFailure(undefined), { kind: "unchecked", reason: "the provider didn't say why." });
	// Google's SDK: bare JSON, code 400, for a bad key.
	assert.equal(
		keyFailure('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}').kind,
		"rejected",
	);
	// Google's SDK as it really arrives: the API's JSON error inside its own error's message.
	const google = JSON.stringify({ error: { message: JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }, null, 2), code: 400, status: "Bad Request" } });
	assert.deepEqual(keyFailure(google), { kind: "rejected", reason: "the provider turned it down (API key not valid. Please pass a valid API key)." });
	// xAI as it really arrives: the message as a quoted JSON string.
	assert.deepEqual(keyFailure('400 "Incorrect API key provided. You can obtain an API key from https://console.x.ai."'), {
		kind: "rejected",
		reason: "the provider turned it down (Incorrect API key provided. You can obtain an API key from https://console.x.ai).",
	});
	// A 403 for the test model alone isn't proof the key is bad.
	assert.equal(keyFailure('403 {"error":{"message":"Project does not have access to model gpt-4o-mini"}}').kind, "unchecked");
	assert.equal(keyFailure('400 {"error":{"message":"max_tokens is too large"}}').kind, "unchecked");
	// Naming the key isn't enough; it has to say the key is wrong.
	assert.equal(keyFailure('403 {"error":{"message":"This API key does not have access to model gpt-4o-mini"}}').kind, "unchecked");
	assert.equal(keyFailure("400 invalid keyword in request").kind, "unchecked");
	assert.equal(keyFailure('400 {"error":{"message":"Invalid API Key"}}').kind, "rejected");
	// The test reads the whole message, not the 160 characters shown.
	assert.equal(keyFailure(`400 ${"x".repeat(170)} API key not valid`).kind, "rejected");
	const row = readFileSync(new URL("../src/components/ProviderKeyRow.ts", import.meta.url), "utf8");
	assert.match(row, /problem\.kind === "limited"\) \{\s*await getAppStorage\(\)\.providerKeys\.set/, "a limited key is saved");
	assert.match(row, /Save anyway/);
	assert.match(row, /AbortSignal\.timeout\(CHECK_TIMEOUT_MS\)/, "a check can't hang on Checking… forever");
	assert.match(row, /\} finally \{\s*this\.checking = false;/);
	assert.match(row, /i18n\("Key saved"\)/, "Key saved stays translated");
});

test("opening Settings doesn't scroll Providers or light up the search box far below", () => {
	const tab = readFileSync(new URL("../src/dialogs/ApiKeysTab.ts", import.meta.url), "utf8");
	assert.doesNotMatch(tab, /\.focus\(/, "nothing in Providers takes focus on open");
});

test("API keys are one line per provider: the key field opens on Add key, a bad key says why and stays, and a key can be removed", () => {
	const row = readFileSync(new URL("../src/components/ProviderKeyRow.ts", import.meta.url), "utf8");
	assert.match(row, /this\.editing \? this\.renderEditor\(\) : nothing/, "no key field until asked for");
	assert.match(row, /Add key/);
	assert.match(row, /providerKeys\.delete\(this\.provider\)/, "Remove deletes the key");
	assert.match(row, /That key didn't work: /);
	assert.match(row, /Toast\.error\(/, "a failed removal says so");
	assert.match(row, /disconnectedCallback\(\) \{\s*super\.disconnectedCallback\(\);[\s\S]*?this\.abort\.abort\(\)/, "a row that goes away stops its check");
	assert.match(row, /providerKeys\.set\(provider, key\)/, "a key is saved under the provider it was checked for");
	assert.doesNotMatch(row, /setTimeout/, "the reason doesn't vanish on a timer");
	assert.doesNotMatch(row, /stopReason === "stop"/, "a reasoning model that hits the token limit still proves the key");
	for (const file of ["../src/dialogs/ApiKeysTab.ts", "../src/dialogs/ApiKeyDialog.ts"]) {
		const source = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.match(source, /<tabkyra-provider-key /, file);
		assert.doesNotMatch(source, /<provider-key-input/, file);
	}
});

test("Settings > Skills lists every library skill, bundled and community, with no cap", async () => {
	const { libraryRows } = await import("../src/dialogs/skill-list.ts");
	const folders = readdirSync(new URL("../skills/", import.meta.url), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);
	const bundled = folders.map((name) => ({ name, description: `${name} does a thing. More detail.` }));
	const many = Array.from({ length: 150 }, (_, i) => ({ name: `community-${i}`, description: "Shared. Detail." }));
	const rows = libraryRows(bundled, [...many, { name: folders[0], description: "A clash." }], "");
	assert.equal(rows.length, folders.length + 150, "every bundled and community skill, a clash listed once");
	for (const name of folders) assert.ok(rows.some((r) => r.name === name && r.source === "bundled"), name);
	assert.equal(rows.find((r) => r.name === folders[0])?.summary, `${folders[0]} does a thing.`);
	assert.deepEqual(libraryRows(bundled, [], "/osint").map((r) => r.name), ["osint"]);
	const tab = readFileSync(new URL("../src/dialogs/SkillsTab.ts", import.meta.url), "utf8");
	assert.match(tab, /libraryRows\(this\.library, community, this\.searchQuery, siteNames\)/);
	assert.doesNotMatch(tab, /variant: "destructive"/, "Delete is a quiet button, not a red slab on every card");
});

test("the / menu lists every skill: no cap drops any", async () => {
	const { skillMenuItems } = await import("../src/composer/menus.ts");
	const site = Array.from({ length: 150 }, (_, i) => ({ name: `site-${i}`, shortDescription: "x", domainPatterns: [`s${i}.example`] }));
	const library = Array.from({ length: 40 }, (_, i) => ({ name: `lib-${i}`, description: "y." }));
	assert.equal(skillMenuItems("", site, new Set(), library).length, 190);
});

test("costs read as money, and the CORS proxy no longer names a sign-in Polycarp refuses", async () => {
	const { formatCost } = await import("../src/utils/format-cost.ts");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(0.0042), "$0.0042");
	assert.equal(formatCost(1.5), "$1.50");
	assert.equal(formatCost(Number.NaN), "$0.00");
	const patch = readFileSync(new URL("../patches/pi-mono.patch", import.meta.url), "utf8");
	assert.match(patch, /\+.*Required for Z\.ai\./);
	const costs = readFileSync(new URL("../src/dialogs/CostsTab.ts", import.meta.url), "utf8");
	assert.match(costs, /No costs in this range/);
	assert.doesNotMatch(costs, /toFixed\(4\)/);
});

test("Settings > Skills: one search for both lists, full descriptions on hover, name clashes explained", async () => {
	const { libraryRows, normalizeSkillQuery } = await import("../src/dialogs/skill-list.ts");
	assert.equal(normalizeSkillQuery(" /GitHub "), "github");
	const bundled = [{ name: "github", description: "Work with GitHub. Issues, pull requests and more." }];
	const community = [
		{ name: "github", description: "A clash with bundled." },
		{ name: "shop", description: "A clash with a site skill." },
	];
	const rows = libraryRows(bundled, community, "/github ", new Set(["github", "shop"]));
	assert.deepEqual(rows, [
		{ name: "github", summary: "Work with GitHub.", description: "Work with GitHub. Issues, pull requests and more.", source: "bundled", sharesNameWithSiteSkill: true },
	]);
	assert.deepEqual(
		libraryRows(bundled, community, "shop", new Set(["github", "shop"])).map((r) => [r.name, r.source, r.sharesNameWithSiteSkill]),
		[["shop", "community", true]],
		"a community skill that shares a site skill's name is listed and flagged",
	);
	const tab = readFileSync(new URL("../src/dialogs/SkillsTab.ts", import.meta.url), "utf8");
	assert.match(tab, /const query = normalizeSkillQuery\(this\.searchQuery\);/);
	assert.match(tab, /title=\$\{row\.description\}/);
	const { formatCost } = await import("../src/utils/format-cost.ts");
	assert.equal(formatCost(0.00003), "<$0.0001");
	assert.equal(formatCost(-0.0042), "-$0.0042");
	assert.equal(formatCost(-2.5), "-$2.50");
});

// Donovan, 2026-10-29: "The default check boxes are weird" (bare grey squares beside a switch).
test("an on/off setting is a switch, and every checkbox and radio is styled", () => {
	const dir = new URL("../src/dialogs/", import.meta.url);
	// Boxes that pick items from a list stay checkboxes: skills to import, a model's abilities.
	const listPicks = { "SkillsTab.ts": 1, "CustomProviderEditDialog.ts": 2 };
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		const src = readFileSync(new URL(file, dir), "utf8");
		// Counted, not parsed: an @change arrow's ">" would end a tag-matching regex early.
		const boxes = (src.match(/type="checkbox"/g) ?? []).length;
		const switches = (src.match(/role="switch"\s+class="tk-switch"/g) ?? []).length;
		assert.equal(boxes - switches, listPicks[file] ?? 0, `${file}: a setting checkbox without role="switch" class="tk-switch"`);
	}
	const css = readFileSync(new URL("../src/app.css", import.meta.url), "utf8");
	for (const rule of ['input[type="checkbox"].tk-switch', 'input[type="checkbox"]:not(.tk-switch)', 'input[type="radio"]', 'button[role="switch"]']) {
		assert.ok(css.includes(`${rule} {`) || css.includes(`${rule},`), `app.css styles ${rule}`);
	}
	const patch = readFileSync(new URL("../patches/pi-mono.patch", import.meta.url), "utf8");
	assert.match(patch, /^\+.*Key saved/m, "a saved provider key reads Key saved, not a green ✓");
});

// Donovan, 2026-10-29: Settings and the skill screens are "full screen with a back arrow, NOT a
// weird overlay thing".
test("Settings, the skill screens and the provider editor are pages, not overlay dialogs", () => {
	const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
	for (const file of ["SettingsPage", "SkillDialog", "RecordSkillDialog", "CustomProviderEditDialog"]) {
		const src = read(`dialogs/${file}.ts`);
		assert.match(src, /extends PageBase\b/, `${file} is a page`);
		assert.doesNotMatch(src, /DialogBase|mini-lit\/dist\/Dialog\.js/, `${file} uses no overlay dialog`);
	}
	assert.doesNotMatch(read("sidepanel.ts"), /\bSettingsDialog\b/, "the side panel opens SettingsPage, not pi-web-ui's dialog");
	const page = read("components/PageBase.ts");
	assert.match(page, /aria-label=\$\{i18n\("Back"\)\}/, "every page has a back arrow");
	assert.match(page, /fixed inset-0/, "a page fills the panel");
});

test("the short provider list loses nothing: a saved key stays, and custom providers never hide", () => {
	const tab = readFileSync(new URL("../src/dialogs/ApiKeysTab.ts", import.meta.url), "utf8");
	assert.match(tab, /this\.withKeys\.add\(this\.justSaved\)/);
	assert.match(tab, /this\.showAll \|\| this\.hasCustom \|\| this\.query\.trim\(\) \? html`<div class="pt-5 border-t border-border">\$\{this\.custom\}/);
	// Having a custom provider must not take away the way to reach the rest of the list.
	assert.match(tab, /this\.showAll \|\| this\.query\.trim\(\)\s*\? nothing\s*: html`<button/);
	assert.match(tab, /q \|\| this\.showAll \|\| this\.withKeys\.has\(p\) \|\| COMMON_PROVIDERS\.has\(p\)/);
});

test("sending from the panel with another session's tab in front leaves that tab with its session", async () => {
	const fake = installFakeChrome();
	const { BrowserSession } = await import(`../src/browser/session.ts?ctx=share-${Math.random()}`);
	const { shareActiveTab } = await import(`../src/browser/share-tab.ts?${Math.random()}`);
	const agent = await BrowserSession.open("bridge-claude-shop", "claude · shop", 1, { agent: "claude", project: "shop" });
	const t = (await agent.createTab("https://shop.example/")).id;
	await chrome.tabs.update(t, { active: true });
	const panel = await BrowserSession.open("saved-chat", "chat", 1);
	// Window 1's tab in front is the agent's tab T; the panel sends a message.
	assert.deepEqual(await shareActiveTab(panel, 1, true), { tabId: t, heldBy: "claude · shop" });
	assert.ok(fake.table()["bridge-claude-shop"].tabIds.includes(t), "T stays in the bridge session");
	assert.ok(!fake.table()["saved-chat"].tabIds.includes(t), "and the panel's chat did not take it");
});
