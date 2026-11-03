/**
 * The native host's side of Settings > Connect: how this computer is reached from claude.ai,
 * ChatGPT or grok.com, the devices behind one connector, and joining a hub. The side panel sends
 * `{type: "connect", id, method, params?}` and gets `{type: "connect", id, result | error}` back
 * (plus `progress` while `joinHub` works).
 *
 * The frame is untrusted input from a browser page, so it is parsed strictly: exactly the known
 * fields, a known method, params of exactly that method's shape. Anything else is answered with
 * an error and runs nothing. `joinHub` checks its hub address and its code before any network
 * call. Replies never carry a secret, a token hash or the passcode. Code minting is limited to
 * ten per ten minutes, counted in a private file so a new host process does not reset it. Nothing here prints to stdout: that stream is the channel to the browser.
 */

import type { HostConnect } from "../../src/bridge/protocol.ts";
import {
	type ApprovalCode,
	CODE_LIMIT,
	CODE_WINDOW_MS,
	CONNECT_METHODS,
	type ConnectDevice,
	type ConnectMethod,
	type ConnectRoute,
	type ConnectStatus,
	type DeviceCode,
	type JoinResult,
} from "../../src/connect/types.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CodeLimitError, normalizeCode, REQUEST_LOCK_MS } from "./codes.ts";
import { LockTimeoutError, readJsonFile, withFileLock, withFileLockAsync, writeJsonPrivate } from "./files.ts";
import { deviceRows } from "./hub-admin.ts";
import { devicesFile, devicesReadable, hubFile, loadHubConfig, mintConnectCode, validDeviceName } from "./hub-state.ts";
import { type EnrollHooks, type EnrollResult, enrollDevice, HubCodeError, LinkError, linkFile, linkOnline, loadLinkConfig, mintViaHub, normalizeHubUrl, readLinkLive, setLinkBusyAsync } from "./link.ts";
import { configDir, DEFAULT_GRANT, mintApprovalCode, passcodeSet } from "./oauth.ts";
import { SCOPES } from "./remote.ts";
import { loadRemoteConfig, remoteFile } from "./remote-setup.ts";
import { isAccent, isMode, loadTheme, PRESETS, saveTheme } from "./theme.ts";

// ---------- parsing ----------

export type ConnectCall =
	| { method: "status" }
	| { method: "approvalCode" }
	| { method: "deviceCode" }
	| { method: "setBusy"; busy: boolean }
	| { method: "joinHub"; hubUrl: string; code: string; name?: string }
	| { method: "setTheme"; preset?: string; accent?: string | null; mode?: string };

