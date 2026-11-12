/**
 * The native host's side of the Connect panel's "Use Polycarp from Claude, ChatGPT and Grok" flow. The panel never runs a
 * command: it calls these through connect-host.ts, which parses every frame first. Each answer is the same `state`, `code` and
 * `next` that `remote setup --json` and `remote status --json` give (remote-state.ts), copied field by field (`remoteAnswer`),
 * so the panel reads states and never sentences, and never a passcode (D33). Nothing here prints to stdout: that stream is the
 * native host's channel to the browser.
 */
import { execFile } from "node:child_process";
import { cloudflaredBinary } from "./cloudflare.ts";
import { cloudflaredAsset } from "./cloudflared-download.ts";
import { loadRemoteConfig, openFunnel, planFunnelAsync, preflight, type ProbeSeam, type RemoteConfig, remoteRoutesAsync, remoteSetup, tailscaleReadyAsync } from "./remote-setup.ts";
import { CLOUDFLARED_DOWNLOAD_URL, type RemoteNext, type RemoteState, type SetupReport, TAILSCALE_OPERATOR_FIX, tailscaleAccessDenied, tailscaleDownloadUrl } from "./remote-state.ts";
import { publicChecks, realFault } from "./remote-test.ts";
import { COMMAND_NAME, selfExec, selfPrefix } from "./self.ts";
import type { RemoteAnswer, RemoteCheckView, RemoteFixAnswer, RemoteNextView } from "../../src/connect/types.ts";

/** The longest helper sentence that reaches the panel. Tailscale's own words can be long; this keeps Details readable. */
const MAX_MESSAGE = 600;
const cap = (text: string, n = MAX_MESSAGE): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

const NEXT_KINDS: readonly RemoteNextView["kind"][] = ["install", "sign_in", "open_page", "run_command", "choose_name", "add_connector"];

/** A `next` the panel may draw: a known kind, an https URL with no credentials, a one-line command. Anything else is dropped. */
export function nextView(next: unknown): RemoteNextView | undefined {
	if (!next || typeof next !== "object") return undefined;
	const n = next as Record<string, unknown>;
	if (!NEXT_KINDS.includes(n.kind as RemoteNextView["kind"])) return undefined;
	const out: RemoteNextView = { kind: n.kind as RemoteNextView["kind"] };
	if (typeof n.url === "string" && n.url.length <= 2000) {
		try {
			const url = new URL(n.url);
			if (url.protocol === "https:" && !url.username && !url.password) out.url = url.href;
		} catch {
			/* dropped */
		}
	}
	if (typeof n.command === "string" && n.command.length <= 300 && !/[\r\n]/.test(n.command)) out.command = n.command;
	return out;
}

/** Checks as the panel draws them: known statuses, capped text. */
export function checkViews(checks: unknown): RemoteCheckView[] | undefined {
	if (!Array.isArray(checks)) return undefined;
	const out: RemoteCheckView[] = [];
	for (const c of checks.slice(0, 20)) {
		if (!c || typeof c !== "object") continue;
		const x = c as Record<string, unknown>;
		if (typeof x.name !== "string" || !["ok", "warn", "fail"].includes(x.status as string) || typeof x.detail !== "string") continue;
		out.push({
			name: cap(x.name, 40),
			status: x.status as RemoteCheckView["status"],
			detail: cap(x.detail, 400),
			...(typeof x.next === "string" ? { next: cap(x.next, 400) } : {}),
			// A failure that waiting fixes (a new name not published yet, a tunnel still connecting): the panel shows it as waiting.
			...(x.status === "fail" && x.pending === true ? { pending: true } : {}),
		});
	}
	return out;
}

/**
 * The panel's copy of a helper answer: only these fields, each checked. The passcode is never copied, whatever the answer holds
 * (D33: never in an answer to the panel). The connect code is added by the caller, which counts it against the mint limit.
 */
