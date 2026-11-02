/**
 * Wire protocol of the tabkyra bridge. Shared by the extension (src/bridge) and
 * the CLI (cli/src), which imports this file directly.
 *
 *   harness ── stdio MCP ── `tabkyra mcp` ── unix socket ── native host ── native messaging ── extension
 *
 * Both socket legs carry `[uint32 LE length][UTF-8 JSON]` frames. The native host
 * copies frames between the two and only adds/strips `clientId`.
 */

import type { BuildInfo } from "../update/build.js";
import type { ExtensionLocation, Mismatch, UpdateAction, UpdatePolicy } from "../update/logic.js";

export const NATIVE_HOST_NAME = "ai.tabkyra.bridge";
export const PROTOCOL_VERSION = 1;

/** Native messaging caps host->extension frames at 1 MiB; leave headroom. */
export const MAX_FRAME_TO_EXTENSION = 900 * 1024;
/** Extension->host frames may be up to 64 MiB; screenshots live here. */
export const MAX_FRAME_FROM_EXTENSION = 60 * 1024 * 1024;

export interface ClientHello {
	type: "hello";
	client: {
		/** Harness name, shown as the tab group label ("omp", "claude", ...). */
		name: string;
		/** Stable per-conversation id so a reconnect re-adopts its tabs. */
		session?: string;
		/**
		 * True when `session` is the CLI's default (project plus harness), not one the user named:
		 * a second live client with the same default gets its own session ("-2") instead of sharing.
		 */
		auto?: boolean;
		/**
		 * True when the user chose `session` (--session, TABKYRA_SESSION, or a rename): only then
		 * does it go in the group title. Ids from older CLIs and remote sessions never do.
		 */
		named?: boolean;
		/** The project the agent works in (its git root or folder name), for the group title. */
		project?: string;
		version?: string;
	};
}

