/**
 * `tabkyra remote setup|status|off`: one command that makes `tabkyra serve` reachable by claude.ai,
 * ChatGPT and grok.com, for free and with no domain (D31). Setup writes remote.json, opens
 * Tailscale Funnel on its own port (or takes the user's own HTTPS front door), sets the owner
 * passcode, and installs a user service that keeps `tabkyra serve` running. `serve` reads
 * remote.json when `--public-url` is absent.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { launcherValid, tabkyraBinary, which } from "./harness.ts";
import { configDir, listClients, passcodeSet, setPasscode } from "./oauth.ts";
import { DEFAULT_PORT } from "./tunnel.ts";
import { c, sym } from "./ui.ts";

/** Funnel's own port: keeps the OAuth paths at the root and anything on 443 private. */
export const FUNNEL_PORT = 8443;
const LAUNCHD_LABEL = "com.tabkyra.serve";
const SYSTEMD_UNIT = "tabkyra-serve.service";
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

export interface RemoteConfig {
	publicUrl: string;
	port: number;
	route: "funnel" | "custom";
	redirectHosts?: string[];
	allowHosts?: string[];
}

export const remoteFile = () => join(configDir(), "remote.json");

const stringList = (value: unknown, field: string): string[] | undefined => {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) throw new Error(`${remoteFile()}: ${field} must be a list of strings.`);
	return value as string[];
};

/** remote.json, or undefined when it doesn't exist. A file that exists but is wrong throws, so serve never silently drops it. */
export function loadRemoteConfig(): RemoteConfig | undefined {
	if (!existsSync(remoteFile())) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(remoteFile(), "utf8")) as Record<string, unknown>;
	} catch {
		throw new Error(`${remoteFile()} isn't valid JSON. Run tabkyra remote setup again, or delete it.`);
	}
	if (!raw || typeof raw !== "object") throw new Error(`${remoteFile()} isn't a Tabkyra remote file.`);
	if (typeof raw.publicUrl !== "string" || !raw.publicUrl) throw new Error(`${remoteFile()}: publicUrl is missing.`);
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new Error(`${remoteFile()}: port must be a port number.`);
	if (raw.route !== "funnel" && raw.route !== "custom") throw new Error(`${remoteFile()}: route must be funnel or custom.`);
	const redirectHosts = stringList(raw.redirectHosts, "redirectHosts");
	const allowHosts = stringList(raw.allowHosts, "allowHosts");
	return { publicUrl: raw.publicUrl, port: raw.port, route: raw.route, ...(redirectHosts ? { redirectHosts } : {}), ...(allowHosts ? { allowHosts } : {}) };
}

function writeAtomic(path: string, text: string, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	renameSync(tmp, path);
}

export function saveRemoteConfig(config: RemoteConfig): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeAtomic(remoteFile(), `${JSON.stringify(config, null, "\t")}\n`, 0o600);
}

function run(cmd: string, args: string[]): { code: number; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000 });
	if (r.error) return { code: 1, out: r.error.message };
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

// ---------- Tailscale Funnel ----------

type FunnelPlan = { ok: true; bin: string; dns: string } | { ok: false; message: string };

