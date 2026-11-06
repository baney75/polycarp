/**
 * Writes the native messaging host manifest for every Chromium browser present on
 * this machine, plus the launcher script the manifest points at. Idempotent; run
 * automatically by `tabkyra mcp` when the manifest is missing.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { NATIVE_HOST_NAME } from "../../src/bridge/protocol.ts";
import { COMPILED, selfExec, selfPrefix } from "./self.ts";

/** Stable id from the `key` in static/manifest.chrome.json: unpacked and bundled copies. */
export const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";

/** The id Google assigned the Chrome Web Store listing. Empty until the first upload. */
export const STORE_EXTENSION_ID: string = "";

/** Every extension allowed to talk to the native host: the unpacked copy, and the store copy once it exists. */
export function extensionOrigins(storeId: string = STORE_EXTENSION_ID): string[] {
	return [EXTENSION_ID, storeId].filter(Boolean).map((id) => `chrome-extension://${id}/`);
}

/** True when a host manifest allows exactly today's extensions. An older file gets rewritten. */
export function originsCurrent(origins: unknown, storeId: string = STORE_EXTENSION_ID): boolean {
	return JSON.stringify(origins) === JSON.stringify(extensionOrigins(storeId));
}

export interface BrowserDir {
	name: string;
	dir: string;
}

/** User-data directories of the Chromium browsers we register with. */
export function browserDirs(): BrowserDir[] {
	const home = homedir();
	if (process.platform === "darwin") {
		const base = join(home, "Library", "Application Support");
		return [
			{ name: "Helium", dir: join(base, "net.imput.helium") },
			{ name: "Chrome", dir: join(base, "Google", "Chrome") },
			{ name: "Chrome Beta", dir: join(base, "Google", "Chrome Beta") },
			{ name: "Chrome Canary", dir: join(base, "Google", "Chrome Canary") },
			{ name: "Chromium", dir: join(base, "Chromium") },
			{ name: "Brave", dir: join(base, "BraveSoftware", "Brave-Browser") },
			{ name: "Edge", dir: join(base, "Microsoft Edge") },
			{ name: "Arc", dir: join(base, "Arc", "User Data") },
			{ name: "Vivaldi", dir: join(base, "Vivaldi") },
			{ name: "Opera", dir: join(base, "com.operasoftware.Opera") },
		];
	}
	if (process.platform === "linux") {
		const cfg = process.env.XDG_CONFIG_HOME || join(home, ".config");
		return [
			{ name: "Helium", dir: join(cfg, "net.imput.helium") },
			{ name: "Chrome", dir: join(cfg, "google-chrome") },
			{ name: "Chrome Beta", dir: join(cfg, "google-chrome-beta") },
			{ name: "Chromium", dir: join(cfg, "chromium") },
			{ name: "Brave", dir: join(cfg, "BraveSoftware", "Brave-Browser") },
			{ name: "Edge", dir: join(cfg, "microsoft-edge") },
			{ name: "Vivaldi", dir: join(cfg, "vivaldi") },
			{ name: "Opera", dir: join(cfg, "opera") },
		];
	}
	return [];
}

/** The app each browser ships as on a Mac, by the name browserDirs() gives it. */
const MAC_APPS: Record<string, string> = {
	Helium: "Helium",
	Chrome: "Google Chrome",
	"Chrome Beta": "Google Chrome Beta",
	"Chrome Canary": "Google Chrome Canary",
	Chromium: "Chromium",
	Brave: "Brave Browser",
	Edge: "Microsoft Edge",
	Arc: "Arc",
	Vivaldi: "Vivaldi",
	Opera: "Opera",
};

