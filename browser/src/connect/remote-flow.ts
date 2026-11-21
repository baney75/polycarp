/**
 * The side panel's "Use Polycarp from Claude, ChatGPT and Grok" flow as a pure function: from what the helper last said, pick
 * the one screen to draw and what to ask next while it waits. No DOM and no timers here, so every transition is tested
 * (test/remote-flow.test.mjs). The words come from remote-copy.ts; the states from the helper (RemoteAnswer).
 *
 * Choose a way -> get it and sign in -> turn on -> the result. A step that waits on the person (install, sign in, allow Funnel)
 * names a poll, and the next answer moves the screen on by itself: nobody presses "try again" to find out it worked.
 */
import {
	answerOn,
	copyKey,
	REPAIR_AGAIN,
	RESULT_COPY,
	type RemoteCopyKey,
	type RemoteStepCopy,
	realFailures,
	STEP_COPY,
	stepCopy,
	waitingChecks,
} from "./remote-copy.js";
import type { ConnectStatus, RemoteAnswer, RemoteCheckView, RemoteFixAnswer, RemoteRoutesView } from "./types.js";

export type ChosenRoute = "tailscale" | "cloudflare";

export interface FlowInput {
	status?: ConnectStatus;
	/** The latest `remoteState` answer. */
	remote?: RemoteAnswer;
	chosen?: ChosenRoute;
	/** The answer of the last thing the person started (Turn on, or the Funnel retry that follows it). */
	run?: RemoteAnswer;
	/** A setup is running now. */
	busy?: "setup" | "tunnel";
	/** The latest outside checks, from whichever answer brought them last (a run, a test or a repair). */
	checks?: RemoteCheckView[];
	/** `remote fix --dry-run`'s plan; Repair shows only when it exists and has actions. */
	fix?: RemoteFixAnswer;
	/** The ten-minute Funnel retry ran out: the step stops waiting and its button checks again. */
	funnelGaveUp?: boolean;
	/** The result waited WAITING_FOR_MS on a pending check: it is a failure now, with Repair (second-N2). */
	waitingGaveUp?: boolean;
	/** `run` is a refusal from the Cloudflare form (setupTunnel's problem), not a Funnel answer (PR 136 second-S1). */
	runFromForm?: boolean;
}

/** Funnel is retried by itself for this long after a refusal; then the step's button checks again (funnel_gave_up). */
export const FUNNEL_RETRY_FOR_MS = 10 * 60_000;

/**
 * How long the result says "still being published" before a pending check counts as failed (second-N2). Public DNS for a new
 * name and a new tunnel both answer within minutes; setup already waited 5 of them.
 */
export const WAITING_FOR_MS = 15 * 60_000;

/** The longest gap between two ticks that counts as waiting: a panel hidden longer than this wasn't watching (second-S4). */
export const WAIT_TICK_GAP_MS = 2_000;

/**
 * Waiting time the person could see. Each tick adds the time since the last one, at most WAIT_TICK_GAP_MS, and the tick
 * stops while the panel is hidden, so a panel left hidden for 15 minutes doesn't come back gave-up on an old test (second-S4).
 */
export function waitedMs(prev: { ms: number; at?: number } | undefined, now: number): { ms: number; at: number } {
	const ms = prev?.ms ?? 0;
	const step = prev?.at === undefined ? 0 : Math.min(Math.max(0, now - prev.at), WAIT_TICK_GAP_MS);
	return { ms: ms + step, at: now };
}

/**
 * The Cloudflare name a step's download or sign-in button sets up: the saved Cloudflare address, else the name the refused run
 * was for, else what was typed. Never a Funnel route's ts.net name (PR 136 second-S3).
 */
export function cloudflareHostFor(
	status: ConnectStatus | undefined,
	refusedHost: string | undefined,
	typed: string,
): string {
	if (status?.route === "remote" && status.remoteKind === "cloudflare" && status.publicUrl)
		return new URL(status.publicUrl).hostname;
	return refusedHost ?? typed.trim();
}

/** The result's heading: on, on and waiting for a pending check, on with a failed check, or on with no browser. */
export type ResultHead = Extract<RemoteCopyKey, "on" | "on_waiting" | "check_failed" | "no_browser_connected">;