export type ParsedConnect = { ok: true; id: number; call: ConnectCall } | { ok: false; id?: number; message: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `params` must hold only these keys. Returns a sentence when it holds another. */
function onlyKeys(params: Record<string, unknown>, allowed: string[]): string | undefined {
	const extra = Object.keys(params).filter((k) => !allowed.includes(k));
	return extra.length ? `Unexpected field ${JSON.stringify(extra[0].slice(0, 30))}.` : undefined;
}

/** The text a person sees for a hub address that isn't acceptable. */
const BAD_HUB_URL = "The hub address must be https://host with nothing after it (http works only for localhost).";

/**
 * Exactly `{type: "connect", id, method, params?}` with a known method and that method's params,
 * or the reason it isn't. Pure: no file is read and nothing is sent.
 */
export function parseConnect(message: unknown): ParsedConnect {
	if (!isPlainObject(message)) return { ok: false, message: "A connect frame is an object." };
	const id = Number.isSafeInteger(message.id) && (message.id as number) >= 0 ? (message.id as number) : undefined;
	const fail = (text: string): ParsedConnect => ({ ok: false, ...(id !== undefined ? { id } : {}), message: text });
	if (message.type !== "connect") return fail("Not a connect frame.");
	if (id === undefined) return fail("The id must be a whole number.");
	const stray = Object.keys(message).find((k) => !["type", "id", "method", "params"].includes(k));
	if (stray !== undefined) return fail(`Unexpected field ${JSON.stringify(stray.slice(0, 30))}.`);
	if (typeof message.method !== "string") return fail("The method must be a string.");
	if (!(CONNECT_METHODS as readonly string[]).includes(message.method)) return fail(`Unknown method ${JSON.stringify(message.method.slice(0, 40))}.`);
	const method = message.method as ConnectMethod;
	if (message.params !== undefined && !isPlainObject(message.params)) return fail("params must be an object.");
	const params = (message.params ?? {}) as Record<string, unknown>;
	const call = (c: ConnectCall): ParsedConnect => ({ ok: true, id, call: c });
	switch (method) {
		case "status":
		case "approvalCode":
		case "deviceCode": {
			const problem = onlyKeys(params, []);
			return problem ? fail(problem) : call({ method });
		}
		case "setBusy": {
			const problem = onlyKeys(params, ["busy"]);
			if (problem) return fail(problem);
			if (typeof params.busy !== "boolean") return fail("busy must be true or false.");
			return call({ method, busy: params.busy });
		}
		case "joinHub": {
			const problem = onlyKeys(params, ["hubUrl", "code", "name"]);
			if (problem) return fail(problem);
			if (typeof params.hubUrl !== "string" || params.hubUrl.length === 0 || params.hubUrl.length > 300) return fail(BAD_HUB_URL);
			let hubUrl: string;
			try {
				hubUrl = normalizeHubUrl(params.hubUrl.trim());
			} catch {
				return fail(BAD_HUB_URL);
			}
			if (typeof params.code !== "string") return fail("The connect code looks like TK-XXXX-XXXX.");
			const code = normalizeCode(params.code);
			if (!code) return fail("The connect code looks like TK-XXXX-XXXX.");
			if (params.name !== undefined && (typeof params.name !== "string" || !validDeviceName(params.name))) {
				return fail("The device name can use letters, digits, dot, dash, underscore and space, up to 40.");
			}
			return call({ method, hubUrl, code, ...(typeof params.name === "string" ? { name: params.name } : {}) });
		}
		case "setTheme": {
			const problem = onlyKeys(params, ["preset", "accent", "mode"]);
			if (problem) return fail(problem);
			// The preset may be left out only to change the mode alone; the saved preset and accent are then kept.
			if (params.preset === undefined && params.mode === undefined) return fail("Send a preset, a mode, or both.");
			if (params.preset !== undefined && (typeof params.preset !== "string" || !Object.hasOwn(PRESETS, params.preset))) return fail(`preset is one of ${Object.keys(PRESETS).join(", ")}.`);
			if (params.accent !== undefined && params.accent !== null && !isAccent(params.accent)) return fail("accent is #rrggbb, or null for the preset's own.");
			if (params.mode !== undefined && !isMode(params.mode)) return fail("mode is light, dark or system.");
			return call({
				method,
				...(params.preset !== undefined ? { preset: params.preset as string } : {}),
				...(params.accent !== undefined ? { accent: params.accent as string | null } : {}),
				...(params.mode !== undefined ? { mode: params.mode as string } : {}),
			});
		}
	}
}

// ---------- running ----------

/** An error the side panel shows as written. `code` is for the panel's logic, `message` for the person. */
export class ConnectError extends Error {
	constructor(
		readonly code: "bad_params" | "unavailable" | "rate_limited" | "busy" | "failed" | "linked_no_service",
		message: string,
	) {
		super(message);
	}
}

export interface ConnectOptions {
	/** The user service `joinHub` installs; tests pass a stand-in so no real service is touched. */
	service?: EnrollHooks["service"];
	now?: () => number;
	/** How often `joinHub` tells the panel it is still working. The panel waits 30 seconds between frames. Tests shorten it. */
	keepAliveMs?: number;
}

type Reply = (frame: HostConnect) => void;

const JOIN_REFUSED = "This computer already has a public address or a hub link. Run tabkyra remote off, tabkyra hub off or tabkyra link off first.";
const MINT_FILE = "connect-mints.json";

const NOT_MANAGER = "This device isn't a manager, so it can't ask the hub for codes. Link it with a code from tabkyra hub code --manage, or run the command on the hub.";
const NO_ROUTE = "This computer has no public address yet. Run tabkyra remote setup (one computer) or tabkyra hub setup --public-url https://host (many devices) first.";

const GENERIC_FAILURE = "That didn't work on this computer. Try again, or run the matching tabkyra command in a terminal.";
const unreadable = (file: string) => `${file} is unreadable. Fix it or move it aside.`;

/** The longest sentence that passes through from the library or a hub; the panel shows it as written. */
export const MAX_PASSTHROUGH = 200;
const cap = (text: string): string => (text.length > MAX_PASSTHROUGH ? `${text.slice(0, MAX_PASSTHROUGH - 1)}…` : text);

/**
 * The text a person sees for an error from the library. Only our own sentences pass as written
 * (ConnectError, CodeLimitError, and the link.ts sentences, none of which quotes a file). Anything else
 * can carry a file's contents (a JSON parse error quotes the start of the file) or a path, so it
 * becomes a fixed sentence, naming `file` when the failure is about reading one.
 */
export function safeMessage(err: unknown, file?: string): string {
	// Text that quotes the hub or the network never passes: a hub can echo a request header, and the credential is in it.
	if (err instanceof HubCodeError) return hubCodeFailure(err.status).message;
	if (err instanceof ConnectError || err instanceof CodeLimitError || err instanceof LinkError) return cap(err.message);
	if (err instanceof LockTimeoutError) return "Another Tabkyra window is busy with that. Try again in a moment.";
	return file ? unreadable(file) : GENERIC_FAILURE;
}

export class ConnectService {
	private joining = false;
	private readonly service?: EnrollHooks["service"];
	private readonly now: () => number;
	private readonly keepAliveMs: number;

	constructor(options: ConnectOptions = {}) {
		this.service = options.service;
		this.now = options.now ?? Date.now;
		this.keepAliveMs = options.keepAliveMs ?? 10_000;
	}

	/** Answer one frame from the side panel. Never throws; a bad frame gets an error and runs nothing. */
	async handle(message: unknown, reply: Reply): Promise<void> {
		const parsed = parseConnect(message);
		if (!parsed.ok) {
			process.stderr.write("[tabkyra-host] refused a connect frame\n");
			if (parsed.id !== undefined) reply({ type: "connect", id: parsed.id, error: { code: "bad_params", message: parsed.message } });
			return;
		}
		const { id, call } = parsed;
		try {
			const result = await this.run(call, (progress) => reply({ type: "connect", id, progress }));
			reply({ type: "connect", id, result });
		} catch (err) {
			const code = err instanceof ConnectError ? err.code : "failed";
			// The method only: params (a code, a hub address) stay out of the log.
			process.stderr.write(`[tabkyra-host] connect ${call.method} failed (${code})\n`);
			reply({ type: "connect", id, error: { code, message: safeMessage(err) } });
		}
	}

	private async run(call: ConnectCall, progress: (p: Record<string, unknown>) => void): Promise<unknown> {
		switch (call.method) {
			case "status":
				return this.status();
			case "approvalCode":
				return this.approvalCode();
			case "deviceCode":
				return this.deviceCode();
			case "setBusy": {
				// Any device with a link.json can be marked busy, whatever else is set up on this computer.
				let linked: ReturnType<typeof loadLinkConfig>;
				try {
					linked = loadLinkConfig();
				} catch {
					throw new ConnectError("failed", `${linkFile()} is unreadable. Fix it or move it aside.`);
				}
				if (!linked) throw new ConnectError("unavailable", "Only a device linked to a hub can be marked busy.");
				try {
					await setLinkBusyAsync(call.busy);
				} catch (err) {
					throw new ConnectError("failed", safeMessage(err, linkFile()));
				}
				return { busy: call.busy };
			}
			case "joinHub":
				return this.joinHub(call, progress);
			case "setTheme":
				try {
					return saveTheme(call.preset, call.accent, call.mode);
				} catch (err) {
					throw new ConnectError("bad_params", safeMessage(err, join(configDir(), "theme.json")));
				}
		}
	}

	/** Local files only: no network call, so the panel can ask every few seconds. */
	status(): ConnectStatus {
		const problems: string[] = [];
		// The reply never carries the library's error text: a parse error can quote the start of a file, and link.json holds a secret.
		const tryLoad = <T>(file: string, load: () => T): T | undefined => {
			try {
				return load();
			} catch {
				problems.push(`${file} is unreadable. Fix it or move it aside.`);
				return undefined;
			}
		};
		const hub = tryLoad(hubFile(), loadHubConfig);
		const remote = tryLoad(remoteFile(), loadRemoteConfig);
		const link = tryLoad(linkFile(), loadLinkConfig);
		// The route is the public face of this computer; a link to a hub is reported beside it, not instead of it.
		const route: ConnectRoute = hub ? "hub" : remote ? "remote" : link ? "link" : "none";
		const publicUrl = hub?.publicUrl ?? remote?.publicUrl;
		let devices: ConnectDevice[] | undefined;
		if (hub) {
			// A bad hub-devices.json is a problem to show, not a reason to fail every call; the route stays "hub".
			devices = tryLoad(devicesFile(), () => {
				// loadDevices() answers an empty list for a file it can't read (it fails closed), which would read as "No devices yet".
				if (!devicesReadable()) throw new Error(`${devicesFile()} is unreadable. Fix it or move it aside; the hub lists no devices until then.`);
				return deviceRows().rows.map((d) => ({ name: d.name, online: d.online, extensionConnected: d.extensionConnected, sessions: d.sessions, busy: d.busy, lastSeen: d.lastSeen }));
			});
		}
		return {
			route,
			...(publicUrl && route !== "link" ? { publicUrl } : {}),
			passcodeSet: tryLoad(join(configDir(), "oauth.json"), passcodeSet) ?? false,
			...(link ? { link: { hubUrl: link.hubUrl, name: link.name, online: linkOnline(readLinkLive(), this.now()), busy: link.busy === true, manage: link.manage } } : {}),
			...(devices ? { hub: { devices } } : {}),
			theme: loadTheme(),
			...(route === "none" && !problems.length ? { joinScopes: DEFAULT_GRANT.map((id) => ({ id, what: SCOPES[id]?.what ?? id })) } : {}),
			...(problems.length ? { problem: problems[0] } : {}),
		};
	}

	/**
	 * Ten codes per ten minutes, of either kind. The window is a 0600 file of timestamps in the config
	 * dir, because Chrome starts a new host process for each connection and a counter in memory would
	 * start again at zero. An unreadable file counts as empty; the hub's own cap on live codes stays.
	 */
	private takeCodeSlot(): void {
		const now = this.now();
		const file = join(configDir(), MINT_FILE);
		try {
			this.stampCodeSlot(file, now);
		} catch (err) {
			// A short wait: the event loop is blocked meanwhile, and this host relays every agent's traffic.
			if (err instanceof LockTimeoutError) throw new ConnectError("busy", "Another Tabkyra window is making a code. Try again in a moment.");
			throw err;
		}
	}

	private stampCodeSlot(file: string, now: number): void {
		withFileLock(
			file,
			() => {
				let stamps: number[] = [];
				try {
					const raw = readJsonFile<{ minted?: unknown }>(file, {}).minted;
					if (Array.isArray(raw)) stamps = raw.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && now - t < CODE_WINDOW_MS && t <= now + CODE_WINDOW_MS);
				} catch {
					stamps = [];
				}
				stamps.sort((x, y) => x - y);
				if (stamps.length >= CODE_LIMIT) {
					const wait = Math.max(1, Math.ceil((CODE_WINDOW_MS - (now - stamps[0])) / 60_000));
					throw new ConnectError("rate_limited", `That is ${CODE_LIMIT} codes in ten minutes. Wait ${wait} minute${wait === 1 ? "" : "s"} and try again.`);
				}
				writeJsonPrivate(file, { minted: [...stamps, now] });
			},
			REQUEST_LOCK_MS,
		);
	}

	private async approvalCode(): Promise<ApprovalCode> {
		const status = this.status();
		if (status.route === "none") throw new ConnectError("unavailable", NO_ROUTE);
		if (status.route === "link" && !status.link?.manage) throw new ConnectError("unavailable", NOT_MANAGER);
		this.takeCodeSlot();
		try {
			if (status.route === "link") {
				const made = await mintViaHub("approval", false);
				return { code: made.code, expiresAt: made.expiresAt, connectorUrl: made.url ?? `${made.hubUrl}/mcp` };
			}
			const made = mintApprovalCode();
			return { code: made.code, expiresAt: made.expiresAt, connectorUrl: `${status.publicUrl}/mcp` };
		} catch (err) {
			throw this.codeFailure(err, status.route === "link" ? undefined : join(configDir(), "oauth-codes.json"));
		}
	}

	/** A minting error as the panel sees it: our own sentences as written, a fixed one for anything else. */
	private codeFailure(err: unknown, file?: string): ConnectError {
		if (err instanceof ConnectError) return err;
		// What the hub said never reaches the panel: the status picks a fixed sentence (the CLI still prints the hub's own words).
		if (err instanceof HubCodeError) return hubCodeFailure(err.status);
		return new ConnectError(err instanceof LinkError && /manager/.test(err.message) ? "unavailable" : "failed", safeMessage(err, file));
	}

	private async deviceCode(): Promise<DeviceCode> {
		const status = this.status();
		if (status.route === "none") throw new ConnectError("unavailable", NO_ROUTE);
		if (status.route === "remote") throw new ConnectError("unavailable", "This computer serves one connector for itself. To add other devices behind one connector, run tabkyra hub setup --public-url https://host instead.");
		if (status.route === "link" && !status.link?.manage) throw new ConnectError("unavailable", NOT_MANAGER);
		this.takeCodeSlot();
		try {
			if (status.route === "link") {
				const made = await mintViaHub("connect", false);
				return { code: made.code, expiresAt: made.expiresAt, hubUrl: made.hubUrl };
			}
			const made = mintConnectCode({ manage: false }, this.now());
			return { code: made.code, expiresAt: made.expiresAt, hubUrl: status.publicUrl ?? "" };
		} catch (err) {
			throw this.codeFailure(err, status.route === "link" ? undefined : join(configDir(), "hub-codes.json"));
		}
	}

	private async joinHub(call: Extract<ConnectCall, { method: "joinHub" }>, progress: (p: Record<string, unknown>) => void): Promise<JoinResult> {
		// The address and the code were validated in parseConnect, before this ran and before any network call.
		// The same refusal runs again under the lock at the commit: another process can add a route while the hub call is out.
		// A hub.json or remote.json that exists but can't be read leaves the route at none, so check the files too.
		const refuse = (): void => {
			const status = this.status();
			if (status.route !== "none" || status.problem || existsSync(hubFile()) || existsSync(remoteFile())) throw new ConnectError("unavailable", JOIN_REFUSED);
		};
		refuse();
		if (this.joining) throw new ConnectError("busy", "Already joining a hub.");
		this.joining = true;
		// The hub call and the service manager take as long as they take, so the lock on link.json covers only the check and the write.
		// A join in any process (this panel, another one, or the CLI) first takes the reservation enrollDevice makes before it contacts the hub:
		// a competing join is refused with its code unspent.
		const locked = async <T>(fn: () => T): Promise<T> => {
			try {
				return await withFileLockAsync(linkFile(), async () => fn(), REQUEST_LOCK_MS);
			} catch (err) {
				if (err instanceof LockTimeoutError) throw new ConnectError("busy", "Another Tabkyra window is joining a hub. Try again in a moment.");
				throw err;
			}
		};
		const noLink = (): void => {
			let existing: ReturnType<typeof loadLinkConfig>;
			try {
				existing = loadLinkConfig();
			} catch {
				throw new ConnectError("unavailable", JOIN_REFUSED);
			}
			if (existing) throw new ConnectError("unavailable", JOIN_REFUSED);
		};
		// The panel gives up 30 seconds after the last frame, and a slow service manager can take longer: repeat the current step until the work ends.
		let current = "contacting";
		const keepAlive = setInterval(() => progress({ step: current }), this.keepAliveMs);
		try {
			const result = await enrollDevice(
				{ hubUrl: call.hubUrl, code: call.code, name: call.name, service: true },
				{
					step: (step) => {
						current = step;
						progress({ step });
					},
					nonBlocking: true,
					commit: (write) =>
						locked(() => {
							refuse();
							noLink();
							write();
						}),
					...(this.service ? { service: this.service } : {}),
				},
			);
			if (result.kind === "failed") throw enrollFailure(result, call.hubUrl);
			if (!result.ok) throw new ConnectError("linked_no_service", `Linked as ${result.name}, but the background service didn't start; run tabkyra link status.`);
			return { name: result.name, manage: result.manage, scopes: result.scopes };
		} finally {
			clearInterval(keepAlive);
			this.joining = false;
		}
	}
}