/** Everything that can refuse Funnel, checked before anything changes. */
function planFunnel(port: number): FunnelPlan {
	const bin = which("tailscale");
	if (!bin) return { ok: false, message: "Tailscale isn't installed. Install it from tailscale.com, or use --public-url with your own tunnel (a free Cloudflare named tunnel works)." };
	if (/tailnet lock is enabled/i.test(run(bin, ["lock", "status"]).out)) {
		return {
			ok: false,
			message:
				"This tailnet has Tailnet Lock on, and Tailscale Funnel doesn't work on a Tailnet Lock tailnet. Nothing was changed. Use --public-url with a Cloudflare named tunnel (free); docs/remote.md has the steps.",
		};
	}
	let dns = "";
	try {
		dns = String((JSON.parse(run(bin, ["status", "--json"]).out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
	} catch {
		/* reported below */
	}
	if (!dns) return { ok: false, message: "Tailscale isn't connected. Run tailscale up, then try again." };
	const serveStatus = run(bin, ["serve", "status", "--json"]);
	let web: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
	try {
		if (serveStatus.code !== 0) throw new Error("serve status failed");
		web = (JSON.parse(serveStatus.out || "{}") as { Web?: typeof web }).Web ?? {};
	} catch {
		return { ok: false, message: "Couldn't read tailscale serve status, so nothing was changed." };
	}
	const existing = web[`${dns}:${FUNNEL_PORT}`];
	if (existing) {
		const ours = new Set([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, `http://localhost:${port}`, `http://localhost:${port}/`]);
		const others = Object.entries(existing.Handlers ?? {}).filter(([, h]) => !h.Proxy || !ours.has(h.Proxy));
		if (others.length) {
			return {
				ok: false,
				message: `Port ${FUNNEL_PORT} on this machine already serves something else (${others.map(([path]) => path).join(", ")}). Funnel would make it public, so nothing was changed. Turn that off in Tailscale first, or use --public-url.`,
			};
		}
	}
	return { ok: true, bin, dns };
}

// ---------- User service ----------

const xml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const systemdQuote = (text: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `"${text.replace(/(["\\])/g, "\\$1")}"`);

/** Environment the service needs when this shell moved Tabkyra's state somewhere other than the default. */
function serviceEnvironment(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of ["TABKYRA_CONFIG_DIR", "TABKYRA_SOCKET_DIR"]) if (process.env[name]) out[name] = process.env[name] as string;
	return out;
}

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const unitPath = () => join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
const launchdTarget = () => `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`;

export function plistText(binary: string, env: Record<string, string>, log: string): string {
	const vars = Object.entries(env)
		.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>\n`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(binary)}</string>
		<string>serve</string>
	</array>
${vars ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${vars}\t</dict>\n` : ""}	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function unitText(binary: string, env: Record<string, string>): string {
	const vars = Object.entries(env)
		.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`)
		.join("");
	return `[Unit]
Description=Tabkyra serve (MCP over HTTP for claude.ai, ChatGPT and grok.com)

[Service]
ExecStart=${systemdQuote(binary)} serve
${vars}Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Install and (re)start the user service. Returns the step that failed, if any; the file is written either way. */
function installService(): { ok: boolean; message: string; file?: string } {
	const binary = tabkyraBinary();
	const env = serviceEnvironment();
	if (process.platform === "darwin") {
		const log = join(homedir(), "Library", "Logs", "tabkyra-serve.log");
		mkdirSync(dirname(log), { recursive: true });
		writeAtomic(plistPath(), plistText(binary, env, log), 0o644);
		run("launchctl", ["bootout", launchdTarget()]);
		const r = run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath()]);
		return { ok: r.code === 0, file: plistPath(), message: r.code === 0 ? `Service installed (${plistPath()}); logs in ${log}.` : `launchctl bootstrap failed: ${r.out}. Run: launchctl bootstrap gui/${process.getuid?.() ?? 0} ${plistPath()}` };
	}
	if (process.platform === "linux") {
		writeAtomic(unitPath(), unitText(binary, env), 0o644);
		for (const args of [["daemon-reload"], ["enable", SYSTEMD_UNIT], ["restart", SYSTEMD_UNIT]]) {
			const r = run("systemctl", ["--user", ...args]);
			if (r.code !== 0) return { ok: false, file: unitPath(), message: `systemctl --user ${args.join(" ")} failed: ${r.out}. The unit is at ${unitPath()}.` };
		}
		return { ok: true, file: unitPath(), message: `Service installed (${unitPath()}); journalctl --user -u ${SYSTEMD_UNIT} shows its log.` };
	}
	return { ok: false, message: `No service manager is set up for ${process.platform}. Keep it running yourself: ${binary} serve` };
}

function removeService(): string[] {
	const notes: string[] = [];
	if (process.platform === "darwin" && existsSync(plistPath())) {
		run("launchctl", ["bootout", launchdTarget()]);
		rmSync(plistPath(), { force: true });
		notes.push(`Stopped and removed ${plistPath()}.`);
	} else if (process.platform === "linux" && existsSync(unitPath())) {
		run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
		rmSync(unitPath(), { force: true });
		run("systemctl", ["--user", "daemon-reload"]);
		notes.push(`Stopped and removed ${unitPath()}.`);
	}
	return notes;
}

// ---------- remote setup ----------

export interface SetupOptions {
	/** A normalized origin, or undefined for the Tailscale Funnel route. */
	publicUrl?: string;
	port?: number;
	service: boolean;
}

export function remoteSetup(options: SetupOptions): number {
	const port = options.port ?? DEFAULT_PORT;
	let previous: RemoteConfig | undefined;
	try {
		previous = loadRemoteConfig();
	} catch {
		previous = undefined;
	}
	let publicUrl: string;
	let route: RemoteConfig["route"];
	if (options.publicUrl) {
		publicUrl = options.publicUrl;
		route = "custom";
		if (previous?.route === "funnel") console.log(`${sym.warn} Funnel from an earlier setup is still on. ${c.bold("tabkyra remote off")} turns it off (then run setup again).`);
	} else {
		const plan = planFunnel(port);
		if (!plan.ok) {
			console.error(`${sym.fail} ${plan.message}`);
			return 1;
		}
		const r = run(plan.bin, ["funnel", "--bg", "--yes", `--https=${FUNNEL_PORT}`, `http://127.0.0.1:${port}`]);
		if (r.code !== 0) {
			console.error(`${sym.fail} tailscale funnel failed: ${r.out}`);
			return 1;
		}
		publicUrl = `https://${plan.dns}:${FUNNEL_PORT}`;
		route = "funnel";
		console.log(`${sym.ok} Tailscale Funnel on ${publicUrl} ${c.dim(`-> 127.0.0.1:${port}`)}`);
	}
	if (!passcodeSet()) {
		const passcode = setPasscode();
		console.log(`${sym.ok} OAuth passcode:\n\n  ${passcode}\n`);
		console.log(c.dim("Shown once. Type it on the approval page when claude.ai, ChatGPT or grok.com connects. Keep it in a password manager, but not one the browser Tabkyra drives can fill. tabkyra token passcode replaces it; grants already approved keep working."));
	}
	saveRemoteConfig({ publicUrl, port, route, ...(previous?.redirectHosts ? { redirectHosts: previous.redirectHosts } : {}), ...(previous?.allowHosts ? { allowHosts: previous.allowHosts } : {}) });
	console.log(`${sym.ok} Wrote ${c.dim(remoteFile())}`);
	let code = 0;
	if (options.service) {
		if (!launcherValid()) console.log(`${sym.warn} ${tabkyraBinary()} isn't a working launcher yet. Run ${c.bold("tabkyra install")} so the service has something to start.`);
		const service = installService();
		console.log(`${service.ok ? sym.ok : sym.fail} ${service.message}`);
		if (!service.ok) code = 1;
	} else {
		console.log(`${sym.dot} No service installed. Start it yourself: ${c.bold("tabkyra serve")}`);
	}
	console.log(`
Connector URL: ${c.bold(`${publicUrl}/mcp`)}

  claude.ai   Settings > Connectors > Add custom connector, paste the URL.
  ChatGPT     Settings > Apps & Connectors (developer mode) > Create, paste the URL, OAuth.
  grok.com    grok.com/connectors > New Connector > Custom, paste the URL.

Approve with your Tabkyra passcode.
Check it with: tabkyra remote status`);
	return code;
}

// ---------- remote status ----------

export interface Check {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

/** 100.64.0.0/10: the address range Tailscale hands out. */
export function inTailnetRange(address: string): boolean {
	const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
	return Boolean(m) && Number(m?.[1]) >= 64 && Number(m?.[1]) <= 127;
}

async function metadata(url: string, timeoutMs: number, publicUrl: string): Promise<{ ok: boolean; detail: string }> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return { ok: false, detail: `${url} answered ${res.status}` };
		const body = (await res.json()) as { resource?: unknown };
		if (body.resource !== `${publicUrl}/mcp`) return { ok: false, detail: `${url} says resource ${String(body.resource)}, expected ${publicUrl}/mcp` };
		return { ok: true, detail: `${url} answers with resource ${publicUrl}/mcp` };
	} catch (err) {
		return { ok: false, detail: `${url} didn't answer: ${err instanceof Error ? err.message : String(err)}` };
	}
}

