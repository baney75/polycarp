/**
 * Every sentence of "Use Polycarp from Claude, ChatGPT and Grok", in one place: the side panel draws from it, the Mac app
 * holds the same strings (spaces/Sources/BaneySpacesCore/RemoteSharedCopy.swift, held equal by test/remote-copy.test.mjs),
 * and the assistant steps are the lines `remote setup` prints. Types and constants only, so the extension and the helper
 * both import it.
 *
 * The helper's JSON is the contract: `state`, `code` and `next.kind` pick one entry here (`copyKey`). A known state never
 * falls back to a generic sentence; only a state or code this table doesn't know shows the helper's own `message`.
 */

/** What the one button on a step does. The label comes from the entry; the surface does the work. */
export type RemoteActionKind =
	| "open_url"
	| "download"
	| "copy_command"
	| "turn_on"
	| "check_again"
	| "try_again"
	| "use_cloudflare"
	| "sign_in_cloudflare"
	| "open_funnel"
	| "new_code"
	| "repair"
	| "choose";

export interface RemoteStepCopy {
	title: string;
	/** Undefined only for `unknown`, whose body is the helper's own message. */
	body?: string;
	action?: { kind: RemoteActionKind; label: string };
	/** The page moves on by itself on this step (it polls), so the person never presses "try again". */
	waits?: boolean;
}

export const REMOTE_TITLE = "Use Polycarp from Claude, ChatGPT and Grok";

/** What a stopped Repair's step ends with in place of "this page moves on by itself": nothing polls there. */
export const REPAIR_AGAIN = "Then press Repair again.";

export const ROUTE_COPY = {
	chooseTitle: "How should assistants reach this computer?",
	chooseBody: "Both ways are free and run on your own account. Polycarp never sees the account or makes one for you.",
	tailscale: { name: "Tailscale", detail: "No domain needed.", use: "Use Tailscale" },
	cloudflare: { name: "Cloudflare", detail: "Uses a domain on your Cloudflare account.", use: "Use Cloudflare" },
	recommended: "Recommended",
	signedIn: "Signed in on this computer",
	installed: "Installed, not signed in",
	missing: "Not on this computer yet",
	chooseAgain: "Choose another way",
	useCloudflareInstead: "Use Cloudflare instead",
} as const;

/** The route card's status line, from `routes` in the helper's status. */
export function routeStatus(installed: boolean, signedIn: boolean): string {
	return signedIn ? ROUTE_COPY.signedIn : installed ? ROUTE_COPY.installed : ROUTE_COPY.missing;
}

/** The three steps a person goes through, shown as "Step N of 3" on both surfaces. */
export const FLOW_STEPS = ["Choose a way", "Get it and sign in", "Turn on"] as const;

/**
 * One entry per thing the helper can say. Keys are `state` for states that say enough by themselves, and the `code` for a
 * `problem` (and for `port_busy`, which has two). `copyKey` picks the entry.
 */
