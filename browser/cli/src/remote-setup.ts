/**
 * `polycarp browser remote setup|status|off`: one command that makes `polycarp browser serve` reachable by claude.ai,
 * ChatGPT and grok.com, for free and with no domain (D31). Setup writes remote.json, opens
 * Tailscale Funnel on its own port (or takes the user's own HTTPS front door), sets the owner
 * passcode, and installs a user service that keeps `polycarp browser serve` running. `serve` reads
 * remote.json when `--public-url` is absent.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
	CLOUDFLARE_SERVICE,
	checkCloudflareZone,
	closeCloudflare,
	cloudflaredBinary,
	cloudflareLoginForPanel,
	cloudflareSignedIn,
	cloudflareTunnelName,
	normalizeCloudflareHost,
	prepareCloudflare,
} from "./cloudflare.ts";
import { CLOUDFLARED_VERSION, cloudflaredAsset, downloadCloudflared, downloadedCloudflared } from "./cloudflared-download.ts";
import { launcherValid, launcherBinary, which } from "./harness.ts";
import { connectionChecks } from "./doctor.ts";
import { install } from "./install.ts";
import { ask, askYes, closeInput, duration, openPage, waitMs } from "./remote-guide.ts";
import {
	CLOUDFLARED_DOWNLOAD_URL,
	completeFunnelAdminUrl,
	funnelAdminUrl,
	lingerFromLoginctl,
	operatorFromPrefs,
	printReport,
	type RemoteNext,
	type RemoteRoutes,
	type RemoteState,
	type SetupReport,
	setupExitCode,
	stateFromStatus,
	TAILSCALE_OPERATOR_FIX,
	tailscaleAccessDenied,
	tailscaleDownloadUrl,
} from "./remote-state.ts";
import { installService, removeService, run, serviceFile, serviceLogHint, sleep, writeAtomic } from "./service.ts";
import { configDir, listClients, mintApprovalCode, passcodeSet, setPasscode } from "./oauth.ts";
import { hubFile } from "./hub-state.ts";
import { DEFAULT_PORT } from "./tunnel.ts";
import { c, sym } from "./ui.ts";
import { COMMAND_NAME } from "./self.ts";
import { envVar } from "./env.ts";
import { type ToolLookup, windowsInstallPaths, windowsTool } from "./tool-paths.ts";

/** Funnel's own port: keeps the OAuth paths at the root and anything on 443 private. */
export const FUNNEL_PORT = 8443;
export const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

export interface RemoteConfig {
	publicUrl: string;
	port: number;
	route: "funnel" | "custom" | "cloudflare";
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
		throw new Error(`${remoteFile()} isn't valid JSON. Run ${COMMAND_NAME} remote off to remove it, then ${COMMAND_NAME} remote setup again.`);
	}
	if (!raw || typeof raw !== "object") throw new Error(`${remoteFile()} isn't a Polycarp remote file.`);
	if (typeof raw.publicUrl !== "string" || !raw.publicUrl) throw new Error(`${remoteFile()}: publicUrl is missing.`);
	if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 0 || raw.port > 65535) throw new Error(`${remoteFile()}: port must be a port number.`);
	if (raw.route !== "funnel" && raw.route !== "custom" && raw.route !== "cloudflare") throw new Error(`${remoteFile()}: route must be funnel, custom or cloudflare.`);
	const redirectHosts = stringList(raw.redirectHosts, "redirectHosts");
	const allowHosts = stringList(raw.allowHosts, "allowHosts");
	return { publicUrl: raw.publicUrl, port: raw.port, route: raw.route, ...(redirectHosts ? { redirectHosts } : {}), ...(allowHosts ? { allowHosts } : {}) };
}

export function saveRemoteConfig(config: RemoteConfig): void {
	mkdirSync(configDir(), { recursive: true, mode: 0o700 });
	writeAtomic(remoteFile(), `${JSON.stringify(config, null, "\t")}\n`, 0o600);
}

// ---------- Tailscale Funnel ----------

/** How to sign in to Tailscale here: its app on macOS, its Start menu entry on Windows (it runs in the notification area), else tailscale up. */
export function tailscaleSignIn(platform: NodeJS.Platform = process.platform): string {
	if (platform === "darwin") return "Open the Tailscale app and sign in, or run tailscale up";
	if (platform === "win32") return "Open Tailscale from the Start menu and sign in, or run tailscale up";
	return "Run tailscale up";
}

/** Where the Tailscale Mac app keeps its command. It never puts `tailscale` on PATH. TABKYRA_APPLICATIONS_DIR replaces /Applications, for tests. */
export const tailscaleAppPath = () => join(envVar("APPLICATIONS_DIR") || "/Applications", "Tailscale.app", "Contents", "MacOS", "Tailscale");

/**
 * The `tailscale` binary: on PATH, or the Tailscale Mac app's own copy at its fixed path, so a terminal and Polycarp's window
 * find the same one. On Windows, tailscale.exe on PATH or in the installer's folder (tool-paths.ts). Nothing else is searched:
 * a path nobody asked for is never run.
 */
export function tailscaleBinary(lookup: ToolLookup = {}): string | undefined {
	if ((lookup.platform ?? process.platform) === "win32") return windowsTool("tailscale", lookup);
	const onPath = which("tailscale");
	if (onPath) return onPath;
	const app = tailscaleAppPath();
	return existsSync(app) ? app : undefined;
}

type ServeWeb = Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
type ServeTcp = Record<string, { HTTPS?: boolean; TCPForward?: string }>;

/** What `tailscale` says about this machine: not connected, unreadable serve status, or its DNS name, Web entries and which host:ports Funnel is on for. */
type TailscaleState = { kind: "disconnected" } | { kind: "unreadable" } | { kind: "ok"; dns: string; web: ServeWeb; tcp: ServeTcp; allowFunnel: Record<string, boolean> };

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
		const parsed = JSON.parse(serveStatus.out || "{}") as { Web?: ServeWeb; TCP?: ServeTcp; AllowFunnel?: Record<string, boolean> };
		return { kind: "ok", dns, web: parsed.Web ?? {}, tcp: parsed.TCP ?? {}, allowFunnel: parsed.AllowFunnel ?? {} };
	} catch {
		return { kind: "unreadable" };
	}
}

const LOCAL_PROXY = /^http:\/\/(127\.0\.0\.1|localhost):/;

type FunnelBlock = { ok: false; state: RemoteState; message: string; code?: string };
type FunnelPlan = { ok: true; bin: string; dns: string } | FunnelBlock;

