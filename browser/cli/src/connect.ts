/**
 * `polycarp browser connect on|off|status`: one step that lets claude.ai, ChatGPT and grok.com reach this
 * computer's Polycarp browser. It asks Polycarp's connection service for a free Cloudflare named tunnel
 * (service/ in the connect/ folder of this repo), then reuses `remote setup --public-url` for everything on
 * this computer: the passcode, OAuth, and the service that keeps `serve` running.
 *
 * Nothing about the person's browser ever goes to the connection service. It receives a device public key,
 * signed requests and a port number. The approval passcode, OAuth and every access token stay here.
 */

import { createPrivateKey, createPublicKey, createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ensureCloudflared } from "./connect-cloudflared.ts";
import { hubFile } from "./hub-state.ts";
import { configDir, normalizePublicUrl, passcodeSet, setPasscode } from "./oauth.ts";
import { loadRemoteConfig, metadata, METADATA_PATH, probeLocal, remoteOff, remoteSetup, type Check } from "./remote-setup.ts";
import { removeService, installService, run, serviceFile, serviceLogHint, sleep, writeAtomic, type ServiceSpec } from "./service.ts";
import { DEFAULT_PORT } from "./tunnel.ts";
import { c, sym } from "./ui.ts";

/** Where the connection service lives. POLYCARP_CONNECT_URL overrides it (tests, or a self-hosted copy). */
export const DEFAULT_CONNECT_URL = "https://connect.dbaney.com";

export class ConnectUsageError extends Error {}

export function connectServiceUrl(): string {
	const raw = process.env.POLYCARP_CONNECT_URL || DEFAULT_CONNECT_URL;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`POLYCARP_CONNECT_URL isn't a web address (got ${raw}).`);
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("POLYCARP_CONNECT_URL must use https.");
	return url.origin;
}

export const CONNECT_SERVICE: ServiceSpec = {
	label: "com.polycarp.connect",
	unit: "polycarp-connect.service",
	args: ["connect", "run"],
	logName: "polycarp-connect.log",
	description: "Polycarp Connect (keeps the connection to your web agents open)",
	off: "polycarp browser connect off",
	kept: "the connection record",
};

// ---------- files: device key and state ----------

const connectDir = () => join(configDir(), "connect");
const keyFile = () => join(connectDir(), "device.key");
const stateFile = () => join(connectDir(), "state.json");

export interface DeviceKey {
	privateKey: KeyObject;
	/** base64url of the raw 32-byte public key. */
	publicKey: string;
}

function toDeviceKey(privateKey: KeyObject): DeviceKey {
	const jwk = createPublicKey(privateKey).export({ format: "jwk" }) as { x?: string };
	if (!jwk.x) throw new Error("Couldn't read the device key.");
	return { privateKey, publicKey: jwk.x };
}

/** The device key, or undefined when there isn't one. A key file other users can read is tightened to 600. */
export function readDeviceKey(): DeviceKey | undefined {
	if (!existsSync(keyFile())) return undefined;
	if (process.platform !== "win32" && (statSync(keyFile()).mode & 0o077) !== 0) chmodSync(keyFile(), 0o600);
	return toDeviceKey(createPrivateKey(readFileSync(keyFile(), "utf8")));
}

export function deviceKey(): DeviceKey {
	const existing = readDeviceKey();
	if (existing) return existing;
	mkdirSync(connectDir(), { recursive: true, mode: 0o700 });
	const { privateKey } = generateKeyPairSync("ed25519");
	writeAtomic(keyFile(), privateKey.export({ format: "pem", type: "pkcs8" }) as string, 0o600);
	return toDeviceKey(privateKey);
}

export interface ConnectState {
	version: 1;
	hostname: string;
	port: number;
	serviceUrl: string;
	/** Absolute path of the cloudflared that `connect run` starts. */
	cloudflared: string;
	claimedAt: number;
	/** Turned off here, but the service couldn't be told yet. */
	releasePending?: boolean;
}

export function loadState(): ConnectState | undefined {
	try {
		const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<ConnectState>;
		if (raw && raw.version === 1 && typeof raw.hostname === "string" && typeof raw.port === "number" && typeof raw.serviceUrl === "string" && typeof raw.cloudflared === "string") return raw as ConnectState;
	} catch {
		/* none, or unreadable: treated as off */
	}
	return undefined;
}

