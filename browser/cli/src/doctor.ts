/**
 * `tabkyra doctor`: every check that has to pass for an agent to drive a tab, with
 * one exact fix per failure. Exits 1 when any check fails.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_HOST_NAME, type UserScriptsStatus } from "../../src/bridge/protocol.ts";
import { BridgeClient, listSockets } from "./client.ts";
import { harnesses, launcherValid, shellJoin } from "./harness.ts";
import { browserDirs, cliLauncherPath, EXTENSION_ID, launcherPath } from "./install.ts";
import { EXTENSION_FILES, extensionDir, repoRoot } from "./paths.ts";
import { banner, c, sym } from "./ui.ts";
import { VERSION } from "./version.ts";

export interface Check {
	id: string;
	/** "warn" is shown but does not fail the run. */
	status: "ok" | "fail" | "warn";
	label: string;
	detail?: string;
	fix?: string;
}

const MIN_NODE_MAJOR = 20;

function nodeCheck(): Check {
	const major = Number(process.versions.node.split(".")[0]);
	return major >= MIN_NODE_MAJOR
		? { id: "node", status: "ok", label: `Node ${process.versions.node}` }
		: {
				id: "node",
				status: "fail",
				label: `Node ${process.versions.node} is too old`,
				detail: `Tabkyra needs Node ${MIN_NODE_MAJOR} or newer.`,
				fix: process.platform === "darwin" ? "brew install node" : "Install Node 20+ from https://nodejs.org",
			};
}

