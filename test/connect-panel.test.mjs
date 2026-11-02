// The side panel's Connect pieces that don't need a browser: the relay's first check, the text
// helpers, and the header, tab and welcome wiring the UX review asked for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkConnectRequest } from "../src/connect/check.ts";
import { connectorUrl, countdown, lastSeen, linkCommand } from "../src/connect/format.ts";
import { CONNECT_METHODS } from "../src/connect/types.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

test("the relay passes only known methods with object params, and names the id of a refused one", () => {
	assert.deepEqual([...CONNECT_METHODS], ["status", "approvalCode", "deviceCode", "setBusy", "joinHub", "setTheme"]);
	assert.deepEqual(checkConnectRequest({ id: 1, method: "status" }), { ok: true, request: { id: 1, method: "status" } });
	assert.deepEqual(checkConnectRequest({ id: 2, method: "setBusy", params: { busy: true } }).request.params, { busy: true });
	for (const bad of [{ id: 3, method: "link.off" }, { id: 3, method: "__proto__" }, { id: 3, method: 5 }, { id: 3, method: "status", params: [] }, { id: 3, method: "status", params: "x" }, { id: 3, method: "status", params: null }]) {
		const r = checkConnectRequest(bad);
		assert.equal(r.ok, false, JSON.stringify(bad));
		assert.equal(r.id, 3);
	}
	for (const bad of [null, undefined, "status", { method: "status" }, { id: "1", method: "status" }]) assert.equal(checkConnectRequest(bad).ok, false);
});

test("countdown and last-seen read as a person would say them", () => {
	assert.equal(countdown(10 * 60_000, 0), "10:00");
	assert.equal(countdown(9 * 60_000 + 41_000, 0), "9:41");
	assert.equal(countdown(65_000, 0), "1:05");
	assert.equal(countdown(1000, 1000), "");
	assert.equal(countdown(0, 5000), "");
	const now = Date.parse("2026-11-02T12:00:00Z");
	assert.equal(lastSeen(null, now), "never");
	assert.equal(lastSeen("garbage", now), "never");
	assert.equal(lastSeen("2026-11-02T11:59:30Z", now), "just now");
	assert.equal(lastSeen("2026-11-02T11:59:00Z", now), "1 minute ago");
	assert.equal(lastSeen("2026-11-02T11:55:00Z", now), "5 minutes ago");
	assert.equal(lastSeen("2026-11-02T09:00:00Z", now), "3 hours ago");
	assert.equal(lastSeen("2026-11-01T11:00:00Z", now), "1 day ago");
	assert.equal(connectorUrl("https://h.example.com"), "https://h.example.com/mcp");
	assert.equal(linkCommand("https://h.example.com", "TK-ABCD-EFGH"), "tabkyra link https://h.example.com --code TK-ABCD-EFGH");
});

test("Settings has the eight tabs in the spec's order, and Bridge is now Agents", () => {
	const panel = read("src/sidepanel.ts");
	const start = panel.indexOf("SettingsPage.open([");
	const list = panel.slice(start, panel.indexOf("]);\n", start));
	// Top-level entries only: a tab, or a combined tab by its name.
	const order = list
		.split("\n")
		.map((line) => /^\t\t(?:new CombinedTab\("(\w+)"|new (\w+)\(|(providers),)/.exec(line))
		.filter(Boolean)
		.map((m) => m[1] ?? m[2] ?? m[3]);
	assert.deepEqual(order, ["providers", "BridgeTab", "ConnectTab", "SkillsTab", "Privacy", "AppearanceTab", "CostsTab", "About"]);
	assert.match(read("src/dialogs/BridgeTab.ts"), /getTabName\(\): string \{\s*return "Agents";/);
	assert.match(read("src/dialogs/ConnectTab.ts"), /return "Connect";/);
	assert.match(read("src/dialogs/AppearanceTab.ts"), /return "Appearance";/);
});

test("the welcome dialog offers Connect, and Set up provider lands on the API keys list", () => {
	const welcome = read("src/dialogs/WelcomeSetupDialog.ts");
	assert.match(welcome, /Use from claude\.ai or ChatGPT/);
	assert.match(welcome, /Set up provider/);
	const panel = read("src/sidepanel.ts");
	assert.match(panel, /choice === "connect" \? \{ tab: "Connect" \} : \{ tab: "Providers", anchor: "api-keys-heading" \}/);
	assert.match(read("src/dialogs/ApiKeysTab.ts"), /id="api-keys-heading"/);
});

test("with no provider the composer's model button reads Add a provider", () => {
	const panel = read("src/sidepanel.ts");
	assert.match(panel, /if \(providerless\)\s+return \{ content: "Add a provider"/);
	assert.match(panel, /provider-key-saved", "provider-key-removed"/);
});

test("every icon-only header button has an aria-label and a visible tooltip", () => {
	const panel = read("src/sidepanel.ts");
	// headerButton sets both from one label.
	assert.match(panel, /function headerButton\([^)]*\)[\s\S]{0,200}aria-label=\$\{label\} data-tip=\$\{label\}/);
	for (const label of ["Past chats", "New chat", "Settings"]) assert.match(panel, new RegExp(`headerButton\\("${label}"`));
	// The More menu button carries both too.
	const menu = read("src/components/HeaderMenu.ts");
	assert.match(menu, /aria-label=\$\{this\.label\}\s+data-tip=\$\{this\.label\}/);
	assert.match(panel, /<tk-header-menu \.items=\$\{moreMenuItems\(\)\} label="More">/);
	// The recording pill and the Artifacts button too.
	assert.match(panel, /aria-label="Stop recording and save as a skill"\s+data-tip="Stop recording and save as a skill"/);
	// The theme items left the More menu; one Theme entry opens Appearance.
	assert.doesNotMatch(panel, /Light theme|Dark theme|Match the system/);
	assert.match(panel, /label: "Theme"[^}]*openApiKeysDialog\(\{ tab: "Appearance" \}\)/);
});

test("Privacy keeps one sentence visible and every long explanation under Details, text unchanged", () => {
	const text = read("src/dialogs/PrivacyTab.ts");
	assert.equal((text.match(/>Details</g) ?? []).length + (text.match(/<summary[^>]*>Details/g) ?? []).length >= 2, true);
	// The original explanations survive word for word.
	for (const kept of [
		"The side panel agent then runs only OpenRouter models, sent with zero data retention required and no",
		"Ollama cloud model) is still a cloud service: don't use one in private mode.",
		"Prefer names over IPs (for example mac.example.ts.net): a listed IP is trusted on every network, including one where it belongs to someone else.",
		"Keeps a copy of your side panel chats in ~/.local/share/tabkyra/threads (readable only by your user), so",
		"Nothing is sent: you review the report here, copy it, and paste it into a GitHub issue yourself.",
	]) {
		assert.ok(text.includes(kept), `missing: ${kept}`);
	}
});

test("Page scripts reads as one plain sentence with the old wording under Details", () => {
	const text = read("src/dialogs/BridgeTab.ts");
	assert.match(text, /Turning this on makes agents' page scripts run faster\./);
	assert.match(text, /Tabkyra has not been granted the userScripts permission\./);
	assert.match(text, /<summary class="cursor-pointer text-foreground">Details<\/summary>/);
	// The jargon is no longer a visible line.
	assert.doesNotMatch(text, /line\(\s*['"]Off: Tabkyra has not been granted/);
});
