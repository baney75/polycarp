/**
 * GitHub Copilot through the Copilot SDK, run by the native host. GitHub's docs: "Use an OAuth
 * GitHub App to authenticate users through your application and pass their credentials to the
 * SDK" (authenticate-copilot-sdk, read 2026-10-28). Tabkyra signs the user in with its own
 * OAuth App (constants.ts) by the device flow, so no client secret exists anywhere, and passes
 * the user's token to the SDK. Each user's Copilot plan pays for their requests.
 *
 * Never used here: another app's client id, editor headers, or Copilot's internal endpoints.
 */

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COPILOT } from "../../../src/subscriptions/constants.ts";
import { type Fetch, SubscriptionError } from "./siwc.ts";
import { readPrivateJson, removeFile, subscriptionsDir, withFileLock, writePrivateJson } from "./store.ts";

export interface CopilotRecord {
	login?: string;
	user_id?: number;
	access_token?: string;
	refresh_token?: string;
	/** Seconds the access token lives from saved_at; absent when it doesn't expire. */
	expires_in?: number;
	refresh_token_expires_in?: number;
	saved_at: string;
}

export interface CopilotStatus {
	signedIn: boolean;
	login?: string;
	/** GitHub's Copilot SDK is installed where the host can load it. */
	sdkInstalled: boolean;
}

export interface PendingDeviceSignIn {
	userCode: string;
	verificationUri: string;
	expiresIn: number;
	result: Promise<CopilotStatus>;
	cancel: () => void;
}

interface DeviceCodeResponse {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	expires_in?: number;
	interval?: number;
	error?: string;
}

interface GitHubTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	refresh_token_expires_in?: number;
	error?: string;
	interval?: number;
}

/** The SDK refreshes a session's token when an hour or less is left; we do the same. */
const REFRESH_MARGIN_MS = 60 * 60 * 1000;