export function remoteAnswer(report: Partial<SetupReport> & { state: string; routes?: unknown; route?: unknown }): RemoteAnswer {
	const next = nextView(report.next);
	const checks = checkViews(report.checks);
	const routes = routesView(report.routes);
	const connector = typeof report.connectorUrl === "string" && /^https:\/\/[^\s/]+(:\d+)?\/mcp$/.test(report.connectorUrl) ? report.connectorUrl : undefined;
	return {
		state: cap(String(report.state), 40),
		...(typeof report.code === "string" ? { code: cap(report.code, 40) } : {}),
		message: cap(typeof report.message === "string" ? report.message : ""),
		...(next ? { next } : {}),
		...(routes ? { routes } : {}),
		...(report.route === "funnel" || report.route === "cloudflare" || report.route === "custom" ? { route: report.route } : {}),
		...(connector ? { connectorUrl: connector } : {}),
		...(typeof report.passcodeSet === "boolean" ? { passcodeSet: report.passcodeSet } : {}),
		...(checks?.length ? { checks } : {}),
		...(typeof report.connectCodeProblem === "string" ? { connectCodeProblem: cap(report.connectCodeProblem, 300) } : {}),
	};
}

function routesView(routes: unknown): RemoteAnswer["routes"] {
	if (!routes || typeof routes !== "object") return undefined;
	const r = routes as Record<string, Record<string, unknown> | undefined>;
	const one = (x: Record<string, unknown> | undefined) => ({ installed: x?.installed === true, signedIn: x?.signedIn === true });
	return { tailscale: one(r.tailscale), cloudflare: one(r.cloudflare) };
}

/**
 * remote.json that can't be read. The parser's words can quote the start of the file, so the panel gets a fixed sentence and
 * `remote status` in a terminal says the rest.
 */
export function configProblem(_err: unknown): RemoteAnswer {
	return remoteAnswer({ state: "problem", code: "config", message: `remote.json couldn't be read. Run ${COMMAND_NAME} remote status to see why.` });
}

/** What a person does next for a state the planner refused with, as `remote setup` says it. */
function nextFor(state: RemoteState): RemoteNext | undefined {
	if (state === "tailscale_missing") return { kind: "install", url: tailscaleDownloadUrl() };
	if (state === "tailscale_signed_out") return { kind: "sign_in", command: "tailscale up" };
	return undefined;
}

/** The "Get it for me" command for cloudflared, when this platform has a pinned release to download. */
function cloudflaredNext(host: string | undefined): RemoteNext {
	return { kind: "install", url: CLOUDFLARED_DOWNLOAD_URL, ...(cloudflaredAsset() && host ? { command: `${COMMAND_NAME} remote setup --cloudflare ${host} --yes` } : {}) };
}

/**
 * Where remote access stands, read without changing anything and without the network: cheap enough to ask every few seconds
 * while a step waits on the person. With nothing set up it is `remote setup`'s preflight (ready, or the first thing in the
 * way); set up, it is what stops the route from working on this computer (Tailscale gone or signed out, Funnel closed,
 * cloudflared gone), else `on`. The outside checks are `remoteTest`, asked for on their own. Every Tailscale read is async with
 * a time limit (first-F3): this process relays every agent's traffic, and a poll must never hold it up.
 */
export async function remoteState(seam: ProbeSeam = {}): Promise<RemoteAnswer> {
	let config: RemoteConfig | undefined;
	try {
		config = loadRemoteConfig();
	} catch (err) {
		const routes = routesView(await remoteRoutesAsync(seam));
		return { ...configProblem(err), ...(routes ? { routes } : {}) };
	}
	const routes = await remoteRoutesAsync(seam);
	if (!config) {
		const pf = await preflight(seam);
		const next = nextFor(pf.state);
		return remoteAnswer({ ...pf, ...(next ? { next } : {}), routes });
	}
	const base = { routes, route: config.route, connectorUrl: `${config.publicUrl}/mcp` };
	if (config.route === "funnel") {
		const ready = await tailscaleReadyAsync(seam);
		if (!ready.ok) {
			const next = nextFor(ready.state);
			return remoteAnswer({ ...base, state: ready.state, message: ready.message, ...(ready.code ? { code: ready.code } : {}), ...(next ? { next } : {}) });
		}
		const address = new URL(config.publicUrl);
		const key = `${address.hostname}:${address.port || "443"}`;
		if (ready.state.kind === "ok" && ready.state.allowFunnel[key] !== true) {
			return remoteAnswer({ ...base, state: "funnel_closed", message: `Tailscale Funnel isn't open for ${key}, so assistants can't reach this computer.` });
		}
	}
	if (config.route === "cloudflare" && !cloudflaredBinary()) {
		return remoteAnswer({ ...base, state: "cloudflared_missing", message: "cloudflared isn't installed any more, so assistants can't reach this computer.", next: cloudflaredNext(new URL(config.publicUrl).hostname) });
	}
	return remoteAnswer({ ...base, state: "on", message: "Remote access is on.", next: { kind: "add_connector", url: `${config.publicUrl}/mcp` } });
}

