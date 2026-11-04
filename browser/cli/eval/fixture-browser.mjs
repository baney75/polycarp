// A throwaway browser for the evals: Playwright's Chromium, headless, with its own HOME,
// profile and socket directory, the built extension loaded and the native host registered
// there. Nothing here touches an installed browser or a running bridge.
//
// Playwright's own CDP session is not used: the extension drives tabs through
// chrome.debugger, and a second client attached to every page gets in its way. Pages are
// listed over the DevTools HTTP endpoint, and the extension's service worker is evaluated
// over its own target's websocket (read-only probes for scoring).
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
export const repo = join(here, "..", "..");
export const cli = join(repo, "cli", "dist", "index.js");
export const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";

/** Variables that pick a harness session; the evals clear them so an outer harness can't. */
export const HARNESS_SESSION_VARS = ["TABKYRA_SESSION", "TABKYRA_CLIENT_NAME", "CLAUDE_SESSION_ID", "CODEX_THREAD_ID", "OMP_SESSION_ID", "PI_SESSION_ID"];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms, what = "a condition") {
	const end = Date.now() + ms;
	let last;
	while (Date.now() < end) {
		try {
			const v = await fn();
			if (v) return v;
		} catch (err) {
			last = err;
		}
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** One CDP command over a target's websocket. */
export async function cdp(wsUrl, method, params = {}) {
	const ws = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	try {
		const reply = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000);
			ws.onmessage = (m) => {
				const msg = JSON.parse(m.data);
				if (msg.id !== 1) return;
				clearTimeout(timer);
				resolve(msg);
			};
			ws.send(JSON.stringify({ id: 1, method, params }));
		});
		if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
		return reply.result;
	} finally {
		ws.close();
	}
}

