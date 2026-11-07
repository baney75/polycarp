/**
 * `polycarp browser doctor`: every check that has to pass for an agent to drive a tab, with
 * one exact fix per failure. Exits 1 when any check fails.
 */

import { COMMAND_NAME } from "./self.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_HOST_NAME, type UserScriptsStatus } from "../../src/bridge/protocol.ts";
import { BridgeClient, listSockets } from "./client.ts";
import { harnesses, launcherValid, shellJoin } from "./harness.ts";
import { cliLauncherPath, extensionOrigins, hostTarget, installedBrowserDirs, launcherPath, manifestLauncherRuns, originsCurrent } from "./install.ts";
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
				detail: `Polycarp needs Node ${MIN_NODE_MAJOR} or newer.`,
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
		return { id: "build", status: "fail", label: "Extension build missing", detail: `${dir} is missing or incomplete.`, fix: `${COMMAND_NAME} setup` };
	}
	if (state === "stale") {
		return {
			id: "build",
			status: "fail",
			label: `Extension build ${builtVersion()} does not match this checkout (${sourceVersion()})`,
			detail: "dist-chrome was built from a different version of the source.",
			fix: `${COMMAND_NAME} setup`,
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
				fix: `${COMMAND_NAME} install --force`,
			};
}

/** `live`: browsers a running connection names, which count as installed even if their app can't be found. */
function hostChecks(live: readonly string[] = []): Check[] {
	if (process.platform === "win32") {
		return [
			{
				id: "host",
				status: "warn",
				label: "Native host registration is not checked on Windows",
				detail: `${COMMAND_NAME} install writes HKCU\\Software\\<browser>\\NativeMessagingHosts keys; run it again if the extension can't connect.`,
				fix: `${COMMAND_NAME} install --force`,
			},
		];
	}
	const origins = extensionOrigins();
	// What a manifest may name: the helper inside Polycarp, or the standalone launcher (a standalone Polycarp's own manifest is fine).
	const accepted = [...new Set([hostTarget(), launcherPath()])];
	// Only browsers that are really installed: a data folder outlives the app.
	const found = installedBrowserDirs(live);
	if (found.length === 0) {
		return [
			{
				id: "host",
				status: "fail",
				label: "No Chromium browser found",
				detail: "Polycarp works with Helium, Chrome, Chromium, Brave, Edge, Arc, Vivaldi and Opera.",
				fix: `Install a Chromium browser, then run: ${COMMAND_NAME} setup`,
			},
		];
	}
	const installFix = (name: string): string => `${COMMAND_NAME} install --browser ${shellJoin([name])}`;
	return found.map(({ name, dir }) => {
		const file = join(dir, "NativeMessagingHosts", `${NATIVE_HOST_NAME}.json`);
		const fail = (detail: string): Check => ({
			id: `host:${name}`,
			status: "fail",
			label: `${name}: native host ${existsSync(file) ? "manifest is wrong" : "not registered"}`,
			detail,
			fix: installFix(name),
		});
		// A browser that was simply never connected is news, not a failure: one-browser Connect leaves the others alone.
		if (!existsSync(file)) {
			return { id: `host:${name}`, status: "warn", label: `${name}: not connected yet`, detail: "Polycarp isn't set up in this browser.", fix: installFix(name) };
		}
		let manifest: { name?: string; path?: string; allowed_origins?: string[] };
		try {
			manifest = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return fail(`${file} is not valid JSON`);
		}
		if (manifest.name !== NATIVE_HOST_NAME) return fail(`name is ${manifest.name}, expected ${NATIVE_HOST_NAME}`);
		if (!originsCurrent(manifest.allowed_origins ?? [])) {
			return fail(`allowed_origins is ${JSON.stringify(manifest.allowed_origins ?? [])}, expected ${JSON.stringify(origins)}`);
		}
		const path = manifest.path ?? "";
		if (!accepted.includes(path)) return fail(`path is ${manifest.path}, expected ${accepted.join(" or ")}`);
		// The file the manifest names must run: exist, be executable, and (for a launcher script) point at a program that is still there.
		if (!manifestLauncherRuns(path)) return fail(`${path} is missing, not executable, or runs a program that is gone`);
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
	`Open the Polycarp side panel > Settings > Agents > Page scripts and click Allow, then accept the browser's prompt. If doctor still warns, run ${COMMAND_NAME} reload.`;

/** The "Allow user scripts" row of `polycarp browser doctor`, or undefined when there is nothing to say. */
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
					detail: `${slow} Either "Allow user scripts" is off on the extension's Details page, or Polycarp hasn't restarted since the permission was granted.`,
					fix: `Check "Allow user scripts" at chrome://extensions > Polycarp > Details, then ${COMMAND_NAME} reload`,
				};
			}
			return {
				id: "user-scripts",
				status: "warn",
				label: '"Allow user scripts" is off',
				detail: `${slow} The permission is granted, but the browser refuses userScripts calls until the toggle is on.${status.error ? ` Browser said: ${status.error}` : ""}`,
				fix: `Turn on "Allow user scripts" at chrome://extensions > Polycarp > Details, then ${COMMAND_NAME} reload`,
			};
		case "probe_error":
			return {
				id: "user-scripts",
				status: "warn",
				label: "Couldn't tell whether user scripts work",
				detail: `${slow} The check failed: ${status.error ?? "no error text"}`,
				fix: `${COMMAND_NAME} reload, then ${COMMAND_NAME} doctor`,
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
		fix: `${COMMAND_NAME} update or rebuild the CLI so doctor can name the cause`,
	};
}

