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
}

/** Funnel is retried by itself for this long after a refusal; then the step's button checks again (funnel_gave_up). */
export const FUNNEL_RETRY_FOR_MS = 10 * 60_000;

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

/** Repair needs this helper's `remote fix` (feature-detected) and a plan with something in it. */
export const repairAvailable = (fix?: RemoteFixAnswer): boolean =>
	fix?.available === true && (fix.actions?.length ?? 0) > 0;

function step(answer: RemoteAnswer, input: FlowInput, route?: ChosenRoute): Extract<FlowScreen, { kind: "step" }> {
	let copy: RemoteStepCopy & { key: string } = stepCopy(answer);
	if (copy.key === "funnel_not_allowed" && input.funnelGaveUp)
		copy = { key: "funnel_gave_up", ...STEP_COPY.funnel_gave_up };
	// A button with nothing behind it is not drawn: Repair needs `remote fix` and a plan.
	if (copy.action?.kind === "repair" && !repairAvailable(input.fix)) {
		const { action: _drop, ...rest } = copy;
		copy = rest;
	}
	const saved = input.status?.route === "remote";
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
	const failed = realFailures(checks);
	const waiting = !failed.length && (waitingChecks(checks) || (!checks?.length && answer?.code === "dns"));
	const head: ResultHead = failed.length
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
		repair: failed.length > 0 && repairAvailable(input.fix),
		noPasscode: input.status?.passcodeSet === false,
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
		if (chosen === "cloudflare" && routeOf(status) !== "cloudflare") return { kind: "cloudflare", step: 3 };
		// Set up. Something about Tailscale or cloudflared itself comes first; then the last run's answer (Funnel not allowed
		// yet carries the page to open, a retry's operator refusal its command); else the result, with what was last found from
		// outside. funnel_closed is only what a newer run is trying to fix, so any run that isn't on comes ahead of it.
		if (remote && BLOCKING.has(remote.state) && !(run && !isOn(run) && remote.state === "funnel_closed"))
			return step(remote, input, routeOf(status));
		if (run && !isOn(run)) return step(run, input, routeOf(status));
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

export function pollFor(screen: FlowScreen, input: FlowInput): Poll | undefined {
	if (screen.kind === "choose") return { method: "remoteState", everyMs: STATE_POLL_MS };
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

/** Two answers draw the same: a poll that brings nothing new must not touch the screen (the side panel jitter, PR 117). */
export function sameAnswer(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
