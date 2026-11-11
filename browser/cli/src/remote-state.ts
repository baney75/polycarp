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
 * terminal (the person runs it: Polycarp never runs sudo; a `<name>` in it is theirs to fill in, so an app shows it rather
 * than running it). choose_name: pick another Cloudflare hostname. add_connector: setup is
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
	 * "cloudflare_tunnel", "cloudflare_dns" (that name is taken, with next choose_name; without next, cloudflared couldn't make the
	 * record), "cloudflare_zone" (the sign-in covers another domain), "connect_code" (set up, but --connect-code's code couldn't be made); on status also
	 * "dns" (public DNS doesn't answer for the address yet; Tailscale takes minutes to publish a new one). After remote.json is saved,
	 * setup's outside proof can also fail with the name of the check that failed: "dns", "tls", "resource_metadata",
	 * "auth_metadata", "auth_challenge", "streaming" or "probe_cleanup" (the probe's token couldn't be deleted; it expires on its
	 * own); `checks` has that check's next action, and `connectorUrl` the saved address. port_busy:
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
	/** Why the connect code `--connect-code` asked for couldn't be made (with state problem, code "connect_code"). The route is saved. */
	connectCodeProblem?: string;
	/** What the person does next. Present on `on` (add_connector) and on every refusal a person can clear. */
	next?: RemoteNext;
	/** `remote test`'s checks, run at the end of setup: what an assistant sees from outside. `code` names the one that failed. */
	checks?: ProofLine[];
}

/** One check of `remote test` (and the end of setup): its name, ok, warn or fail, what it found, and on a failure what to do. */
export interface ProofLine {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
	next?: string;
	/** On a failure: true when it is what a new name looks like for its first few minutes, so waiting is the fix. */
	pending?: boolean;
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
 * The DNS zone a name sits in and what its SOA says about Cloudflare, from a DNS-over-HTTPS JSON answer for `type=SOA`. The SOA is
 * in Answer for a zone apex and in Authority for any name below one (also for a name that doesn't exist yet). `onCloudflare` is
 * true only when the SOA itself shows Cloudflare: its primary is one of Cloudflare's nameservers (`<x>.ns.cloudflare.com`, or
 * Foundation DNS's `foundationdns.com/.net/.org`), or its mailbox is Cloudflare's `dns.cloudflare.com`, which Cloudflare writes
 * for zones on custom nameservers too. False means only "not shown here"; `primary` lets the caller look further.
 * Undefined when there is no SOA to read.
 */
export function zoneFromSoa(answer: unknown): { zone: string; onCloudflare: boolean; primary: string } | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const { Answer, Authority } = answer as { Answer?: unknown; Authority?: unknown };
	const records = [...(Array.isArray(Answer) ? Answer : []), ...(Array.isArray(Authority) ? Authority : [])] as { name?: unknown; type?: unknown; data?: unknown }[];
	const soa = records.find((r) => r && r.type === 6 && typeof r.name === "string" && typeof r.data === "string");
	if (!soa) return undefined;
	const zone = String(soa.name).replace(/\.$/, "").toLowerCase();
	const [primary = "", mailbox = ""] = String(soa.data).trim().toLowerCase().split(/\s+/).map((x) => x.replace(/\.$/, ""));
	const onCloudflare = /\.ns\.cloudflare\.com$/.test(primary) || /\.foundationdns\.(com|net|org)$/.test(primary) || mailbox === "dns.cloudflare.com";
	return { zone, onCloudflare, primary };
}

/**
 * Cloudflare's published IPv4 ranges (cloudflare.com/ips-v4). Its nameservers, custom nameservers included, answer from these, so
 * a zone whose primary nameserver has an address here is on Cloudflare whatever the nameserver is called.
 */
const CLOUDFLARE_V4 = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];

const v4 = (address: string): number | undefined => {
	const parts = address.split(".");
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
	return parts.reduce((n, p) => n * 256 + Number(p), 0);
};

/** Is this IPv4 address in one of Cloudflare's ranges? */
export function cloudflareAddress(address: string): boolean {
	const n = v4(address);
	if (n === undefined) return false;
	return CLOUDFLARE_V4.some((range) => {
		const [base, bits] = range.split("/");
		const size = 2 ** (32 - Number(bits));
		const start = v4(base) ?? -1;
		return n >= start && n < start + size;
	});
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

/** Where serve answers the protected-resource metadata (RFC 9728) for its /mcp endpoint. */
export const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";

/** 100.64.0.0/10: the address range Tailscale hands out. */
export function inTailnetRange(address: string): boolean {
	const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
	return Boolean(m) && Number(m?.[1]) >= 64 && Number(m?.[1]) <= 127;
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