export interface ClientRequest {
	type: "request";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export type ClientToHost = ClientHello | ClientRequest;

export interface RpcError {
	code: string;
	message: string;
	/**
	 * Set by the extension on an `interrupted` it worded itself (the debugger detached, the page
	 * navigated under the call): the connection is fine, so the client passes it on as it is
	 * instead of treating it as a dropped bridge.
	 */
	source?: "extension";
}

export interface HostWelcome {
	type: "welcome";
	clientId: string;
	hostVersion: string;
	extensionConnected: boolean;
	/** The browser profile behind this host, once its extension has said hello. */
	browserId?: string;
}

export interface HostResponse {
	type: "response";
	id: number;
	result?: unknown;
	error?: RpcError;
}

export interface HostEvent {
	type: "event";
	event: string;
	data: Record<string, unknown>;
}

export interface HostExtensionStatus {
	type: "extension_status";
	connected: boolean;
	browserId?: string;
}

export type HostToClient = HostWelcome | HostResponse | HostEvent | HostExtensionStatus;

// ---- host <-> extension ---------------------------------------------------

export interface ExtHello {
	type: "hello";
	version: string;
	protocol: number;
	methods: string[];
	/** The build the extension runs (compiled in). Absent from builds before the update system. */
	build?: BuildInfo;
	/** The extension folder's build-info.json as the browser serves it now (where it loads from). */
	diskBuild?: BuildInfo;
	/**
	 * A random id this browser profile keeps for good (chrome.storage.local), so a client can
	 * tell one browser from another and resend a request only to the browser it started on.
	 */
	browserId?: string;
}

/**
 * Ask the native host to check, update, roll back, re-run the install step or change the
 * updates setting. Exactly these two fields: the host refuses a frame with anything more
 * (parseUpdateRequest in src/update/logic.ts) and runs only fixed commands.
 */
export interface ExtUpdateAction {
	type: "update_action";
	action: UpdateAction;
}

export interface ExtResponse {
	type: "response";
	clientId: string;
	id: number;
	result?: unknown;
	error?: RpcError;
}

export interface ExtEvent {
	type: "event";
	/** Omitted for broadcast events. */
	clientId?: string;
	event: string;
	data: Record<string, unknown>;
}

export interface ExtPong {
	type: "pong";
}

/**
 * A change to the local thread mirror (src/threads/mirror.ts). The host checks every field
 * (cli/src/threads-mirror.ts) and writes only inside its threads folder.
 */
export interface ExtThreadsMirror {
	type: "threads_mirror";
	op: "put" | "delete" | "sync" | "clear";
	id?: string;
	md?: string;
	json?: string;
	meta?: { id: string; title: string; createdAt: string; lastModified: string; messageCount: number; model: string };
	/** op "sync": every thread that should have files; the rest are removed. */
	ids?: string[];
}

/**
 * Community skills (docs/decisions.md D27): turn them on or off, or check now. Exactly these
 * two fields; the host refuses anything more (cli/src/community-host.ts).
 */
export interface ExtCommunityAction {
	type: "community_action";
	action: "on" | "off" | "sync";
}

/**
 * A subscription sign-in request from the side panel (relayed by the background worker).
 * The host keeps every token; the extension only ever gets status and the loopback proxy's
 * address and secret (cli/src/subscriptions, docs/auth-policy.md).
 */
export interface ExtSubscription {
	type: "subscription";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export type ExtToHost =
	| ExtHello
	| ExtResponse
	| ExtEvent
	| ExtPong
	| ExtUpdateAction
	| ExtThreadsMirror
	| ExtCommunityAction
	| ExtSubscription;

export interface HostClientConnected {
	type: "client_connected";
	clientId: string;
	client: ClientHello["client"];
}

export interface HostClientDisconnected {
	type: "client_disconnected";
	clientId: string;
}

export interface HostForwardedRequest {
	type: "request";
	clientId: string;
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export interface HostPing {
	type: "ping";
}

/** How Tabkyra was installed, which decides what "update" does (docs/updates.md). */
export type InstallMode = "release" | "checkout" | "unmanaged";

/** The record of the last update, rollback or reinstall (~/.config/tabkyra/last-update.json). */
export interface LastUpdate {
	/** New for every run; the side panel remembers which one's "What's new" was dismissed. */
	id: string;
	kind: "update" | "rollback" | "reinstall";
	mode: InstallMode;
	at: number;
	from: string;
	to: string;
	/** Release notes (the GitHub release body), release mode. Plain text; never rendered as HTML. */
	notes?: string;
	/** Commits pulled in, newest first, capped; checkout mode. */
	commits?: Array<{ sha: string; subject: string }>;
	totalCommits?: number;
	/** The release page or the compare view. */
	url?: string;
	/** The extension build installed by this run: "What's new" shows once the browser runs it. */
	extensionBuild?: string;
	skills?: { refreshed: string[]; skipped: Array<{ skill: string; file: string; reason: string }>; error?: string };
}

/** A community skill in use, or the user's local copy of one, with the text in use. */
export interface HostCommunitySkill {
	name: string;
	description: string;
	version: string;
	/** "community, catalog 42" or "local override of the community skill (...)". */
	provenance: string;
	sites: string[];
	text: string;
}

/** Community skills as the native host has them: verified, synced, and the user's choice. */
export interface HostCommunityStatus {
	type: "community_status";
	enabled: boolean;
	/** The serial of the verified catalog in use. */
	serial?: number;
	lastCheck?: string;
	/** Why the last check failed or the catalog was refused. */
	error?: string;
	skills: HostCommunitySkill[];
	/** Skills the catalog pulled, newest last. */
	removed: Array<{ name: string; reason: string }>;
	/** What the last sync changed for the user (removals, kept local copies). */
	notes: string[];
}

/** What the last check found, and everything Settings > Updates shows. */
export interface HostUpdateStatus {
	type: "update_status";
	available: boolean;
	/** Release version, or "<version> (<commit>)" in a checkout. */
	current: string;
	latest?: string;
	channel: string;
	checkedAt: number;
	mode?: InstallMode;
	policy?: UpdatePolicy;
	/** When the host checks next; absent when checks are off. */
	nextCheckAt?: number;
	/** Where updates install: the checkout or ~/.local/share/tabkyra/app. */
	root?: string;
	error?: string;
	/** Why "Update now" would refuse right now (local changes, not on main, diverged, elsewhere). */
	blocked?: string;
	/** Commits waiting on origin/main (checkout mode). */
	behind?: number;
	/** The build "Update now" would replace still differs from the checkout's HEAD. */
	needsBuild?: boolean;
	canRollback?: boolean;
	rollbackTo?: string;
	/** A build or release that is built and verified and waits to be activated. */
	staged?: string;
	/** An updater is running in the host right now. */
	updating?: boolean;
	location?: ExtensionLocation;
	mismatch?: Mismatch;
	lastUpdate?: LastUpdate;
	hostBuild?: BuildInfo;
	cliBuild?: BuildInfo;
	extensionBuild?: BuildInfo;
}

export type UpdatePhase =
	| "checking"
	| "downloading"
	| "verifying"
	| "pulling"
	| "installing"
	| "building"
	| "skills"
	| "waiting"
	| "reloading"
	| "done"
	| "failed";

/** One step of an update the host runs for the extension. */
export interface HostUpdateProgress {
	type: "update_progress";
	action: UpdateAction | "reload" | "install";
	phase: UpdatePhase;
	message: string;
	at: number;
	/** Set on "done" when a build is staged: the extension sends "activate" once no agent runs. */
	staged?: boolean;
	/** Set on "done" when the extension should reload to run the new build. */
	reload?: boolean;
	/** The extension build now on disk, so the reload can tell it worked. */
	extensionBuild?: string;
	/** A result a new host sends again in case the extension missed it; not shown, only matched. */
	replay?: boolean;
}

/** chrome.storage.local key where the extension keeps the last HostUpdateProgress. */
export const UPDATE_PROGRESS_KEY = "tabkyra.updateProgress";

/** chrome.storage.local key where the extension keeps the last HostUpdateStatus. */
export const UPDATE_STATUS_KEY = "tabkyra.updateStatus";

/** The answer to an ExtSubscription, or a step along the way (`progress`, then `result` or `error`). */
export interface HostSubscription {
	type: "subscription";
	id: number;
	result?: unknown;
	error?: RpcError;
	progress?: Record<string, unknown>;
}

export type HostToExt =
	| HostSubscription
	| HostClientConnected
	| HostClientDisconnected
	| HostForwardedRequest
	| HostPing
	| HostUpdateStatus
	| HostUpdateProgress
	| HostCommunityStatus;

/** Error codes the extension returns. */
export const ERR = {
	BAD_PARAMS: "bad_params",
	NOT_FOUND: "not_found",
	NO_TAB: "no_tab",
	PERMISSION_DENIED: "permission_denied",
	DISABLED: "bridge_disabled",
	INTERNAL: "internal",
	TIMEOUT: "timeout",
	NO_EXTENSION: "no_extension",
	/** An alert, confirm or prompt box is open; answer it with the `dialog` method. */
	DIALOG_OPEN: "dialog_open",
	/**
	 * The bridge dropped while the request was out (extension reload, native host restart), so
	 * it may have run. Clients repeat a read on their own; anything else goes to the agent, which
	 * checks the page before repeating it (never replayed blindly).
	 */
	INTERRUPTED: "interrupted",
	/** The request was refused before it reached the browser (the bridge is restarting); repeating it is safe. */
	NOT_SENT: "not_sent",
	/** A ref names an element that left the page, is hidden now, or shows something else; read_page gives fresh refs. */
	STALE_REF: "stale_ref",
	/** The element exists but a click or fill can't reach it (covered, off screen, not a form control). */
	NOT_ACTIONABLE: "not_actionable",
	/** The page's own script threw (run_js); the message is its error, without a stack. */
	SCRIPT_ERROR: "script_error",
	/** The navigation failed in the network stack (DNS, refused, certificate). */
	NAV_FAILED: "navigation_failed",
	/** The session holds the most tabs it may (MAX_SESSION_TABS); close some first. */
	TAB_LIMIT: "tab_limit",
} as const;

/**
 * Methods with no side effect in the page or the tab strip: repeating one changes nothing, so a
 * client may resend it after the bridge drops. Everything else is sent at most once.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
	"status",
	"tabs.context",
	"session.info",
	"sessions.list",
	"threads.list",
	"threads.read",
	"threads.search",
	"tabs.select",
	"snapshot",
	"text",
	"html",
	"inspect",
	"find",
	"screenshot",
	"wait",
	"console.read",
	"network.read",
	"bridge.debug",
	"bridge.bench",
]);

/** Whether a request may be resent after the bridge dropped with it in flight. */
export function isIdempotent(method: string, params: Record<string, unknown> = {}): boolean {
	if (IDEMPOTENT_METHODS.has(method)) return true;
	// Loading the same URL again is a repeat of a GET; "back" and "forward" twice are not.
	if (method === "navigate")
		return typeof params.url === "string" && params.url !== "back" && params.url !== "forward";
	return false;
}

/** Methods the extension implements; the CLI maps MCP tools onto these. */
export const BRIDGE_METHODS = [
	"status",
	"tabs.context",
	"tabs.create",
	"tabs.close",
	"tabs.select",
	"tabs.show",
	"tabs.release",
	"session.info",
	"session.end",
	"sessions.list",
	"sessions.rename",
	"sessions.end",
	"sessions.group",
	"navigate",
	"screenshot",
	"screencast.start",
	"screencast.stop",
	"snapshot",
	"actions",
	"text",
	"html",
	"inspect",
	"find",
	"click",
	"hover",
	"drag",
	"type",
	"press",
	"scroll",
	"fill",
	"evaluate",
	"wait",
	"dialog",
	"console.read",
	"network.read",
	"ask_user",
	"ask_user.cancel",
	"permission.respond",
	"permission.allow",
	"permission.setMode",
	"threads.list",
	"threads.read",
	"threads.search",
	"bridge.reload",
	"bridge.activate",
	"bridge.debug",
	"bridge.bench",
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

// bridge.debug `userScripts`: why in-page scripts can or can't use chrome.userScripts
// (probe and classifier in src/browser/userscripts-status.ts; read by `tabkyra doctor`).

/**
 * - ready: the API is present and a call into it succeeded.
 * - not_granted: the optional permission is not granted (the toggle alone is not enough).
 * - toggle_off: the permission is granted but the browser hides or blocks the API.
 * - probe_error: something else failed; `error` has the browser's text.
 */
export type UserScriptsState = "ready" | "not_granted" | "toggle_off" | "probe_error";

export interface UserScriptsStatus {
	state: UserScriptsState;
	/** `chrome.permissions.contains({permissions:["userScripts"]})`; null when that call failed. */
	permissionGranted: boolean | null;
	/** `chrome.userScripts.execute` is a function: the injection path's own check. */
	apiPresent: boolean;
	/** `chrome.userScripts.getScripts()` resolved (execute needs a tab, so this stands in). */
	callWorks: boolean;
	error?: string;
}
