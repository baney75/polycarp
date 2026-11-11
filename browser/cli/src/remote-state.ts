/**
 * The structured answer `remote setup --json` and `remote status --json` give an app, so it never has to
 * read sentences to know where a person is. Pure types and helpers with no imports; the commands stay in remote-setup.ts.
 */

/**
 * Where setting up remote access stands.
 * - tailscale_missing / tailscale_signed_out: Tailscale isn't installed, or isn't signed in (or isn't running).
 * - funnel_not_allowed: Tailscale refused Funnel for this tailnet or computer; `adminUrl` is the page it printed.
 * - funnel_closed: set up, but Tailscale's Funnel isn't open for the saved address (status only; running setup again opens it).
 * - cloudflared_missing: remote.json is on the Cloudflare route and cloudflared is gone.
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
	| "cloudflared_missing"
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
	"cloudflared_missing",
	"tailnet_lock",
	"port_busy",
	"ready",
	"on",
	"no_browser_connected",
	"problem",
];

/** Which ways of reaching this computer are installed and signed in, for an app that offers the choice. */
export interface RemoteRoutes {
	tailscale: { installed: boolean; signedIn: boolean };
	cloudflare: { installed: boolean; signedIn: boolean };
}

/**
 * The one thing a person does next, so an app can render it without reading `message`. install: get a program (`url` is its
 * download page, `command` the setup run that gets it for you, when there is one). sign_in: sign in to Tailscale or Cloudflare
 * (`command` does it). open_page: open `url` and allow something there (Tailscale's Funnel page). run_command: run `command` in a
 * terminal (the person runs it: Polycarp never runs sudo). choose_name: pick another Cloudflare hostname. add_connector: setup is
 * done; paste `url` into an assistant.
 */
export interface RemoteNext {
	kind: "install" | "sign_in" | "open_page" | "run_command" | "choose_name" | "add_connector";
	url?: string;
	command?: string;
}

/** Exit codes of `remote setup`: 0 on, 1 failed, 2 usage (UsageError), 3 waits on a person (a `next` that isn't add_connector). */
export const EXIT_ON = 0;
export const EXIT_FAILED = 1;
export const EXIT_NEEDS_PERSON = 3;

export function setupExitCode(report: { ok: boolean; next?: RemoteNext }): number {
	if (report.ok) return EXIT_ON;
	return report.next && report.next.kind !== "add_connector" ? EXIT_NEEDS_PERSON : EXIT_FAILED;
}

/** What `remote setup --json` prints (one object on stdout). `passcode` is present only when this run made it. */
export interface SetupReport {
	ok: boolean;
	state: RemoteState;
	message: string;
	adminUrl?: string;
	/**
	 * Why a `problem` or `port_busy` happened, when an app has something specific to say. problem: "launcher" (no working launcher yet:
	 * connect a browser first), "hub", "service", "serve" (nothing answers on the local port), "funnel", "config", "cloudflare_login",
	 * "cloudflare_tunnel", "cloudflare_dns" (that name is taken), "cloudflare_zone" (the sign-in covers another domain); on status also
	 * "dns" (public DNS doesn't answer for the address yet; Tailscale takes minutes to publish a new one). port_busy:
	 * "tailscale_port" (a Tailscale setting already uses 8443) or "local_port" (a program here uses the local port).
	 */
	code?: string;
	connectorUrl?: string;
	passcode?: string;
	/** True when a passcode exists after this run, whether or not this run made it. */
	passcodeSet?: boolean;
	/** A one-time connect code (TK-XXXX-XXXX) that approves a new assistant, minted only on success with `--connect-code`. */
	connectCode?: string;
	/** When `connectCode` stops working, in milliseconds since 1970 (ten minutes after it was made). */
	connectCodeExpiresAt?: number;
	/** What the person does next. Present on `on` (add_connector) and on every refusal a person can clear. */
	next?: RemoteNext;
}

/** Tailscale's download page for this platform. */
export function tailscaleDownloadUrl(platform: string = process.platform): string {
	return `https://tailscale.com/download/${platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux"}`;
}

export const CLOUDFLARED_DOWNLOAD_URL = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

/** The fix Tailscale itself prints for a non-root user it refuses (cmd/tailscale/cli/cli.go). Polycarp shows it and never runs it. */
export const TAILSCALE_OPERATOR_FIX = "sudo tailscale set --operator=$USER";

/**
 * Tailscale refused a change because this user isn't root or its operator. Its CLI wraps the local API's 403 as
 * "Access denied: <what>" (client/local/local.go, AccessDeniedError) and, off Windows and not as root, adds
 * "To not require root, use 'sudo tailscale set --operator=$USER' once." (cmd/tailscale/cli/cli.go). Either line counts.
 */
export function tailscaleAccessDenied(output: string): boolean {
	return /^Access denied: /m.test(output) || /tailscale set --operator=/.test(output);
}

/** `loginctl show-user <user> -p Linger` prints `Linger=yes` or `Linger=no`. Undefined when the answer isn't one of those. */
export function lingerFromLoginctl(output: string): boolean | undefined {
	const m = /^Linger=(yes|no)\s*$/m.exec(output);
	return m ? m[1] === "yes" : undefined;
}

/** The operator in `tailscale debug prefs` (JSON with OperatorUser, ipn/prefs.go): "" when none is set, undefined when unreadable. */
export function operatorFromPrefs(output: string): string | undefined {
	try {
		const prefs = JSON.parse(output) as { OperatorUser?: unknown };
		if (!prefs || typeof prefs !== "object") return undefined;
		return typeof prefs.OperatorUser === "string" ? prefs.OperatorUser : "";
	} catch {
		return undefined;
	}
}

/**
 * The DNS zone a name sits in and whether Cloudflare serves it, from a DNS-over-HTTPS JSON answer for `type=SOA`. The SOA is in
 * Answer for a zone apex and in Authority for any name below one (also for a name that doesn't exist yet). A zone on Cloudflare
 * names one of its nameservers, `<x>.ns.cloudflare.com`, first in its SOA. Undefined when there is no SOA to read.
 */
export function zoneFromSoa(answer: unknown): { zone: string; onCloudflare: boolean } | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const { Answer, Authority } = answer as { Answer?: unknown; Authority?: unknown };
	const records = [...(Array.isArray(Answer) ? Answer : []), ...(Array.isArray(Authority) ? Authority : [])] as { name?: unknown; type?: unknown; data?: unknown }[];
	const soa = records.find((r) => r && r.type === 6 && typeof r.name === "string" && typeof r.data === "string");
	if (!soa) return undefined;
	const zone = String(soa.name).replace(/\.$/, "").toLowerCase();
	const primary = String(soa.data).trim().split(/\s+/)[0] ?? "";
	return { zone, onCloudflare: /\.ns\.cloudflare\.com\.?$/i.test(primary) };
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