const saveState = (state: ConnectState): void => writeAtomic(stateFile(), `${JSON.stringify(state, null, "\t")}\n`, 0o600);

// ---------- the connection service ----------

export type ServiceCall = { reply: { httpStatus: number; body: Record<string, unknown> } } | { offline: string };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** One call to the connection service. Signed with the device key when `key` is given. Never throws. */
export async function callService(method: string, path: string, options: { key?: DeviceKey; body?: unknown; base?: string; fetchFn?: typeof fetch } = {}): Promise<ServiceCall> {
	const base = options.base ?? connectServiceUrl();
	const text = options.body === undefined ? "" : JSON.stringify(options.body);
	const headers: Record<string, string> = {};
	if (text) headers["content-type"] = "application/json";
	if (options.key) {
		const time = String(Math.floor(Date.now() / 1000));
		const nonce = randomBytes(18).toString("base64url");
		const message = ["polycarp-connect/v1", method, path, time, nonce, sha256(text)].join("\n");
		headers["x-polycarp-key"] = options.key.publicKey;
		headers["x-polycarp-time"] = time;
		headers["x-polycarp-nonce"] = nonce;
		headers["x-polycarp-sig"] = edSign(null, Buffer.from(message), options.key.privateKey).toString("base64url");
	}
	try {
		const res = await (options.fetchFn ?? fetch)(`${base}${path}`, { method, headers, ...(text ? { body: text } : {}), signal: AbortSignal.timeout(20_000) });
		let body: Record<string, unknown> = {};
		try {
			body = (await res.json()) as Record<string, unknown>;
		} catch {
			/* a non-JSON answer reads as an empty one */
		}
		return { reply: { httpStatus: res.status, body } };
	} catch (err) {
		return { offline: err instanceof Error ? err.message : String(err) };
	}
}

// ---------- results ----------

export type ConnectStateName = "off" | "on" | "connecting" | "problem" | "at_capacity" | "invite_only" | "invite_invalid" | "paused" | "rate_limited" | "offline" | "unsupported";

export interface ConnectResult {
	ok: boolean;
	state: ConnectStateName;
	/** One plain sentence for a person. */
	message: string;
	/** What to do next, in a command. */
	next?: string;
	connectorUrl?: string;
	hostname?: string;
	/** Present once, when the passcode was just made. */
	passcode?: string;
	checks?: Check[];
}

const WORDS = {
	paused: "Polycarp isn't adding new connections right now. Please try again later.",
	at_capacity: "Polycarp's free connections are full right now. Join the waitlist, or enter an invite code.",
	invite_only: "New connections need an invite code right now. Enter your code, or join the waitlist.",
	invite_invalid: "That invite code isn't valid, or it was already used.",
	rate_limited: "Too many tries from here. Please wait a while and try again.",
	offline: "Can't reach Polycarp's connection service. Check your internet connection and try again.",
	trouble: "Polycarp's connection service is having trouble. Try again in a few minutes.",
};

const WAITLIST_NEXT = "Join the waitlist: polycarp browser connect waitlist you@example.com   ·   Have a code: polycarp browser connect on --invite PC-XXXX-XXXX-XXXX-XXXX";

/** Turn the service's answer to a refused claim or capacity check into a result a person can read. */
function refusal(body: Record<string, unknown>, httpStatus: number): ConnectResult | undefined {
	const s = String(body.status ?? "");
	if (s === "paused") return { ok: false, state: "paused", message: WORDS.paused };
	if (s === "at_capacity") return { ok: false, state: "at_capacity", message: WORDS.at_capacity, next: WAITLIST_NEXT };
	if (s === "invite_required") return { ok: false, state: "invite_only", message: WORDS.invite_only, next: WAITLIST_NEXT };
	if (s === "invite_invalid") return { ok: false, state: "invite_invalid", message: WORDS.invite_invalid, next: WAITLIST_NEXT };
	if (s === "rate_limited" || httpStatus === 429) return { ok: false, state: "rate_limited", message: WORDS.rate_limited };
	if (s === "in_progress") return { ok: false, state: "connecting", message: "Your connection is still being set up. Try again in a minute." };
	if (s === "unauthorized") return { ok: false, state: "problem", message: String(body.message ?? "The connection service didn't accept this computer's request. Check that its clock is right.") };
	if (s === "unavailable" || httpStatus >= 500) return { ok: false, state: "offline", message: WORDS.trouble };
	return undefined;
}

