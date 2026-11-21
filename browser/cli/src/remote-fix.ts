/**
 * `remote fix`: one repair per fault, in a fixed order, checking again after each, then the outside proof (`remote test`).
 *
 * What it may do: restart the serve or cloudflared service, open Funnel, download the pinned cloudflared (on a yes), and rewrite
 * remote.json when the computer was renamed. What it never does: delete or overwrite a DNS record, run sudo, touch Tailnet Lock,
 * turn a route off, revoke a token or a connector, or make a passcode. Those it names, with the exact command, for the person.
 */
import { existsSync } from "node:fs";
import { CLOUDFLARE_SERVICE, cloudflareConfigFile, cloudflaredBinary } from "./cloudflare.ts";
import { CLOUDFLARED_VERSION, cloudflaredAsset, downloadCloudflared, downloadedCloudflared } from "./cloudflared-download.ts";
import { envVar } from "./env.ts";
import { passcodeSet } from "./oauth.ts";
import { askYes, closeInput, interactiveTerminal } from "./remote-guide.ts";
import { FUNNEL_PORT, lingerWarning, loadRemoteConfig, openFunnel, operatorWarning, probeLocal, proofLines, type RemoteConfig, saveRemoteConfig, serveWaitMs, tailscaleReady, waitForServe } from "./remote-setup.ts";
import { CLOUDFLARED_DOWNLOAD_URL, EXIT_FAILED, EXIT_NEEDS_PERSON, EXIT_ON, printReport, type RemoteState, TAILSCALE_OPERATOR_FIX } from "./remote-state.ts";
import { type ProofCheck, publicChecks } from "./remote-test.ts";
import { COMMAND_NAME } from "./self.ts";
import { installService, SERVE_SERVICE, type ServiceSpec, serviceFile, serviceLogHint, serviceRunning, sleep } from "./service.ts";
import { c, sym } from "./ui.ts";

/** The repairs, in the order they run: a rename first (serve must restart for the new name), serve before Funnel (setup's rule). */
export const FIX_ORDER = ["download_cloudflared", "rename", "restart_serve", "restart_cloudflared", "open_funnel"] as const;
export type FixKind = (typeof FIX_ORDER)[number];

export interface FixAction {
	kind: FixKind;
	/** What it does, for the person and the list. */
	what: string;
	status: "planned" | "done" | "failed" | "declined";
	detail?: string;
}

/** A step only the person can take, with the exact command when there is one. */
export interface FixAdvice {
	name: string;
	detail: string;
	command?: string;
}

interface Diagnosis {
	actions: { kind: FixKind; what: string; oldUrl?: string; newUrl?: string }[];
	advice: FixAdvice[];
	/** Nothing here can move without the person (or a fault fix doesn't touch). */
	blocked?: { state: RemoteState; code?: string; message: string; command?: string; url?: string };
}

const serveFile = () => serviceFile(SERVE_SERVICE);