/** The Tailscale part of planning: installed, no Tailnet Lock, signed in. What `remote status` re-checks once remote.json exists. */
export function tailscaleReady(): { ok: true; bin: string; state: TailscaleState } | FunnelBlock {
	const bin = tailscaleBinary();
	if (!bin) return { ok: false, state: "tailscale_missing", message: `Tailscale isn't installed. Install it from ${tailscaleDownloadUrl()} and sign in, or use --cloudflare name.yourdomain.com for a domain on your Cloudflare account.` };
	if (/tailnet lock is enabled/i.test(run(bin, ["lock", "status"]).out)) {
		return {
			ok: false,
			state: "tailnet_lock",
			message:
				"This tailnet has Tailnet Lock on, and Tailscale Funnel doesn't work on a Tailnet Lock tailnet. Nothing was changed. Use --public-url with a Cloudflare named tunnel (free); docs/remote.md has the steps.",
		};
	}
	const state = readTailscale(bin);
	if (state.kind === "disconnected") return { ok: false, state: "tailscale_signed_out", message: `Tailscale isn't connected. ${tailscaleSignIn()}, then try again.` };
	return { ok: true, bin, state };
}

/** Everything that can refuse Funnel, checked before anything changes. `ports` are the local ports that count as ours on 8443. */
export function planFunnel(ports: number[]): FunnelPlan {
	const basics = tailscaleReady();
	if (!basics.ok) return basics;
	const { bin, state } = basics;
	if (state.kind === "unreadable") return { ok: false, state: "problem", message: "Couldn't read tailscale serve status, so nothing was changed." };
	if (state.kind !== "ok") return { ok: false, state: "problem", message: "Couldn't read tailscale, so nothing was changed." };
	const tcp = state.tcp[String(FUNNEL_PORT)];
	if (tcp && tcp.HTTPS !== true) {
		return {
			ok: false,
			state: "port_busy",
			code: "tailscale_port",
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
				code: "tailscale_port",
				message: `Port ${FUNNEL_PORT} on this machine already serves something else (${others.map(([path]) => path).join(", ")}). Funnel would make it public, so nothing was changed. Turn that off in Tailscale first, or use --public-url.`,
			};
		}
	}
	return { ok: true, bin, dns: state.dns };
}

// ---------- opening Funnel ----------

/**
 * `tailscale funnel --bg` as Tailscale's own CLI behaves (tailscale/tailscale, cmd/tailscale/cli):
 * - serve_v2.go:458 calls verifyFunnelEnabled for every `funnel` that isn't `off`; funnel.go:139-162 runs enableFeatureInteractive
 *   and, only if that errors, falls back to ipn.CheckFunnelAccess (error text with tailscale.com/s/https or /s/no-funnel).
 * - serve_legacy.go:797-870, enableFeatureInteractive, when Funnel isn't enabled for the node: prints the login.tailscale.com
 *   page (826-828), then EITHER exits 0 with nothing changed when the control server says not to wait (829-835), OR blocks until
 *   enablement arrives and prints "Success." (836-873), which can be never. A lost connection is log.Fatalf (845, 856).
 * So a URL on the output means "not enabled", whatever the exit code, and the process may never end by itself.
 */
type FunnelOpen = { kind: "opened" } | { kind: "not_allowed"; url: string } | { kind: "failed"; message: string };

/** Longest `tailscale funnel` call, in ms. TABKYRA_FUNNEL_WAIT_MS shortens it for tests. */
const funnelWaitMs = () => {
	const n = Number(envVar("FUNNEL_WAIT_MS"));
	return Number.isFinite(n) && n > 0 ? n : 30_000;
};

/** Run `tailscale funnel --bg`, reading as it prints. The enablement page ends the call at once and stops the process; every call is bounded. */
function openFunnelProcess(bin: string, port: number): Promise<FunnelOpen> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		let child: ReturnType<typeof spawn>;
		const limit = funnelWaitMs();
		const stop = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
		};
		// Cancelled (Ctrl-C, or the app's timeout) while the call runs: its process group dies with us, so it can't open Funnel later.
		const onSignal = (signal: NodeJS.Signals) => {
			stop();
			process.exit(signal === "SIGINT" ? 130 : 143);
		};
		const finish = (result: FunnelOpen) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			stop();
			resolve(result);
		};
		try {
			// A process group of its own, so stopping it stops anything it started.
			child = spawn(bin, ["funnel", "--bg", "--yes", `--https=${FUNNEL_PORT}`, `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], detached: true });
		} catch (err) {
			resolve({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
			return;
		}
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
		const timer = setTimeout(() => {
			const url = funnelAdminUrl(out);
			finish(url ? { kind: "not_allowed", url } : { kind: "failed", message: [out.trim(), `tailscale funnel didn't finish in ${Math.round(limit / 1000)} seconds`].filter(Boolean).join("\n") });
		}, limit);
		const onData = (chunk: Buffer) => {
			out += chunk.toString("utf8");
			const url = completeFunnelAdminUrl(out);
			if (url) finish({ kind: "not_allowed", url });
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (err) => finish({ kind: "failed", message: [out.trim(), err.message].filter(Boolean).join("\n") }));
		child.on("close", (code) => {
			const url = funnelAdminUrl(out);
			if (url) finish({ kind: "not_allowed", url });
			else if (code === 0) finish({ kind: "opened" });
			else finish({ kind: "failed", message: out.trim() || `tailscale funnel exited with code ${code}` });
		});
	});
}

/** Open Funnel on 8443 and confirm Tailscale really has it on for this machine before saying so. */
async function openFunnel(bin: string, dns: string, port: number): Promise<FunnelOpen> {
	const result = await openFunnelProcess(bin, port);
	if (result.kind !== "opened") return result;
	const after = readTailscale(bin);
	if (after.kind === "ok" && after.allowFunnel[`${dns}:${FUNNEL_PORT}`] === true) return result;
	return { kind: "failed", message: `tailscale funnel finished, but Funnel isn't on for ${dns}:${FUNNEL_PORT}${after.kind === "ok" ? "" : " (and tailscale serve status can't be read)"}.` };
}

/**
 * Port 8443 as `tailscale serve status` shows it when remote.json can't say what we set up. found.ours:
 * every handler on 8443 proxies to a loopback port that answers like Polycarp, so closing it is safe.
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

/** Does anything answer on the local port, and is it Polycarp with OAuth for this publicUrl? */
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

/** Does a loopback port answer the protected-resource metadata like Polycarp: a JSON body whose string `resource` ends in /mcp? */
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