/** Run `fn` with console.log and console.error collected instead of printed. Reused code (remote setup) talks a lot. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
	const lines: string[] = [];
	const { log, error } = console;
	console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
	try {
		return { value: await fn(), lines };
	} finally {
		console.log = log;
		console.error = error;
	}
}

// Test hook, never set in real use: look for the public answer here instead of at the real address.
const publicBase = (publicUrl: string) => process.env.POLYCARP_CONNECT_PUBLIC_BASE || publicUrl;

const platformSupported = () => process.platform === "darwin" || process.platform === "linux";

// ---------- on ----------

export interface OnOptions {
	invite?: string;
	port?: number;
	/** Install the user services. False (--no-service): you start `serve` and `connect run` yourself. */
	service: boolean;
	wait: boolean;
	newPasscode: boolean;
	say?: (line: string) => void;
}

export async function connectOn(options: OnOptions): Promise<ConnectResult> {
	const say = options.say ?? (() => undefined);
	if (!platformSupported()) return { ok: false, state: "unsupported", message: "Polycarp can't set up Connect on this kind of computer yet. It works on a Mac for now." };
	// Everything that can refuse here, before a slot is taken.
	if (existsSync(hubFile())) return { ok: false, state: "problem", message: "This computer is set up as a hub, and it can have only one way in. Turn the hub off first (polycarp browser hub off)." };
	let previous: ReturnType<typeof loadRemoteConfig>;
	try {
		previous = loadRemoteConfig();
	} catch (err) {
		return { ok: false, state: "problem", message: `${err instanceof Error ? err.message : String(err)} Nothing was changed.` };
	}
	const existing = loadState();
	if (previous && !(existing && previous.publicUrl === `https://${existing.hostname}`)) {
		return { ok: false, state: "problem", message: `Remote access is already set up another way (${previous.publicUrl}). Turn it off first (polycarp browser remote off), then turn Connect on. Nothing was changed.` };
	}
	const port = options.port ?? existing?.port ?? previous?.port ?? DEFAULT_PORT;
	let base: string;
	try {
		base = connectServiceUrl();
	} catch (err) {
		return { ok: false, state: "problem", message: err instanceof Error ? err.message : String(err) };
	}
	const key = deviceKey();

	// Is there room? Asked first, so nobody downloads a helper for a door that is shut.
	if (!options.invite) {
		const cap = await callService("GET", "/v1/capacity", { base });
		if ("offline" in cap) return { ok: false, state: "offline", message: WORDS.offline };
		const body = cap.reply.body;
		if (body.paused === true) return { ok: false, state: "paused", message: WORDS.paused };
		if (body.status === "at_capacity" && !existing) return { ok: false, state: "at_capacity", message: WORDS.at_capacity, next: WAITLIST_NEXT };
		if (body.status === "invite_only" && !existing) return { ok: false, state: "invite_only", message: WORDS.invite_only, next: WAITLIST_NEXT };
		if (cap.reply.httpStatus >= 500) return { ok: false, state: "offline", message: WORDS.trouble };
	}

	const cloudflared = await ensureCloudflared({ say });
	if (!cloudflared.ok) return { ok: false, state: "problem", message: cloudflared.message };

	say("Setting up your connection…");
	const claim = await callService("POST", "/v1/claim", { base, key, body: { port, ...(options.invite ? { invite: options.invite } : {}) } });
	if ("offline" in claim) return { ok: false, state: "offline", message: WORDS.offline };
	const body = claim.reply.body;
	if (claim.reply.httpStatus !== 200 || body.status !== "ok") {
		return refusal(body, claim.reply.httpStatus) ?? { ok: false, state: "problem", message: `The connection service said no (${claim.reply.httpStatus}).` };
	}
	const hostname = String(body.hostname ?? "");
	if (!/^[a-z0-9.-]+$/.test(hostname) || !hostname.includes(".")) return { ok: false, state: "problem", message: "The connection service gave an address that doesn't look right, so nothing was set up." };
	let publicUrl: string;
	try {
		publicUrl = normalizePublicUrl(`https://${hostname}`);
	} catch {
		return { ok: false, state: "problem", message: "The connection service gave an address that doesn't look right, so nothing was set up." };
	}
	saveState({ version: 1, hostname, port, serviceUrl: base, cloudflared: cloudflared.path, claimedAt: Math.floor(Date.now() / 1000) });

	const undo = async (reason: string, lines: string[]): Promise<ConnectResult> => {
		await quietly(async () => {
			removeService(CONNECT_SERVICE);
			return remoteOff({ frontDoorStopped: true });
		});
		await callService("DELETE", "/v1/claim", { base, key });
		rmSync(stateFile(), { force: true });
		const detail = lines.filter((l) => l && !/No passcode made/.test(l)).join(" ").slice(0, 600);
		return { ok: false, state: "problem", message: `${reason}${detail ? ` (${detail})` : ""} Nothing is left turned on.` };
	};

	// Everything on this computer is the existing remote setup, pointed at the new address.
	const setup = await quietly(() => remoteSetup({ publicUrl, port, service: options.service, passcode: false }));
	if (setup.value !== 0) return undo("Couldn't finish setting up Polycarp on this computer.", setup.lines.map((l) => l.replace(/^\S+\s/, "")));
	let passcode: string | undefined;
	if (options.newPasscode || !passcodeSet()) passcode = setPasscode();

	if (options.service) {
		const svc = await installService(CONNECT_SERVICE);
		if (!svc.ok) return undo("Couldn't start the connection on this computer.", [svc.message]);
	}

	const connectorUrl = `${publicUrl}/mcp`;
	let state: ConnectResult["state"] = "connecting";
	let message = "Almost there: the connection is starting. It can take a minute to answer from the internet.";
	if (options.service && options.wait) {
		say("Waiting for the connection to answer…");
		const until = Date.now() + (Number(process.env.POLYCARP_CONNECT_WAIT_MS) || 40_000);
		for (;;) {
			if ((await metadata(`${publicBase(publicUrl)}${METADATA_PATH}`, 8000, publicUrl)).ok) {
				state = "on";
				message = "Connected. Claude, ChatGPT and Grok can now use your browser once you add the connector.";
				break;
			}
			if (Date.now() >= until) break;
			await sleep(1500);
		}
	} else if (!options.service) {
		message = "Set up, but nothing is keeping it running (--no-service). Start `polycarp browser serve` and `polycarp browser connect run` yourself.";
	}
	return { ok: true, state, message, connectorUrl, hostname, ...(passcode ? { passcode } : {}) };
}

