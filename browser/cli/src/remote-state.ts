/**
 * The structured answer `remote setup --json` and `remote status --json` give an app, so it never has to
 * read sentences to know where a person is. Pure types and helpers with no imports; the commands stay in remote-setup.ts.
 */

/**
 * Where setting up remote access stands.
 * - tailscale_missing / tailscale_signed_out: Tailscale isn't installed, or isn't signed in (or isn't running).
 * - funnel_not_allowed: Tailscale refused Funnel for this tailnet or computer; `adminUrl` is the page it printed.
 * - funnel_closed: set up, but Tailscale's Funnel isn't open for the saved address (status only; running setup again opens it).
 * - tailnet_lock: the tailnet has Tailnet Lock, and Funnel doesn't work on one.
 * - port_busy: something else uses the local port or Funnel's port 8443, so nothing was changed.
 * - ready: nothing is set up yet and nothing stands in the way.
 * - on: set up, answering here and reachable from the internet.
 * - no_browser_connected: set up and reachable, but no browser has the extension loaded, so an assistant would find nothing to drive.
 * - problem: anything else; `message` says what and `checks` (status only) says which.
 */
export type RemoteState =
	| "tailscale_missing"
	| "tailscale_signed_out"
	| "funnel_not_allowed"
	| "funnel_closed"
	| "tailnet_lock"
	| "port_busy"
	| "ready"
	| "on"
	| "no_browser_connected"
	| "problem";

export const REMOTE_STATES: readonly RemoteState[] = [
	"tailscale_missing",
	"tailscale_signed_out",
	"funnel_not_allowed",
	"funnel_closed",
	"tailnet_lock",
	"port_busy",
	"ready",
	"on",
	"no_browser_connected",
	"problem",
];

/** What `remote setup --json` prints (one object on stdout). `passcode` is present only when this run made it. */
export interface SetupReport {
	ok: boolean;
	state: RemoteState;
	message: string;
	adminUrl?: string;
	/**
	 * Why a `problem` or `port_busy` happened, when an app has something specific to say. problem: "launcher" (no working launcher yet:
	 * connect a browser first), "hub", "service", "serve" (nothing answers on the local port), "funnel", "config"; on status also
	 * "dns" (public DNS doesn't answer for the address yet; Tailscale takes minutes to publish a new one). port_busy:
	 * "tailscale_port" (a Tailscale setting already uses 8443) or "local_port" (a program here uses the local port).
	 */
	code?: string;
	connectorUrl?: string;
	passcode?: string;
	/** True when a passcode exists after this run, whether or not this run made it. */
	passcodeSet?: boolean;
}

/**
 * The page Tailscale prints when Funnel isn't enabled yet (tailscale funnel: enableFeatureInteractive in
 * tailscale/cli/serve_legacy.go), or undefined. Only a login.tailscale.com address counts: a docs link such as
 * tailscale.com/s/https comes from a different failure. Trailing punctuation from a sentence is dropped.
 */
export function funnelAdminUrl(output: string): string | undefined {
	const match = /https:\/\/login\.tailscale\.com\/[^\s"'<>]*/.exec(output);
	return match?.[0].replace(/[.,;:)\]]+$/, "");
}

/** The enablement page, but only once something follows it (a space, a newline or a quote), so a chunk that stops mid-address never counts. */
export function completeFunnelAdminUrl(output: string): string | undefined {
	return /https:\/\/login\.tailscale\.com\/[^\s"'<>]*[\s"'<>]/.test(output) ? funnelAdminUrl(output) : undefined;
}

export function printReport(report: object): void {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

export interface StatusCheck {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
}

/**
 * One state for `remote status --json`. Without remote.json the answer is the read-only preflight (`preflight`:
 * ready, or what stands in the way). With it, a failed check is a problem, a working connection with no browser
 * attached is no_browser_connected, and the rest is on. `extensionConnected` is undefined when nobody asked.
 * `tailscale` is what stands in the way of Tailscale itself (missing, signed out, Tailnet Lock, or Funnel closed) when remote.json is on the Funnel
 * route; it comes ahead of everything else, because nothing else can work without Tailscale.
 */
export function stateFromStatus(input: {
	configured: boolean;
	checks: StatusCheck[];
	extensionConnected?: boolean;
	preflight?: { state: RemoteState; message: string; code?: string };
	tailscale?: { state: RemoteState; message: string };
}): { state: RemoteState; message: string; code?: string } {
	const failed = input.checks.find((x) => x.status === "fail");
	if (!input.configured) {
		if (failed && failed.name === "remote.json" && !/not found/.test(failed.detail)) return { state: "problem", message: failed.detail };
		return input.preflight ?? { state: "ready", message: "Nothing is set up yet." };
	}
	if (input.tailscale) return input.tailscale;
	if (failed) {
		// Public DNS (and so the public fetch) lags a fresh Funnel by minutes: code "dns" lets an app treat that, and only that, as still pending.
		const failures = input.checks.filter((x) => x.status === "fail");
		const dnsOnly = failures.some((x) => x.name === "public DNS") && failures.every((x) => x.name === "public DNS" || x.name === "public fetch");
		return { state: "problem", message: `${failed.name}: ${failed.detail}`, ...(dnsOnly ? { code: "dns" } : {}) };
	}
	if (input.extensionConnected === false) return { state: "no_browser_connected", message: "Remote access is on, but no browser has Polycarp's extension connected." };
	return { state: "on", message: "Remote access is on." };
}