/** How long setup waits for serve to answer, in ms. TABKYRA_SERVE_WAIT_MS shortens it for tests. */
const serveWaitMs = () => {
	const n = Number(envVar("SERVE_WAIT_MS"));
	return Number.isFinite(n) && n > 0 ? n : 15_000;
};

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
	/** A name on a domain in the person's Cloudflare account: the named-tunnel route. "" asks for the name (a terminal only). */
	cloudflare?: string;
	/** --tailscale: the Funnel route, chosen outright, so nothing asks which route. */
	tailscale?: boolean;
	port?: number;
	service: boolean;
	/** False (--no-passcode) mints and prints no passcode; the one-time connect code is the way in. For an agent's shell. */
	passcode?: boolean;
	/** One JSON object on stdout (a SetupReport) and no other output, for an app. The passcode is in it only when this run made it. */
	json?: boolean;
	/**
	 * Takes the final SetupReport instead of printing it, and keeps every other line off stdout too. The native host's stdout is
	 * its channel to the browser, so the Connect panel's setup uses this. Implies the JSON mode's behavior.
	 */
	report?: (report: SetupReport) => void;
	/**
	 * Move from this install's own Funnel route to the Cloudflare one (the Connect panel's button). remote.json stays until the
	 * new route is saved, so the running serve is still known as ours and restarted, and Funnel is closed only after Cloudflare
	 * has made the tunnel: any refusal before that leaves the Funnel route as it was.
	 */
	replaceFunnel?: boolean;
	/** A person at a terminal (and no --no-wait): wait for what they do (install, sign in, allow Funnel) and carry on. Never in JSON mode. */
	wait?: boolean;
	/** A person at a terminal (and no --no-input): questions may be asked. Never in JSON mode. */
	input?: boolean;
	/** --yes: the answer to "download cloudflared?" is yes. Nothing else is downloaded or changed by it. */
	yes?: boolean;
	/** --connect-code: in JSON mode, a successful run mints a one-time connect code and reports it. Text mode always does. */
	connectCode?: boolean;
}

const tailscaleUp = tailscaleSignIn().replace(/un tailscale up$/, "un: tailscale up");

/** What a planning refusal asks the person to do, when it asks anything. */
function nextFor(state: RemoteState): RemoteNext | undefined {
	if (state === "tailscale_missing") return { kind: "install", url: tailscaleDownloadUrl() };
	if (state === "tailscale_signed_out") return { kind: "sign_in", command: "tailscale up" };
	return undefined;
}

/** In a terminal: wait while Tailscale is missing or signed out, one line per state, until it is ready or the wait ends. */
async function waitForTailscale(ports: number[], first: FunnelPlan, say: (line: string) => void): Promise<FunnelPlan> {
	let plan = first;
	let shown = "";
	const every = waitMs("TAILSCALE_POLL_MS", 2000);
	const deadline = Date.now() + waitMs("TAILSCALE_WAIT_MS", 30 * 60_000);
	while (!plan.ok && (plan.state === "tailscale_missing" || plan.state === "tailscale_signed_out") && Date.now() < deadline) {
		if (plan.state !== shown) {
			shown = plan.state;
			if (plan.state === "tailscale_missing") {
				say(`${sym.dot} Tailscale isn't installed. It's free: ${tailscaleDownloadUrl()}`);
				say(`Waiting for Tailscale to be installed. Ctrl-C stops; nothing has changed yet.`);
			} else {
				say(`${sym.dot} Tailscale isn't signed in. ${tailscaleUp}`);
				say(`Waiting for Tailscale to sign in. Ctrl-C stops; nothing has changed yet.`);
			}
		}
		await sleep(every);
		plan = planFunnel(ports);
	}
	if (plan.ok && shown) say(`${sym.ok} Tailscale is signed in.`);
	return plan;
}

/** In a terminal: `polycarp browser install` writes only the launcher and the browsers' native host files, and skips what is current, so setup runs it. */
async function ensureLauncher(say: (line: string) => void): Promise<void> {
	say(`${sym.dot} The service needs ${COMMAND_NAME} install first, so setup runs it now.`);
	try {
		const result = install();
		say(`${sym.ok} Launcher ${c.dim(result.launcher)}`);
	} catch (err) {
		say(`${sym.warn} ${COMMAND_NAME} install didn't finish: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (launcherValid()) return;
	say(`Run ${COMMAND_NAME} install in another terminal. Waiting for it. Ctrl-C stops; nothing else has changed.`);
	const every = waitMs("TAILSCALE_POLL_MS", 2000);
	const deadline = Date.now() + waitMs("TAILSCALE_WAIT_MS", 30 * 60_000);
	while (!launcherValid() && Date.now() < deadline) await sleep(every);
}

/** Tailscale refused the change for this user, and named the operator setting as the fix (Linux and other Unix, not Windows). */
const operatorRefusal = (message: string) => process.platform !== "win32" && tailscaleAccessDenied(message);

/** A refusal a person clears in Tailscale, so a terminal run waits for it: Funnel not allowed yet, or this user not Tailscale's operator. */
const funnelWaitsOnPerson = (opened: FunnelOpen) => opened.kind === "not_allowed" || (opened.kind === "failed" && operatorRefusal(opened.message));

/** In a terminal: open the page (or show the command), then try Funnel again every 5 seconds for up to 10 minutes. */
async function waitForFunnel(bin: string, dns: string, port: number, first: FunnelOpen, say: (line: string) => void): Promise<FunnelOpen> {
	let opened = first;
	let shown = "";
	const every = waitMs("FUNNEL_RETRY_MS", 5000);
	const total = waitMs("FUNNEL_RETRY_TOTAL_MS", 10 * 60_000);
	const deadline = Date.now() + total;
	while (funnelWaitsOnPerson(opened) && Date.now() < deadline) {
		const key = opened.kind === "not_allowed" ? opened.url : "operator";
		if (key !== shown) {
			shown = key;
			if (opened.kind === "not_allowed") {
				const started = openPage(opened.url);
				say(`${sym.dot} Tailscale asks you to allow Funnel for this computer. ${started ? "Your browser opened" : "Open"} ${opened.url}`);
				say("  Sign in if it asks, then press the button that enables Funnel (and HTTPS, if it asks) for this computer.");
			} else {
				say(`${sym.dot} Tailscale refused the change because your user isn't its operator. In another terminal, run this once (Polycarp never runs sudo):\n\n  ${TAILSCALE_OPERATOR_FIX}\n`);
			}
			say(`Waiting for Tailscale to allow Funnel, trying again every ${duration(every)} for up to ${duration(total)}. Ctrl-C stops; ${COMMAND_NAME} remote setup continues from here.`);
		}
		await sleep(every);
		opened = await openFunnel(bin, dns, port);
	}
	return opened;
}

