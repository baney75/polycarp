/**
 * `tabkyra hub setup|serve|code|devices|remove|prefer|status|off`: run the hub on an always-on box (D32).
 * Setup writes hub.json, sets the passcode and installs a user service that runs `hub serve`. The
 * service code is shared with `remote setup` (service.ts).
 */

import { existsSync, rmSync } from "node:fs";
import { launcherValid, tabkyraBinary } from "./harness.ts";
import { type HubConfig, hubFile, liveFile, loadDevices, loadHubConfig, mintConnectCode, readLive, removeDevice, removeHubConfig, saveHubConfig, setPrefer } from "./hub-state.ts";
import { startHub } from "./hub-server.ts";
import { printCode } from "./link.ts";
import { passcodeSet, setPasscode } from "./oauth.ts";
import { type Check, dnsCheck, METADATA_PATH, metadata, probeLocal, remoteFile, waitForServe } from "./remote-setup.ts";
import { HUB_SERVICE, installService, removeService, serviceLogHint } from "./service.ts";
import { DEFAULT_PORT } from "./tunnel.ts";
import { c, sym } from "./ui.ts";

const ago = (iso: string | null): string => {
	if (!iso) return "never";
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	return seconds < 120 ? `${seconds}s ago` : seconds < 7200 ? `${Math.round(seconds / 60)}m ago` : `${Math.round(seconds / 3600)}h ago`;
};

// ---------- hub setup ----------

export interface HubSetupOptions {
	publicUrl: string;
	port?: number;
	service: boolean;
	json: boolean;
}

export async function hubSetup(options: HubSetupOptions): Promise<number> {
	const say = (line: string) => {
		if (!options.json) console.log(line);
	};
	const fail = (message: string): number => {
		if (options.json) console.log(JSON.stringify({ ok: false, error: message }));
		else console.error(`${sym.fail} ${message}`);
		return 1;
	};
	if (existsSync(remoteFile())) return fail(`This install already has a public route (${remoteFile()}), and an install has one. Run tabkyra remote off first. Nothing was changed.`);
	let previous: HubConfig | undefined;
	try {
		previous = loadHubConfig();
	} catch (err) {
		return fail(`${err instanceof Error ? err.message : String(err)} Nothing was changed.`);
	}
	const port = options.port ?? previous?.port ?? DEFAULT_PORT;
	if (options.service && !launcherValid()) return fail(`${tabkyraBinary()} isn't a working launcher, so the service would have nothing to start. Run tabkyra install first, then tabkyra hub setup again. Nothing was changed.`);
	const probe = await probeLocal(port, options.publicUrl);
	if (probe.state === "other" && !options.service) return fail(`Something already listens on 127.0.0.1:${port} and isn't a Tabkyra server for ${options.publicUrl} (${probe.detail}). Nothing was changed.`);
	let passcode: string | undefined;
	if (!passcodeSet()) {
		passcode = setPasscode();
		say(`${sym.ok} OAuth passcode:\n\n  ${passcode}\n`);
		say(c.dim("Shown once. Type it on the approval page when claude.ai, ChatGPT or grok.com connects (a one-time connect code from tabkyra token approval-code works too). tabkyra token passcode replaces it; grants already approved keep working."));
	}
	saveHubConfig({ publicUrl: options.publicUrl, port });
	say(`${sym.ok} Wrote ${c.dim(hubFile())}`);
	let serviceMessage = "no service";
	if (options.service) {
		const service = await installService(HUB_SERVICE);
		serviceMessage = service.message;
		say(`${service.ok ? sym.ok : sym.fail} ${service.message}`);
		if (!service.ok) return fail(`The service didn't start. hub.json is kept; fix the cause and run tabkyra hub setup again.`);
		if (!(await waitForServe(port, options.publicUrl, 15_000))) return fail(`The hub isn't answering on 127.0.0.1:${port} with ${options.publicUrl}/mcp after 15 seconds. Look in ${serviceLogHint(HUB_SERVICE)}. hub.json is kept; fix the cause and run tabkyra hub setup again.`);
	} else {
		say(`${sym.dot} No service installed. Start it yourself: ${c.bold("tabkyra hub serve")}`);
	}
	if (options.json) {
		console.log(JSON.stringify({ ok: true, publicUrl: options.publicUrl, port, connectorUrl: `${options.publicUrl}/mcp`, ...(passcode ? { passcode } : {}), service: serviceMessage }, null, 2));
		return 0;
	}
	console.log(`
Connector URL: ${c.bold(`${options.publicUrl}/mcp`)}

Point your HTTPS front door (a Cloudflare named tunnel works) at http://127.0.0.1:${port}.
Then, on each device that has a browser with Tabkyra:
  1. here:       tabkyra hub code
  2. on device:  tabkyra link ${options.publicUrl} --code <code>
Add the connector URL once in claude.ai, ChatGPT or grok.com. Check it with: tabkyra hub status`);
	return 0;
}