export interface CopilotAuthOptions {
	fetch?: Fetch;
	dir?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export class CopilotAuth {
	private readonly fetch: Fetch;
	private readonly dir: string;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private pending?: PendingDeviceSignIn;
	private refreshing?: Promise<CopilotRecord>;
	/** Bumped by sign-out: a sign-in or refresh that started before it must not write a token back. */
	private generation = 0;

	constructor(options: CopilotAuthOptions = {}) {
		this.fetch = options.fetch ?? fetch;
		this.dir = options.dir ?? subscriptionsDir();
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	get path(): string {
		return join(this.dir, "copilot.json");
	}

	record(): CopilotRecord | undefined {
		return readPrivateJson<CopilotRecord>(this.path);
	}

	status(): CopilotStatus {
		const record = this.record();
		const signedIn = Boolean(record?.access_token);
		return { signedIn, ...(signedIn && record?.login ? { login: record.login } : {}), sdkInstalled: sdkInstalled() };
	}

	private async post(url: string, form: Array<[string, string]>): Promise<Record<string, unknown>> {
		const response = await this.fetch(url, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form).toString(),
			signal: AbortSignal.timeout(15_000),
		});
		const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok && !body.error) body.error = `http_${response.status}`;
		return body;
	}

	/** Device flow, step 1: a code for the user to enter at github.com/login/device. */
	async startSignIn(): Promise<PendingDeviceSignIn> {
		this.pending?.cancel();
		const form: Array<[string, string]> = [["client_id", COPILOT.clientId]];
		if (COPILOT.scope) form.push(["scope", COPILOT.scope]);
		const device = (await this.post(COPILOT.deviceCodeUrl, form)) as DeviceCodeResponse;
		if (device.error || !device.device_code || !device.user_code || !device.verification_uri)
			throw new SubscriptionError(device.error ?? "device_code_failed", `GitHub didn't start the sign-in (${device.error ?? "no code"}).`);
		const deviceCode = device.device_code;
		const generation = this.generation;
		let cancelled = false;
		let interval = Math.max(5, device.interval ?? 5) * 1000;
		let networkErrors = 0;
		const deadline = this.now() + (device.expires_in ?? 900) * 1000;
		const result = (async (): Promise<CopilotStatus> => {
			for (;;) {
				await this.sleep(interval);
				if (cancelled) throw new SubscriptionError("cancelled", "Sign-in cancelled.");
				if (this.now() > deadline) throw new SubscriptionError("expired_token", "The GitHub code expired. Start the sign-in again.");
				let tokens: GitHubTokenResponse;
				try {
					tokens = (await this.post(COPILOT.tokenUrl, [
						["client_id", COPILOT.clientId],
						["device_code", deviceCode],
						["grant_type", "urn:ietf:params:oauth:grant-type:device_code"],
					])) as GitHubTokenResponse;
					networkErrors = 0;
				} catch (err) {
					// A dropped connection while the user is still on GitHub's page is not a failed
					// sign-in: keep polling until the code expires, unless the network stays down.
					if (++networkErrors >= 6) throw new SubscriptionError("network", `Can't reach GitHub (${err instanceof Error ? err.message : String(err)}).`);
					continue;
				}
				if (tokens.error === "authorization_pending") continue;
				if (tokens.error === "slow_down") {
					interval = (tokens.interval ?? interval / 1000 + 5) * 1000;
					continue;
				}
				if (tokens.error === "access_denied") throw new SubscriptionError("declined", "You declined the GitHub sign-in.");
				if (tokens.error === "expired_token") throw new SubscriptionError("expired_token", "The GitHub code expired. Start the sign-in again.");
				if (tokens.error || !tokens.access_token) throw new SubscriptionError(tokens.error ?? "no_token", `GitHub sign-in failed (${tokens.error ?? "no token"}).`);
				if (cancelled) throw new SubscriptionError("cancelled", "Sign-in cancelled.");
				await this.save(tokens, undefined, () => !cancelled && generation === this.generation);
				return this.status();
			}
		})();
		result.catch(() => undefined);
		const pending: PendingDeviceSignIn = {
			userCode: device.user_code,
			verificationUri: device.verification_uri,
			expiresIn: device.expires_in ?? 900,
			result,
			cancel: () => {
				cancelled = true;
			},
		};
		this.pending = pending;
		result.finally(() => {
			if (this.pending === pending) this.pending = undefined;
		}).catch(() => undefined);
		return pending;
	}

	cancelSignIn(): void {
		this.pending?.cancel();
	}

	private async save(tokens: GitHubTokenResponse, previous: CopilotRecord | undefined, current: () => boolean): Promise<CopilotRecord> {
		const record: CopilotRecord = { saved_at: new Date(this.now()).toISOString() };
		if (tokens.access_token) record.access_token = tokens.access_token;
		const renewable = tokens.refresh_token ?? previous?.refresh_token;
		if (renewable) record.refresh_token = renewable;
		if (tokens.expires_in) record.expires_in = tokens.expires_in;
		if (tokens.refresh_token_expires_in) record.refresh_token_expires_in = tokens.refresh_token_expires_in;
		if (previous?.login) {
			record.login = previous.login;
			record.user_id = previous.user_id;
		} else if (tokens.access_token) {
			type GitHubUser = { login?: string; id?: number };
			const user: GitHubUser = await this.fetch(COPILOT.userUrl, {
				headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(15_000),
			})
				.then((r) => (r.ok ? (r.json() as Promise<GitHubUser>) : {}))
				.catch(() => ({}));
			if (user.login) record.login = user.login;
			if (user.id) record.user_id = user.id;
		}
		// Signed out or cancelled while this ran: the token is dropped, never written back.
		if (!current()) throw new SubscriptionError("signed_out", "Signed out.");
		writePrivateJson(this.path, record);
		return record;
	}

	private expiresAt(record: CopilotRecord): number | undefined {
		if (!record.expires_in) return undefined;
		return Date.parse(record.saved_at) + record.expires_in * 1000;
	}

	/** The user's GitHub token for the SDK, refreshed when an hour or less is left. */
	async token(): Promise<string> {
		let record = this.record();
		if (!record?.access_token) throw new SubscriptionError("not_signed_in", "Sign in with GitHub Copilot first (Settings).");
		const expires = this.expiresAt(record);
		if (expires !== undefined && this.now() > expires - REFRESH_MARGIN_MS) record = await this.refresh();
		if (!record.access_token) throw new SubscriptionError("not_signed_in", "Sign in with GitHub Copilot again.");
		return record.access_token;
	}

	/**
	 * Refresh an expiring user token. GitHub: client_secret is "Required unless the user access
	 * token was generated using the device flow", so none is sent.
	 */
	refresh(): Promise<CopilotRecord> {
		if (!this.refreshing) {
			const generation = this.generation;
			this.refreshing = withFileLock(`${this.path}.lock`, async () => {
				const record = this.record();
				if (!record?.access_token) throw new SubscriptionError("not_signed_in", "Sign in with GitHub Copilot first.");
				const expires = this.expiresAt(record);
				if (expires === undefined || this.now() <= expires - REFRESH_MARGIN_MS) return record;
				const renewable = record.refresh_token;
				if (!renewable) throw new SubscriptionError("not_signed_in", "Your GitHub sign-in expired. Sign in again.");
				const tokens = (await this.post(COPILOT.tokenUrl, [
					["client_id", COPILOT.clientId],
					["grant_type", "refresh_token"],
					["refresh_token", renewable],
				])) as GitHubTokenResponse;
				if (tokens.error || !tokens.access_token) {
					if (tokens.error === "bad_refresh_token" || tokens.error === "invalid_grant") {
						removeFile(this.path);
						throw new SubscriptionError("signed_out", "Your GitHub sign-in is no longer valid. Sign in again.");
					}
					throw new SubscriptionError(tokens.error ?? "refresh_failed", `Refreshing the GitHub sign-in failed (${tokens.error ?? "no token"}).`);
				}
				return this.save(tokens, record, () => generation === this.generation);
			}).finally(() => {
				this.refreshing = undefined;
			});
		}
		return this.refreshing;
	}

	/**
	 * Sign out deletes the token file. Revoking the grant on GitHub's side takes the app's client
	 * secret, which Tabkyra deliberately doesn't have, so the user is pointed to their settings.
	 */
	async signOut(): Promise<{ revoked: false; revokeUrl: string }> {
		this.generation++;
		this.pending?.cancel();
		await this.refreshing?.catch(() => undefined);
		// Under the refresh lock, so another host's refresh can't write the token back meanwhile.
		await withFileLock(`${this.path}.lock`, async () => removeFile(this.path));
		return { revoked: false, revokeUrl: COPILOT.revokeUrl };
	}
}