/** In a terminal, when nothing says which route: use the one that's ready, or ask when both or neither is. */
async function chooseRoute(say: (line: string) => void): Promise<"tailscale" | "cloudflare" | undefined> {
	const routes = remoteRoutes();
	const tailscale = (await preflight()).state === "ready";
	const cloudflare = routes.cloudflare.installed && routes.cloudflare.signedIn;
	if (tailscale && !cloudflare) {
		say(`${sym.dot} Using Tailscale: it's installed and signed in. (--cloudflare name.yourdomain.com uses Cloudflare instead.)`);
		return "tailscale";
	}
	if (cloudflare && !tailscale) {
		say(`${sym.dot} Using Cloudflare: cloudflared is signed in. (--tailscale uses Tailscale instead.)`);
		return "cloudflare";
	}
	say(tailscale ? "Tailscale and Cloudflare are both ready. Which should assistants use to reach this computer?" : "How should assistants reach this computer? Both are free, on your own account.");
	say("  1  Tailscale (no domain needed)");
	say("  2  Cloudflare (a domain on your Cloudflare account)");
	for (;;) {
		const answer = await ask("Type 1 or 2 [1]: ");
		if (answer === undefined) return undefined;
		const pick = answer.trim().toLowerCase();
		if (pick === "" || pick === "1" || pick === "tailscale") return "tailscale";
		if (pick === "2" || pick === "cloudflare") return "cloudflare";
	}
}

/** In a terminal: the hostname for a Cloudflare route, asked until it can be one. Undefined when input ends. */
async function askCloudflareHost(say: (line: string) => void): Promise<string | undefined> {
	for (;;) {
		const answer = await ask("Connector hostname, on a domain in your Cloudflare account (for example polycarp.yourdomain.com): ");
		if (answer === undefined) return undefined;
		const host = normalizeCloudflareHost(answer);
		if (host) return host;
		if (answer.trim()) say(`${answer.trim()} isn't a name a tunnel can have. Use one like polycarp.yourdomain.com.`);
	}
}

export async function remoteSetup(options: SetupOptions): Promise<number> {
	try {
		return await runSetup(options);
	} finally {
		closeInput();
	}
}