/** What a hub's refusal of a code request says to a person: a fixed sentence for the status, never the hub's own words. */
function hubCodeFailure(status: number | undefined): ConnectError {
	if (status === undefined) return new ConnectError("failed", "Couldn't reach the hub. Check this computer's connection.");
	if (status === 401) return new ConnectError("failed", "This device's link was revoked. Run tabkyra link status.");
	if (status === 429) return new ConnectError("rate_limited", "The hub is rate limiting code requests. Wait a few minutes and try again.");
	if (status === 403) return new ConnectError("unavailable", "This device isn't a manager on the hub.");
	return new ConnectError("failed", "The hub refused to make a code.");
}

/** What a failed enroll says to a person: a fixed sentence for the cause, never the hub's own words. */
function enrollFailure(result: Extract<EnrollResult, { kind: "failed" }>, hubUrl: string): ConnectError {
	const cause = result.cause;
	switch (cause.type) {
		case "busy":
			return new ConnectError("busy", "Another join is already running on this computer. Wait for it, or try again in a few minutes.");
		case "linked":
			return new ConnectError("unavailable", JOIN_REFUSED);
		case "unreadable":
			return new ConnectError("failed", unreadable(linkFile()));
		case "launcher":
			return new ConnectError("failed", "Tabkyra's launcher isn't a working one, so the background service would have nothing to start. Run tabkyra install, then try again.");
		case "unreachable": {
			let host = "the hub";
			try {
				host = new URL(hubUrl).host;
			} catch {
				/* parseConnect already validated it */
			}
			return new ConnectError("failed", `Couldn't reach ${host}. Check the address and this computer's connection.`);
		}
		case "malformed":
			return new ConnectError("failed", "The hub's answer wasn't one Tabkyra accepts, so nothing was linked.");
		case "hub":
			if (cause.status === 401 && cause.invalidCode) return new ConnectError("failed", "That code is wrong, expired or already used. Get a new device code on the hub and try again.");
			if (cause.status === 429) return new ConnectError("rate_limited", "The hub says there were too many wrong codes. Wait 15 minutes and try again.");
			if (cause.status === 401) return new ConnectError("failed", "The hub refused this request. Check the hub's address and try again.");
			return new ConnectError("failed", "The hub refused to add this computer. Check the hub's device list and try again.");
		default:
			return new ConnectError("failed", GENERIC_FAILURE);
	}
}