/** Each browser's bundle identifier, for finding its app wherever it lives (Launch Services knows; the fixed folders may not). */
const MAC_BUNDLE_IDS: Record<string, string> = {
	Helium: "net.imput.helium",
	Chrome: "com.google.Chrome",
	"Chrome Beta": "com.google.Chrome.beta",
	"Chrome Canary": "com.google.Chrome.canary",
	Chromium: "org.chromium.Chromium",
	Brave: "com.brave.Browser",
	Edge: "com.microsoft.edgemac",
	Arc: "company.thebrowser.Browser",
	Vivaldi: "com.vivaldi.Vivaldi",
	Opera: "com.operasoftware.Opera",
};

/** The browser (by browserDirs() name) for a Mac app name such as "Google Chrome", or the app name itself if it isn't one we list. */
export function browserNameForApp(app: string): string {
	return Object.entries(MAC_APPS).find(([, a]) => a === app)?.[0] ?? app;
}

const spotlight = new Map<string, boolean>();
/** Does Launch Services (through Spotlight's index) know an app with this bundle id? Asked once per id. */
function knownToSpotlight(id: string): boolean {
	const seen = spotlight.get(id);
	if (seen !== undefined) return seen;
	let found = false;
	try {
		found = execFileSync("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${id}'`], { encoding: "utf8", timeout: 3000 }).trim().length > 0;
	} catch {
		/* no Spotlight, or it timed out: the fixed folders decide */
	}
	spotlight.set(id, found);
	return found;
}

/**
 * Is the browser really installed? A data folder outlives the app (uninstalled browsers leave theirs), so on a Mac the app
 * must be in an Applications folder. TABKYRA_APPLICATIONS_DIRS (a PATH-style list) replaces the folders, for tests.
 * Elsewhere the data folder is all there is to go on.
 */
export function browserInstalled(name: string): boolean {
	if (process.platform !== "darwin") return true;
	const app = MAC_APPS[name];
	if (!app) return true;
	const dirs = process.env.TABKYRA_APPLICATIONS_DIRS ? process.env.TABKYRA_APPLICATIONS_DIRS.split(delimiter) : ["/Applications", join(homedir(), "Applications")];
	if (dirs.some((dir) => existsSync(join(dir, `${app}.app`)))) return true;
	// An app outside the top of an Applications folder (Setapp, an external drive): ask by bundle id. Not under test overrides.
	const id = MAC_BUNDLE_IDS[name];
	return !process.env.TABKYRA_APPLICATIONS_DIRS && id !== undefined && knownToSpotlight(id);
}

/**
 * The browsers with a data folder here and the app installed. `live` names browsers a running connection says hold the extension:
 * they are in use even if their app can't be found. A manifest left in a data folder proves nothing (uninstalling the app keeps it).
 */
export function installedBrowserDirs(live: readonly string[] = []): BrowserDir[] {
	return browserDirs().filter(({ name, dir }) => existsSync(dir) && (browserInstalled(name) || live.includes(name)));
}

/** The browsers that already have one of our manifests, current or not: the ones this install has been registered with. */
export function registeredBrowserNames(): string[] {
	return browserDirs()
		.filter(({ dir }) => existsSync(join(dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`)))
		.map(({ name }) => name);
}

function configDir(): string {
	return join(homedir(), ".config", "tabkyra");
}

export function launcherPath(): string {
	return join(configDir(), process.platform === "win32" ? "host.cmd" : "host");
}

/**
 * The `tabkyra` command harness configs run: a launcher that pins Node by absolute path,
 * so harnesses started from a GUI (Cursor, Claude Desktop) work without node on PATH.
 */
export function cliLauncherPath(): string {
	return join(configDir(), process.platform === "win32" ? "tabkyra.cmd" : "tabkyra");
}

/** Node by its PATH name when that is this same binary (survives upgrades), else execPath. */
function stableNode(): string {
	const exec = process.execPath;
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		// A relative PATH entry would make the launcher depend on the directory it runs from.
		if (!isAbsolute(dir)) continue;
		const candidate = join(dir, process.platform === "win32" ? "node.exe" : "node");
		try {
			if (existsSync(candidate) && realpathSync(candidate) === realpathSync(exec)) return candidate;
		} catch {
			/* unreadable entry */
		}
	}
	return exec;
}

/**
 * What the browser runs for the native host. Inside Polycarp that is the helper itself (it takes the
 * `chrome-extension://` argument the browser passes as `host`), so the manifest holds one path that
 * moves with the app; elsewhere it is the launcher script.
 */
export function hostTarget(): string {
	return COMPILED ? selfExec() : launcherPath();
}

function writeScript(path: string, args: string, options: { compileCache?: boolean } = {}): void {
	if (COMPILED) {
		// The helper is the whole program: no Node to pin, no script, no compile cache.
		if (process.platform === "win32") writeFileSync(path, `@echo off\r\n"${selfExec()}" ${args} %*\r\n`);
		else {
			writeFileSync(path, `#!/bin/sh\nexec "${selfExec()}" ${args}"$@"\n`);
			chmodSync(path, 0o755);
		}
		return;
	}
	const node = stableNode();
	const script = selfPrefix()[0] ?? process.argv[1];
	if (process.platform === "win32") {
		writeFileSync(path, `@echo off\r\n"${node}" "${script}" ${args} %*\r\n`);
	} else {
		// Node's compile cache (Node 22.1+; older versions ignore it): a small saving, about 10 ms
		// of 120 on one machine, near run-to-run noise (`cli/eval/bridge-metrics.mjs --only launcher`).
		const cache = join(homedir(), ".cache", "tabkyra", "node-compile-cache");
		// Only the launcher harnesses run; the native host's environment (and what it spawns) is unchanged.
		const prefix = options.compileCache ? `: "\${NODE_COMPILE_CACHE:=${cache}}"\nexport NODE_COMPILE_CACHE\n` : "";
		writeFileSync(path, `#!/bin/sh\n${prefix}exec "${node}" "${script}" ${args}"$@"\n`);
		chmodSync(path, 0o755);
	}
}

function writeLauncher(): string {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeScript(cliLauncherPath(), "", { compileCache: true });
	const path = launcherPath();
	writeScript(path, "host ");
	return hostTarget();
}

export function manifestFor(launcher: string): string {
	return `${JSON.stringify(
		{
			name: NATIVE_HOST_NAME,
			description: "Polycarp browser bridge",
			path: launcher,
			type: "stdio",
			allowed_origins: extensionOrigins(),
		},
		null,
		2,
	)}\n`;
}

export interface InstallResult {
	launcher: string;
	written: string[];
	skipped: string[];
}

export interface InstallOptions {
	force?: boolean;
	/** Register only this browser (by the name browserDirs() gives it), and touch the launchers only if one of them doesn't work. */
	browser?: string;
	/** Register only these browsers; the launchers are kept as they are while both work. */
	browsers?: readonly string[];
	/** False rewrites the launchers even when they work. */
	keepLaunchers?: boolean;
}

export function install(options: InstallOptions = {}): InstallResult {
	const only = options.browsers ?? (options.browser !== undefined ? [options.browser] : undefined);
	// A chosen set of browsers: working launchers (a standalone Polycarp's, say) stay as they are, so nothing else is repointed.
	const keepLaunchers = options.keepLaunchers !== false && only !== undefined && launchersWork();
	const launcher = keepLaunchers ? hostTarget() : writeLauncher();
	const manifest = manifestFor(launcher);
	const written: string[] = [];
	const skipped: string[] = [];

	if (process.platform === "win32") {
		const file = join(configDir(), `${NATIVE_HOST_NAME}.json`);
		writeFileSync(file, manifest);
		for (const hive of ["Google\\Chrome", "BraveSoftware\\Brave-Browser", "Microsoft\\Edge", "Chromium"]) {
			const key = `HKCU\\Software\\${hive}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
			try {
				execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"], { stdio: "ignore" });
				written.push(key);
			} catch {
				skipped.push(key);
			}
		}
		return { launcher, written, skipped };
	}

	for (const { name, dir } of browserDirs()) {
		if (!existsSync(dir)) continue;
		if (only !== undefined && !only.includes(name)) continue;
		const hostsDir = join(dir, "NativeMessagingHosts");
		const file = join(hostsDir, `${NATIVE_HOST_NAME}.json`);
		if (!options.force && existsSync(file) && readFileSync(file, "utf8") === manifest) {
			skipped.push(file);
			continue;
		}
		mkdirSync(hostsDir, { recursive: true });
		writeFileSync(file, manifest);
		written.push(file);
	}
	return { launcher, written, skipped };
}

/**
 * Does this launcher script run? It exists, is executable, and every program or script it names by absolute path is still
 * there (a deleted checkout leaves a launcher that execs nothing). A bare name such as `node` is the PATH's business.
 */
export function launcherWorks(path: string): boolean {
	const named = absolutePathsIn(path);
	return named !== undefined && named.length > 0 && named.every((p) => existsSync(p));
}

/** The absolute paths a launcher script quotes, or undefined if it isn't there or can't run. */
function absolutePathsIn(path: string): string[] | undefined {
	try {
		if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) return undefined;
		return [...readFileSync(path, "utf8").matchAll(/"([^"\n]+)"/g)].map((m) => m[1]).filter((p) => isAbsolute(p));
	} catch {
		return undefined;
	}
}

/** The first `n` characters of a file, without reading the rest (the helper is a large binary). */
function firstBytes(path: string, n: number): string {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(n);
		const read = readSync(fd, buf, 0, n, 0);
		return buf.subarray(0, read).toString("latin1");
	} finally {
		closeSync(fd);
	}
}

/**
 * What a browser's manifest names: a launcher script (every program it names must still be there) or the helper itself (it must
 * exist and be executable). A script that names nothing has nothing missing.
 */
export function manifestLauncherRuns(path: string): boolean {
	try {
		if (!existsSync(path)) return false;
		const head = firstBytes(path, 2);
		if (head !== "#!" && !path.endsWith(".cmd")) return process.platform === "win32" || (statSync(path).mode & 0o111) !== 0;
		const named = absolutePathsIn(path);
		return named !== undefined && named.every((p) => existsSync(p));
	} catch {
		return false;
	}
}

/** Both launchers work: the agent launcher harness configs run and the host launcher the manifests name. */
function launchersWork(): boolean {
	return launcherWorks(cliLauncherPath()) && manifestLauncherRuns(hostTarget());
}

export type HostState = "current" | "stale" | "missing";

/** For each browser found on this machine: is our host manifest there and current. */
export function hostStatus(): Array<BrowserDir & { state: HostState; file: string }> {
	if (process.platform === "win32") return [];
	const accepted = new Set([hostTarget(), launcherPath()]);
	return installedBrowserDirs().map((browser) => {
		const file = join(browser.dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		let state: HostState = "missing";
		if (existsSync(file)) {
			// Current: it names the helper or a standalone launcher that still runs (down to the program the launcher execs), and the one extension id (doctor's test).
			try {
				const m = JSON.parse(readFileSync(file, "utf8")) as { path?: string; allowed_origins?: string[] };
				const ok = typeof m.path === "string" && accepted.has(m.path) && manifestLauncherRuns(m.path) && originsCurrent(m.allowed_origins);
				state = ok ? "current" : "stale";
			} catch {
				state = "stale";
			}
		}
		return { ...browser, state, file };
	});
}

/** True when at least one browser has a current manifest. */
export function isInstalled(): boolean {
	if (process.platform === "win32") return existsSync(join(configDir(), `${NATIVE_HOST_NAME}.json`));
	if (!existsSync(hostTarget())) return false;
	return hostStatus().some((b) => b.state === "current");
}