async function diagnose(config: RemoteConfig): Promise<Diagnosis> {
	const actions: Diagnosis["actions"] = [];
	const advice: FixAdvice[] = [];
	let expected = config.publicUrl;
	let funnel: { bin: string; dns: string; open: boolean } | undefined;

	if (config.route === "funnel") {
		const ts = tailscaleReady();
		// Tailscale missing, signed out or under Tailnet Lock: the person's to change, and Tailnet Lock is never touched.
		if (!ts.ok) return { actions, advice, blocked: { state: ts.state, message: ts.message } };
		if (ts.state.kind !== "ok") return { actions, advice, blocked: { state: "problem", code: "tailscale", message: "Couldn't read tailscale serve status, so I can't tell what Funnel is doing. Check that Tailscale is running." } };
		const dns = ts.state.dns;
		const host = new URL(config.publicUrl).hostname;
		if (dns !== host) {
			expected = `https://${dns}:${FUNNEL_PORT}`;
			actions.push({ kind: "rename", what: `This computer's Tailscale name is now ${dns}: rewrite remote.json from ${config.publicUrl} to ${expected}`, oldUrl: config.publicUrl, newUrl: expected });
		}
		funnel = { bin: ts.bin, dns, open: ts.state.allowFunnel[`${dns}:${FUNNEL_PORT}`] === true };
		const operator = operatorWarning(ts.bin);
		if (operator) advice.push({ name: "tailscale user", detail: operator, command: TAILSCALE_OPERATOR_FIX });
	}

	if (config.route === "cloudflare") {
		if (!cloudflaredBinary()) {
			if (!cloudflaredAsset()) return { actions, advice, blocked: { state: "cloudflared_missing", message: `cloudflared isn't installed. Get it from ${CLOUDFLARED_DOWNLOAD_URL}, then run ${COMMAND_NAME} remote fix again.`, url: CLOUDFLARED_DOWNLOAD_URL } };
			actions.push({ kind: "download_cloudflared", what: `Download Cloudflare's cloudflared ${CLOUDFLARED_VERSION} from GitHub (checked against its SHA-256) to ${downloadedCloudflared()}` });
		}
		const file = serviceFile(CLOUDFLARE_SERVICE);
		if (!existsSync(cloudflareConfigFile())) {
			const command = `${COMMAND_NAME} remote setup --cloudflare ${new URL(config.publicUrl).hostname}`;
			return { actions, advice, blocked: { state: "problem", code: "cloudflare_tunnel", message: `The tunnel's settings (${cloudflareConfigFile()}) are gone. Run ${command} again.`, command } };
		}
		if (!file || !existsSync(file) || serviceRunning(CLOUDFLARE_SERVICE) === false) actions.push({ kind: "restart_cloudflared", what: "Start the Cloudflare tunnel's service again" });
	}

	const local = await probeLocal(config.port, expected, 3000);
	if (local.state !== "match") {
		const file = serveFile();
		if (file && existsSync(file)) actions.push({ kind: "restart_serve", what: `Restart ${COMMAND_NAME} serve's service, so 127.0.0.1:${config.port} answers for ${expected}` });
		else if (local.state === "other")
			return { actions, advice, blocked: { state: "port_busy", code: "local_port", message: `Something else answers on 127.0.0.1:${config.port} (${local.detail}). Stop it, then run ${COMMAND_NAME} remote fix again.` } };
		else {
			const command = `${COMMAND_NAME} serve`;
			return { actions, advice, blocked: { state: "problem", code: "serve", message: `Nothing answers on 127.0.0.1:${config.port} and no service runs serve. Start it yourself (${command}), or run ${COMMAND_NAME} remote setup to install the service.`, command } };
		}
	}
	if (funnel && !funnel.open) actions.push({ kind: "open_funnel", what: `Open Tailscale Funnel on ${funnel.dns}:${FUNNEL_PORT} to 127.0.0.1:${config.port}` });

	const linger = serveFile() && existsSync(serveFile() as string) ? lingerWarning() : undefined;
	if (linger) advice.push({ name: "linger", detail: linger, command: `loginctl enable-linger ${linger.split(" ").pop()}` });
	if (!passcodeSet()) advice.push({ name: "passcode", detail: `No passcode is set, so only a connect code can approve a new assistant. ${COMMAND_NAME} token passcode sets one (shown once).`, command: `${COMMAND_NAME} token passcode` });

	actions.sort((a, b) => FIX_ORDER.indexOf(a.kind) - FIX_ORDER.indexOf(b.kind));
	return { actions, advice };
}

type Done = { ok: true; detail: string } | { ok: false; detail: string; blocked?: Diagnosis["blocked"] };

/** How long remote fix waits for a service it started to be running, in ms. TABKYRA_FIX_SERVICE_WAIT_MS changes it for tests. */
const serviceWaitMs = () => {
	const n = Number(envVar("FIX_SERVICE_WAIT_MS"));
	return Number.isFinite(n) && n > 0 ? n : 10_000;
};

/** True once the service manager says the service runs, or when it can't say (Windows); false if it still isn't at the deadline. */
async function serviceUp(spec: ServiceSpec): Promise<boolean> {
	const deadline = Date.now() + serviceWaitMs();
	for (;;) {
		if (serviceRunning(spec) !== false) return true;
		if (Date.now() >= deadline) return false;
		await sleep(250);
	}
}