/** A worker this young may not have settled since `polycarp browser reload`; ask it again once. */
const SETTLE_S = 10;
const RETRY_MS = 1500;

export async function connectionChecks(): Promise<{ checks: Check[]; holders: string[] }> {
	const notConnected: Check = {
		id: "connected",
		status: "fail",
		label: "Extension not connected",
		detail: "No running browser has the Polycarp extension loaded, or it has not reached the native host yet.",
		// Not `setup`: it registers browsers, and registration isn't what is missing when the host never heard from the extension.
		fix: `Open your browser and load the Polycarp extension (chrome://extensions > Load unpacked > ${extensionDir()}), then run ${COMMAND_NAME} doctor again`,
	};
	let sockets: string[];
	try {
		sockets = listSockets();
	} catch (err) {
		return { checks: [{ ...notConnected, detail: err instanceof Error ? err.message : String(err) }], holders: [] };
	}
	// Every live browser connection, each with the browser that holds it (the host knows its parent process). All are asked at
	// once under one deadline, so browsers that don't answer cost the run one wait, not one each.
	const clients: BridgeClient[] = [];
	const seen: Array<Held | undefined> = sockets.map(() => undefined);
	const asked = sockets.map((path, i) => askSocket(path, clients, (held) => { seen[i] = held; }));
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([Promise.all(asked), new Promise<void>((resolve) => { timer = setTimeout(resolve, CONNECT_DEADLINE_MS); })]);
	if (timer) clearTimeout(timer);
	for (const client of clients) client.close();
	const live = seen.filter((held): held is Held => held !== undefined);
	// The overall line comes from the first connection that answered; only when none did, from the first one there is.
	const primary = live.find((held) => held.info) ?? live[0];
	const checks: Check[] = [];
	for (const held of live) {
		const isFirst = held === primary;
		const { holder } = held;
		if (held.info) {
			const version = held.info.version ?? "unknown version";
			if (holder) checks.push({ id: `connected:${holder}`, status: "ok", label: `${holder}: extension connected (${version})`, detail: held.path });
			if (!isFirst) continue;
			checks.unshift({ id: "connected", status: "ok", label: `Extension connected (${version})`, detail: held.path });
			const built = builtVersion();
			if (built && held.info.version && built !== held.info.version) {
				checks.push({
					id: "loaded-version",
					status: "fail",
					label: `The browser runs extension ${held.info.version}, the build is ${built}`,
					fix: `${COMMAND_NAME} reload`,
				});
			}
			const userScripts = userScriptsCheck(held.info);
			if (userScripts) checks.push(userScripts);
			continue;
		}
		// Connected, but bridge.debug failed or timed out: the browser is live, so it still gets its own line.
		if (holder) {
			checks.push({
				id: `connected:${holder}`,
				status: "warn",
				label: `${holder}: extension connected but not responding (unknown version)`,
				detail: held.error,
				fix: `${COMMAND_NAME} reload`,
			});
		}
		if (isFirst) {
			checks.unshift({
				id: "connected",
				status: "fail",
				label: "Extension connected but not responding",
				detail: held.error,
				fix: `${COMMAND_NAME} reload`,
			});
		}
	}
	return { checks: checks.length ? checks : [notConnected], holders: live.flatMap((held) => (held.holder ? [held.holder] : [])) };
}