export type FlowScreen =
	| { kind: "loading" }
	/** Not this flow: a hub, a link to a hub, or the person's own front door. Connect draws those as before. */
	| { kind: "other" }
	| { kind: "choose"; routes?: RemoteRoutesView; recommended?: ChosenRoute }
	| {
			kind: "step";
			step: 2 | 3;
			route?: ChosenRoute;
			copy: RemoteStepCopy & { key: string };
			answer: RemoteAnswer;
			/** "Choose another way": only before anything is saved, where choosing again does something. */
			chooseAgain: boolean;
			/** "Use Cloudflare instead": on a saved Funnel route, unless the step's own button already is that. */
			useCloudflare: boolean;
	  }
	| { kind: "cloudflare"; step: 3 }
	| {
			kind: "result";
			connectorUrl: string;
			answer?: RemoteAnswer;
			head: ResultHead;
			/** Every failure is pending: the result checks again by itself. */
			waiting: boolean;
			/** A check failed for real and this helper's `remote fix` has something to do. */
			repair: boolean;
			/** No passcode is set, so "No passcode was made here" is true. */
			noPasscode: boolean;
			/** The wait ran out (WAITING_FOR_MS): the pending checks are drawn as failed. */
			gaveUp: boolean;
	  };

/** States that stop the saved route from working on this computer: they come ahead of the result, whatever an older run said. */
const BLOCKING = new Set([
	"tailscale_missing",
	"tailscale_signed_out",
	"tailnet_lock",
	"funnel_closed",
	"cloudflared_missing",
]);

/** Step 2 is getting the tool and signing in; anything about turning on or what it found is step 3. */
const STEP_TWO = new Set([
	"tailscale_missing",
	"tailscale_signed_out",
	"tailnet_lock",
	"cloudflared_manual",
	"cloudflared_missing",
	"cloudflare_login",
]);

const isOn = (a?: RemoteAnswer): boolean => Boolean(a && answerOn(a));

/**
 * Comes ahead of the result on a saved route, whatever an older run said: a state that stops the route on this computer, or
 * Tailscale not answering in time, which must never read as "on" (PR 136 r2 first-F1).
 */
const blocks = (a: RemoteAnswer): boolean =>
	BLOCKING.has(a.state) || (a.state === "problem" && a.code === "tailscale_silent");

/** What Check again asks: the outside checks again for a step about them, else where things stand on this computer. */
export function checkAgainMethod(answer: RemoteAnswer): "remoteState" | "remoteTest" {
	const k = copyKey(answer);
	return k === "dns" || k === "dns_lookup" || k === "check_failed" ? "remoteTest" : "remoteState";
}

/** Repair needs this helper's `remote fix` (feature-detected) and a plan with something in it. */
export const repairAvailable = (fix?: RemoteFixAnswer): boolean =>
	fix?.available === true && (fix.actions?.length ?? 0) > 0;

function step(answer: RemoteAnswer, input: FlowInput, route?: ChosenRoute): Extract<FlowScreen, { kind: "step" }> {
	let copy: RemoteStepCopy & { key: string } = stepCopy(answer);
	const saved = input.status?.route === "remote";
	if (copy.key === "funnel_not_allowed" && input.funnelGaveUp)
		copy = { key: "funnel_gave_up", ...STEP_COPY.funnel_gave_up };
	// The operator refusal waits only while the Funnel retry runs; once it stopped, or with nothing saved to retry, the button
	// checks again (first-F2).
	if (copy.key === "tailscale_operator" && (input.funnelGaveUp || !saved))
		copy = { key: "tailscale_operator_check", ...STEP_COPY.tailscale_operator_check };
	// A button with nothing behind it is not drawn: Repair needs `remote fix` and a plan. The step still keeps a way forward,
	// checking from outside again, since nothing else would ever end it (PR 136 r2 first-F2).
	if (copy.action?.kind === "repair" && !repairAvailable(input.fix))
		copy = { ...copy, action: { kind: "check_again", label: RESULT_COPY.checkAgain } };
	return {
		kind: "step",
		step: STEP_TWO.has(copy.key) ? 2 : 3,
		...(route ? { route } : {}),
		copy,
		answer,
		chooseAgain: !saved && route === "tailscale" && copy.key !== "turning_on",
		useCloudflare: saved && route === "tailscale" && copy.action?.kind !== "use_cloudflare",
	};
}