async function perform(action: Diagnosis["actions"][number], config: RemoteConfig, funnelFor: () => { bin: string; dns: string } | undefined): Promise<Done> {
	switch (action.kind) {
		case "download_cloudflared": {
			const base = envVar("CLOUDFLARED_BASE_URL");
			const got = await downloadCloudflared(base ? { baseUrl: base } : {});
			return got.ok ? { ok: true, detail: `cloudflared ${got.path}` } : { ok: false, detail: got.message };
		}
		case "rename": {
			saveRemoteConfig({ ...config, publicUrl: action.newUrl as string });
			return { ok: true, detail: `remote.json now names ${action.newUrl}` };
		}
		case "restart_serve": {
			const r = await installService(SERVE_SERVICE);
			if (!r.ok) return { ok: false, detail: r.message };
			const current = loadRemoteConfig() ?? config;
			if (!(await waitForServe(current.port, current.publicUrl, serveWaitMs()))) return { ok: false, detail: `the service restarted, but 127.0.0.1:${current.port} still doesn't answer for ${current.publicUrl} after ${Math.round(serveWaitMs() / 1000)} seconds` };
			return { ok: true, detail: `127.0.0.1:${current.port} answers for ${current.publicUrl}` };
		}
		case "restart_cloudflared": {
			const r = await installService(CLOUDFLARE_SERVICE);
			if (!r.ok) return { ok: false, detail: r.message };
			// launchd and systemd can take a moment to run what they were just given ("spawn scheduled", "activating").
			return (await serviceUp(CLOUDFLARE_SERVICE))
				? { ok: true, detail: "the tunnel's service started" }
				: { ok: false, detail: `the tunnel's service was started but isn't running after ${Math.round(serviceWaitMs() / 1000)} seconds. Its log: ${serviceLogHint(CLOUDFLARE_SERVICE)}` };
		}
		case "open_funnel": {
			const where = funnelFor();
			if (!where) return { ok: false, detail: "Tailscale isn't ready" };
			const opened = await openFunnel(where.bin, where.dns, config.port);
			if (opened.kind === "opened") return { ok: true, detail: `Funnel is on for ${where.dns}:${FUNNEL_PORT}` };
			if (opened.kind === "not_allowed") return { ok: false, detail: `Funnel isn't enabled for this tailnet yet. Open ${opened.url}, enable it, then run ${COMMAND_NAME} remote fix again.`, blocked: { state: "funnel_not_allowed", message: "Funnel isn't enabled for this tailnet yet.", url: opened.url } };
			return { ok: false, detail: `tailscale funnel failed: ${opened.message}` };
		}
	}
}

export interface FixOptions {
	json: boolean;
	yes: boolean;
	dryRun: boolean;
}