/**
 * The Tailscale route, as `remote setup --tailscale --json --no-passcode`: the panel never holds a passcode (D33), so the
 * one-time connect code approves each assistant. Never waits on the person: a refusal comes back at once with its `next`.
 */
export async function remoteSetupTailscale(run: typeof remoteSetup = remoteSetup): Promise<RemoteAnswer> {
	let report: SetupReport | undefined;
	await run({ tailscale: true, service: true, passcode: false, report: (r) => (report = r) });
	if (!report) return remoteAnswer({ state: "problem", message: `Setup ended without an answer. Run ${COMMAND_NAME} remote setup --tailscale in a terminal to see why.` });
	return remoteAnswer(report);
}

/** Seams for `remoteOpenFunnel`, so a test runs it without Tailscale. */
export interface FunnelSeam {
	load?: () => RemoteConfig | undefined;
	plan?: (ports: number[]) => ReturnType<typeof planFunnelAsync> | Awaited<ReturnType<typeof planFunnelAsync>>;
	open?: typeof openFunnel;
	checks?: typeof publicChecks;
}

/**
 * Open the Funnel remote.json already names, again: the step after a person allows Funnel in Tailscale, and the "Open Funnel
 * again" button. Only `tailscale funnel` runs; the service and remote.json are left as setup made them, so the panel can try
 * every few seconds while it waits. Refused unless remote.json is on the Funnel route, so it never opens anything a person
 * didn't already turn on. On success it runs the outside checks, as setup does at its end.
 */
export async function remoteOpenFunnel(seam: FunnelSeam = {}): Promise<RemoteAnswer> {
	const config = (seam.load ?? loadRemoteConfig)();
	if (!config || config.route !== "funnel") return remoteAnswer({ state: "problem", code: "not_set_up", message: "Funnel isn't this computer's route, so there is nothing to open.", next: { kind: "run_command", command: `${COMMAND_NAME} remote setup` } });
	const base = { route: config.route, connectorUrl: `${config.publicUrl}/mcp` };
	const plan = await (seam.plan ?? planFunnelAsync)([config.port]);
	if (!plan.ok) {
		const next = nextFor(plan.state);
		return remoteAnswer({ ...base, state: plan.state, message: plan.message, ...(plan.code ? { code: plan.code } : {}), ...(next ? { next } : {}) });
	}
	const opened = await (seam.open ?? openFunnel)(plan.bin, plan.dns, config.port);
	if (opened.kind === "not_allowed") return remoteAnswer({ ...base, state: "funnel_not_allowed", message: "Funnel isn't enabled for this tailnet or computer yet.", adminUrl: opened.url, next: { kind: "open_page", url: opened.url } });
	if (opened.kind === "failed" && process.platform !== "win32" && tailscaleAccessDenied(opened.message)) {
		return remoteAnswer({ ...base, state: "problem", code: "tailscale_operator", message: `Tailscale's words: ${opened.message}`, next: { kind: "run_command", command: TAILSCALE_OPERATOR_FIX } });
	}
	if (opened.kind === "failed") return remoteAnswer({ ...base, state: "problem", code: "funnel", message: `tailscale funnel failed: ${opened.message}` });
	const checks = await (seam.checks ?? publicChecks)(config.publicUrl);
	// Setup's rule: only a failure that waiting doesn't fix is a problem. A new name not published yet is on, with its pending
	// check, and the panel checks again by itself.
	const fault = realFault(checks);
	if (fault) return remoteAnswer({ ...base, state: "problem", code: fault.name, message: `${fault.name} failed: ${fault.detail}`, checks });
	return remoteAnswer({ ...base, state: "on", message: "Connector ready.", next: { kind: "add_connector", url: `${config.publicUrl}/mcp` }, checks });
}