function result(input: FlowInput, connectorUrl: string, answer?: RemoteAnswer): FlowScreen {
	// The newest checks speak; before any arrive, the answer's own (or an older helper's bare dns code) does.
	const checks = input.checks ?? answer?.checks;
	const real = realFailures(checks);
	const pending = !real.length && (waitingChecks(checks) || (!checks?.length && answer?.code === "dns"));
	// Past the wait, a pending check is a failure like any other, and Repair can try (second-N2).
	const gaveUp = pending && input.waitingGaveUp === true;
	const failed = gaveUp ? (checks ?? []).filter((c) => c.status === "fail") : real;
	const waiting = pending && !gaveUp;
	const head: ResultHead =
		failed.length || gaveUp
			? "check_failed"
			: waiting
				? "on_waiting"
				: answer?.state === "no_browser_connected"
					? "no_browser_connected"
					: "on";
	return {
		kind: "result",
		connectorUrl,
		...(answer ? { answer } : {}),
		head,
		waiting,
		repair: (failed.length > 0 || gaveUp) && repairAvailable(input.fix),
		noPasscode: input.status?.passcodeSet === false,
		gaveUp,
	};
}

/** Recommended: Tailscale when it is installed here (no domain needed). Nothing is pressed on the person otherwise. */
export function recommendedRoute(routes?: RemoteRoutesView): ChosenRoute | undefined {
	return routes?.tailscale.installed ? "tailscale" : undefined;
}

/** The flow draws Connect's assistant section when there is no address yet, or this computer's own Funnel or Cloudflare one. */
export function remoteFlowFor(s: ConnectStatus): boolean {
	if (s.problem) return false;
	return s.route === "none" || (s.route === "remote" && (s.remoteKind === "funnel" || s.remoteKind === "cloudflare"));
}

export function flowScreen(input: FlowInput): FlowScreen {
	const { status, remote, chosen, run, busy } = input;
	if (!status) return { kind: "loading" };
	if (!remoteFlowFor(status)) return { kind: "other" };
	if (busy === "setup") return step({ state: "turning_on", message: "" }, input, "tailscale");
	if (busy === "tunnel") return { kind: "cloudflare", step: 3 };
	// A run that turned on (a new name still being published included) speaks for itself until the status catches up.
	if (isOn(run) && run?.connectorUrl) return result(input, run.connectorUrl, run);
	if (status.route === "remote" && status.publicUrl) {
		// "Use Cloudflare instead" on a Funnel route: the Cloudflare form, until it turns on or the person goes back.
		// A refusal from that form (a taken name) is drawn as its own step first (first-F1). Only one from the form: a Funnel
		// answer that lands after "Use Cloudflare instead" must not hide the form (PR 136 second-S1).
		if (chosen === "cloudflare" && routeOf(status) !== "cloudflare" && !(run && !isOn(run) && input.runFromForm))
			return { kind: "cloudflare", step: 3 };
		// Set up. Something about Tailscale or cloudflared itself comes first; then the last run's answer (Funnel not allowed
		// yet carries the page to open, a retry's operator refusal its command); else the result, with what was last found from
		// outside. funnel_closed is only what a newer run is trying to fix, so any run that isn't on comes ahead of it.
		if (remote && blocks(remote) && !(run && !isOn(run) && remote.state === "funnel_closed"))
			return step(remote, input, routeOf(status));
		if (run && !isOn(run)) return step(run, input, chosen === "cloudflare" ? "cloudflare" : routeOf(status));
		return result(input, `${status.publicUrl}/mcp`, remote);
	}
	// Nothing set up yet.
	if (run && !isOn(run)) return step(run, input, chosen);
	if (!chosen)
		return {
			kind: "choose",
			...(remote?.routes ? { routes: remote.routes } : {}),
			...(recommendedRoute(remote?.routes) ? { recommended: recommendedRoute(remote?.routes) } : {}),
		};
	if (chosen === "cloudflare") return { kind: "cloudflare", step: 3 };
	if (!remote) return { kind: "loading" };
	return step(remote, input, "tailscale");
}

const routeOf = (status: ConnectStatus): ChosenRoute | undefined =>
	status.remoteKind === "funnel" ? "tailscale" : status.remoteKind === "cloudflare" ? "cloudflare" : undefined;

/** What the panel asks while this screen is up, and how often. Undefined: nothing until the person acts. */
export interface Poll {
	method: "remoteState" | "remoteFunnel" | "remoteTest";
	everyMs: number;
}

export const STATE_POLL_MS = 3_000;
export const FUNNEL_POLL_MS = 5_000;
export const DNS_POLL_MS = 30_000;
/**
 * The choose screen once the routes are read: an install or sign-in in another window still shows up, without asking Tailscale
 * every 3 seconds while nobody acts (first-F3).
 */
export const CHOOSE_POLL_MS = 15_000;

