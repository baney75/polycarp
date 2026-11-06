/**
 * `tabkyra remote setup|status|off`: one command that makes `tabkyra serve` reachable by claude.ai,
 * ChatGPT and grok.com, for free and with no domain (D31). Setup writes remote.json, opens
 * Tailscale Funnel on its own port (or takes the user's own HTTPS front door), sets the owner
 * passcode, and installs a user service that keeps `tabkyra serve` running. `serve` reads
 * remote.json when `--public-url` is absent.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { launcherValid, tabkyraBinary, which } from "./harness.ts";
import { connectionChecks } from "./doctor.ts";
import { funnelAdminUrl, printReport, type RemoteState, type SetupReport, stateFromStatus } from "./remote-state.ts";
import { installService, removeService, run, serviceFile, serviceLogHint, sleep, writeAtomic } from "./service.ts";
import { configDir, listClients, passcodeSet, setPasscode } from "./oauth.ts";
import { hubFile } from "./hub-state.ts";
import { DEFAULT_PORT } from "./tunnel.ts";
import { c, sym } from "./ui.ts";

/** Funnel's own port: keeps the OAuth paths at the root and anything on 443 private. */
export const FUNNEL_PORT = 8443;
export const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

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
		throw new Error(`${remoteFile()} isn't valid JSON. Run tabkyra remote off to remove it, then tabkyra remote setup again.`);
	}
	if (!raw || typeof raw !== "object") throw new Error(`${remoteFile()} isn't a Tabkyra remote file.`);
	if (typeof raw.publicUrl !== "string" || !raw.publicUrl) throw new Error(`${remoteFile()}: publicUrl is missing.`);
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new Error(`${remoteFile()}: port must be a port number.`);
	if (raw.route !== "funnel" && raw.route !== "custom") throw new Error(`${remoteFile()}: route must be funnel or custom.`);
	const redirectHosts = stringList(raw.redirectHosts, "redirectHosts");
	const allowHosts = stringList(raw.allowHosts, "allowHosts");
	return { publicUrl: raw.publicUrl, port: raw.port, route: raw.route, ...(redirectHosts ? { redirectHosts } : {}), ...(allowHosts ? { allowHosts } : {}) };
}

export function saveRemoteConfig(config: RemoteConfig): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeAtomic(remoteFile(), `${JSON.stringify(config, null, "\t")}\n`, 0o600);
}

// ---------- Tailscale Funnel ----------

/**
 * The `tailscale` binary: on PATH, or, when the caller names it, the Tailscale Mac app's own copy
 * (TABKYRA_TAILSCALE_APP). The app doesn't put `tailscale` on PATH, so a desktop app that runs this helper
 * passes it. Nothing else is searched: a path nobody asked for is never run.
 */
export function tailscaleBinary(): string | undefined {
	const onPath = which("tailscale");
	if (onPath) return onPath;
	const app = process.env.TABKYRA_TAILSCALE_APP;
	return app?.startsWith("/") && existsSync(app) ? app : undefined;
}

type ServeWeb = Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
type ServeTcp = Record<string, { HTTPS?: boolean; TCPForward?: string }>;

/** What `tailscale` says about this machine: not connected, unreadable serve status, or its DNS name and Web entries. */
type TailscaleState = { kind: "disconnected" } | { kind: "unreadable" } | { kind: "ok"; dns: string; web: ServeWeb; tcp: ServeTcp };