// ---------- hub serve ----------

/** Errors that belong to one peer's connection, not to the hub's own code. */
const CONNECTION_ERRORS = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT", "ERR_STREAM_PREMATURE_CLOSE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

/**
 * Last resort. The handlers attach their own error listeners; if a connection error still escapes
 * one, log it loudly and keep serving, because a stranger's reset must not drop every device. Any
 * other uncaught error is a bug in the hub: log it with its stack and exit, so the service manager
 * restarts a clean process instead of one in an unknown state.
 */
function guardConnections(): void {
	process.on("uncaughtException", (err) => {
		const code = (err as NodeJS.ErrnoException).code ?? "";
		if (CONNECTION_ERRORS.has(code)) {
			process.stderr.write(`[tabkyra hub] a connection error escaped its handler and was survived (${code}): ${err.stack ?? err.message}\n`);
			return;
		}
		process.stderr.write(`[tabkyra hub] UNCAUGHT ERROR, exiting so the service restarts: ${err.stack ?? err.message}\n`);
		process.exit(1);
	});
}

export async function hubServe(overrides: { port?: number; publicUrl?: string }): Promise<void> {
	const saved = overrides.publicUrl === undefined ? loadHubConfig() : undefined;
	const publicUrl = overrides.publicUrl ?? saved?.publicUrl;
	if (!publicUrl) throw new Error("No public URL. Run tabkyra hub setup --public-url https://host, or pass --public-url.");
	const port = overrides.port ?? saved?.port ?? DEFAULT_PORT;
	if (!passcodeSet()) console.log(`${sym.warn} No OAuth passcode yet; only a connect code (tabkyra token approval-code) can approve a connection. Run: tabkyra token passcode`);
	guardConnections();
	// TABKYRA_HUB_HEAD_TIMEOUT_MS and TABKYRA_HUB_SLOW_CLIENT_MS shorten the head wait and the slow-client wait; the tests use them.
	const positive = (name: string) => {
		const n = Number(process.env[name]);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	const headTimeoutMs = positive("TABKYRA_HUB_HEAD_TIMEOUT_MS");
	const slowClientMs = positive("TABKYRA_HUB_SLOW_CLIENT_MS");
	const { url } = await startHub({ port, publicUrl, ...(headTimeoutMs ? { headTimeoutMs } : {}), ...(slowClientMs ? { slowClientMs } : {}) });
	console.log(`${sym.ok} Hub at ${url} (loopback only). Connector URL: ${publicUrl}/mcp. Ctrl-C stops it.`);
	await new Promise(() => {});
}

// ---------- hub code ----------

export function hubCode(options: { name?: string; manage: boolean; json: boolean }): number {
	let config: HubConfig | undefined;
	try {
		config = loadHubConfig();
	} catch {
		config = undefined;
	}
	try {
		const { code, expiresAt } = mintConnectCode({ name: options.name, manage: options.manage });
		if (options.json) console.log(JSON.stringify({ ok: true, kind: "connect", code, expiresAt, manage: options.manage, ...(options.name ? { name: options.name } : {}), ...(config ? { hubUrl: config.publicUrl } : {}) }, null, 2));
		else printCode("connect", code, expiresAt, undefined, config?.publicUrl);
		return 0;
	} catch (err) {
		console.error(`${sym.fail} ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

// ---------- hub devices / remove / prefer ----------

export function hubDevices(json: boolean): number {
	const { devices, prefer } = loadDevices();
	const live = readLive();
	const rows = devices.map((d) => {
		const l = live?.devices.find((x) => x.id === d.id);
		return {
			name: d.name,
			id: d.id,
			online: l?.online ?? false,
			extensionConnected: l?.extensionConnected ?? false,
			sessions: l?.sessions ?? 0,
			busy: l?.busy ?? false,
			lastSeen: l?.lastSeen ?? d.lastSeen ?? null,
			version: l?.version ?? d.version ?? null,
			manager: d.manage,
		};
	});
	if (json) {
		console.log(JSON.stringify({ hubRunning: Boolean(live), prefer, devices: rows }, null, 2));
		return 0;
	}
	if (!rows.length) {
		console.log(`${sym.dot} No devices. Run tabkyra hub code, then tabkyra link on a device.`);
		return 0;
	}
	if (!live) console.log(`${sym.warn} The hub isn't running, so every device shows offline.`);
	for (const r of rows) {
		const state = r.online ? c.green("online ") : c.dim("offline");
		console.log(
			`${state} ${r.name.padEnd(16)} ${c.dim(r.id)}  extension ${r.extensionConnected ? "yes" : "no "}  sessions ${String(r.sessions).padEnd(3)} ${r.busy ? "busy " : "      "}${c.dim(`seen ${ago(r.lastSeen)}`)}${r.version ? c.dim(`  v${r.version}`) : ""}${r.manager ? c.dim("  manager") : ""}`,
		);
	}
	if (prefer.length) console.log(c.dim(`Tie-break order: ${prefer.join(", ")}`));
	return 0;
}

export function hubRemove(nameOrId: string): number {
	const gone = removeDevice(nameOrId);
	if (!gone) {
		console.error(`${sym.fail} No device named or numbered ${nameOrId}. tabkyra hub devices lists them.`);
		return 1;
	}
	console.log(`${sym.ok} Removed ${gone.name} (${gone.id}). Its credential no longer works; a running hub closes its link within a second.`);
	return 0;
}

export function hubPrefer(list: string): number {
	const names = list.split(",").map((x) => x.trim()).filter(Boolean);
	const known = new Set(loadDevices().devices.map((d) => d.name));
	const unknown = names.filter((n) => !known.has(n));
	if (!names.length || unknown.length) {
		console.error(`${sym.fail} ${names.length ? `No device named ${unknown.join(", ")}.` : "Name at least one device."} tabkyra hub devices lists them.`);
		return 1;
	}
	setPrefer([...new Set(names)]);
	console.log(`${sym.ok} When devices tie, the hub prefers: ${[...new Set(names)].join(", ")}.`);
	return 0;
}

// ---------- hub status ----------

export async function hubStatus(json: boolean): Promise<number> {
	const checks: Check[] = [];
	let config: HubConfig | undefined;
	try {
		config = loadHubConfig();
	} catch (err) {
		checks.push({ name: "hub.json", status: "fail", detail: err instanceof Error ? err.message : String(err) });
	}
	if (config) checks.push({ name: "hub.json", status: "ok", detail: `${config.publicUrl}, local port ${config.port}` });
	else if (!checks.length) checks.push({ name: "hub.json", status: "fail", detail: `${hubFile()} not found. Run tabkyra hub setup --public-url https://host.` });
	if (config) {
		const passcode = passcodeSet();
		checks.push({ name: "passcode", status: passcode ? "ok" : "warn", detail: passcode ? "set" : "not set; only connect codes (tabkyra token approval-code) can approve a connection. tabkyra token passcode sets one." });
		const local = await probeLocal(config.port, config.publicUrl, 3000);
		const where = `http://127.0.0.1:${config.port}${METADATA_PATH}`;
		checks.push({
			name: "local hub",
			status: local.state === "match" ? "ok" : "fail",
			detail: local.state === "match" ? `${where} answers with resource ${config.publicUrl}/mcp` : `${where} ${local.state === "none" ? "didn't answer: connection refused" : local.detail}. Is tabkyra hub serve running? tabkyra hub setup starts it.`,
		});
		checks.push(await dnsCheck(new URL(config.publicUrl).hostname));
		const pub = await metadata(`${config.publicUrl}${METADATA_PATH}`, 10_000, config.publicUrl);
		checks.push({ name: "public fetch", status: pub.ok ? "ok" : "fail", detail: pub.detail });
		const live = readLive();
		const { devices } = loadDevices();
		const online = live?.devices.filter((d) => d.online).length ?? 0;
		checks.push({
			name: "devices",
			status: !devices.length ? "warn" : online ? "ok" : "warn",
			detail: !devices.length ? "none enrolled; tabkyra hub code, then tabkyra link on a device" : `${devices.length} enrolled, ${online} online${live ? "" : " (the hub isn't running)"}; tabkyra hub devices has the detail`,
		});
	}
	const ok = checks.every((x) => x.status !== "fail");
	if (json) {
		console.log(JSON.stringify({ ok, publicUrl: config?.publicUrl ?? null, checks }, null, 2));
		return ok ? 0 : 1;
	}
	for (const check of checks) console.log(`${check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail} ${check.name.padEnd(13)} ${c.dim(check.detail)}`);
	return ok ? 0 : 1;
}

// ---------- hub off ----------

export function hubOff(): number {
	const service = removeService(HUB_SERVICE);
	if (!service.ok) {
		console.error(`${sym.fail} ${service.failure}`);
		return 1;
	}
	for (const note of service.notes) console.log(`${sym.ok} ${note}`);
	if (existsSync(hubFile())) {
		removeHubConfig();
		console.log(`${sym.ok} Removed ${c.dim(hubFile())}`);
	} else {
		console.log(`${sym.dot} No hub.json; nothing else to remove.`);
	}
	rmSync(liveFile(), { force: true });
	console.log(c.dim("Devices stay enrolled in hub-devices.json and approvals in oauth.json. tabkyra hub remove <device> and tabkyra token revoke <client id> end them for good."));
	return 0;
}