export function pollFor(screen: FlowScreen, input: FlowInput): Poll | undefined {
	if (screen.kind === "choose")
		return { method: "remoteState", everyMs: screen.routes ? CHOOSE_POLL_MS : STATE_POLL_MS };
	// A new address takes minutes to reach public DNS, and a new tunnel a minute to connect: check again until it answers.
	if (screen.kind === "result") return screen.waiting ? { method: "remoteTest", everyMs: DNS_POLL_MS } : undefined;
	if (screen.kind !== "step" || input.busy) return undefined;
	const key = screen.copy.key;
	// Allowing Funnel (or making the user Tailscale's operator) happens in Tailscale; opening Funnel again is how to see it worked.
	if (input.run && (key === "funnel_not_allowed" || key === "tailscale_operator") && input.status?.route === "remote")
		return { method: "remoteFunnel", everyMs: FUNNEL_POLL_MS };
	if (key === "dns") return { method: "remoteTest", everyMs: DNS_POLL_MS };
	if (screen.copy.waits || key === "ready" || key === "funnel_closed" || key === "cloudflared_missing")
		return { method: "remoteState", everyMs: STATE_POLL_MS };
	return undefined;
}

/**
 * The run answer to keep once a newer `remoteState` arrives. A refusal about Tailscale itself ends when the state no longer
 * says the same thing (signing in moves the screen on); a refusal from the turn-on step stays until the person acts or a
 * retry answers; an `on` run ends once the status shows the route.
 */
export function settleRun(
	run: RemoteAnswer | undefined,
	remote: RemoteAnswer,
	status?: ConnectStatus,
): RemoteAnswer | undefined {
	if (!run) return undefined;
	if (isOn(run)) return status?.route === "remote" ? undefined : run;
	const k = copyKey(run);
	if (
		(k === "tailscale_missing" || k === "tailscale_signed_out" || k === "tailnet_lock") &&
		remote.state !== run.state
	)
		return undefined;
	return run;
}

/**
 * The run answer to keep once a `remoteTest` answers. A run that stopped on a check (dns, or a failed check) is over once a
 * later test says the route is on, so the step can't outlive what it was about (first-F1). Anything else is the person's.
 */
export function settleRunAfterTest(run: RemoteAnswer | undefined, test: RemoteAnswer): RemoteAnswer | undefined {
	if (!run || isOn(run) || !isOn(test)) return run;
	const k = copyKey(run);
	return k === "dns" || k === "check_failed" ? undefined : run;
}

/** What a Repair that stopped says: the step only the person can take, its command or page, and `remote fix`'s advice. */
export interface RepairOutcome {
	/** The step Repair stopped on, as an answer, for the step's own button. */
	answer: RemoteAnswer;
	copy: RemoteStepCopy & { key: string };
	message?: string;
	command?: string;
	url?: string;
	advice: NonNullable<RemoteFixAnswer["advice"]>;
}

/** A step's body without its claim that the page moves on by itself, for a place where nothing polls. */
export function withoutWaiting(body: string): string {
	return body
		.replace(/;\s*this page [^.]*\./gi, ".")
		.replace(/\s*This page [^.]*\./g, "")
		.trim();
}

/**
 * The block a failed Repair draws (second-N1), or undefined when it worked or never ran. Nothing polls for it, so every step
 * that would say it moves on by itself (every `waits` entry) says to press Repair again instead, and its button is Repair
 * (PR 136 second-S2 and first-F2). Any other step keeps its own button, which the block draws.
 */
export function repairOutcome(done: RemoteFixAnswer | undefined): RepairOutcome | undefined {
	if (!done?.available || done.ok !== false) return undefined;
	const answer = {
		state: done.state ?? "problem",
		...(done.code ? { code: done.code } : {}),
		message: done.message ?? "",
		...(done.next ? { next: done.next } : {}),
	};
	const step = stepCopy(answer);
	const copy: RemoteStepCopy & { key: string } = step.waits
		? {
				key: step.key,
				title: step.title,
				body: `${withoutWaiting(step.body ?? "")} ${REPAIR_AGAIN}`,
				action: { kind: "repair", label: RESULT_COPY.repair },
			}
		: step;
	return {
		answer,
		copy,
		...(done.message ? { message: done.message } : {}),
		...(done.next?.command ? { command: done.next.command } : {}),
		...(done.next?.url ? { url: done.next.url } : {}),
		advice: done.advice ?? [],
	};
}

/** Two answers draw the same: a poll that brings nothing new must not touch the screen (the side panel jitter, PR 117). */
export function sameAnswer(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