export const STEP_COPY = {
	tailscale_missing: {
		title: "Get Tailscale",
		body: "Tailscale is free and runs on your own account. Install it and sign in; this page moves on by itself.",
		action: { kind: "open_url", label: "Get Tailscale" },
		waits: true,
	},
	tailscale_signed_out: {
		title: "Sign in to Tailscale",
		body: "Tailscale is installed but not signed in. Open Tailscale and sign in, or run the command below in a terminal. This page moves on by itself.",
		action: { kind: "copy_command", label: "Copy the command" },
		waits: true,
	},
	tailnet_lock: {
		title: "Funnel won't work on this tailnet",
		body: "Your tailnet has Tailnet Lock turned on, and Funnel doesn't work with it. Nothing was changed. Use Cloudflare instead; turning Tailnet Lock off is your decision.",
		action: { kind: "use_cloudflare", label: "Use Cloudflare" },
	},
	local_port: {
		title: "Another program is using Polycarp's port",
		body: "A program on this computer already listens on the port Polycarp needs, so nothing was changed. Quit it, then check again.",
		action: { kind: "check_again", label: "Check again" },
	},
	tailscale_port: {
		title: "A Tailscale setting is using port 8443",
		body: "A setting saved in Tailscale already uses the port Funnel needs, so nothing was changed. Turn that setting off in Tailscale, then check again.",
		action: { kind: "check_again", label: "Check again" },
	},
	ready: {
		title: "Ready to turn on",
		body: "Tailscale is signed in. Turning on gives you an address to add in each assistant and a one-time connect code that approves it.",
		action: { kind: "turn_on", label: "Turn on" },
	},
	turning_on: {
		title: "Turning on",
		body: "This can take about a minute the first time.",
	},
	funnel_not_allowed: {
		title: "Allow Funnel in Tailscale",
		body: "Funnel is the Tailscale setting that lets assistants reach this computer. On Tailscale's page, press the button that enables it. This page moves on by itself once it's allowed.",
		action: { kind: "open_url", label: "Open Tailscale's page" },
		waits: true,
	},
	/** The surface's own, not the helper's: the ten-minute Funnel retry stopped, so the button checks again. */
	funnel_gave_up: {
		title: "Allow Funnel in Tailscale",
		body: "This page stopped checking after 10 minutes. Once Funnel is allowed on Tailscale's page, press Check again.",
		action: { kind: "open_funnel", label: "Check again" },
	},
	funnel_closed: {
		title: "Funnel is closed in Tailscale",
		body: "Remote access is set up, but Funnel isn't open for this computer, so assistants can't reach it.",
		action: { kind: "open_funnel", label: "Open Funnel again" },
	},
	tailscale_operator: {
		title: "Let your user control Tailscale",
		body: "Tailscale refused because your user isn't its operator. Run this command once in a terminal; Polycarp never runs sudo. This page moves on by itself.",
		action: { kind: "copy_command", label: "Copy the command" },
		waits: true,
	},
	/**
	 * The surface's own: the operator refusal when nothing checks for it by itself (the Funnel retry stopped, or nothing is saved
	 * yet to retry), so the button checks again.
	 */
	tailscale_operator_check: {
		title: "Let your user control Tailscale",
		body: "Tailscale refused because your user isn't its operator. Run this command once in a terminal; Polycarp never runs sudo. Then press Check again.",
		action: { kind: "open_funnel", label: "Check again" },
	},
	launcher: {
		title: "Finish installing Polycarp",
		body: "Polycarp's launcher isn't set up on this computer, so the background service would have nothing to start. Run this command once in a terminal, then try again.",
		action: { kind: "copy_command", label: "Copy the command" },
	},
	launcher_app: {
		title: "Connect a browser first",
		body: "Polycarp needs a browser connected before an assistant can use it. Use Connect in the Browsers section above, then press Check again.",
		action: { kind: "check_again", label: "Check again" },
	},
	hub: {
		title: "This computer is a hub",
		body: "It already has the one public address an install can have, for your devices. Add the hub's address in assistants, or turn the hub off first.",
		action: { kind: "check_again", label: "Check again" },
	},
	service: {
		title: "The background service didn't start",
		body: "Polycarp couldn't start the service that keeps the connector running. Your settings are kept. Details has the reason.",
		action: { kind: "try_again", label: "Try again" },
	},
	serve: {
		title: "The connector didn't answer on this computer",
		body: "The service started, but nothing answered on Polycarp's local port, so nothing was opened to the internet. Details has the reason.",
		action: { kind: "try_again", label: "Try again" },
	},
	funnel: {
		title: "Tailscale couldn't open Funnel",
		body: "Tailscale refused to open Funnel. Its own words are under Details. Fix that, then try again.",
		action: { kind: "try_again", label: "Try again" },
	},
	config: {
		title: "A settings file couldn't be saved",
		body: "Polycarp couldn't read or write its connector settings. Details names the file. Fix it, then try again.",
		action: { kind: "try_again", label: "Try again" },
	},
	dns: {
		title: "The new address is still spreading",
		body: "A new address takes a few minutes to reach public DNS. This page checks again by itself.",
		action: { kind: "check_again", label: "Check now" },
		waits: true,
	},
	cloudflared_missing: {
		title: "Get cloudflared",
		body: "cloudflared is Cloudflare's free program for tunnels. Polycarp can download Cloudflare's own release and check its fingerprint before using it.",
		action: { kind: "download", label: "Get it for me" },
	},
	cloudflared_manual: {
		title: "Get cloudflared",
		body: "cloudflared is Cloudflare's free program for tunnels. Install it from Cloudflare's page; this page moves on by itself.",
		action: { kind: "open_url", label: "Open the download page" },
		waits: true,
	},
	cloudflare_login: {
		title: "Sign in to Cloudflare",
		body: "Your browser opens Cloudflare. Sign in and pick the domain for this computer's address. This page moves on by itself.",
		action: { kind: "sign_in_cloudflare", label: "Sign in to Cloudflare" },
		waits: true,
	},
	cloudflare_name: {
		title: "Pick this computer's address",
		body: "Any name on a domain in your Cloudflare account, like polycarp.yourdomain.com. Polycarp makes the tunnel and its DNS record there.",
		action: { kind: "turn_on", label: "Turn on" },
	},
	cloudflare_name_refused: {
		title: "Pick another name",
		body: "Cloudflare can't use that name for a new tunnel: it's taken, or it isn't a valid name. Polycarp never replaces a record.",
		action: { kind: "turn_on", label: "Turn on" },
	},
	cloudflare_dns: {
		title: "Cloudflare couldn't make the DNS record",
		body: "The tunnel is ready, but its DNS record wasn't made. Details has Cloudflare's words.",
		action: { kind: "try_again", label: "Try again" },
	},
	cloudflare_zone: {
		title: "That domain isn't on your Cloudflare account",
		body: "The name must be on the domain you signed in for. Pick a name on that domain, or sign in again for another one.",
		action: { kind: "turn_on", label: "Turn on" },
	},
	cloudflare_tunnel: {
		title: "Cloudflare couldn't make the tunnel",
		body: "Details has Cloudflare's words. Fix that, then try again.",
		action: { kind: "try_again", label: "Try again" },
	},
	connect_code: {
		title: "On, but no connect code yet",
		body: "The connector is set up, but the one-time connect code couldn't be made. Make a new code before you add an assistant.",
		action: { kind: "new_code", label: "New code" },
	},
	check_failed: {
		title: "On, but a check from the internet failed",
		body: "The connector answers, but an assistant may not be able to use it. The failed check says why.",
		action: { kind: "repair", label: "Repair" },
	},
	/** The result while a pending check waits: a new name not published yet, or a tunnel still connecting. */
	on_waiting: {
		title: "On: the address is still being published",
		body: "A new address takes a few minutes to reach the internet. This page checks again by itself; add the assistant once it passes.",
	},
	on: {
		title: "On: add Polycarp to an assistant",
		body: "Assistants you approve can use this browser. Only approve a connection you just started.",
	},
	no_browser_connected: {
		title: "On, but no browser is connected",
		body: "Open your browser with Polycarp's extension, and assistants can use it.",
	},
	not_set_up: {
		title: "Nothing is set up yet",
		body: "Choose how assistants reach this computer.",
		action: { kind: "choose", label: "Choose a way" },
	},
	unknown: {
		title: "Setup stopped",
		action: { kind: "try_again", label: "Try again" },
	},
} as const satisfies Record<string, RemoteStepCopy>;