async function runSetup(options: SetupOptions): Promise<number> {
	const json = options.json === true || options.report !== undefined;
	const wait = !json && options.wait === true;
	const input = !json && options.input === true;
	const emit = options.report ?? printReport;
	/** The passcode this run made. A run that fails after making it still reports it, because a later run won't print it again. */
	let madePasscode: string | undefined;
	const say = (line: string) => {
		if (!json) console.log(line);
	};
	/** Text mode: the old stderr lines. JSON mode: the state, with the passcode if this run made it. Exit 3 when a person has something to do. */
	const fail = (state: RemoteState, message: string, extra: { adminUrl?: string; code?: string; after?: string; next?: RemoteNext } = {}): number => {
		const report: SetupReport = {
			ok: false,
			state,
			message,
			...(extra.adminUrl ? { adminUrl: extra.adminUrl } : {}),
			...(extra.code ? { code: extra.code } : {}),
			...(madePasscode ? { passcode: madePasscode } : {}),
			passcodeSet: passcodeSet(),
			...(extra.next ? { next: extra.next } : {}),
		};
		if (json) {
			emit(report);
			return setupExitCode(report);
		}
		console.error(`${sym.fail} ${message}`);
		if (extra.after) console.error(extra.after);
		return setupExitCode(report);
	};
	// One public route per install: a hub (polycarp browser hub setup) owns it.
	if (existsSync(hubFile())) {
		return fail("problem", `This install is set up as a hub (${hubFile()}), and an install has one public route. Run ${COMMAND_NAME} hub off first. Nothing was changed.`, { code: "hub" });
	}
	let previous: RemoteConfig | undefined;
	try {
		previous = loadRemoteConfig();
	} catch (err) {
		return fail("problem", `${err instanceof Error ? err.message : String(err)} Nothing was changed; run ${COMMAND_NAME} remote off first.`, { code: "config" });
	}
	const port = options.port ?? previous?.port ?? DEFAULT_PORT;
	// Plan: everything that can refuse, before anything changes.
	let publicUrl: string;
	let route: RemoteConfig["route"];
	let funnelBin = "";
	let funnelDns = "";
	let cloudflaredBin = "";
	// `remote setup` again on this route picks up where a failed run stopped, with the name it already has.
	let cloudflareName = options.cloudflare ?? (previous?.route === "cloudflare" && !options.publicUrl && !options.tailscale ? new URL(previous.publicUrl).hostname : undefined);
	if (input && !previous && cloudflareName === undefined && !options.publicUrl && !options.tailscale) {
		const choice = await chooseRoute(say);
		if (choice === undefined) return fail("problem", `No route was chosen, so nothing was changed. Run ${COMMAND_NAME} remote setup --tailscale, or --cloudflare name.yourdomain.com.`);
		if (choice === "cloudflare") cloudflareName = "";
	}
	if (cloudflareName === "") {
		const typed = input ? await askCloudflareHost(say) : undefined;
		if (!typed) {
			return fail("problem", `The Cloudflare route needs a name on a domain in your Cloudflare account: ${COMMAND_NAME} remote setup --cloudflare polycarp.yourdomain.com. Nothing was changed.`, {
				code: "cloudflare_name",
				next: { kind: "choose_name" },
			});
		}
		cloudflareName = typed;
	}
	const cloudflareHost = cloudflareName === undefined ? undefined : normalizeCloudflareHost(cloudflareName);
	if (cloudflareName !== undefined && !cloudflareHost) return fail("problem", `${cloudflareName} isn't a name a tunnel can have. Use one like polycarp.yourdomain.com.`, { code: "cloudflare_dns", next: { kind: "choose_name" } });
	if (previous?.route === "cloudflare" && !cloudflareHost) return fail("problem", `A Cloudflare tunnel from an earlier setup is on. Run ${COMMAND_NAME} remote off first.`);
	if (cloudflareHost) {
		if (previous?.route === "funnel" && !options.replaceFunnel) return fail("problem", `Funnel from an earlier setup is on. Run ${COMMAND_NAME} remote off first.`);
		if (!options.service) return fail("problem", "The Cloudflare route runs as a service, so --no-service doesn't apply.");
		let bin = cloudflaredBinary();
		if (!bin) {
			const getIt = `${COMMAND_NAME} remote setup --cloudflare ${cloudflareHost} --yes`;
			const missing = (message: string) => fail("cloudflared_missing", message, { next: { kind: "install", url: CLOUDFLARED_DOWNLOAD_URL, ...(cloudflaredAsset() ? { command: getIt } : {}) } });
			// No release for this platform (Windows, other CPUs): the person installs it, as before.
			if (!cloudflaredAsset()) return missing(`cloudflared isn't installed. Get it from ${CLOUDFLARED_DOWNLOAD_URL}, then try again.`);
			let yes = options.yes === true;
			if (!yes && input) yes = await askYes(`cloudflared isn't installed. Download Cloudflare's release ${CLOUDFLARED_VERSION} from GitHub (checked against its SHA-256) to ${downloadedCloudflared()}? [y/N] `);
			if (!yes) return missing(`cloudflared isn't installed. ${getIt} downloads Cloudflare's own release ${CLOUDFLARED_VERSION}, checked against its SHA-256; or install it from ${CLOUDFLARED_DOWNLOAD_URL}.`);
			say(`${sym.dot} Downloading cloudflared ${CLOUDFLARED_VERSION}...`);
			const got = await downloadCloudflared();
			if (!got.ok) return missing(got.message);
			say(`${sym.ok} cloudflared ${c.dim(got.path)}`);
			bin = got.path;
		}
		if (!cloudflareSignedIn()) {
			const signIn: RemoteNext = { kind: "sign_in", command: `${COMMAND_NAME} remote cloudflare login` };
			if (!wait) return fail("problem", `Sign in to Cloudflare first: ${COMMAND_NAME} remote cloudflare login.`, { code: "cloudflare_login", next: signIn });
			say(`${sym.dot} Sign in to Cloudflare in your browser and choose the domain for ${cloudflareHost}.`);
			say(`Waiting up to 5 minutes for the sign-in. Ctrl-C stops; nothing has changed yet.`);
			const signedIn = await cloudflareLoginForPanel(bin, (url) => say(`  ${openPage(url) ? "Your browser opened" : "Open"} ${url}`));
			if (!signedIn.ok) return fail("problem", signedIn.message, { code: "cloudflare_login", next: signIn });
			say(`${sym.ok} Signed in to Cloudflare.`);
		}
		// Cloudflare doesn't refuse a name outside the signed-in domain; it makes a different record. So this refuses first.
		const zone = await checkCloudflareZone(cloudflareHost);
		if (!zone.ok) return fail("problem", zone.message, { code: "cloudflare_zone", next: { kind: "choose_name" } });
		// Funnel on 8443 would stay public and forward to this machine, whatever else is set up.
		if (tailscaleBinary()) {
			const stray = await strayFunnel();
			// The Funnel being replaced is ours (it proxies only to Polycarp) and closes below; any other stays a refusal.
			const replacing = options.replaceFunnel && previous?.route === "funnel" && stray.kind === "found" && stray.ours;
			if (stray.kind !== "none" && !replacing) return fail("port_busy", `Funnel on ${FUNNEL_PORT} is on${stray.kind === "unknown" ? ` (${stray.message})` : ""}; run ${COMMAND_NAME} remote off first. Nothing was changed.`, { code: "tailscale_port" });
		}
		cloudflaredBin = bin;
		publicUrl = `https://${cloudflareHost}`;
		route = "cloudflare";
	} else if (options.publicUrl) {
		if (previous?.route === "funnel") {
			return fail("problem", `Funnel from an earlier setup is on. Run ${COMMAND_NAME} remote off first.`);
		}
		// Funnel on 8443 would stay public and forward to this machine, whatever front door the user adds.
		if (tailscaleBinary()) {
			const stray = await strayFunnel();
			if (stray.kind !== "none") {
				return fail("port_busy", `Funnel on ${FUNNEL_PORT} is on${stray.kind === "unknown" ? ` (${stray.message})` : ""}; run ${COMMAND_NAME} remote off first. Nothing was changed.`);
			}
		}
		publicUrl = options.publicUrl;
		route = "custom";
	} else {
		const ports = previous?.route === "funnel" ? [port, previous.port] : [port];
		let plan = planFunnel(ports);
		if (!plan.ok && wait) plan = await waitForTailscale(ports, plan, say);
		if (!plan.ok) {
			const next = nextFor(plan.state);
			return fail(plan.state, plan.message, { ...(plan.code ? { code: plan.code } : {}), ...(next ? { next } : {}) });
		}
		funnelBin = plan.bin;
		funnelDns = plan.dns;
		publicUrl = `https://${plan.dns}:${FUNNEL_PORT}`;
		route = "funnel";
	}
	const installed = serviceFile();
	if (!options.service && installed && existsSync(installed)) {
		return fail("problem", `A service from an earlier setup is installed (${installed}), and --no-service would leave it running. Run ${COMMAND_NAME} remote off first. Nothing was changed.`);
	}
	if (options.service && !launcherValid()) {
		if (wait) await ensureLauncher(say);
		if (!launcherValid()) {
			return fail("problem", `${launcherBinary()} isn't a working launcher, so the service would have nothing to start. Run ${COMMAND_NAME} install first, then ${COMMAND_NAME} remote setup again.`, {
				code: "launcher",
				next: { kind: "run_command", command: `${COMMAND_NAME} install` },
			});
		}
	}
	// Whatever listens on the port must be Polycarp with OAuth for this URL, or Funnel would publish something else.
	const probe = await probeLocal(port, publicUrl);
	if (probe.state === "other") {
		const file = serviceFile();
		const restartsOurs = options.service && Boolean(file && existsSync(file)) && previous?.port === port;
		if (!restartsOurs) {
			return fail(
				"port_busy",
				`Something already listens on 127.0.0.1:${port} and isn't Polycarp serve for ${publicUrl} (${probe.detail}). Nothing was changed. Stop it (a ${COMMAND_NAME} serve you started by hand, or another program), or pick another port with --port, then run ${COMMAND_NAME} remote setup again.`,
				{ code: "local_port" },
			);
		}
	}
	if (options.passcode === false && !passcodeSet()) {
		say(`${sym.dot} No passcode made (--no-passcode). A one-time connect code approves each new assistant; setup prints one when it's done. ${COMMAND_NAME} token passcode sets a passcode later.`);
	} else if (!passcodeSet()) {
		madePasscode = setPasscode();
		// Shown now, so a run that stops or waits can't lose it; the summary at the end repeats it.
		say(`${sym.ok} Passcode, shown once:\n\n  ${madePasscode}\n`);
		say(
			c.dim(
				`It re-approves an assistant you already approved. A new assistant needs a one-time connect code instead; setup prints one when it's done. Keep the passcode in a password manager, but not one the browser Polycarp drives can fill. ${COMMAND_NAME} token passcode replaces it.`,
			),
		);
	}
	// Every step from here on has made (or may have made) a passcode a later run won't print, so in JSON mode a throw is still a report.
	let stage = "config";
	let tunnelName: string | undefined;
	try {
		// Before anything is saved: a name Cloudflare refuses leaves this computer as it was, and a working tunnel keeps working.
		if (route === "cloudflare" && cloudflareHost) {
			stage = "cloudflare_tunnel";
			const opened = await prepareCloudflare(cloudflaredBin, cloudflareHost, port);
			if (!opened.ok) return fail("problem", opened.message, { code: opened.code, ...(opened.code === "cloudflare_tunnel" ? {} : { next: { kind: "choose_name" } }) });
			tunnelName = opened.tunnel;
			if (options.replaceFunnel && previous?.route === "funnel") {
				// The tunnel is ready, so now the old public route closes. If it won't, nothing is saved and Funnel keeps working.
				const closed = funnelOff(tailscaleBinary());
				if (!closed.ok) return fail("problem", `Funnel didn't turn off (${closed.message}), so the Cloudflare route wasn't saved and Funnel still works.`, { code: "funnel" });
			}
			stage = "config";
		}
		saveRemoteConfig({ publicUrl, port, route, ...(previous?.redirectHosts ? { redirectHosts: previous.redirectHosts } : {}), ...(previous?.allowHosts ? { allowHosts: previous.allowHosts } : {}) });
		say(`${sym.ok} Wrote ${c.dim(remoteFile())}`);
		stage = "service";
		let listening = probe.state === "match";
		if (options.service) {
			const service = await installService();
			say(`${service.ok ? sym.ok : sym.fail} ${service.message}`);
			if (!service.ok) {
				return fail("problem", `The service didn't start, so ${route === "funnel" ? "Funnel was not opened" : "setup isn't finished"}. remote.json is kept; fix the cause and run ${COMMAND_NAME} remote setup again.${json ? ` (${service.message})` : ""}`, { code: "service" });
			}
			if (!(await waitForServe(port, publicUrl, serveWaitMs()))) {
				return fail(
					"problem",
					`${COMMAND_NAME} serve isn't answering on 127.0.0.1:${port} with ${publicUrl}/mcp after ${Math.round(serveWaitMs() / 1000)} seconds, so ${route === "funnel" ? "Funnel was not opened" : "setup isn't finished"}. Look in ${serviceLogHint()}. remote.json is kept; fix the cause and run ${COMMAND_NAME} remote setup again.`,
					{ code: "serve" },
				);
			}
			listening = true;
		}
		if (!listening && (route === "funnel" || json)) {
			// Nothing answers on the port: Funnel stays closed (or, on your own route, there is nothing to reach), so this is not "on".
			return fail(
				"problem",
				`Nothing is listening on 127.0.0.1:${port} yet, so ${route === "funnel" ? "Funnel was not opened" : "remote access isn't on"}. remote.json is kept. Start ${COMMAND_NAME} serve (it reads remote.json), then run ${COMMAND_NAME} remote setup --no-service again.`,
				{ code: "serve" },
			);
		}
		if (route === "cloudflare" && tunnelName) {
			stage = "cloudflare_tunnel";
			const service = await installService(CLOUDFLARE_SERVICE);
			if (!service.ok) return fail("problem", `The Cloudflare tunnel didn't start: ${service.message}`, { code: "service" });
			say(`${sym.ok} Cloudflare tunnel ${tunnelName} on ${publicUrl} ${c.dim(`-> 127.0.0.1:${port}`)}`);
		}
		stage = "funnel";
		if (route === "funnel") {
			let opened = await openFunnel(funnelBin, funnelDns, port);
			if (wait && funnelWaitsOnPerson(opened)) opened = await waitForFunnel(funnelBin, funnelDns, port, opened, say);
			const after = `${sym.dot} remote.json is kept. Fix that, then run ${COMMAND_NAME} remote setup again, or ${COMMAND_NAME} remote off to undo setup.`;
			if (opened.kind === "not_allowed") {
				return fail("funnel_not_allowed", `Funnel isn't enabled for this tailnet or node yet. Open ${opened.url}, enable it, then run ${COMMAND_NAME} remote setup again.`, {
					adminUrl: opened.url,
					after,
					next: { kind: "open_page", url: opened.url },
				});
			}
			if (opened.kind === "failed" && operatorRefusal(opened.message)) {
				return fail("problem", `Tailscale refused to open Funnel because your user isn't its operator. Run this once: ${TAILSCALE_OPERATOR_FIX}, then ${COMMAND_NAME} remote setup again. Tailscale's words: ${opened.message}`, {
					code: "tailscale_operator",
					after,
					next: { kind: "run_command", command: TAILSCALE_OPERATOR_FIX },
				});
			}
			if (opened.kind === "failed") return fail("problem", `tailscale funnel failed: ${opened.message}`, { code: "funnel", after });
			say(`${sym.ok} Tailscale Funnel on ${publicUrl} ${c.dim(`-> 127.0.0.1:${port}`)}`);
		}
		if (!options.service) say(listening ? `${sym.dot} No service installed. Start it yourself: ${c.bold(`${COMMAND_NAME} serve`)}` : `${sym.warn} Nothing is listening on 127.0.0.1:${port} yet. Start it yourself: ${c.bold(`${COMMAND_NAME} serve`)}`);
		if (options.service) {
			const linger = lingerWarning();
			if (linger) say(`${sym.warn} ${linger}`);
		}
		if (route === "cloudflare" && wait) await waitForPublic(publicUrl, say);
		const connectorUrl = `${publicUrl}/mcp`;
		// The one-time connect code a new assistant needs (the passcode alone is refused for one, issue #97). JSON mode makes one only when asked.
		let connect: { code: string; expiresAt: number } | undefined;
		let connectProblem = "";
		if (!json || options.connectCode) {
			try {
				connect = mintApprovalCode();
			} catch (err) {
				connectProblem = err instanceof Error ? err.message : String(err);
			}
		}
		if (json) {
			const report: SetupReport = {
				ok: true,
				state: "on",
				message: "Connector ready.",
				connectorUrl,
				...(madePasscode ? { passcode: madePasscode } : {}),
				passcodeSet: passcodeSet(),
				...(connect ? { connectCode: connect.code, connectCodeExpiresAt: connect.expiresAt } : {}),
				next: { kind: "add_connector", url: connectorUrl },
			};
			emit(report);
			return 0;
		}
		const codeLines = connect
			? `Connect code: ${c.bold(connect.code)}
  Type it on the approval page when you add Polycarp to an assistant for the first time.
  It works once, for 10 minutes. Each new assistant needs its own: ${COMMAND_NAME} token approval-code makes another.`
			: `Connect code: none made (${connectProblem}). Make one with ${COMMAND_NAME} token approval-code before you add an assistant.`;
		const passcodeLines = madePasscode
			? `
Passcode: ${c.bold(madePasscode)}
  For re-approving an assistant you already approved. Shown only in this run; save it now.`
			: "";
		console.log(`
Connector URL: ${c.bold(connectorUrl)}

${codeLines}
${passcodeLines}
Add it to an assistant (paste the connector URL):
  claude.ai   Settings > Connectors > Add custom connector.
  ChatGPT     Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth.
  grok.com    grok.com/connectors > New Connector > Custom.
Each opens Polycarp's approval page: check the name, tick what it may do, type the connect code and press Allow.

Check it with: ${COMMAND_NAME} remote status`);
		return 0;
	} catch (err) {
		if (!json) throw err;
		return fail("problem", `${err instanceof Error ? err.message : String(err)}. remote.json is kept; fix the cause and run ${COMMAND_NAME} remote setup again.`, { code: stage });
	}
}