export async function remoteFix(options: FixOptions): Promise<number> {
	const say = (line: string) => {
		if (!options.json) console.log(line);
	};
	let config: RemoteConfig | undefined;
	try {
		config = loadRemoteConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (options.json) printReport({ ok: false, state: "problem", code: "config", message, actions: [], advice: [] });
		else console.error(`${sym.fail} ${message}`);
		return EXIT_FAILED;
	}
	if (!config) {
		const command = `${COMMAND_NAME} remote setup`;
		const message = `Nothing is set up yet, so there is nothing to fix. Run ${command}.`;
		if (options.json) printReport({ ok: false, state: "problem", code: "not_set_up", message, next: { kind: "run_command", command }, actions: [], advice: [] });
		else console.error(`${sym.fail} ${message}`);
		return EXIT_NEEDS_PERSON;
	}

	const done: FixAction[] = [];
	let renamed: { oldUrl: string; newUrl: string } | undefined;
	let advice: FixAdvice[] = [];
	let funnelWhere: { bin: string; dns: string } | undefined;
	const interactive = !options.json && interactiveTerminal();

	const finish = (report: { ok: boolean; state: RemoteState; code?: string; message: string; next?: object; checks?: ProofCheck[]; planned?: FixAction[] }, exit: number) => {
		const actions = [...done, ...(report.planned ?? [])];
		if (options.json) {
			printReport({
				ok: report.ok,
				state: report.state,
				...(report.code ? { code: report.code } : {}),
				message: report.message,
				...(report.next ? { next: report.next } : {}),
				publicUrl: (loadRemoteConfig() ?? config).publicUrl,
				...(renamed ? renamed : {}),
				actions,
				advice,
				...(report.checks ? { checks: report.checks } : {}),
			});
		} else {
			for (const a of advice) say(`${sym.warn} ${a.name}: ${a.detail}`);
			say(`\n${report.ok ? sym.ok : sym.fail} ${report.message}`);
		}
		closeInput();
		return exit;
	};

	const tried = new Set<FixKind>();
	for (;;) {
		const current = loadRemoteConfig() ?? config;
		const d = await diagnose(current);
		advice = d.advice;
		if (current.route === "funnel") {
			const ts = tailscaleReady();
			funnelWhere = ts.ok && ts.state.kind === "ok" ? { bin: ts.bin, dns: ts.state.dns } : undefined;
		}
		if (d.blocked) {
			const b = d.blocked;
			const next = b.url ? { kind: "open_page", url: b.url } : b.command ? { kind: "run_command", command: b.command } : undefined;
			const planned = d.actions.map((a) => ({ kind: a.kind, what: a.what, status: "planned" as const }));
			// A dry run only reports, so it exits 0 here too; the JSON still names the step that blocks the rest.
			return finish({ ok: false, state: b.state, ...(b.code ? { code: b.code } : {}), message: b.message, ...(next ? { next } : {}), planned }, options.dryRun ? EXIT_ON : EXIT_NEEDS_PERSON);
		}
		const action = d.actions[0];
		if (!action) break;
		if (options.dryRun || (!options.yes && !interactive)) {
			const planned = d.actions.map((a) => ({ kind: a.kind, what: a.what, status: "planned" as const }));
			if (!options.json) {
				say(options.dryRun ? "remote fix would do, in this order:" : `remote fix would do these, in this order (nothing was changed; add --yes, or run it in a terminal to be asked):`);
				planned.forEach((a, i) => say(`  ${i + 1}. ${a.what}`));
			}
			const message = options.dryRun ? `${planned.length} repair${planned.length === 1 ? "" : "s"} to make; nothing was changed (--dry-run).` : `${planned.length} repair${planned.length === 1 ? "" : "s"} to make; nothing was changed. Run ${COMMAND_NAME} remote fix --yes, or run it in a terminal.`;
			return finish({ ok: false, state: "problem", code: "fix_pending", message, planned, ...(options.dryRun ? {} : { next: { kind: "run_command", command: `${COMMAND_NAME} remote fix --yes` } }) }, options.dryRun ? EXIT_ON : EXIT_NEEDS_PERSON);
		}
		if (tried.has(action.kind)) {
			done.push({ kind: action.kind, what: action.what, status: "failed", detail: "it was done, and the check still fails" });
			return finish({ ok: false, state: "problem", code: action.kind, message: `${action.what}: done, and the check still fails. Run ${COMMAND_NAME} remote status for the details.` }, EXIT_FAILED);
		}
		tried.add(action.kind);
		if (!options.yes) {
			if (!(await askYes(`${action.what}? [y/N] `))) {
				done.push({ kind: action.kind, what: action.what, status: "declined" });
				return finish({ ok: false, state: "problem", code: action.kind, message: "Stopped: you said no. Nothing after that was changed." }, EXIT_NEEDS_PERSON);
			}
		}
		say(`${sym.dot} ${action.what}...`);
		const result = await perform(action, current, () => funnelWhere);
		if (!result.ok) {
			done.push({ kind: action.kind, what: action.what, status: "failed", detail: result.detail });
			say(`${sym.fail} ${result.detail}`);
			const b = result.blocked;
			return finish({ ok: false, state: b?.state ?? "problem", code: action.kind, message: result.detail, ...(b?.url ? { next: { kind: "open_page", url: b.url } } : {}) }, b ? EXIT_NEEDS_PERSON : EXIT_FAILED);
		}
		done.push({ kind: action.kind, what: action.what, status: "done", detail: result.detail });
		say(`${sym.ok} ${result.detail}`);
		if (action.kind === "rename" && action.oldUrl && action.newUrl) {
			renamed = { oldUrl: action.oldUrl, newUrl: action.newUrl };
			say(`${sym.warn} The connector moved: ${c.bold(`${action.oldUrl}/mcp`)} -> ${c.bold(`${action.newUrl}/mcp`)}. Add the new URL in each assistant; the old one no longer works.`);
		}
	}

	// Nothing left to repair here: the outside proof says whether an assistant can reach it.
	const now = loadRemoteConfig() ?? config;
	say(done.length ? "\nChecking from outside, the way an assistant reaches it:" : "Nothing to repair on this computer. Checking from outside, the way an assistant reaches it:");
	const checks = await publicChecks(now.publicUrl);
	for (const line of proofLines(checks)) say(line);
	const failed = checks.find((x) => x.status === "fail");
	if (!failed) {
		const moved = renamed ? ` The connector is now ${renamed.newUrl}/mcp: add the new URL in each assistant; the old one no longer works.` : "";
		return finish({ ok: true, state: "on", message: `An assistant can reach and stream from this connector.${moved}`, checks }, EXIT_ON);
	}
	const hint = fixHint(failed);
	return finish({ ok: false, state: "problem", code: failed.name, message: `${failed.name}: ${failed.detail}. ${hint}`, checks }, EXIT_FAILED);
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What remote fix says after the outside proof fails. A check's own advice often ends "run remote fix", which here would loop;
 * that part goes and the rest stays (a certificate to give the front door, a DNS record to check). A pending failure says
 * to wait, since a route that was just opened or renamed takes a few minutes to reach public DNS.
 */
export function fixHint(failed: ProofCheck): string {
	if (failed.pending) return `A name or route that just changed takes a few minutes to answer from outside; run ${COMMAND_NAME} remote test again soon.`;
	const fix = escaped(`${COMMAND_NAME} remote fix`);
	const own = (failed.next ?? "")
		.replace(new RegExp(`;? on Tailscale or Cloudflare, run ${fix}`, "g"), "")
		.replace(new RegExp(`,? or run ${fix} on Tailscale or Cloudflare`, "g"), "")
		.replace(new RegExp(`\\s*Run ${fix}[^.]*\\.`, "g"), "")
		.trim();
	const local = `Nothing on this computer explains it; ${COMMAND_NAME} remote status shows the local side.`;
	if (!own) return local;
	const ended = /[.!?]$/.test(own) ? own : `${own}.`;
	return failed.next && new RegExp(fix).test(failed.next) ? `${ended} ${local}` : ended;
}
