/**
 * Writes the native messaging host manifest for every Chromium browser present on
 * this machine, plus the launcher script the manifest points at. Idempotent; run
 * automatically by `tabkyra mcp` when the manifest is missing.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { NATIVE_HOST_NAME } from "../../src/bridge/protocol.ts";

/** Stable id from the `key` in static/manifest.chrome.json. */
export const EXTENSION_ID = "kenehmggpggpiolepbjojeenmeapgfoc";

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

function writeScript(path: string, args: string, options: { compileCache?: boolean } = {}): void {
	const node = stableNode();
	const script = process.argv[1];
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
	return path;
}

export function manifestFor(launcher: string): string {
	return `${JSON.stringify(
		{
			name: NATIVE_HOST_NAME,
			description: "Tabkyra browser bridge",
			path: launcher,
			type: "stdio",
			allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
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

export function install(options: { force?: boolean } = {}): InstallResult {
	const launcher = writeLauncher();
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

	for (const { dir } of browserDirs()) {
		if (!existsSync(dir)) continue;
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

export type HostState = "current" | "stale" | "missing";

/** For each browser found on this machine: is our host manifest there and current. */
export function hostStatus(): Array<BrowserDir & { state: HostState; file: string }> {
	if (process.platform === "win32") return [];
	const manifest = manifestFor(launcherPath());
	return browserDirs()
		.filter(({ dir }) => existsSync(dir))
		.map((browser) => {
			const file = join(browser.dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
			let state: HostState = "missing";
			if (existsSync(file)) state = readFileSync(file, "utf8") === manifest ? "current" : "stale";
			return { ...browser, state, file };
		});
}

/** True when at least one browser has a current manifest. */
export function isInstalled(): boolean {
	if (process.platform === "win32") return existsSync(join(configDir(), `${NATIVE_HOST_NAME}.json`));
	if (!existsSync(launcherPath())) return false;
	return hostStatus().some((b) => b.state === "current");
}