/** In a terminal, after a Cloudflare setup: a new DNS name takes minutes, so check the public address for up to 5 minutes. */
async function waitForPublic(publicUrl: string, say: (line: string) => void): Promise<void> {
	const every = waitMs("PUBLIC_POLL_MS", 5000);
	const total = waitMs("PUBLIC_WAIT_MS", 5 * 60_000);
	const start = Date.now();
	say(`Waiting for ${publicUrl} to answer from the internet (a new name takes a few minutes), up to ${duration(total)}. Ctrl-C stops; setup is saved.`);
	let shownAt = start;
	for (;;) {
		const result = await metadata(`${publicUrl}${METADATA_PATH}`, 10_000, publicUrl);
		if (result.ok) {
			say(`${sym.ok} ${publicUrl} answers from the internet.`);
			return;
		}
		if (Date.now() + every >= start + total) {
			say(`${sym.warn} ${publicUrl} isn't answering yet (${result.detail}). DNS can take longer; check with ${COMMAND_NAME} remote status.`);
			return;
		}
		if (Date.now() - shownAt >= 30_000) {
			shownAt = Date.now();
			say(`  still waiting, ${duration(Date.now() - start)} so far`);
		}
		await sleep(every);
	}
}

/**
 * Linux stops a user's services at logout unless lingering is on for that user (systemd-logind). Undefined when it is on, when
 * this isn't Linux, or when loginctl can't say.
 */