/** One live connection: where it is, which browser holds it, and what bridge.debug said (or why it said nothing). */
interface Held {
	path: string;
	holder?: string;
	info?: DebugInfo;
	error?: string;
}

/** Everything doctor does with all its sockets has to finish inside this; the app stops waiting for doctor at 12 seconds. */
const CONNECT_DEADLINE_MS = 8000;

async function askSocket(path: string, clients: BridgeClient[], report: (held: Held) => void): Promise<void> {
	const client = new BridgeClient({ name: "doctor" });
	clients.push(client);
	try {
		await client.connect(path);
	} catch {
		return;
	}
	if (!client.extensionConnected) return;
	const holder = client.hostBrowserName;
	// Until it answers, this connection stands as one that did not: the deadline may arrive first.
	report({ path, holder, error: `no answer from bridge.debug within ${CONNECT_DEADLINE_MS / 1000} seconds` });
	try {
		let info = (await client.call("bridge.debug", {}, 5000)) as DebugInfo;
		if (userScriptsCheck(info) && (info.workerUptimeS ?? SETTLE_S) < SETTLE_S) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			// A worker still restarting may not answer again; the first answer stands then.
			info = ((await client.call("bridge.debug", {}, 5000).catch(() => undefined)) as DebugInfo | undefined) ?? info;
		}
		report({ path, holder, info });
	} catch (err) {
		report({ path, holder, error: err instanceof Error ? err.message : String(err) });
	}
}

function harnessChecks(): Check[] {
	return harnesses()
		.filter((h) => h.detected)
		.map((h): Check => {
			const id = `mcp:${h.id}`;
			if (h.configured === true) return { id, status: "ok", label: `${h.name}: Polycarp MCP server configured` };
			const replace = h.configured === "stale" || h.configured === "other";
			let fix: string;
			if (h.addCommand) fix = replace && h.removeCommand ? (h.oldName ? `${shellJoin(h.addCommand)} && ${shellJoin(h.removeCommand)}` : `${shellJoin(h.removeCommand)} && ${shellJoin(h.addCommand)}`) : shellJoin(h.addCommand);
			else if (h.snippet?.startsWith("{")) fix = `${replace ? "Replace the Polycarp entry in" : "Add this to"} ${h.configFile}:\n${h.snippet}`;
			else fix = h.snippet ?? "";
			if (h.configured === undefined) {
				return {
					id,
					status: "warn",
					label: `${h.name}: couldn't tell whether Polycarp is configured`,
					detail: h.note ?? (h.configFile ? `${h.configFile} could not be parsed.` : `\`${h.id} mcp get polycarp\` failed or printed something unexpected.`),
					fix: h.configFile ? `Check ${h.configFile}` : `${h.id} mcp get polycarp`,
				};
			}
			if (h.configured === "stale") {
				return { id, status: "fail", label: h.oldName ? `${h.name}: Polycarp's entry is under its old name` : `${h.name}: the polycarp entry points at a missing command`, detail: h.currentCommand, fix };
			}
			if (h.configured === "other") {
				// Could be the user's own wrapper; flag it, don't fail on it.
				return { id, status: "warn", label: `${h.name}: the polycarp entry runs a different command`, detail: h.currentCommand, fix };
			}
			return {
				id,
				// A harness the user doesn't browse from shouldn't fail the run; Claude Code and
				// Codex are fixed with one command, so those count.
				status: h.id === "claude" || h.id === "codex" ? "fail" : "warn",
				label: `${h.name}: Polycarp MCP server not configured`,
				fix,
			};
		});
}

export async function runDoctor(options: { json: boolean }): Promise<number> {
	const connection = await connectionChecks();
	const checks: Check[] = [nodeCheck(), buildCheck(), launcherCheck(), ...hostChecks(connection.holders), ...connection.checks, ...harnessChecks()];
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
			: `${sym.fail} ${c.bold(`${failed} check${failed === 1 ? "" : "s"} failed.`)} Run the ${sym.arrow} command under each, then run ${c.bold(`${COMMAND_NAME} doctor`)} again.`,
	);
	return failed === 0 ? 0 : 1;
}