async function dnsCheck(host: string): Promise<Check> {
	const name = "public DNS";
	if (/^[\d.]+$/.test(host) || host.includes(":")) return { name, status: "ok", detail: `${host} is an address, no DNS to check` };
	const doh = process.env.TABKYRA_DOH_URL || "https://cloudflare-dns.com/dns-query";
	let answer: { Answer?: { type?: number; data?: string }[] };
	try {
		const url = new URL(doh);
		url.searchParams.set("name", host);
		url.searchParams.set("type", "A");
		const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
		answer = (await res.json()) as typeof answer;
	} catch (err) {
		return { name, status: "warn", detail: `couldn't ask public DNS about ${host}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const addresses = (answer.Answer ?? []).filter((a) => a.type === 1 && typeof a.data === "string").map((a) => a.data as string);
	const reachable = addresses.filter((a) => !inTailnetRange(a));
	if (reachable.length) return { name, status: "ok", detail: `${host} resolves publicly to ${reachable.join(", ")}` };
	if (addresses.length) return { name, status: "fail", detail: `${host} resolves only to ${addresses.join(", ")}, a tailnet address. Funnel isn't reaching the internet.` };
	return { name, status: "fail", detail: `public DNS has no A record for ${host}` };
}

export async function remoteStatus(options: { json: boolean }): Promise<number> {
	const checks: Check[] = [];
	let config: RemoteConfig | undefined;
	try {
		config = loadRemoteConfig();
	} catch (err) {
		checks.push({ name: "remote.json", status: "fail", detail: err instanceof Error ? err.message : String(err) });
	}
	if (config) {
		checks.push({ name: "remote.json", status: "ok", detail: `route ${config.route}, ${config.publicUrl}, local port ${config.port}` });
	} else if (!checks.length) {
		checks.push({ name: "remote.json", status: "fail", detail: `${remoteFile()} not found. Run tabkyra remote setup.` });
	}
	let clients = 0;
	if (config) {
		const passcode = passcodeSet();
		checks.push({ name: "passcode", status: passcode ? "ok" : "fail", detail: passcode ? "set" : "not set, so nobody can approve a connection. Run tabkyra token passcode." });
		const local = await metadata(`http://127.0.0.1:${config.port}${METADATA_PATH}`, 3000, config.publicUrl);
		checks.push({ name: "local serve", status: local.ok ? "ok" : "fail", detail: local.ok ? local.detail : `${local.detail}. Is tabkyra serve running? tabkyra remote setup starts it.` });
		checks.push(await dnsCheck(new URL(config.publicUrl).hostname));
		const pub = await metadata(`${config.publicUrl}${METADATA_PATH}`, 10_000, config.publicUrl);
		checks.push({
			name: "public fetch",
			status: pub.ok ? "ok" : "fail",
			detail: `${pub.detail} (from inside a tailnet this may go over the tailnet, so it can pass while the internet can't reach it; the DNS line is the check for that)`,
		});
		try {
			clients = listClients().length;
		} catch {
			clients = 0;
		}
		checks.push({ name: "OAuth clients", status: clients ? "ok" : "warn", detail: clients ? `${clients} registered (tabkyra token clients)` : "none yet; add the connector in claude.ai, ChatGPT or grok.com" });
	}
	const ok = checks.every((x) => x.status !== "fail");
	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok, route: config?.route ?? null, publicUrl: config?.publicUrl ?? null, oauthClients: clients, checks }, null, 2)}\n`);
		return ok ? 0 : 1;
	}
	for (const check of checks) {
		const mark = check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail;
		console.log(`${mark} ${check.name.padEnd(13)} ${c.dim(check.detail)}`);
	}
	return ok ? 0 : 1;
}

// ---------- remote off ----------

export function remoteOff(): number {
	let config: RemoteConfig | undefined;
	try {
		config = loadRemoteConfig();
	} catch (err) {
		console.error(`${sym.fail} ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	for (const note of removeService()) console.log(`${sym.ok} ${note}`);
	if (config?.route === "funnel") {
		const bin = which("tailscale");
		const r = bin ? run(bin, ["funnel", `--https=${FUNNEL_PORT}`, "off"]) : { code: 1, out: "tailscale isn't on PATH" };
		if (r.code !== 0) {
			console.error(`${sym.fail} Couldn't turn Funnel off: ${r.out}. remote.json is kept; run tailscale funnel --https=${FUNNEL_PORT} off, then tabkyra remote off again.`);
			return 1;
		}
		console.log(`${sym.ok} Tailscale Funnel on port ${FUNNEL_PORT} is off.`);
	}
	if (config) {
		rmSync(remoteFile(), { force: true });
		console.log(`${sym.ok} Removed ${c.dim(remoteFile())}`);
	} else {
		console.log(`${sym.dot} No remote.json; nothing else to remove.`);
	}
	console.log(c.dim("Approved connectors keep their grants in oauth.json. tabkyra token clients lists them; tabkyra token revoke <client id> ends one."));
	return 0;
}