/** `extraArgs`: more Chromium switches (window size, language). `extensionDir`: a build other than dist-chrome. */
export async function launchFixtureBrowser({ extraEnv = {}, extraArgs = [], extensionDir } = {}) {
	const home = mkdtempSync(join(tmpdir(), "tk-eval-home-"));
	// Unix socket paths are capped near 104 bytes on macOS, so keep this one short.
	const socketDir = mkdtempSync("/tmp/tkev-");
	const profile = process.platform === "darwin" ? join(home, "Library", "Application Support", "Chromium") : join(home, ".config", "chromium");
	mkdirSync(profile, { recursive: true });
	const env = { ...process.env, HOME: home, TABKYRA_SOCKET_DIR: socketDir, TABKYRA_AUTO_ALLOW: "1", ...extraEnv };
	// The eval may itself run inside a harness: its session variables must not decide which
	// session the measured clients share.
	for (const k of HARNESS_SESSION_VARS) if (!(k in extraEnv)) delete env[k];
	execFileSync(process.execPath, [cli, "install"], { env, stdio: "ignore" });
	const ext = extensionDir ?? join(repo, "dist-chrome");
	const browser = spawn(
		chromium.executablePath(),
		[
			`--user-data-dir=${profile}`,
			"--headless=new",
			"--no-first-run",
			"--no-default-browser-check",
			"--use-mock-keychain",
			"--password-store=basic",
			"--remote-debugging-port=0",
			`--disable-extensions-except=${ext}`,
			`--load-extension=${ext}`,
			...extraArgs,
			"about:blank",
		],
		{ env, stdio: ["ignore", "ignore", "pipe"] },
	);
	// Resolves however Chromium ends, a signal included (exitCode stays null then).
	const exited = new Promise((r) => browser.once("exit", r));
	let stderr = "";
	browser.stderr.on("data", (d) => {
		stderr += d;
	});
	const devtools = await until(async () => stderr.match(/DevTools listening on ws:\/\/([^/]+)\//)?.[1], 20000, "Chromium to start");

	const targets = async () => (await fetch(`http://${devtools}/json/list`)).json();

	async function evaluate(wsUrl, expression) {
		const result = await cdp(wsUrl, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
		return result.result?.value;
	}

	/** Evaluate an expression in the extension's service worker (awaits promises; returns by value). */
	async function swEval(expression) {
		const sw = await until(
			async () => (await targets()).find((t) => t.type === "service_worker" && t.url === `chrome-extension://${EXTENSION_ID}/background.js`),
			20000,
			"the extension service worker",
		);
		return evaluate(sw.webSocketDebuggerUrl, expression);
	}

	// Developer mode on: without it this Chromium disables an unpacked extension when it reloads
	// ("unsupportedDeveloperExtension"), so a forced reload would unload Tabkyra for good. The
	// setting lives in a protected preference, so it is set the way the extensions page does.
	{
		const version = await (await fetch(`http://${devtools}/json/version`)).json();
		const { targetId } = await cdp(version.webSocketDebuggerUrl, "Target.createTarget", { url: "chrome://extensions" });
		const page = await until(async () => (await targets()).find((t) => t.id === targetId && t.url.startsWith("chrome://extensions")), 10000, "chrome://extensions");
		await until(
			() => evaluate(page.webSocketDebuggerUrl, "chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => true)"),
			10000,
			"developer mode",
		);
		await cdp(version.webSocketDebuggerUrl, "Target.closeTarget", { targetId });
	}

	/** Tabs with their group titles, from the browser itself (not from Tabkyra's own records). */
	async function tabsWithGroups() {
		return swEval(`(async () => {
			const groups = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title]));
			return (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url || t.pendingUrl || "", active: t.active, group: t.groupId === -1 ? null : groups.get(t.groupId) ?? null }));
		})()`);
	}

	/** Tabkyra's stored session table. */
	async function storedSessions() {
		return swEval(`chrome.storage.local.get("browser_sessions").then((d) => Object.values(d.browser_sessions ?? {}))`);
	}

	const tabkyra = (args, opts = {}) =>
		execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();

	async function waitConnected(ms = 45000) {
		await until(
			async () => {
				try {
					return JSON.parse((await tabkyraAsync(["status", "--json"])).stdout).connected;
				} catch (err) {
					// status exits 1 while not connected; its stdout is still the report.
					return JSON.parse(err.stdout?.toString() || "{}").connected;
				}
			},
			ms,
			"the extension to connect to the bridge",
		);
	}

	/** Reload the extension through the bridge (what `tabkyra reload` does) and wait for it to come back. */
	/** Async, so the fixture server and the timers keep running while the CLI waits. */
	const tabkyraAsync = (args) => promisify(execFile)(process.execPath, [cli, ...args], { env, encoding: "utf8" });

	/** The live native host's pid: a new one means the extension reloaded. */
	function hostPid() {
		for (const name of readdirSync(socketDir)) {
			const pid = Number.parseInt(name, 10);
			try {
				process.kill(pid, 0);
				return pid;
			} catch {
				/* stale socket */
			}
		}
		return undefined;
	}

	/** How many reloads were sent, so a double reload shows in the results. */
	let reloadsSent = 0;

	async function reloadExtension({ wait = true } = {}) {
		// Right after a reload the new host can be up before the extension has said hello to it,
		// so a refused reload is retried, but only while the same host lives: a reload whose
		// reply was lost has already happened and must not be sent again.
		const before = hostPid();
		const gone = () => {
			if (before === undefined) return false;
			try {
				process.kill(before, 0);
				return false;
			} catch {
				return true;
			}
		};
		await until(
			async () => {
				if (gone()) return true;
				reloadsSent++;
				try {
					await tabkyraAsync(["reload"]);
				} catch (err) {
					// The connection closed under the reply: the reload went out. Wait for the old
					// host to exit rather than send another.
					if (/connection closed|ECONNRESET|EPIPE/i.test(`${err.stderr ?? ""}${err.message}`)) return true;
					// Refused before it reached a ready extension: wait for the old host to go, or retry.
					for (let i = 0; i < 8 && !gone(); i++) await sleep(250);
					if (gone()) return true;
					throw err;
				}
				return true;
			},
			30000,
			"the extension to take a reload",
		);
		if (wait) {
			await sleep(1500);
			await waitConnected();
		}
	}

	async function close() {
		browser.kill();
		await Promise.race([exited, sleep(10000).then(() => browser.kill("SIGKILL"))]);
		rmSync(home, { recursive: true, force: true });
		rmSync(socketDir, { recursive: true, force: true });
	}

	return { home, socketDir, env, devtools, targets, swEval, tabsWithGroups, storedSessions, tabkyra, waitConnected, reloadExtension, hostPid, reloads: () => reloadsSent, close };
}
