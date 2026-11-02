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
 * ten per ten minutes. Nothing here prints to stdout: that stream is the channel to the browser.
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
import { normalizeCode } from "./codes.ts";
import { deviceRows } from "./hub-admin.ts";
import { loadHubConfig, mintConnectCode, validDeviceName } from "./hub-state.ts";
import { type EnrollHooks, enrollDevice, linkOnline, loadLinkConfig, mintViaHub, normalizeHubUrl, readLinkLive, setLinkBusy } from "./link.ts";
import { mintApprovalCode, passcodeSet } from "./oauth.ts";
import { loadRemoteConfig } from "./remote-setup.ts";
import { isAccent, loadTheme, PRESETS, saveTheme } from "./theme.ts";

// ---------- parsing ----------

export type ConnectCall =
	| { method: "status" }
	| { method: "approvalCode" }
	| { method: "deviceCode" }
	| { method: "setBusy"; busy: boolean }
	| { method: "joinHub"; hubUrl: string; code: string; name?: string }
	| { method: "setTheme"; preset: string; accent?: string | null };

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
	if (typeof message.method !== "string" || !(CONNECT_METHODS as readonly string[]).includes(message.method)) {
		return fail(`Unknown method ${JSON.stringify(String(message.method).slice(0, 40))}.`);
	}
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
			const problem = onlyKeys(params, ["preset", "accent"]);
			if (problem) return fail(problem);
			if (typeof params.preset !== "string" || !Object.hasOwn(PRESETS, params.preset)) return fail(`preset is one of ${Object.keys(PRESETS).join(", ")}.`);
			if (params.accent !== undefined && params.accent !== null && !isAccent(params.accent)) return fail("accent is #rrggbb, or null for the preset's own.");
			return call({ method, preset: params.preset, ...(params.accent !== undefined ? { accent: params.accent as string | null } : {}) });
		}
	}
}

// ---------- running ----------

/** An error the side panel shows as written. `code` is for the panel's logic, `message` for the person. */
export class ConnectError extends Error {
	constructor(
		readonly code: "bad_params" | "unavailable" | "rate_limited" | "busy" | "failed",
		message: string,
	) {
		super(message);
	}
}

export interface ConnectOptions {
	/** The user service `joinHub` installs; tests pass a stand-in so no real service is touched. */
	service?: EnrollHooks["service"];
	now?: () => number;
}

type Reply = (frame: HostConnect) => void;

const NO_ROUTE = "This computer has no public address yet. Run tabkyra remote setup (one computer) or tabkyra hub setup --public-url https://host (many devices) first.";

export class ConnectService {
	private readonly minted: number[] = [];
	private joining = false;
	private readonly service?: EnrollHooks["service"];
	private readonly now: () => number;

