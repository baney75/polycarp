/**
 * The Connect panel's "Set up with Cloudflare" button, host side: the same setup as `remote setup --cloudflare <host>`,
 * run as five steps the panel can show. Nothing here prints to stdout, which is the native host's channel to the browser.
 *
 * Each step reports progress `{step, state, detail?, url?}`. A step that fails reports `failed` with the reason and throws, except
 * the tunnel step when `remote setup` answers with a state of its own (a taken name, a domain off the account): that report comes
 * back as `problem`, so the panel draws the step's own sentence and action (first-F1).
 */
import { existsSync } from "node:fs";
import type { TunnelStepId } from "../../src/connect/types.ts";
import { cloudflareLoginForPanel, cloudflaredBinary, cloudflareSignedIn, normalizeCloudflareHost } from "./cloudflare.ts";
import { downloadCloudflared } from "./cloudflared-download.ts";
import { hubFile } from "./hub-state.ts";
import { loadRemoteConfig, metadata, METADATA_PATH, remoteSetup, type SetupOptions } from "./remote-setup.ts";
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
	/** Runs `remote setup` for the tunnel; the report it answers with carries the outside checks. */
	setup(options: SetupOptions): Promise<SetupReport | undefined | void>;
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
	setup: (options) => setupReport(options),
	check: (publicUrl) => metadata(`${publicUrl}${METADATA_PATH}`, 10_000, publicUrl),
};

/** `remote setup` for the tunnel, as its report: refused or not, the report is the answer. Only no report at all throws. */
export async function setupReport(options: SetupOptions, run: typeof remoteSetup = remoteSetup): Promise<SetupReport> {
	let report: SetupReport | undefined;
	await run({ ...options, report: (r) => (report = r) });
	if (!report) throw new Error("Setup didn't finish.");
	return report;
}

export interface TunnelTimings {
	checkTotalMs?: number;
	checkEveryMs?: number;
}

/**
 * Runs the five steps for `host` (already normalized). Returns the public origin, or the report setup refused with as `problem`.
 * Throws TunnelError.
 */
export async function setupTunnel(host: string, progress: (p: TunnelProgress) => void, hooks: TunnelHooks = realTunnelHooks, timings: TunnelTimings = {}): Promise<{ publicUrl: string; checks?: SetupReport["checks"]; problem?: SetupReport }> {
	const name = normalizeCloudflareHost(host);
	if (!name) throw new TunnelError("cloudflared", `${host} isn't a name a tunnel can have. Use one like polycarp.yourdomain.com.`);
	const publicUrl = `https://${name}`;
	/** `refused` names an answer that stops the setup without an error: the step shows failed with those words. */
	const run = async <T>(step: TunnelStep, work: () => Promise<T>, refused?: (out: T) => string | undefined): Promise<T> => {
		progress({ step, state: "running" });
		try {
			const out = await work();
			const why = refused?.(out);
			progress(why === undefined ? { step, state: "done" } : { step, state: "failed", detail: why.slice(0, 500) });
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

	// Another Cloudflare name is a different route; the person turns it off first, as on the command line.
	await run("route", async () => {
		if (previous?.route === "cloudflare" && previous.publicUrl !== publicUrl)
			throw new Error(`This computer already has a Cloudflare tunnel on ${previous.publicUrl}. Run ${COMMAND_NAME} remote off first.`);
	});

	// Always run: setup again on the same name picks up where a failed run stopped (a service that never started). Funnel, when
	// it is the route now, closes inside setup only after Cloudflare has made the tunnel.
	// A report that isn't ok is setup's own answer (a taken name, a domain off the account): the step fails with its words and
	// the report goes back whole, so the panel draws that state's sentence and action instead of a bare error.
	const report = await run(
		"tunnel",
		async () => (await hooks.setup({ cloudflare: name, service: true, passcode: false, replaceFunnel: previous?.route === "funnel" })) || undefined,
		(r) => (r && !r.ok ? r.message : undefined),
	);
	if (report && !report.ok) return { publicUrl, problem: report };

	// The tunnel and its record are made, so a name that isn't answering yet is on with a lagging check, not a failed setup: a new
	// record takes minutes. The check is left waiting, pending, and the panel checks again from the result by itself.
	progress({ step: "check", state: "running" });
	const result = await checkWithRetry(publicUrl, timings.checkTotalMs ?? CHECK_TOTAL_MS, timings.checkEveryMs ?? CHECK_EVERY_MS, hooks.check);
	const checks = report?.checks ?? [];
	if (result.ok) {
		progress({ step: "check", state: "done" });
		return { publicUrl, ...(report?.checks ? { checks } : {}) };
	}
	const detail = result.detail.slice(0, 500);
	progress({ step: "check", state: "waiting", detail });
	const lagging = { name: "resource_metadata" as const, status: "fail" as const, detail, pending: true };
	// In place, so the checklist keeps the report's order (first-F5); appended only when the report had none.
	const at = checks.findIndex((c) => c.name === "resource_metadata");
	return { publicUrl, checks: at < 0 ? [...checks, lagging] : checks.map((c, i) => (i === at ? lagging : c)) };
}