// ---- the Copilot SDK ---------------------------------------------------------------------

/** Where `tabkyra copilot-sdk install` puts the pinned SDK. */
export function sdkInstallDir(): string {
	return process.env.TABKYRA_COPILOT_SDK_DIR || join(homedir(), ".local", "share", "tabkyra", "copilot-sdk");
}

/** package.json paths the SDK may be resolved from, in order: the install dir, then the CLI's own node_modules. */
function sdkSearchRoots(): string[] {
	const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	return [join(sdkInstallDir(), "package.json"), join(cliRoot, "package.json")];
}

export function sdkInstalled(): boolean {
	return sdkSearchRoots().some((root) => existsSync(join(dirname(root), "node_modules", ...COPILOT.sdkPackage.split("/"), "package.json")));
}

/** The parts of the SDK Tabkyra uses, typed here so the CLI builds without the 160 MB package. */
export interface SdkToolResult {
	textResultForLlm: string;
	binaryResultsForLlm?: Array<{ data: string; mimeType: string; type: "image" }>;
	resultType: "success" | "failure";
}
export interface SdkTool {
	name: string;
	description?: string;
	parameters?: Record<string, unknown>;
	handler: (args: unknown, invocation: { toolCallId: string; toolName: string }) => Promise<SdkToolResult>;
	skipPermission?: boolean;
	defer?: "never";
}
export interface SdkEvent {
	type: string;
	data?: Record<string, unknown>;
}
export interface SdkSession {
	send(options: { prompt: string; attachments?: Array<{ type: "blob"; data: string; mimeType: string }> }): Promise<string>;
	on(handler: (event: SdkEvent) => void): () => void;
	abort(): Promise<void>;
	disconnect(): Promise<void>;
}
export interface SdkClient {
	createSession(config: Record<string, unknown>): Promise<SdkSession>;
	listModels(): Promise<Array<{ id: string; name: string; capabilities?: unknown; policy?: { state?: string } }>>;
	stop(): Promise<unknown>;
}
export interface SdkModule {
	CopilotClient: new (options: Record<string, unknown>) => SdkClient;
}

/**
 * Load the SDK installed beside the CLI. A require from a fixed path, not a bundled import: the
 * SDK carries a 160 MB runtime per platform that only Copilot users install.
 */
export function loadSdk(): SdkModule {
	let failure: unknown;
	for (const root of sdkSearchRoots()) {
		try {
			return createRequire(root)(COPILOT.sdkPackage) as SdkModule;
		} catch (err) {
			failure ??= (err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" ? undefined : err;
		}
	}
	// Installed but broken (a partial install, a missing platform runtime) is not "not installed".
	if (sdkInstalled() || failure)
		throw new SubscriptionError(
			"sdk_load_failed",
			`GitHub's Copilot SDK is installed but didn't load (${failure instanceof Error ? failure.message : "unknown error"}). Run \`tabkyra copilot-sdk install\` again.`,
		);
	throw new SubscriptionError(
		"sdk_missing",
		`GitHub's Copilot SDK isn't installed. Run \`tabkyra copilot-sdk install\` (installs ${COPILOT.sdkPackage}@${COPILOT.sdkVersion}, about 160 MB).`,
	);
}

export function copilotWorkDir(): string {
	const dir = join(sdkInstallDir(), "work");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}