	constructor(options: ConnectOptions = {}) {
		this.service = options.service;
		this.now = options.now ?? Date.now;
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
			reply({ type: "connect", id, error: { code, message: err instanceof Error ? err.message : String(err) } });
		}
	}

	private run(call: ConnectCall, progress: (p: Record<string, unknown>) => void): Promise<unknown> | unknown {
		switch (call.method) {
			case "status":
				return this.status();
			case "approvalCode":
				return this.approvalCode();
			case "deviceCode":
				return this.deviceCode();
			case "setBusy": {
				if (this.status().route !== "link") throw new ConnectError("unavailable", "Only a device linked to a hub can be marked busy.");
				try {
					setLinkBusy(call.busy);
				} catch (err) {
					throw new ConnectError("failed", err instanceof Error ? err.message : String(err));
				}
				return { busy: call.busy };
			}
			case "joinHub":
				return this.joinHub(call, progress);
			case "setTheme":
				try {
					return saveTheme(call.preset, call.accent);
				} catch (err) {
					throw new ConnectError("bad_params", err instanceof Error ? err.message : String(err));
				}
		}
	}

	/** Local files only: no network call, so the panel can ask every few seconds. */
	status(): ConnectStatus {
		const problems: string[] = [];
		const tryLoad = <T>(load: () => T): T | undefined => {
			try {
				return load();
			} catch (err) {
				problems.push(err instanceof Error ? err.message : String(err));
				return undefined;
			}
		};
		const hub = tryLoad(loadHubConfig);
		const remote = tryLoad(loadRemoteConfig);
		const link = tryLoad(loadLinkConfig);
		const route: ConnectRoute = hub ? "hub" : remote ? "remote" : link ? "link" : "none";
		const publicUrl = hub?.publicUrl ?? remote?.publicUrl;
		let devices: ConnectDevice[] | undefined;
		if (hub) {
			devices = deviceRows().rows.map((d) => ({ name: d.name, online: d.online, extensionConnected: d.extensionConnected, sessions: d.sessions, busy: d.busy, lastSeen: d.lastSeen }));
		}
		return {
			route,
			...(publicUrl && route !== "link" ? { publicUrl } : {}),
			passcodeSet: passcodeSet(),
			...(route === "link" && link ? { link: { hubUrl: link.hubUrl, name: link.name, online: linkOnline(readLinkLive(), this.now()), busy: link.busy === true, manage: link.manage } } : {}),
			...(devices ? { hub: { devices } } : {}),
			theme: loadTheme(),
			...(problems.length ? { problem: problems[0] } : {}),
		};
	}

	/** Ten codes per ten minutes, of either kind. */
	private takeCodeSlot(): void {
		const now = this.now();
		while (this.minted.length && now - this.minted[0] >= CODE_WINDOW_MS) this.minted.shift();
		if (this.minted.length >= CODE_LIMIT) {
			const wait = Math.max(1, Math.ceil((CODE_WINDOW_MS - (now - this.minted[0])) / 60_000));
			throw new ConnectError("rate_limited", `That is ${CODE_LIMIT} codes in ten minutes. Wait ${wait} minute${wait === 1 ? "" : "s"} and try again.`);
		}
		this.minted.push(now);
	}

	private async approvalCode(): Promise<ApprovalCode> {
		const status = this.status();
		if (status.route === "none") throw new ConnectError("unavailable", NO_ROUTE);
		this.takeCodeSlot();
		try {
			if (status.route === "link") {
				const made = await mintViaHub("approval", false);
				return { code: made.code, expiresAt: made.expiresAt, connectorUrl: made.url ?? `${made.hubUrl}/mcp` };
			}
			const made = mintApprovalCode();
			return { code: made.code, expiresAt: made.expiresAt, connectorUrl: `${status.publicUrl}/mcp` };
		} catch (err) {
			throw new ConnectError(err instanceof Error && /manager/.test(err.message) ? "unavailable" : "failed", err instanceof Error ? err.message : String(err));
		}
	}

	private async deviceCode(): Promise<DeviceCode> {
		const status = this.status();
		if (status.route === "none") throw new ConnectError("unavailable", NO_ROUTE);
		if (status.route === "remote") throw new ConnectError("unavailable", "This computer serves one connector for itself. To add other devices behind one connector, run tabkyra hub setup --public-url https://host instead.");
		this.takeCodeSlot();
		try {
			if (status.route === "link") {
				const made = await mintViaHub("connect", false);
				return { code: made.code, expiresAt: made.expiresAt, hubUrl: made.hubUrl };
			}
			const made = mintConnectCode({ manage: false }, this.now());
			return { code: made.code, expiresAt: made.expiresAt, hubUrl: status.publicUrl ?? "" };
		} catch (err) {
			throw new ConnectError(err instanceof Error && /manager/.test(err.message) ? "unavailable" : "failed", err instanceof Error ? err.message : String(err));
		}
	}

	private async joinHub(call: Extract<ConnectCall, { method: "joinHub" }>, progress: (p: Record<string, unknown>) => void): Promise<JoinResult> {
		// The address and the code were validated in parseConnect, before this ran and before any network call.
		if (this.status().route !== "none") throw new ConnectError("unavailable", "This computer already has a public address or a hub link. Run tabkyra remote off, tabkyra hub off or tabkyra link off first.");
		if (this.joining) throw new ConnectError("busy", "Already joining a hub.");
		this.joining = true;
		try {
			const result = await enrollDevice(
				{ hubUrl: call.hubUrl, code: call.code, name: call.name, service: true },
				{ step: (step) => progress({ step }), ...(this.service ? { service: this.service } : {}) },
			);
			if (result.kind === "failed") throw new ConnectError("failed", result.error);
			if (!result.ok) throw new ConnectError("failed", `Linked as ${result.name}, but the background service didn't start. ${result.service}`);
			return { name: result.name, manage: result.manage };
		} finally {
			this.joining = false;
		}
	}
}