export type RemoteCopyKey = keyof typeof STEP_COPY;

/** The outside checks `remote test` runs, by name, as a person reads them. */
export const CHECK_LABELS: Record<string, string> = {
	dns: "Public DNS",
	tls: "Certificate",
	resource_metadata: "Connector address",
	auth_metadata: "Sign-in settings",
	auth_challenge: "Sign-in challenge",
	streaming: "Streaming",
};

/** Proof check names: a `problem` whose code is one of these failed a check from outside. */
export const CHECK_CODES: readonly string[] = Object.keys(CHECK_LABELS);

/**
 * The entry for one helper answer. `state` and `code` are the helper's; `nextKind` and `nextCommand` come from its `next`.
 * Unknown means the helper said something this table doesn't know: show its message.
 */
export function copyKey(answer: {
	state: string;
	code?: string;
	next?: { kind?: string; command?: string };
}): RemoteCopyKey {
	const { state, code } = answer;
	const next = answer.next?.kind;
	switch (state) {
		case "tailscale_missing":
		case "tailscale_signed_out":
		case "tailnet_lock":
		case "ready":
		case "funnel_not_allowed":
		case "funnel_closed":
		case "on":
		case "no_browser_connected":
		// Not the helper's: the surface's own while Turn on runs.
		case "turning_on":
			return state;
		case "cloudflared_missing":
			return answer.next?.command ? "cloudflared_missing" : "cloudflared_manual";
		case "port_busy":
			return code === "tailscale_port" ? "tailscale_port" : "local_port";
		case "problem": {
			if (code === "cloudflare_name") return "cloudflare_name";
			if (code === "cloudflare_dns") return next === "choose_name" ? "cloudflare_name_refused" : "cloudflare_dns";
			if (code === "not_set_up") return "not_set_up";
			// A new name not published yet is its own calm step that checks again, never a failed check with Repair.
			if (code === "dns") return "dns";
			if (code && CHECK_CODES.includes(code)) return "check_failed";
			if (code && code in STEP_COPY && PROBLEM_CODES.includes(code)) return code as RemoteCopyKey;
			return "unknown";
		}
		default:
			return "unknown";
	}
}

/** One outside check as both surfaces read it: `pending` marks a failure that waiting fixes. */
export interface CheckLike {
	name?: string;
	status: string;
	pending?: boolean;
}

/** The failures waiting won't fix. These, and only these, are "failed" and can offer Repair. */
export function realFailures<T extends CheckLike>(checks: readonly T[] | undefined): T[] {
	return (checks ?? []).filter((c) => c.status === "fail" && c.pending !== true);
}

/** Something failed, and every failure is one that waiting fixes: the screen says it is waiting and checks again by itself. */
export function waitingChecks(checks: readonly CheckLike[] | undefined): boolean {
	const failed = (checks ?? []).filter((c) => c.status === "fail");
	return failed.length > 0 && failed.every((c) => c.pending === true);
}