function lingerWarning(): string | undefined {
	if (process.platform !== "linux") return undefined;
	const user = userInfo().username;
	const r = run("loginctl", ["show-user", user, "-p", "Linger"], 10_000);
	if (r.code !== 0 || lingerFromLoginctl(r.out) !== false) return undefined;
	return `Linux stops your user services when you log out, so assistants can't reach this computer then. To keep them running, run once: loginctl enable-linger ${user}`;
}

/** Linux: is this user Tailscale's operator? A warning when it isn't (Funnel then can't be opened again without sudo), else undefined. */
function operatorWarning(bin: string | undefined): string | undefined {
	if (process.platform !== "linux" || !bin || process.getuid?.() === 0) return undefined;
	const r = run(bin, ["debug", "prefs"], 10_000);
	const operator = r.code === 0 ? operatorFromPrefs(r.out) : undefined;
	if (operator === undefined || operator === userInfo().username) return undefined;
	return `Tailscale needs root for changes your user makes, so ${COMMAND_NAME} remote setup can't open Funnel. Run once: ${TAILSCALE_OPERATOR_FIX}`;
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
	const doh = envVar("DOH_URL") || "https://cloudflare-dns.com/dns-query";
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

/** Which ways of reaching this computer are ready. Reads only; never signs in or installs anything. */
export function remoteRoutes(): RemoteRoutes {
	const tailscale = tailscaleReady();
	return {
		tailscale: { installed: tailscale.ok || tailscale.state !== "tailscale_missing", signedIn: tailscale.ok },
		cloudflare: { installed: Boolean(cloudflaredBinary()), signedIn: cloudflareSignedIn() },
	};
}

/** Read-only: can setup go ahead? ready, or the first thing in the way. Runs the same checks setup runs before it changes anything. */
export async function preflight(): Promise<{ state: RemoteState; message: string; code?: string }> {
	if (existsSync(hubFile())) return { state: "problem", message: `This install is set up as a hub (${hubFile()}), and an install has one public route. Run ${COMMAND_NAME} hub off first.`, code: "hub" };
	const plan = planFunnel([DEFAULT_PORT]);
	if (!plan.ok) return { state: plan.state, message: plan.message, ...(plan.code ? { code: plan.code } : {}) };
	const probe = await probeLocal(DEFAULT_PORT, `https://${plan.dns}:${FUNNEL_PORT}`);
	if (probe.state === "other") return { state: "port_busy", message: `Something already listens on 127.0.0.1:${DEFAULT_PORT} and isn't Polycarp serve (${probe.detail}).`, code: "local_port" };
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
		checks.push({ name: "remote.json", status: "fail", detail: `${remoteFile()} not found. Run ${COMMAND_NAME} remote setup.` });
	}
	let clients = 0;
	// On the Funnel route, Tailscale going away (quit, signed out, uninstalled, Tailnet Lock turned on) is the first thing to say, and
	// nothing past it can work, so the internet-side checks are skipped.
	const blocked = config?.route === "funnel" ? tailscaleReady() : undefined;
	let tailscale: { state: RemoteState; message: string } | undefined = blocked && !blocked.ok ? { state: blocked.state, message: blocked.message } : undefined;
	if (blocked?.ok && config && blocked.state.kind === "ok") {
		// Signed in, but Funnel isn't open for the address remote.json names (turned off in Tailscale, or an earlier refusal never retried):
		// the connector can't be reached from the internet, whatever else answers.
		const address = new URL(config.publicUrl);
		const key = `${address.hostname}:${address.port || "443"}`;
		if (blocked.state.allowFunnel[key] !== true) {
			tailscale = { state: "funnel_closed", message: `Tailscale Funnel isn't open for ${key}, so assistants can't reach this computer. Run ${COMMAND_NAME} remote setup to open it again.` };
		}
	}
	// The same for the Cloudflare route: without cloudflared nothing else on it can work.
	if (config?.route === "cloudflare" && !cloudflaredBinary()) {
		tailscale = { state: "cloudflared_missing", message: "cloudflared isn't installed any more, so assistants can't reach this computer." };
		checks.push({ name: "cloudflare", status: "fail", detail: tailscale.message });
	} else if (config?.route === "cloudflare") {
		const file = serviceFile(CLOUDFLARE_SERVICE);
		const running = Boolean(file && existsSync(file));
		checks.push({ name: "cloudflare", status: running ? "ok" : "fail", detail: running ? `tunnel ${cloudflareTunnelName()}` : `The tunnel's service is gone. Run ${COMMAND_NAME} remote setup --cloudflare ${new URL(config.publicUrl).hostname} again.` });
	} else if (tailscale) checks.push({ name: "tailscale", status: "fail", detail: tailscale.message });
	if (config && !tailscale) {
		const passcode = passcodeSet();
		checks.push({ name: "passcode", status: passcode ? "ok" : "warn", detail: passcode ? "set" : `not set; only a connect code (${COMMAND_NAME} token approval-code) can approve a connection. ${COMMAND_NAME} token passcode sets one.` });
		const local = await probeLocal(config.port, config.publicUrl, 3000);
		const where = `http://127.0.0.1:${config.port}${METADATA_PATH}`;
		checks.push({
			name: "local serve",
			status: local.state === "match" ? "ok" : "fail",
			detail:
				local.state === "match"
					? `${where} answers with resource ${config.publicUrl}/mcp`
					: `${where} ${local.state === "none" ? "didn't answer: connection refused" : local.detail}. Is ${COMMAND_NAME} serve running? ${COMMAND_NAME} remote setup starts it.`,
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
		checks.push({ name: "OAuth clients", status: clients ? "ok" : "warn", detail: clients ? `${clients} registered (${COMMAND_NAME} token clients)` : "none yet; add the connector in claude.ai, ChatGPT or grok.com" });
	}
	// Linux only, both warnings: without operator rights setup can't open Funnel again, and without lingering the service stops at logout.
	if (config?.route !== "cloudflare" && config?.route !== "custom") {
		const operator = operatorWarning(tailscaleBinary());
		if (operator) checks.push({ name: "tailscale user", status: "warn", detail: operator });
	}
	const service = serviceFile();
	if (service && existsSync(service)) {
		const linger = lingerWarning();
		if (linger) checks.push({ name: "linger", status: "warn", detail: linger });
	}
	const ok = checks.every((x) => x.status !== "fail");
	if (options.json) {
		// The state is the app's answer; the checks stay for anyone who wants the detail. The passcode itself is never here.
		const extensionConnected = config && !tailscale ? (await connectionChecks()).checks.some((x) => x.id === "connected" && x.status === "ok") : undefined;
		const { state, message, code } = stateFromStatus({ configured: Boolean(config), checks, extensionConnected, preflight: config ? undefined : await preflight(), tailscale });
		printReport({
			ok,
			state,
			message,
			...(code ? { code } : {}),
			route: config?.route ?? null,
			routes: remoteRoutes(),
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

/** Where tailscaleBinary() looked, for the message when it found nothing: the installer's folder on Windows, else the Mac app. */
export const tailscaleMissing = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) =>
	`Tailscale wasn't found (not on PATH, and not at ${platform === "win32" ? windowsInstallPaths("tailscale", env).join(" or ") : tailscaleAppPath()})`;

/** Close Funnel on 8443. A failure that leaves the entry in place is a failure; an entry already gone counts as off. */
function funnelOff(bin: string | undefined): { ok: boolean; message: string } {
	// Bounded like opening it: a call that never ends is a failure that leaves Funnel as it was.
	const r = bin ? run(bin, ["funnel", `--https=${FUNNEL_PORT}`, "off"], 30_000) : { code: 1, out: tailscaleMissing() };
	if (r.code === 0) return { ok: true, message: `Tailscale Funnel on port ${FUNNEL_PORT} is off.` };
	if (bin) {
		const state = readTailscale(bin);
		if (state.kind === "disconnected" || (state.kind === "ok" && !state.web[`${state.dns}:${FUNNEL_PORT}`])) return { ok: true, message: `Tailscale Funnel on port ${FUNNEL_PORT} was already off.` };
	}
	return { ok: false, message: `Couldn't turn Funnel off: ${r.out}. The service and remote.json are kept; run tailscale funnel --https=${FUNNEL_PORT} off, then ${COMMAND_NAME} remote off again.` };
}


/**
 * Funnel first, then the service, then the files: while Funnel is open, a serve with OAuth on loopback is the safe state.
 * `json`: one object on stdout, `{ok, message, notes}`, and nothing else; the exit code is the same either way.
 */
export async function remoteOff(options: { json?: boolean } = {}): Promise<number> {
	const notes: string[] = [];
	let failure: string | undefined;
	/** A line of the report: printed in text mode, kept for the JSON one. */
	const note = (mark: string, text: string, dim = false) => {
		if (options.json) notes.push(text);
		else console.log(mark ? `${mark} ${dim ? c.dim(text) : text}` : dim ? c.dim(text) : text);
	};
	const problem = (text: string) => {
		failure ??= text;
		if (!options.json) console.error(`${sym.fail} ${text}`);
	};
	const finish = (code: number): number => {
		if (options.json) printReport({ ok: code === 0, message: failure ?? "Remote access is off.", notes });
		return code;
	};
	let config: RemoteConfig | undefined;
	let badFile: string | undefined;
	try {
		config = loadRemoteConfig();
	} catch (err) {
		badFile = err instanceof Error ? err.message : String(err);
	}
	if (badFile !== undefined) note(sym.warn, badFile);
	let code = 0;
	// By the service, not remote.json: a damaged or missing file must not leave a tunnel running.
	const tunnelService = serviceFile(CLOUDFLARE_SERVICE);
	if (config?.route === "cloudflare" || (tunnelService && existsSync(tunnelService))) {
		const closed = closeCloudflare();
		if (!closed.ok) {
			problem(closed.failure ?? "The Cloudflare tunnel's service couldn't be removed.");
			return finish(1);
		}
		for (const line of closed.notes) note(sym.ok, line);
		note("", `The tunnel and its DNS record stay in your Cloudflare account, so turning this on again reuses them. To remove the tunnel: cloudflared tunnel delete ${cloudflareTunnelName()}`, true);
	}
	if (config?.route === "cloudflare") {
		// The tunnel is closed above; there's no Funnel to look for on this route.
	} else if (config?.route === "funnel") {
		const r = funnelOff(tailscaleBinary());
		if (!r.ok) {
			problem(r.message);
			return finish(1);
		}
		note(sym.ok, r.message);
	} else {
		const stray = await strayFunnel();
		if (stray.kind === "unknown") {
			problem(`${stray.message} Nothing was changed. Start Tailscale and run ${COMMAND_NAME} remote off again.`);
			return finish(1);
		}
		if (stray.kind === "found" && stray.ours) {
			const r = funnelOff(stray.bin);
			if (!r.ok) {
				problem(r.message);
				return finish(1);
			}
			note(sym.ok, r.message);
		} else if (stray.kind === "found") {
			problem(
				`Tailscale Funnel on port ${FUNNEL_PORT} forwards ${stray.paths.join(", ")} to a local port, but not everything there answers like Polycarp serve, so it was left on. If it is yours to close, run tailscale funnel --https=${FUNNEL_PORT} off.`,
			);
			code = 1;
		}
	}
	const service = removeService();
	if (!service.ok) {
		problem(service.failure ?? "The service couldn't be removed.");
		return finish(1);
	}
	for (const line of service.notes) note(sym.ok, line);
	if (config || badFile !== undefined) {
		rmSync(remoteFile(), { force: true });
		note(sym.ok, `Removed ${remoteFile()}`);
	} else {
		note(sym.dot, "No remote.json; nothing else to remove.");
	}
	if (config?.route === "custom") note(sym.warn, `Your own front door for ${config.publicUrl} still forwards to this machine. Stop it there (for example, stop cloudflared); ${COMMAND_NAME} remote off can't.`);
	note("", `Approved connectors keep their grants in oauth.json. ${COMMAND_NAME} token clients lists them; ${COMMAND_NAME} token revoke <client id> ends one.`, true);
	return finish(code);
}