// ---------- off ----------

export async function connectOff(): Promise<ConnectResult> {
	const state = loadState();
	const key = readDeviceKey();
	if (!state && !key) return { ok: true, state: "off", message: "Connect is already off." };
	const svc = removeService(CONNECT_SERVICE);
	if (!svc.ok) return { ok: false, state: "problem", message: svc.failure ?? "Couldn't stop the connection on this computer.", next: "Fix that, then run polycarp browser connect off again." };
	// Turn Polycarp's remote access off only if it is the one Connect made.
	let remoteMessage: string | undefined;
	try {
		const remote = loadRemoteConfig();
		if (remote && state && remote.publicUrl === `https://${state.hostname}`) {
			const off = await quietly(() => remoteOff({ frontDoorStopped: true }));
			if (off.value !== 0) return { ok: false, state: "problem", message: `Couldn't turn off remote access on this computer (${off.lines.join(" ").slice(0, 400)}).`, next: "Fix that, then run polycarp browser connect off again." };
		} else if (remote) {
			remoteMessage = `Remote access that isn't Connect's (${remote.publicUrl}) was left alone.`;
		}
	} catch {
		/* a broken remote.json is remote setup's to report */
	}
	let freed = true;
	let why = "";
	let held = true;
	if (key) {
		const call = await callService("DELETE", "/v1/claim", { key, base: state?.serviceUrl });
		if ("offline" in call) {
			freed = false;
			why = "Couldn't reach the connection service to free your connection.";
		} else if (call.reply.httpStatus !== 200) {
			freed = false;
			why = String(call.reply.body.message ?? `The connection service said ${call.reply.httpStatus}.`);
		} else {
			held = call.reply.body.released !== false;
		}
	}
	if (!freed && state) {
		saveState({ ...state, releasePending: true });
		return { ok: false, state: "off", message: `Connect is off on this computer, but your connection isn't freed yet. ${why} It frees itself after 60 days unused; run this again when you're online to free it now.`, next: "polycarp browser connect off" };
	}
	rmSync(stateFile(), { force: true });
	if (!state && !held) return { ok: true, state: "off", message: "Connect is already off." };
	return { ok: true, state: "off", message: `Connect is off and your connection is freed.${remoteMessage ? ` ${remoteMessage}` : ""}` };
}

