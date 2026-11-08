/**
 * The Connect panel's "Set up with Cloudflare" button, host side: the same setup as `remote setup --cloudflare <host>`,
 * run as five steps the panel can show. Nothing here prints to stdout, which is the native host's channel to the browser.
 *
 * Each step reports progress `{step, state, detail?, url?}`. A step that fails reports `failed` with the reason and throws.
 */
import { existsSync } from "node:fs";
import type { TunnelStepId } from "../../src/connect/types.ts";
import { cloudflareLoginForPanel, cloudflaredBinary, cloudflareSignedIn, normalizeCloudflareHost } from "./cloudflare.ts";
import { downloadCloudflared } from "./cloudflared-download.ts";
import { hubFile } from "./hub-state.ts";
import { closeFunnelRoute, loadRemoteConfig, metadata, METADATA_PATH, remoteSetup, type SetupOptions } from "./remote-setup.ts";
import type { SetupReport } from "./remote-state.ts";
import { sleep } from "./service.ts";
import { COMMAND_NAME } from "./self.ts";

export type TunnelStep = TunnelStepId;
export interface TunnelProgress {
	step: TunnelStep;
	state: "running" | "waiting" | "done" | "failed";
	detail?: string;
	url?: string;
}

/** A step that stopped the setup. `message` is the sentence the person reads. */
export class TunnelError extends Error {
	constructor(
		readonly step: TunnelStep,
		message: string,
	) {
		super(message);
	}
}

/** The parts that touch the machine, so a test can run the flow with stand-ins. */
export interface TunnelHooks {
	cloudflared(): Promise<{ ok: true; path: string; downloaded: boolean } | { ok: false; message: string }>;
	signedIn(): boolean;
	login(bin: string, onUrl: (url: string) => void): Promise<{ ok: true } | { ok: false; message: string }>;
	closeFunnel(): { ok: boolean; message: string };
	setup(options: SetupOptions): Promise<void>;
	check(publicUrl: string): Promise<{ ok: boolean; detail: string }>;
}

const CHECK_TOTAL_MS = 60_000;
const CHECK_EVERY_MS = 3_000;

/** Retries while DNS for a new name settles. */
async function checkWithRetry(publicUrl: string, total: number, every: number, once: (url: string) => Promise<{ ok: boolean; detail: string }>): Promise<{ ok: boolean; detail: string }> {
	const deadline = Date.now() + total;
	let last = { ok: false, detail: "no answer yet" };
	while (true) {
		last = await once(publicUrl);
		if (last.ok || Date.now() + every >= deadline) return last;
		await sleep(every);
	}
}

export const realTunnelHooks: TunnelHooks = {
	async cloudflared() {
		const found = cloudflaredBinary();
		if (found) return { ok: true, path: found, downloaded: false };
		const got = await downloadCloudflared();
		return got.ok ? { ok: true, path: got.path, downloaded: true } : got;
	},
	signedIn: cloudflareSignedIn,
	login: (bin, onUrl) => cloudflareLoginForPanel(bin, onUrl),
	closeFunnel: closeFunnelRoute,
	async setup(options) {
		let report: SetupReport | undefined;
		const code = await remoteSetup({ ...options, report: (r) => (report = r) });
		if (code !== 0 || !report?.ok) throw new Error(report?.message ?? "Setup didn't finish.");
	},
	check: (publicUrl) => metadata(`${publicUrl}${METADATA_PATH}`, 10_000, publicUrl),
};

export interface TunnelTimings {
	checkTotalMs?: number;
	checkEveryMs?: number;
}

/** Runs the five steps for `host` (already normalized). Returns the public origin. Throws TunnelError. */
export async function setupTunnel(host: string, progress: (p: TunnelProgress) => void, hooks: TunnelHooks = realTunnelHooks, timings: TunnelTimings = {}): Promise<{ publicUrl: string }> {
	const name = normalizeCloudflareHost(host);
	if (!name) throw new TunnelError("cloudflared", `${host} isn't a name a tunnel can have. Use one like polycarp.yourdomain.com.`);
	const publicUrl = `https://${name}`;
	const run = async <T>(step: TunnelStep, work: () => Promise<T>): Promise<T> => {
		progress({ step, state: "running" });
		try {
			const out = await work();
			progress({ step, state: "done" });
			return out;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			progress({ step, state: "failed", detail: message.slice(0, 500) });
			throw err instanceof TunnelError ? err : new TunnelError(step, message);
		}
	};
	// Refuse before anything is downloaded or opened: a hub or the person's own front door is not ours to replace.
	let previous: ReturnType<typeof loadRemoteConfig>;
	try {
		previous = loadRemoteConfig();
	} catch {
		throw new TunnelError("cloudflared", `remote.json is unreadable. Run ${COMMAND_NAME} remote off, then try again.`);
	}
	if (existsSync(hubFile())) throw new TunnelError("cloudflared", `This install is set up as a hub, and an install has one public route. Run ${COMMAND_NAME} hub off first.`);
	if (previous?.route === "custom") throw new TunnelError("cloudflared", `This computer already uses its own address, ${previous.publicUrl}. Run ${COMMAND_NAME} remote off first.`);

	const bin = await run("cloudflared", async () => {
		const got = await hooks.cloudflared();
		if (!got.ok) throw new Error(got.message);
		return got.path;
	});

	await run("signin", async () => {
		if (hooks.signedIn()) return;
		const result = await hooks.login(bin, (url) => progress({ step: "signin", state: "waiting", url }));
		if (!result.ok) throw new Error(result.message);
	});

	const sameHost = previous?.route === "cloudflare" && previous.publicUrl === publicUrl;
	await run("route", async () => {
		if (previous?.route === "funnel") {
			const closed = hooks.closeFunnel();
			if (!closed.ok) throw new Error(closed.message);
		}
	});

	await run("tunnel", async () => {
		// Already on this name: the tunnel is set up, so go straight to the check.
		if (sameHost) return;
		await hooks.setup({ cloudflare: name, service: true, passcode: false, ...(previous?.route === "funnel" ? { port: previous.port } : {}) });
	});

	await run("check", async () => {
		const result = await checkWithRetry(publicUrl, timings.checkTotalMs ?? CHECK_TOTAL_MS, timings.checkEveryMs ?? CHECK_EVERY_MS, hooks.check);
		if (!result.ok) throw new Error(`${publicUrl} isn't answering yet (${result.detail}). DNS can take a few minutes; reopen Settings to check again.`);
	});
	return { publicUrl };
}