/** Reads dist-chrome/manifest.json; undefined when the build is missing or incomplete. */
export function builtVersion(): string | undefined {
	const dir = extensionDir();
	if (!EXTENSION_FILES.every((f) => existsSync(join(dir, f)))) return undefined;
	try {
		return (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** Version in the checkout's static/manifest.chrome.json, which every build copies. */
export function sourceVersion(): string | undefined {
	try {
		return (JSON.parse(readFileSync(join(repoRoot(), "static", "manifest.chrome.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** "missing", "stale" (built from a different version of this checkout) or "ok". */
export function buildState(): "missing" | "stale" | "ok" {
	const built = builtVersion();
	if (!built) return "missing";
	const source = sourceVersion();
	return source && source !== built ? "stale" : "ok";
}

function buildCheck(): Check {
	const dir = extensionDir();
	const state = buildState();
	if (state === "missing") {
		return { id: "build", status: "fail", label: "Extension build missing", detail: `${dir} is missing or incomplete.`, fix: "tabkyra setup" };
	}
	if (state === "stale") {
		return {
			id: "build",
			status: "fail",
			label: `Extension build ${builtVersion()} does not match this checkout (${sourceVersion()})`,
			detail: "dist-chrome was built from a different version of the source.",
			fix: "tabkyra setup",
		};
	}
	return { id: "build", status: "ok", label: `Extension build ${builtVersion()}`, detail: dir };
}

function launcherCheck(): Check {
	return launcherValid()
		? { id: "launcher", status: "ok", label: "Agent launcher in place", detail: cliLauncherPath() }
		: {
				id: "launcher",
				status: "fail",
				label: "Agent launcher missing or broken",
				detail: `${cliLauncherPath()} is what harness configs run.`,
				fix: "tabkyra install --force",
			};
}

function hostChecks(): Check[] {
	if (process.platform === "win32") {
		return [
			{
				id: "host",
				status: "warn",
				label: "Native host registration is not checked on Windows",
				detail: "tabkyra install writes HKCU\\Software\\<browser>\\NativeMessagingHosts keys; run it again if the extension can't connect.",
				fix: "tabkyra install --force",
			},
		];
	}
	const origin = `chrome-extension://${EXTENSION_ID}/`;
	const launcher = launcherPath();
	const found = browserDirs().filter(({ dir }) => existsSync(dir));
	if (found.length === 0) {
		return [
			{
				id: "host",
				status: "fail",
				label: "No Chromium browser found",
				detail: "Tabkyra works with Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi and Opera.",
				fix: "Install a Chromium browser, then run: tabkyra setup",
			},
		];
	}
	return found.map(({ name, dir }) => {
		const file = join(dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		const fail = (detail: string): Check => ({
			id: `host:${name}`,
			status: "fail",
			label: `${name}: native host ${existsSync(file) ? "manifest is wrong" : "not registered"}`,
			detail,
			fix: "tabkyra install --force",
		});
		if (!existsSync(file)) return fail(file);
		let manifest: { name?: string; path?: string; allowed_origins?: string[] };
		try {
			manifest = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return fail(`${file} is not valid JSON`);
		}
		if (manifest.name !== NATIVE_HOST_NAME) return fail(`name is ${manifest.name}, expected ${NATIVE_HOST_NAME}`);
		const origins = manifest.allowed_origins ?? [];
		if (origins.length !== 1 || origins[0] !== origin) {
			return fail(`allowed_origins is ${JSON.stringify(origins)}, expected ["${origin}"] (extension id ${EXTENSION_ID})`);
		}
		if (manifest.path !== launcher) return fail(`path is ${manifest.path}, expected ${launcher}`);
		if (!existsSync(launcher) || (statSync(launcher).mode & 0o111) === 0) return fail(`${launcher} is missing or not executable`);
		return { id: `host:${name}`, status: "ok", label: `${name}: native host registered`, detail: file };
	});
}

export interface DebugInfo {
	version?: string;
	/** Every extension version sends this; true only when user scripts work. */
	userScriptsApi?: boolean;
	/** Newer extensions only: why they do not work. */
	userScripts?: UserScriptsStatus;
	workerUptimeS?: number;
}

const GRANT_STEPS =
	"Open the Tabkyra side panel > Settings > Agents > Page scripts and click Allow, then accept the browser's prompt. If doctor still warns, run tabkyra reload.";

/** The "Allow user scripts" row of `tabkyra doctor`, or undefined when there is nothing to say. */
export function userScriptsCheck(info: DebugInfo): Check | undefined {
	const status = info.userScripts;
	const slow = "Page scripts fall back to a slower path (the debugger).";
	switch (status?.state) {
		case "ready":
			return undefined;
		case "not_granted":
			return {
				id: "user-scripts",
				status: "warn",
				label: "The userScripts permission is not granted",
				detail: `${slow} The "Allow user scripts" toggle on the Details page is not enough: the extension must also be granted the optional userScripts permission.`,
				fix: GRANT_STEPS,
			};
		case "toggle_off":
			if (!status.apiPresent) {
				// Granted but missing: the toggle is off, or the extension hasn't restarted since the grant.
				return {
					id: "user-scripts",
					status: "warn",
					label: "The userScripts permission is granted but the browser hides the API",
					detail: `${slow} Either "Allow user scripts" is off on the extension's Details page, or Tabkyra hasn't restarted since the permission was granted.`,
					fix: 'Check "Allow user scripts" at chrome://extensions > Tabkyra > Details, then tabkyra reload',
				};
			}
			return {
				id: "user-scripts",
				status: "warn",
				label: '"Allow user scripts" is off',
				detail: `${slow} The permission is granted, but the browser refuses userScripts calls until the toggle is on.${status.error ? ` Browser said: ${status.error}` : ""}`,
				fix: 'Turn on "Allow user scripts" at chrome://extensions > Tabkyra > Details, then tabkyra reload',
			};
		case "probe_error":
			return {
				id: "user-scripts",
				status: "warn",
				label: "Couldn't tell whether user scripts work",
				detail: `${slow} The check failed: ${status.error ?? "no error text"}`,
				fix: "tabkyra reload, then tabkyra doctor",
			};
	}
	// No structured status (an older extension) or a state this CLI doesn't know (a newer one):
	// only the boolean is certain.
	if (info.userScriptsApi !== false) return undefined;
	return {
		id: "user-scripts",
		status: "warn",
		label: "User scripts are unavailable",
		detail: `Page scripts fall back to a slower path. Either the userScripts permission is not granted or "Allow user scripts" is off on the extension's Details page.`,
		fix: "tabkyra update or rebuild the CLI so doctor can name the cause",
	};
}

/** A worker this young may not have settled since `tabkyra reload`; ask it again once. */
const SETTLE_S = 10;
const RETRY_MS = 1500;

export async function connectionChecks(): Promise<Check[]> {
	const notConnected: Check = {
		id: "connected",
		status: "fail",
		label: "Extension not connected",
		detail: "No running browser has the Tabkyra extension loaded, or it has not reached the native host yet.",
		fix: "tabkyra setup",
	};
	let sockets: string[];
	try {
		sockets = listSockets();
	} catch (err) {
		return [{ ...notConnected, detail: err instanceof Error ? err.message : String(err) }];
	}
	for (const path of sockets) {
		const client = new BridgeClient({ name: "doctor" });
		try {
			await client.connect(path);
		} catch {
			client.close();
			continue;
		}
		if (!client.extensionConnected) {
			client.close();
			continue;
		}
		try {
			let info = (await client.call("bridge.debug", {}, 5000)) as DebugInfo;
			if (userScriptsCheck(info) && (info.workerUptimeS ?? SETTLE_S) < SETTLE_S) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
				// A worker still restarting may not answer again; the first answer stands then.
				info = ((await client.call("bridge.debug", {}, 5000).catch(() => undefined)) as DebugInfo | undefined) ?? info;
			}
			const checks: Check[] = [{ id: "connected", status: "ok", label: `Extension connected (${info.version ?? "unknown version"})`, detail: path }];
			const built = builtVersion();
			if (built && info.version && built !== info.version) {
				checks.push({
					id: "loaded-version",
					status: "fail",
					label: `The browser runs extension ${info.version}, the build is ${built}`,
					fix: "tabkyra reload",
				});
			}
			const userScripts = userScriptsCheck(info);
			if (userScripts) checks.push(userScripts);
			return checks;
		} catch (err) {
			return [
				{
					id: "connected",
					status: "fail",
					label: "Extension connected but not responding",
					detail: err instanceof Error ? err.message : String(err),
					fix: "tabkyra reload",
				},
			];
		} finally {
			client.close();
		}
	}
	return [notConnected];
}

function harnessChecks(): Check[] {
	return harnesses()
		.filter((h) => h.detected)
		.map((h): Check => {
			const id = `mcp:${h.id}`;
			if (h.configured === true) return { id, status: "ok", label: `${h.name}: Tabkyra MCP server configured` };
			const replace = h.configured === "stale" || h.configured === "other";
			let fix: string;
			if (h.addCommand) fix = replace && h.removeCommand ? `${shellJoin(h.removeCommand)} && ${shellJoin(h.addCommand)}` : shellJoin(h.addCommand);
			else if (h.snippet?.startsWith("{")) fix = `${replace ? "Replace the tabkyra entry in" : "Add this to"} ${h.configFile}:\n${h.snippet}`;
			else fix = h.snippet ?? "";
			if (h.configured === undefined) {
				return {
					id,
					status: "warn",
					label: `${h.name}: couldn't tell whether Tabkyra is configured`,
					detail: h.note ?? (h.configFile ? `${h.configFile} could not be parsed.` : `\`${h.id} mcp get tabkyra\` failed or printed something unexpected.`),
					fix: h.configFile ? `Check ${h.configFile}` : `${h.id} mcp get tabkyra`,
				};
			}
			if (h.configured === "stale") {
				return { id, status: "fail", label: `${h.name}: the tabkyra entry points at a missing command`, detail: h.currentCommand, fix };
			}
			if (h.configured === "other") {
				// Could be the user's own wrapper; flag it, don't fail on it.
				return { id, status: "warn", label: `${h.name}: the tabkyra entry runs a different command`, detail: h.currentCommand, fix };
			}
			return {
				id,
				// A harness the user doesn't browse from shouldn't fail the run; Claude Code and
				// Codex are fixed with one command, so those count.
				status: h.id === "claude" || h.id === "codex" ? "fail" : "warn",
				label: `${h.name}: Tabkyra MCP server not configured`,
				fix,
			};
		});
}

export async function runDoctor(options: { json: boolean }): Promise<number> {
	const checks: Check[] = [nodeCheck(), buildCheck(), launcherCheck(), ...hostChecks(), ...(await connectionChecks()), ...harnessChecks()];
	const failed = checks.filter((check) => check.status === "fail").length;
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok: failed === 0, version: VERSION, checks }, null, 2)}\n`);
		return failed === 0 ? 0 : 1;
	}
	console.log(banner(`doctor ${VERSION}`));
	console.log();
	for (const check of checks) {
		const mark = check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail;
		console.log(`${mark} ${check.label}`);
		if (check.detail && check.status !== "ok") console.log(`  ${c.dim(check.detail)}`);
		if (check.fix) {
			const [first, ...rest] = check.fix.split("\n");
			console.log(`  ${sym.arrow} ${c.bold(first)}`);
			for (const line of rest) console.log(`    ${line}`);
		}
	}
	console.log();
	console.log(
		failed === 0
			? `${sym.ok} ${c.bold("All checks passed.")}`
			: `${sym.fail} ${c.bold(`${failed} check${failed === 1 ? "" : "s"} failed.`)} Run the ${sym.arrow} command under each, then run ${c.bold("tabkyra doctor")} again.`,
	);
	return failed === 0 ? 0 : 1;
}