// ---------- status ----------

async function serviceRunning(spec: ServiceSpec): Promise<boolean> {
	if (process.platform === "darwin") {
		const r = run("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${spec.label}`]);
		return r.code === 0 && !/state = (waiting|not running)/.test(r.out);
	}
	if (process.platform === "linux") return run("systemctl", ["--user", "is-active", spec.unit]).code === 0;
	return false;
}

export async function connectStatus(): Promise<ConnectResult> {
	const state = loadState();
	if (!state) {
		return { ok: true, state: "off", message: "Connect is off.", next: "polycarp browser connect on" };
	}
	if (state.releasePending) {
		return { ok: false, state: "off", message: "Connect is off on this computer, but your connection isn't freed yet.", next: "polycarp browser connect off" };
	}
	const checks: Check[] = [];
	const add = (name: string, status: Check["status"], detail: string) => checks.push({ name, status, detail });
	const publicUrl = `https://${state.hostname}`;
	const running = await serviceRunning(CONNECT_SERVICE);
	add("connection", running ? "ok" : "fail", running ? `running (${serviceFile(CONNECT_SERVICE) ?? "service"})` : `not running. Look in ${serviceLogHint(CONNECT_SERVICE)}, or run polycarp browser connect on again.`);
	let remote: ReturnType<typeof loadRemoteConfig>;
	try {
		remote = loadRemoteConfig();
	} catch (err) {
		add("remote.json", "fail", err instanceof Error ? err.message : String(err));
	}
	if (!remote) add("remote.json", "fail", "missing. Run polycarp browser connect on again.");
	else if (remote.publicUrl !== publicUrl) add("remote.json", "fail", `points at ${remote.publicUrl}, not ${publicUrl}.`);
	else add("remote.json", "ok", `${publicUrl}, local port ${remote.port}`);
	add("passcode", passcodeSet() ? "ok" : "warn", passcodeSet() ? "set" : "not set; only a one-time connect code can approve a connection.");
	const local = await probeLocal(state.port, publicUrl, 3000);
	add("polycarp serve", local.state === "match" ? "ok" : "fail", local.state === "match" ? `answers on 127.0.0.1:${state.port}` : local.state === "none" ? `not answering on 127.0.0.1:${state.port}` : local.detail);
	const pub = await metadata(`${publicBase(publicUrl)}${METADATA_PATH}`, 10_000, publicUrl);
	add("from the internet", pub.ok ? "ok" : "fail", pub.ok ? "answers" : pub.detail);
	// Telling the service we're here also keeps the connection from being freed as unused.
	const seen = await callService("POST", "/v1/seen", { key: deviceKey(), base: state.serviceUrl });
	if ("offline" in seen) add("connection service", "warn", "can't be reached right now");
	else if (seen.reply.httpStatus === 200) add("connection service", "ok", "knows this computer");
	else if (seen.reply.httpStatus === 404) add("connection service", "fail", "no longer has this connection (unused connections are freed after 60 days). Run polycarp browser connect on again.");
	else add("connection service", "warn", String(seen.reply.body.message ?? `answered ${seen.reply.httpStatus}`));
	const failed = checks.filter((x) => x.status === "fail");
	const justStarted = Date.now() / 1000 - state.claimedAt < 120;
	if (!failed.length) return { ok: true, state: "on", message: "Connect is on and answering from the internet.", connectorUrl: `${publicUrl}/mcp`, hostname: state.hostname, checks };
	if (justStarted && running) return { ok: true, state: "connecting", message: "Connect is starting. It can take a minute to answer from the internet.", connectorUrl: `${publicUrl}/mcp`, hostname: state.hostname, checks };
	const first = failed[0] as Check;
	return { ok: false, state: "problem", message: `Connect is set up but not working: ${first.name} ${first.detail}`, connectorUrl: `${publicUrl}/mcp`, hostname: state.hostname, checks };
}

// ---------- waitlist ----------

export async function connectWaitlist(email: string, removeToken?: string): Promise<ConnectResult & { deleteToken?: string }> {
	let base: string;
	try {
		base = connectServiceUrl();
	} catch (err) {
		return { ok: false, state: "problem", message: err instanceof Error ? err.message : String(err) };
	}
	const call = await callService(removeToken ? "DELETE" : "POST", "/v1/waitlist", { base, body: removeToken ? { email, token: removeToken } : { email } });
	if ("offline" in call) return { ok: false, state: "offline", message: WORDS.offline };
	const body = call.reply.body;
	if (call.reply.httpStatus === 200 && body.status === "ok") {
		if (removeToken) return { ok: true, state: "off", message: "Your email was removed from the waitlist." };
		return { ok: true, state: "at_capacity", message: "You're on the waitlist. We only use your email to tell you when there's room.", next: `To remove it later: polycarp browser connect waitlist ${email} --token ${String(body.deleteToken)}`, deleteToken: String(body.deleteToken) };
	}
	if (call.reply.httpStatus === 429) return { ok: false, state: "rate_limited", message: WORDS.rate_limited };
	return { ok: false, state: "problem", message: String(body.message ?? `The connection service said ${call.reply.httpStatus}.`) };
}

// ---------- run: the service entry point ----------

export interface RunHooks {
	/** Tests: stop after this many heartbeats or when this resolves. */
	signal?: AbortSignal;
	log?: (line: string) => void;
}

/**
 * What the user service runs. It asks for the tunnel token again at each start (claim is idempotent), so the
 * token is never written to disk, keeps `cloudflared` running with it in its environment, and tells the
 * service every few hours that this computer is still here.
 */
export async function connectRun(hooks: RunHooks = {}): Promise<number> {
	const log = hooks.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
	const state = loadState();
	const key = readDeviceKey();
	if (!state || !key || state.releasePending) {
		log("Connect isn't on here. Run polycarp browser connect on.");
		return 1;
	}
	const heartbeatMs = Number(process.env.POLYCARP_CONNECT_HEARTBEAT_MS) || 6 * 3600 * 1000;
	let child: ChildProcess | undefined;
	let stopping = false;
	const stop = () => {
		stopping = true;
		child?.kill("SIGTERM");
	};
	hooks.signal?.addEventListener("abort", stop);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	let backoff = 5000;
	while (!stopping) {
		const claim = await callService("POST", "/v1/claim", { key, base: state.serviceUrl, body: { port: state.port } });
		const token = "reply" in claim && claim.reply.body.status === "ok" ? String(claim.reply.body.tunnelToken ?? "") : "";
		if (!token) {
			const why = "offline" in claim ? "can't reach the connection service" : `the connection service said ${String(claim.reply.body.status ?? claim.reply.httpStatus)}`;
			log(`Waiting to connect: ${why}.`);
			await sleep(Math.min(backoff, 600_000));
			backoff = Math.min(backoff * 2, 600_000);
			continue;
		}
		backoff = 5000;
		log("Connecting…");
		// cloudflared gets the token in its environment, not on its command line (ps shows command lines).
		child = spawn(state.cloudflared, ["tunnel", "--no-autoupdate", "run"], { stdio: ["ignore", "inherit", "inherit"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TUNNEL_TOKEN: token } });
		const exited = new Promise<number>((resolve) => {
			child?.on("exit", (code) => resolve(code ?? 1));
			child?.on("error", () => resolve(1));
		});
		const beat = setInterval(() => {
			void callService("POST", "/v1/seen", { key, base: state.serviceUrl }).then((r) => {
				if ("reply" in r && r.reply.httpStatus === 404) {
					log("The service no longer has this connection; asking for a new one.");
					child?.kill("SIGTERM");
				}
			});
		}, heartbeatMs);
		const startedAt = Date.now();
		const code = await exited;
		clearInterval(beat);
		if (stopping) break;
		log(`The helper stopped (${code}); starting it again.`);
		await sleep(Date.now() - startedAt < 10_000 ? 5000 : 1000);
	}
	return 0;
}

// ---------- the command line ----------

export const CONNECT_USAGE = "Usage: polycarp browser connect on [--invite CODE] [--port N] [--no-service] [--no-wait] [--new-passcode] [--json] | off [--json] | status [--json] | waitlist <email> [--token T] [--json]";

const exitFor = (r: ConnectResult): number => (r.ok ? 0 : r.state === "at_capacity" || r.state === "invite_only" || r.state === "paused" ? 3 : 1);

function print(r: ConnectResult, json: boolean): void {
	if (json) {
		process.stdout.write(`${JSON.stringify(r)}\n`);
		return;
	}
	console.log(`${r.ok ? sym.ok : sym.fail} ${r.message}`);
	if (r.connectorUrl) console.log(`\nConnector URL: ${c.bold(r.connectorUrl)}`);
	if (r.passcode) console.log(`Approval passcode (shown once): ${c.bold(r.passcode)}`);
	if (r.connectorUrl) {
		console.log(`
  claude.ai   Settings > Connectors > Add custom connector, paste the URL.
  ChatGPT     Settings > Apps & Connectors (developer mode) > Create, paste the URL, OAuth.
  grok.com    grok.com/connectors > New Connector > Custom, paste the URL.

When one asks to connect, type the passcode on the approval page.${r.passcode ? " Keep it in a password manager." : " Your passcode was shown the first time; polycarp browser connect on --new-passcode makes a new one."}`);
	}
	for (const check of r.checks ?? []) console.log(`${check.status === "ok" ? sym.ok : check.status === "warn" ? sym.warn : sym.fail} ${check.name.padEnd(18)} ${c.dim(check.detail)}`);
	if (r.next) console.log(c.dim(r.next));
}

/** argv is everything after `connect`. */
export async function runConnect(argv: string[]): Promise<number> {
	const flag = (name: string) => argv.includes(name);
	const option = (name: string): string | undefined => {
		const eq = argv.find((a) => a.startsWith(`${name}=`));
		if (eq) return eq.slice(name.length + 1);
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const values = new Set(["--invite", "--port", "--token"]);
	const positional = argv.filter((a, i) => !a.startsWith("-") && !(values.has(argv[i - 1] ?? "")));
	const [sub, arg] = positional;
	const json = flag("--json");
	const say = (line: string) => (json ? process.stderr.write(`${line}\n`) : console.log(c.dim(line)));
	if (sub === "on") {
		const rawPort = option("--port");
		const port = rawPort === undefined ? undefined : Number(rawPort);
		if (port !== undefined && (!Number.isInteger(port) || port < 1024 || port > 65535)) throw new ConnectUsageError("--port takes a port number from 1024 to 65535.");
		const r = await connectOn({ invite: option("--invite"), port, service: !flag("--no-service"), wait: !flag("--no-wait"), newPasscode: flag("--new-passcode"), say });
		print(r, json);
		return exitFor(r);
	}
	if (sub === "off") {
		const r = await connectOff();
		print(r, json);
		return exitFor(r);
	}
	if (sub === "status") {
		const r = await connectStatus();
		print(r, json);
		return exitFor(r);
	}
	if (sub === "waitlist") {
		if (!arg) throw new ConnectUsageError(`waitlist needs your email. ${CONNECT_USAGE}`);
		const r = await connectWaitlist(arg, option("--token"));
		print(r, json);
		return r.ok ? 0 : 1;
	}
	if (sub === "run") return connectRun();
	throw new ConnectUsageError(CONNECT_USAGE);
}