function readTailscale(bin: string): TailscaleState {
	let dns = "";
	try {
		dns = String((JSON.parse(run(bin, ["status", "--json"]).out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
	} catch {
		/* not connected */
	}
	if (!dns) return { kind: "disconnected" };
	const serveStatus = run(bin, ["serve", "status", "--json"]);
	try {
		if (serveStatus.code !== 0) throw new Error("serve status failed");
		const parsed = JSON.parse(serveStatus.out || "{}") as { Web?: ServeWeb; TCP?: ServeTcp };
		return { kind: "ok", dns, web: parsed.Web ?? {}, tcp: parsed.TCP ?? {} };
	} catch {
		return { kind: "unreadable" };
	}
}

const LOCAL_PROXY = /^http:\/\/(127\.0\.0\.1|localhost):/;

type FunnelPlan = { ok: true; bin: string; dns: string } | { ok: false; state: RemoteState; message: string };

/** Everything that can refuse Funnel, checked before anything changes. `ports` are the local ports that count as ours on 8443. */
export function planFunnel(ports: number[]): FunnelPlan {
	const bin = tailscaleBinary();
	if (!bin) return { ok: false, state: "tailscale_missing", message: "Tailscale isn't installed. Install it from tailscale.com, or use --public-url with your own tunnel (a free Cloudflare named tunnel works)." };
	if (/tailnet lock is enabled/i.test(run(bin, ["lock", "status"]).out)) {
		return {
			ok: false,
			state: "tailnet_lock",
			message:
				"This tailnet has Tailnet Lock on, and Tailscale Funnel doesn't work on a Tailnet Lock tailnet. Nothing was changed. Use --public-url with a Cloudflare named tunnel (free); docs/remote.md has the steps.",
		};
	}
	const state = readTailscale(bin);
	if (state.kind === "disconnected") return { ok: false, state: "tailscale_signed_out", message: "Tailscale isn't connected. Run tailscale up, then try again." };
	if (state.kind === "unreadable") return { ok: false, state: "problem", message: "Couldn't read tailscale serve status, so nothing was changed." };
	const tcp = state.tcp[String(FUNNEL_PORT)];
	if (tcp && tcp.HTTPS !== true) {
		return {
			ok: false,
			state: "port_busy",
			message: `Port ${FUNNEL_PORT} on this machine already forwards TCP traffic${tcp.TCPForward ? ` to ${tcp.TCPForward}` : ""}. Funnel would make it public, so nothing was changed. Turn that off in Tailscale first, or use --public-url.`,
		};
	}
	const existing = state.web[`${state.dns}:${FUNNEL_PORT}`];
	if (existing) {
		const ours = new Set(ports.flatMap((port) => [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, `http://localhost:${port}`, `http://localhost:${port}/`]));
		const others = Object.entries(existing.Handlers ?? {}).filter(([, h]) => !h.Proxy || !ours.has(h.Proxy));
		if (others.length) {
			return {
				ok: false,
				state: "port_busy",
				message: `Port ${FUNNEL_PORT} on this machine already serves something else (${others.map(([path]) => path).join(", ")}). Funnel would make it public, so nothing was changed. Turn that off in Tailscale first, or use --public-url.`,
			};
		}
	}
	return { ok: true, bin, dns: state.dns };
}

/**
 * Port 8443 as `tailscale serve status` shows it when remote.json can't say what we set up. found.ours:
 * every handler on 8443 proxies to a loopback port that answers like Tabkyra, so closing it is safe.
 */
type StrayFunnel = { kind: "none" } | { kind: "found"; bin: string; paths: string[]; ours: boolean } | { kind: "unknown"; message: string };

const LOOPBACK_PORT = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/;

/** Port 8443 handlers that proxy to a loopback port, or nothing at all. */
async function strayFunnel(): Promise<StrayFunnel> {
	const bin = tailscaleBinary();
	if (!bin) return { kind: "none" };
	const state = readTailscale(bin);
	if (state.kind === "disconnected") return { kind: "none" };
	if (state.kind === "unreadable") return { kind: "unknown", message: "Couldn't read tailscale serve status, so I can't tell whether Funnel is on." };
	const handlers = Object.entries(state.web[`${state.dns}:${FUNNEL_PORT}`]?.Handlers ?? {});
	const local = handlers.filter(([, h]) => h.Proxy && LOCAL_PROXY.test(h.Proxy));
	if (!local.length) return { kind: "none" };
	let ours = local.length === handlers.length;
	for (const [, h] of local) {
		const port = Number(LOOPBACK_PORT.exec(h.Proxy ?? "")?.[1]);
		if (!ours) break;
		ours = Number.isInteger(port) && (await answersLikeTabkyra(port));
	}
	return { kind: "found", bin, paths: local.map(([path]) => path), ours };
}

// ---------- the local serve ----------

type LocalServe = { state: "none" } | { state: "match" } | { state: "other"; detail: string };

/** One GET to the loopback port. node:http, because fetch refuses a few ports (1, 6000, 6666) that a user could pick. */
function getLocal(port: number, timeoutMs: number): Promise<{ status: number; body: string } | { error: string; refused: boolean }> {
	return new Promise((resolve) => {
		const req = httpGet({ host: "127.0.0.1", port, path: METADATA_PATH, timeout: timeoutMs }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				if (body.length < 65_536) body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			res.on("error", (err) => resolve({ error: err.message, refused: false }));
		});
		req.on("timeout", () => {
			req.destroy();
			resolve({ error: `it didn't answer in ${timeoutMs / 1000} seconds`, refused: false });
		});
		req.on("error", (err: NodeJS.ErrnoException) => resolve({ error: err.message, refused: err.code === "ECONNREFUSED" || err.code === "EADDRNOTAVAIL" }));
	});
}

/** Does anything answer on the local port, and is it Tabkyra with OAuth for this publicUrl? */
export async function probeLocal(port: number, publicUrl: string, timeoutMs = 2000): Promise<LocalServe> {
	const res = await getLocal(port, timeoutMs);
	if ("error" in res) return res.refused ? { state: "none" } : { state: "other", detail: res.error };
	if (res.status !== 200) return { state: "other", detail: `it answered ${res.status} for ${METADATA_PATH}` };
	try {
		const body = JSON.parse(res.body) as { resource?: unknown };
		if (body.resource === `${publicUrl}/mcp`) return { state: "match" };
		return { state: "other", detail: `it says resource ${String(body.resource)}, not ${publicUrl}/mcp` };
	} catch {
		return { state: "other", detail: `its answer for ${METADATA_PATH} isn't JSON` };
	}
}

/** Does a loopback port answer the protected-resource metadata like Tabkyra: a JSON body whose string `resource` ends in /mcp? */
async function answersLikeTabkyra(port: number): Promise<boolean> {
	const res = await getLocal(port, 2000);
	if ("error" in res || res.status !== 200) return false;
	try {
		const resource = (JSON.parse(res.body) as { resource?: unknown }).resource;
		return typeof resource === "string" && resource.endsWith("/mcp");
	} catch {
		return false;
	}
}

export async function waitForServe(port: number, publicUrl: string, totalMs: number): Promise<boolean> {
	const deadline = Date.now() + totalMs;
	for (;;) {
		if ((await probeLocal(port, publicUrl, 1500)).state === "match") return true;
		if (Date.now() >= deadline) return false;
		await sleep(500);
	}
}

// ---------- remote setup ----------

export interface SetupOptions {
	/** A normalized origin, or undefined for the Tailscale Funnel route. */
	publicUrl?: string;
	port?: number;
	service: boolean;
	/** False (--no-passcode) mints and prints no passcode; the one-time connect code is the way in. For an agent's shell. */
	passcode?: boolean;
	/** One JSON object on stdout (a SetupReport) and no other output, for an app. The passcode is in it only when this run made it. */
	json?: boolean;
}

export async function remoteSetup(options: SetupOptions): Promise<number> {
	const json = options.json === true;
	/** The passcode this run made. A run that fails after making it still reports it, because a later run won't print it again. */
	let madePasscode: string | undefined;
	const say = (line: string) => {
		if (!json) console.log(line);
	};
	/** Text mode: the old stderr lines. JSON mode: the state, with the passcode if this run made it. */
	const fail = (state: RemoteState, message: string, extra: { adminUrl?: string; after?: string } = {}): number => {
		if (json) {
			const report: SetupReport = { ok: false, state, message, ...(extra.adminUrl ? { adminUrl: extra.adminUrl } : {}), ...(madePasscode ? { passcode: madePasscode } : {}), passcodeSet: passcodeSet() };
			printReport(report);
			return 1;
		}
		console.error(`${sym.fail} ${message}`);
		if (extra.after) console.error(extra.after);
		return 1;
	};
	// One public route per install: a hub (tabkyra hub setup) owns it.
	if (existsSync(hubFile())) {
		return fail("problem", `This install is set up as a hub (${hubFile()}), and an install has one public route. Run tabkyra hub off first. Nothing was changed.`);
	}
	let previous: RemoteConfig | undefined;
	try {
		previous = loadRemoteConfig();
	} catch (err) {
		return fail("problem", `${err instanceof Error ? err.message : String(err)} Nothing was changed; run tabkyra remote off first.`);
	}
	const port = options.port ?? previous?.port ?? DEFAULT_PORT;
	// Plan: everything that can refuse, before anything changes.
	let publicUrl: string;
	let route: RemoteConfig["route"];
	let funnelBin = "";
	if (options.publicUrl) {
		if (previous?.route === "funnel") {
			return fail("problem", "Funnel from an earlier setup is on. Run tabkyra remote off first.");
		}
		// Funnel on 8443 would stay public and forward to this machine, whatever front door the user adds.
		if (tailscaleBinary()) {
			const stray = await strayFunnel();
			if (stray.kind !== "none") {
				return fail("port_busy", `Funnel on ${FUNNEL_PORT} is on${stray.kind === "unknown" ? ` (${stray.message})` : ""}; run tabkyra remote off first. Nothing was changed.`);
			}
		}
		publicUrl = options.publicUrl;
		route = "custom";
	} else {
		const plan = planFunnel(previous?.route === "funnel" ? [port, previous.port] : [port]);
		if (!plan.ok) return fail(plan.state, plan.message);
		funnelBin = plan.bin;
		publicUrl = `https://${plan.dns}:${FUNNEL_PORT}`;
		route = "funnel";
	}
	const installed = serviceFile();
	if (!options.service && installed && existsSync(installed)) {
		return fail("problem", `A service from an earlier setup is installed (${installed}), and --no-service would leave it running. Run tabkyra remote off first. Nothing was changed.`);
	}
	if (options.service && !launcherValid()) {
		return fail("problem", `${tabkyraBinary()} isn't a working launcher, so the service would have nothing to start. Run tabkyra install first, then tabkyra remote setup again.`);
	}
	// Whatever listens on the port must be Tabkyra with OAuth for this URL, or Funnel would publish something else.
	const probe = await probeLocal(port, publicUrl);
	if (probe.state === "other") {
		const file = serviceFile();
		const restartsOurs = options.service && Boolean(file && existsSync(file)) && previous?.port === port;
		if (!restartsOurs) {
			return fail(
				"port_busy",
				`Something already listens on 127.0.0.1:${port} and isn't Tabkyra serve for ${publicUrl} (${probe.detail}). Nothing was changed. Stop it (a tabkyra serve you started by hand, or another program), or pick another port with --port, then run tabkyra remote setup again.`,
			);
		}
	}
	if (options.passcode === false && !passcodeSet()) {
		say(`${sym.dot} No passcode made (--no-passcode). Approve a connection with a one-time connect code: tabkyra token approval-code. tabkyra token passcode sets a passcode later.`);
	} else if (!passcodeSet()) {
		madePasscode = setPasscode();
		say(`${sym.ok} OAuth passcode:\n\n  ${madePasscode}\n`);
		say(c.dim("Shown once. Type it on the approval page when claude.ai, ChatGPT or grok.com connects. Keep it in a password manager, but not one the browser Tabkyra drives can fill. tabkyra token passcode replaces it; grants already approved keep working."));
	}
	saveRemoteConfig({ publicUrl, port, route, ...(previous?.redirectHosts ? { redirectHosts: previous.redirectHosts } : {}), ...(previous?.allowHosts ? { allowHosts: previous.allowHosts } : {}) });
	say(`${sym.ok} Wrote ${c.dim(remoteFile())}`);
	let listening = probe.state === "match";
	if (options.service) {
		const service = await installService();
		say(`${service.ok ? sym.ok : sym.fail} ${service.message}`);
		if (!service.ok) {
			return fail("problem", `The service didn't start, so ${route === "funnel" ? "Funnel was not opened" : "setup isn't finished"}. remote.json is kept; fix the cause and run tabkyra remote setup again.${json ? ` (${service.message})` : ""}`);
		}
		if (!(await waitForServe(port, publicUrl, 15_000))) {
			return fail(
				"problem",
				`tabkyra serve isn't answering on 127.0.0.1:${port} with ${publicUrl}/mcp after 15 seconds, so ${route === "funnel" ? "Funnel was not opened" : "setup isn't finished"}. Look in ${serviceLogHint()}. remote.json is kept; fix the cause and run tabkyra remote setup again.`,
			);
		}
		listening = true;
	}
	if (route === "funnel" && !listening) {
		say(`${sym.warn} Start tabkyra serve (it reads remote.json), then run tabkyra remote setup --no-service again to open Funnel.`);
	} else if (route === "funnel") {
		const r = run(funnelBin, ["funnel", "--bg", "--yes", `--https=${FUNNEL_PORT}`, `http://127.0.0.1:${port}`]);
		if (r.code !== 0) {
			const login = funnelAdminUrl(r.out);
			const after = `${sym.dot} remote.json is kept. Fix that, then run tabkyra remote setup again, or tabkyra remote off to undo setup.`;
			if (login) return fail("funnel_not_allowed", `Funnel isn't enabled for this tailnet or node yet. Open ${login}, enable it, then run tabkyra remote setup again.`, { adminUrl: login, after });
			return fail("problem", `tailscale funnel failed: ${r.out}`, { after });
		}
		say(`${sym.ok} Tailscale Funnel on ${publicUrl} ${c.dim(`-> 127.0.0.1:${port}`)}`);
	}
	if (!options.service && (route === "custom" || listening)) say(`${sym.dot} No service installed. Start it yourself: ${c.bold("tabkyra serve")}`);
	if (json) {
		const report: SetupReport = {
			ok: true,
			state: "on",
			message: "Connector ready.",
			connectorUrl: `${publicUrl}/mcp`,
			...(madePasscode ? { passcode: madePasscode } : {}),
			passcodeSet: passcodeSet(),
		};
		printReport(report);
		return 0;
	}
	console.log(`
Connector URL: ${c.bold(`${publicUrl}/mcp`)}

  claude.ai   Settings > Connectors > Add custom connector, paste the URL.
  ChatGPT     Settings > Apps & Connectors (developer mode) > Create, paste the URL, OAuth.
  grok.com    grok.com/connectors > New Connector > Custom, paste the URL.

${passcodeSet() ? "Approve with your Tabkyra passcode." : "Approve with a one-time connect code: tabkyra token approval-code."}
Check it with: tabkyra remote status`);
	return 0;
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

export async function metadata(url: string, timeoutMs: number, publicUrl: string): Promise<{ ok: boolean; detail: string }> {
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

export async function dnsCheck(host: string): Promise<Check> {
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

/** Read-only: can setup go ahead? ready, or the first thing in the way. Runs the same checks setup runs before it changes anything. */
export async function preflight(): Promise<{ state: RemoteState; message: string }> {
	if (existsSync(hubFile())) return { state: "problem", message: `This install is set up as a hub (${hubFile()}), and an install has one public route. Run tabkyra hub off first.` };
	const plan = planFunnel([DEFAULT_PORT]);
	if (!plan.ok) return { state: plan.state, message: plan.message };
	const probe = await probeLocal(DEFAULT_PORT, `https://${plan.dns}:${FUNNEL_PORT}`);
	if (probe.state === "other") return { state: "port_busy", message: `Something already listens on 127.0.0.1:${DEFAULT_PORT} and isn't Tabkyra serve (${probe.detail}).` };
	return { state: "ready", message: "Ready to turn on." };
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
		checks.push({ name: "passcode", status: passcode ? "ok" : "warn", detail: passcode ? "set" : "not set; only a connect code (tabkyra token approval-code) can approve a connection. tabkyra token passcode sets one." });
		const local = await probeLocal(config.port, config.publicUrl, 3000);
		const where = `http://127.0.0.1:${config.port}${METADATA_PATH}`;
		checks.push({
			name: "local serve",
			status: local.state === "match" ? "ok" : "fail",
			detail:
				local.state === "match"
					? `${where} answers with resource ${config.publicUrl}/mcp`
					: `${where} ${local.state === "none" ? "didn't answer: connection refused" : local.detail}. Is tabkyra serve running? tabkyra remote setup starts it.`,
		});
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
		// The state is the app's answer; the checks stay for anyone who wants the detail. The passcode itself is never here.
		const extensionConnected = config ? (await connectionChecks()).some((x) => x.id === "connected" && x.status === "ok") : undefined;
		const { state, message } = stateFromStatus({ configured: Boolean(config), checks, extensionConnected, preflight: config ? undefined : await preflight() });
		printReport({
			ok,
			state,
			message,
			route: config?.route ?? null,
			publicUrl: config?.publicUrl ?? null,
			connectorUrl: config ? `${config.publicUrl}/mcp` : null,
			passcodeSet: passcodeSet(),
			extensionConnected: extensionConnected ?? null,
			oauthClients: clients,
			checks,
		});
		return ok ? 0 : 1;
	}
	for (const check of checks) {
		const mark = check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail;
		console.log(`${mark} ${check.name.padEnd(13)} ${c.dim(check.detail)}`);
	}
	return ok ? 0 : 1;
}

// ---------- remote off ----------

/** Close Funnel on 8443. A failure that leaves the entry in place is a failure; an entry already gone counts as off. */
function funnelOff(bin: string | undefined): { ok: boolean; message: string } {
	const r = bin ? run(bin, ["funnel", `--https=${FUNNEL_PORT}`, "off"]) : { code: 1, out: "tailscale isn't on PATH" };
	if (r.code === 0) return { ok: true, message: `Tailscale Funnel on port ${FUNNEL_PORT} is off.` };
	if (bin) {
		const state = readTailscale(bin);
		if (state.kind === "disconnected" || (state.kind === "ok" && !state.web[`${state.dns}:${FUNNEL_PORT}`])) return { ok: true, message: `Tailscale Funnel on port ${FUNNEL_PORT} was already off.` };
	}
	return { ok: false, message: `Couldn't turn Funnel off: ${r.out}. The service and remote.json are kept; run tailscale funnel --https=${FUNNEL_PORT} off, then tabkyra remote off again.` };
}

/** Funnel first, then the service, then the files: while Funnel is open, a serve with OAuth on loopback is the safe state. */
export async function remoteOff(): Promise<number> {
	let config: RemoteConfig | undefined;
	let badFile: string | undefined;
	try {
		config = loadRemoteConfig();
	} catch (err) {
		badFile = err instanceof Error ? err.message : String(err);
	}
	if (badFile !== undefined) console.log(`${sym.warn} ${badFile}`);
	let code = 0;
	if (config?.route === "funnel") {
		const r = funnelOff(tailscaleBinary());
		if (!r.ok) {
			console.error(`${sym.fail} ${r.message}`);
			return 1;
		}
		console.log(`${sym.ok} ${r.message}`);
	} else {
		const stray = await strayFunnel();
		if (stray.kind === "unknown") {
			console.error(`${sym.fail} ${stray.message} Nothing was changed. Start Tailscale and run tabkyra remote off again.`);
			return 1;
		}
		if (stray.kind === "found" && stray.ours) {
			const r = funnelOff(stray.bin);
			if (!r.ok) {
				console.error(`${sym.fail} ${r.message}`);
				return 1;
			}
			console.log(`${sym.ok} ${r.message}`);
		} else if (stray.kind === "found") {
			console.error(
				`${sym.fail} Tailscale Funnel on port ${FUNNEL_PORT} forwards ${stray.paths.join(", ")} to a local port, but not everything there answers like Tabkyra serve, so it was left on. If it is yours to close, run tailscale funnel --https=${FUNNEL_PORT} off.`,
			);
			code = 1;
		}
	}
	const service = removeService();
	if (!service.ok) {
		console.error(`${sym.fail} ${service.failure}`);
		return 1;
	}
	for (const note of service.notes) console.log(`${sym.ok} ${note}`);
	if (config || badFile !== undefined) {
		rmSync(remoteFile(), { force: true });
		console.log(`${sym.ok} Removed ${c.dim(remoteFile())}`);
	} else {
		console.log(`${sym.dot} No remote.json; nothing else to remove.`);
	}
	if (config?.route === "custom") console.log(`${sym.warn} Your own front door for ${config.publicUrl} still forwards to this machine. Stop it there (for example, stop cloudflared); tabkyra remote off can't.`);
	console.log(c.dim("Approved connectors keep their grants in oauth.json. tabkyra token clients lists them; tabkyra token revoke <client id> ends one."));
	return code;
}
