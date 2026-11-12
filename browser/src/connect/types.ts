/**
 * What the side panel and the native host say to each other about Connect: the methods, the
 * shapes of their answers. Types and constants only, so the extension and the CLI both import it.
 * No answer ever carries a secret, a token hash or the passcode.
 */

export type ConnectRoute = "none" | "remote" | "hub" | "link";

/** What a "remote" route runs on: Tailscale Funnel, the person's own front door, or a Cloudflare tunnel. */
export type RemoteKind = "funnel" | "custom" | "cloudflare";

/** The five steps of "Set up with Cloudflare", in order. */
export const TUNNEL_STEPS = ["cloudflared", "signin", "route", "tunnel", "check"] as const;
export type TunnelStepId = (typeof TUNNEL_STEPS)[number];
export type TunnelStepState = "running" | "waiting" | "done" | "failed";

export interface ConnectDevice {
	name: string;
	online: boolean;
	extensionConnected: boolean;
	sessions: number;
	busy: boolean;
	/** ISO time, or null when the hub never saw it. */
	lastSeen: string | null;
}

export interface ConnectStatus {
	route: ConnectRoute;
	/** The public origin (remote and hub routes). The connector URL is this plus /mcp. */
	publicUrl?: string;
	/** Which kind of remote route is in use. Present when the route is "remote". */
	remoteKind?: RemoteKind;
	passcodeSet: boolean;
	/** This device's link to a hub; present whenever link.json loads, whatever the route is (a hub box can link to itself). */
	link?: { hubUrl: string; name: string; online: boolean; busy: boolean; manage: boolean };
	hub?: { devices: ConnectDevice[] };
	theme: { preset: string; accent?: string; mode?: "light" | "dark" };
	/** The Polycarp theme in force (Polycarp's section of theme.json), checked by the helper; the panel checks it again with parsePolycarpTheme. Absent when there is none. */
	polycarp?: Record<string, unknown>;
	/** Why a Polycarp theme file is there but not in use: one line. Absent when it is in force or there is no file. */
	polycarpRefused?: string;
	/** What joining a hub would let the hub's owner do here (the scopes a new link allows). Present when the route is none. */
	joinScopes?: JoinScope[];
	/** A config file that is present but unreadable, in a sentence; the route reads as none until it is fixed. */
	problem?: string;
}

/** A scope a new link allows, with the sentence that says what it lets the hub's owner do. */
export interface JoinScope {
	id: string;
	what: string;
}

export interface ApprovalCode {
	code: string;
	/** ms since the epoch. */
	expiresAt: number;
	connectorUrl: string;
}

export interface DeviceCode {
	code: string;
	expiresAt: number;
	hubUrl: string;
}

export interface JoinResult {
	name: string;
	manage: boolean;
	/** What the hub's owner may do through this device: the scopes the link allows. */
	scopes: string[];
}

/** Methods the side panel may call. Everything else is refused in the background worker and again in the host. */
export const CONNECT_METHODS = [
	"status",
	"approvalCode",
	"deviceCode",
	"setBusy",
	"joinHub",
	"setupTunnel",
	"setTheme",
	"remoteState",
	"remoteSetup",
	"remoteFunnel",
	"remoteTest",
	"remoteFixPlan",
	"remoteFix",
] as const;
export type ConnectMethod = (typeof CONNECT_METHODS)[number];

export const CONNECT_PORT = "tabkyra-connect";

/** side panel -> background */
export interface ConnectRequest {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	/** A single-use, short-lived token the panel mints while it has user activation; the relay requires it for the methods in GESTURE_METHODS and strips it before the host. It guards against accidental or scripted calls from the panel itself; the worker cannot verify a click. */
	gesture?: Gesture;
}

/** Minted by the panel while it has user activation: a one-use token and the time it was minted. Sender-supplied, so not proof of a click. */
export interface Gesture {
	token: string;
	at: number;
}

/** Methods that hand out a code, give a hub control of this browser, or open a public tunnel: they need a gesture token. */
export const GESTURE_METHODS: readonly string[] = [
	"approvalCode",
	"deviceCode",
	"joinHub",
	"setupTunnel",
	"remoteSetup",
	"remoteFix",
];

/** How long a gesture token is good for. */
export const GESTURE_MS = 5_000;

/** background -> side panel */
export interface ConnectReply {
	id: number;
	result?: unknown;
	error?: { code: string; message: string };
	progress?: Record<string, unknown>;
}

/** Codes minted per window; the host refuses more (10 per 10 minutes). */
export const CODE_LIMIT = 10;
export const CODE_WINDOW_MS = 10 * 60_000;

/**
 * What the helper says about remote access, as the panel reads it: the same `state`, `code` and `next` as
 * `remote setup --json` and `remote status --json` (docs/remote.md, "For an app"), checked field by field in the host.
 * Never a passcode (D33). `connectCode` is there once, in the answer of the run that turned remote access on.
 */
export interface RemoteNextView {
	kind: "install" | "sign_in" | "open_page" | "run_command" | "choose_name" | "add_connector";
	url?: string;
	command?: string;
}

export interface RemoteCheckView {
	name: string;
	status: "ok" | "warn" | "fail";
	detail: string;
	next?: string;
	/** On a failure: waiting fixes it (a new name not published yet, a tunnel still connecting). Shown as waiting, never as Repair. */
	pending?: boolean;
}

export interface RemoteRoutesView {
	tailscale: { installed: boolean; signedIn: boolean };
	cloudflare: { installed: boolean; signedIn: boolean };
}

export interface RemoteAnswer {
	state: string;
	code?: string;
	message: string;
	next?: RemoteNextView;
	routes?: RemoteRoutesView;
	/** The route remote.json is on, when it exists. */
	route?: "funnel" | "cloudflare" | "custom";
	connectorUrl?: string;
	passcodeSet?: boolean;
	checks?: RemoteCheckView[];
	connectCode?: string;
	connectCodeExpiresAt?: number;
	/** Why the connect code this run should have made wasn't made. */
	connectCodeProblem?: string;
}

/** `remote fix --dry-run --json` (or the real run) as the panel reads it. `available` is false when the helper has no `remote fix`. */
export interface RemoteFixAnswer {
	available: boolean;
	ok?: boolean;
	state?: string;
	code?: string;
	message?: string;
	/** What it would do, or did: `{kind, what, status}`. */
	actions?: { kind: string; what: string; status: string }[];
	checks?: RemoteCheckView[];
}

/** What "Set up with Cloudflare" answers when it finishes. */
export interface TunnelResult {
	publicUrl: string;
	connectorUrl: string;
	connectCode?: string;
	connectCodeExpiresAt?: number;
	connectCodeProblem?: string;
	checks?: RemoteCheckView[];
	passcodeSet?: boolean;
}