/** `remote test`, for the result screen's checklist: what an assistant sees from outside. Changes nothing. */
export async function remoteTest(checks: typeof publicChecks = publicChecks, load: () => RemoteConfig | undefined = loadRemoteConfig): Promise<RemoteAnswer> {
	const config = load();
	if (!config) return remoteAnswer({ state: "problem", code: "not_set_up", message: `Nothing is set up yet.`, next: { kind: "run_command", command: `${COMMAND_NAME} remote setup` } });
	const found = await checks(config.publicUrl);
	const failed = found.find((x) => x.status === "fail");
	return remoteAnswer({
		state: failed ? "problem" : "on",
		...(failed ? { code: failed.name } : {}),
		message: failed ? `${failed.name}: ${failed.detail}` : "An assistant can reach and stream from this connector.",
		route: config.route,
		connectorUrl: `${config.publicUrl}/mcp`,
		checks: found,
	});
}

/** How the host runs a helper command: this program, with arguments only, no shell. Tests pass a stand-in. */
export type RunSelf = (args: string[], timeoutMs: number) => Promise<{ code: number; out: string }>;

export const runSelf: RunSelf = (args, timeoutMs) =>
	new Promise((resolve) => {
		execFile(selfExec(), [...selfPrefix(), ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1) : 0;
			resolve({ code, out: String(stdout ?? "") });
		});
	});

/**
 * `remote fix --json`, run as its own process because it prints its answer on stdout, which in this process is the channel to
 * the browser. `dryRun` lists the repairs and changes nothing; the real run passes `--yes`, so it never waits on a question.
 * A helper without `remote fix` (a usage error, or no JSON with `actions`) answers `available: false`, and the panel hides
 * Repair. The arguments are fixed: nothing from the page reaches this command line.
 */
export async function remoteFix(dryRun: boolean, run: RunSelf = runSelf): Promise<RemoteFixAnswer> {
	const { code, out } = await run(["remote", "fix", "--json", dryRun ? "--dry-run" : "--yes"], dryRun ? 60_000 : 300_000);
	if (code === 2) return { available: false };
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(out) as Record<string, unknown>;
	} catch {
		return { available: false };
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.actions)) return { available: false };
	const actions = (parsed.actions as unknown[])
		.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
		.filter((a) => typeof a.kind === "string" && typeof a.what === "string" && typeof a.status === "string")
		.slice(0, 10)
		.map((a) => ({ kind: cap(String(a.kind), 40), what: cap(String(a.what), 300), status: cap(String(a.status), 20) }));
	const checks = checkViews(parsed.checks);
	// A step only the person can take (second-N1): what to do next and the advice, so a Repair that stops says why.
	const next = nextView(parsed.next);
	const advice = adviceViews(parsed.advice);
	return {
		available: true,
		ok: parsed.ok === true,
		...(typeof parsed.state === "string" ? { state: cap(parsed.state, 40) } : {}),
		...(typeof parsed.code === "string" ? { code: cap(parsed.code, 40) } : {}),
		...(typeof parsed.message === "string" ? { message: cap(parsed.message) } : {}),
		actions,
		...(checks?.length ? { checks } : {}),
		...(next ? { next } : {}),
		...(advice.length ? { advice } : {}),
	};
}

/** `remote fix`'s advice as the panel draws it: `{name, detail, command?}`, capped, a command only on one short line. */
export function adviceViews(advice: unknown): NonNullable<RemoteFixAnswer["advice"]> {
	if (!Array.isArray(advice)) return [];
	return advice
		.filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
		.filter((a) => typeof a.name === "string" && typeof a.detail === "string")
		.slice(0, 10)
		.map((a) => ({
			name: cap(String(a.name), 40),
			detail: cap(String(a.detail), 400),
			...(typeof a.command === "string" && a.command.length <= 300 && !/[\r\n]/.test(a.command) ? { command: a.command } : {}),
		}));
}