/**
 * The helper says the next step is `remote fix` (setup's deadline passed with a check still pending): waiting is over, and the
 * answer is a failure that offers Repair, never "still being published" (second-N2).
 */
export function needsRepair(answer: { next?: { kind?: string; command?: string } }): boolean {
	return answer.next?.kind === "run_command" && /(^|\s)remote fix(\s|$)/.test(answer.next.command ?? "");
}

/**
 * The route is on, as a person should read it: the helper says on, or it saved an address and the only failures are ones that
 * waiting fixes (setup's own rule), or an older helper's bare `dns` code with the address. The host mints a pressed Turn on's
 * code by this too.
 */
export function answerOn(answer: {
	state: string;
	code?: string;
	connectorUrl?: string;
	next?: { kind?: string; command?: string };
	checks?: readonly CheckLike[];
}): boolean {
	if (answer.state === "on" || answer.state === "no_browser_connected") return true;
	if (answer.state !== "problem" || !answer.connectorUrl || needsRepair(answer)) return false;
	return answer.checks?.length ? waitingChecks(answer.checks) : answer.code === "dns";
}

/** The `problem` codes that have an entry of their own. */
export const PROBLEM_CODES: readonly string[] = [
	"tailscale_operator",
	"launcher",
	"hub",
	"service",
	"serve",
	"funnel",
	"config",
	"dns",
	"cloudflare_login",
	"cloudflare_zone",
	"cloudflare_tunnel",
	"connect_code",
];

/** The sentence and button for one helper answer: the entry, or for `unknown` the helper's message as the body. */
export function stepCopy(answer: {
	state: string;
	code?: string;
	message?: string;
	next?: { kind?: string; command?: string };
}): RemoteStepCopy & { key: RemoteCopyKey } {
	const key = copyKey(answer);
	const entry: RemoteStepCopy = STEP_COPY[key];
	if (key !== "unknown") return { key, ...entry };
	return { key, ...entry, body: answer.message?.trim() || "The helper stopped without saying why." };
}

/**
 * What to type into each assistant. The same lines `remote setup` prints after "Add it to an assistant (paste the connector
 * URL):" (cli/src/remote-setup.ts); test/remote-copy.test.mjs fails if either side changes alone.
 */
export const ASSISTANT_STEPS = [
	{ id: "claude", name: "claude.ai", where: "Settings > Connectors > Add custom connector." },
	{
		id: "chatgpt",
		name: "ChatGPT",
		where: "Settings > Apps & Connectors (turn on developer mode) > Create. Choose OAuth.",
	},
	{ id: "grok", name: "grok.com", where: "grok.com/connectors > New Connector > Custom." },
] as const;

/** The line `remote setup` prints after the three assistants. */
export const APPROVAL_STEP =
	"Each opens Polycarp's approval page: check the name, tick what it may do, type the connect code and press Allow.";

/** The result screen, in the order a person acts. */
export const RESULT_COPY = {
	assistantsStep: "1. In your assistant, add a custom connector",
	addressStep: "2. Paste this address",
	codeStep: "3. On Polycarp's approval page, type this code",
	addressLabel: "Connector URL",
	codeLabel: "Connect code",
	expiresIn: "Expires in",
	expired: "Expired. Make a new code.",
	newCode: "New code",
	codeNote: "It works once, for 10 minutes. Each new assistant needs its own code.",
	passcodeLabel: "Passcode, for re-approving",
	passcodeNote:
		"Shown once. Use it when an assistant you already approved asks again. Keep it in a password manager, but not one the browser Polycarp drives can fill.",
	noPasscode: "No passcode was made here. To approve an assistant again later, make a new connect code.",
	codeNone: "Press New code to make the code for your assistant.",
	checksWaiting: "Waiting for the address to answer.",
	checksTitle: "Checked from the internet",
	checksPassed: "Every check passed.",
	checksRunning: "Checking from the internet...",
	checksNone: "Not checked yet.",
	checkAgain: "Check again",
	repair: "Repair",
	repairing: "Repairing...",
	turnOff: "Turn off",
	copy: "Copy",
	copied: "Copied.",
} as const;

/**
 * RESULT_COPY entries the side panel never draws: the Mac app shows the passcode once (the panel never sees one, D33) and has a
 * Turn off button. Kept here so both surfaces read one table (first-F4).
 */
export const MAC_ONLY_RESULT = [
	"passcodeLabel",
	"passcodeNote",
	"turnOff",
] as const satisfies readonly (keyof typeof RESULT_COPY)[];

/** "1 check failed", "2 checks failed". */
export function checksFailed(n: number): string {
	return `${n} check${n === 1 ? "" : "s"} failed.`;
}
