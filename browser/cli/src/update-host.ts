/**
 * The native host's side of updates from the side panel (docs/updates.md):
 *
 * - status: the last check, refreshed once a day (or on "check"), plus the install mode, the
 *   builds on disk and running, version mismatches and the last update, sent as update_status;
 * - actions: the extension sends `{type: "update_action", action}` and nothing else. Each action
 *   maps to a fixed child command line (UPDATE_COMMANDS) or a fixed settings write. Nothing the
 *   extension sends reaches a command; a frame with any other field is refused.
 * - progress: the child prints one JSON line per step; each becomes an update_progress frame.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtHello, HostToExt, HostUpdateProgress, HostUpdateStatus, UpdatePhase } from "../../src/bridge/protocol.ts";
import { asBuildInfo, BUILD, type BuildInfo, describeBuild } from "../../src/update/build.ts";
import { diagnoseVersions, type ExtensionLocation, locateExtension, parseUpdateRequest, type UpdateAction } from "../../src/update/logic.ts";
import {
	blockedReason,
	canRollBack,
	detectMode,
	inspectCheckout,
	needsBuild,
	previousBuild,
	readBuildInfo,
	readStaged,
	recoverCheckoutQuietly,
	toolEnv,
} from "./checkout.ts";
import { type HostRunAction, type ProgressEvent, type ProgressRecord, readProgressRecord, writeProgressRecord } from "./update-progress.ts";
import {
	CHECK_INTERVAL_MS,
	checkForUpdate,
	installedVersion,
	isNewer,
	previousDir,
	readLastUpdate,
	readSettings,
	readStatus,
	recover,
	setPolicy,
	stagedDir,
	type UpdateStatus,
	withLock,
	writeStatus,
} from "./update.ts";

/**
 * The only command lines the host runs for the extension, by action. They are passed to the
 * CLI this host runs from, as argv (no shell). Checks and settings run in this process.
 */
export const UPDATE_COMMANDS: Readonly<Record<HostRunAction, readonly string[]>> = Object.freeze({
	update: Object.freeze(["update", "--host"]),
	activate: Object.freeze(["update", "--host", "--activate"]),
	rollback: Object.freeze(["update", "--host", "--rollback"]),
	reinstall: Object.freeze(["update", "--host", "--reinstall"]),
});

type Send = (message: HostToExt) => void;

/** The CLI file this host runs from: the child runs the same code. */
function cliEntry(): string {
	return fileURLToPath(import.meta.url);
}

let extension: { build?: BuildInfo; location: ExtensionLocation } = { location: "unknown" };
let running: { action: HostRunAction; last?: HostUpdateProgress } | undefined;
let recovered = false;
let lastStatus: HostUpdateStatus | undefined;

/** No update runs this long (setup 20 min, two builds 10 min each, git); an older record is dead. */
export const MAX_RUN_MS = 60 * 60 * 1000;

/** The updater that wrote a record still runs: its pid is alive and the record isn't older than any run. */
function updaterAlive(record: { pid: number; at: number }): boolean {
	return pidAlive(record.pid) && Date.now() - record.at < MAX_RUN_MS;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Once per host: repair a swap a crash interrupted (unless an updater holds the lock), and pick
 * up an updater a previous host started that is still running, following its progress file.
 */
function startUp(send: Send): void {
	if (recovered) return;
	recovered = true;
	const { mode, root } = detectMode();
	try {
		if (mode === "checkout") recoverCheckoutQuietly(root);
		else if (mode === "release" && existsSync(join(root, ".."))) withLock(recover);
	} catch {
		/* an updater holds the lock; it repairs on its own */
	}
	const record = readProgressRecord();
	if (!record) return;
	if (record.phase === "done" || record.phase === "failed") {
		// A result the extension may have missed while no host ran: send it once more with its own
		// time. The worker acts on it only if it is the result of the step it is waiting for.
		if (Date.now() - record.at < 10 * 60 * 1000) {
			const frame = forward(send, record.action, record, record.at, true);
			if (!frame) return;
		}
		return;
	}
	if (!updaterAlive(record)) {
		const message = "The updater stopped before it finished. An interrupted swap is repaired; run it again.";
		// Once: the record says failed from now on.
		recordFailure(record, failed(send, record.action, message));
		return;
	}
	const state: { action: HostRunAction; last?: HostUpdateProgress } = { action: record.action };
	running = state;
	let seen = 0;
	const poll = setInterval(() => {
		const r = readProgressRecord();
		if (r && r.at !== seen) {
			seen = r.at;
			state.last = forward(send, record.action, r);
		}
		const over = !r || r.phase === "done" || r.phase === "failed";
		if (over && running === state) running = undefined;
		if (over || !updaterAlive(r ?? record)) {
			clearInterval(poll);
			if (running === state) running = undefined;
			if (!over) {
				const message = "The updater stopped before it finished; run it again.";
				const frame = failed(send, record.action, message);
				recordFailure(r ?? record, frame);
			}
			void sendStatus(send);
		}
	}, 1000);
	poll.unref();
}

/**
 * A failure the host reports itself (the updater died or exited without a result). For an
 * install or rollback, files may have changed: repair an interrupted swap, then ask for a reload
 * into whatever is installed, as the updater does.
 */
function failed(send: Send, action: HostRunAction, message: string): HostUpdateProgress {
	if (action !== "activate" && action !== "rollback") return progress(send, action, "failed", message);
	const { mode, root } = detectMode();
	try {
		if (mode === "checkout") recoverCheckoutQuietly(root);
		else if (mode === "release") withLock(recover);
	} catch {
		/* held by a live updater: it finishes on its own */
	}
	const extensionBuild = readBuildInfo(join(root, "dist-chrome"))?.id;
	return progress(send, action, "failed", `${message} Reloading Tabkyra to run what is installed.`, { reload: true, extensionBuild });
}

/**
 * Mark a dead updater's record failed, once, with the same result the extension was sent
 * (reload included), so a host that replays it later asks for the reload too.
 */
function recordFailure(record: ProgressRecord, frame: HostUpdateProgress): void {
	writeProgressRecord({ ...record, phase: "failed", message: frame.message, reload: frame.reload, extensionBuild: frame.extensionBuild, at: Date.now() });
}

let helloSeen = false;

/** The extension said hello: note what it runs and whether it loads from our folder. */
export function noteHello(hello: ExtHello, send: Send): void {
	helloSeen = true;
	startUp(send);
	const { root } = detectMode();
	const disk = readBuildInfo(join(root, "dist-chrome"));
	extension = {
		build: asBuildInfo(hello.build),
		location: locateExtension(asBuildInfo(hello.diskBuild)?.id, disk?.id),
	};
}

/** For tests and `tabkyra debug`: is an update child running. */
export function updateRunning(): HostRunAction | undefined {
	return running?.action;
}

// ---- status -------------------------------------------------------------------------------

/** Release mode and unmanaged: the cached release check, refreshed when old or forced. */
async function releaseCheck(force: boolean, root: string): Promise<UpdateStatus> {
	const { channel } = readSettings();
	const cached = readStatus();
	const current = installedVersion(root) ?? installedVersion();
	if (!force && cached && (cached.mode ?? "release") !== "checkout" && cached.channel === channel && cached.current === current && Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
		return cached;
	}
	return checkForUpdate(channel);
}

interface CheckoutCheck {
	status: UpdateStatus;
	blocked?: string;
	behind: number;
	needsBuild: boolean;
}

/** Checkout mode: `git fetch` once a day (or when forced); everything else is read each time. */
async function checkoutCheck(force: boolean, root: string, checks: boolean): Promise<CheckoutCheck> {
	const cached = readStatus();
	const stale = !cached || cached.mode !== "checkout" || Date.now() - cached.checkedAt >= CHECK_INTERVAL_MS;
	const fetch = checks && (force || stale);
	const info = await inspectCheckout(root, { fetch });
	const pending = needsBuild(info);
	const status: UpdateStatus = {
		checkedAt: fetch ? Date.now() : (cached?.mode === "checkout" ? cached.checkedAt : 0),
		channel: "main",
		mode: "checkout",
		current: describeBuild(info.built) === "unknown" ? info.head.slice(0, 7) : describeBuild(info.built),
		latest: info.origin?.slice(0, 7),
		available: info.behind > 0 || pending,
		head: info.head,
		origin: info.origin,
		error: info.fetchError,
	};
	if (fetch) writeStatus(status);
	return { status, blocked: info.blocked ?? blockedReason(info), behind: info.behind, needsBuild: pending };
}

/** Everything Settings > Updates and the notice show. `force` checks now. */
export async function computeStatus(force = false): Promise<HostUpdateStatus> {
	// While an updater works on the checkout, don't run git next to it: report the last status.
	if (running && lastStatus) return { ...lastStatus, updating: true };
	if (running) {
		// Adopted at start, before any status was computed: what the cached check says, no git.
		const cached = readStatus();
		const settings = readSettings();
		const { mode, root } = detectMode();
		return {
			type: "update_status",
			available: false,
			current: cached?.current ?? "unknown",
			channel: cached?.channel ?? settings.channel,
			checkedAt: cached?.checkedAt ?? 0,
			mode,
			policy: settings.policy,
			root,
			updating: true,
			location: extension.location,
		};
	}
	const settings = readSettings();
	const { mode, root } = detectMode();
	const checks = settings.policy !== "off" || force;
	const extensionOnDisk = readBuildInfo(join(root, "dist-chrome"));
	const cliOnDisk = readBuildInfo(join(root, "cli", "dist"));
	let check: UpdateStatus;
	let blocked: string | undefined;
	let behind: number | undefined;
	let pendingBuild: boolean | undefined;
	let canRollback = false;
	let rollbackTo: string | undefined;
	let staged: string | undefined;
	if (mode === "checkout") {
		staged = readStaged(root)?.to;
		const c = await checkoutCheck(force, root, checks);
		check = c.status;
		blocked = c.blocked;
		behind = c.behind;
		pendingBuild = c.needsBuild;
		canRollback = canRollBack(root);
		rollbackTo = canRollback ? describeBuild(previousBuild(root)) : undefined;
	} else {
		const current = installedVersion(root) ?? describeBuild(cliOnDisk);
		check = checks ? await releaseCheck(force, root) : { checkedAt: readStatus()?.checkedAt ?? 0, channel: settings.channel, current, available: false };
		if (!checks) check.available = false;
		if (mode === "release") {
			const stagedVersion = existsSync(join(stagedDir(), ".pending.json")) ? installedVersion(stagedDir()) : undefined;
			// Only something newer than what is installed is waiting to install.
			staged = stagedVersion && isNewer(stagedVersion, installedVersion(root)) ? stagedVersion : undefined;
			canRollback = existsSync(previousDir());
			rollbackTo = canRollback ? installedVersion(previousDir()) : undefined;
		} else {
			blocked = `This Tabkyra runs from ${root}, which is neither a release install nor a git checkout. Run tabkyra update in a terminal.`;
		}
	}
	if (extension.location === "elsewhere") {
		blocked = `The browser loads Tabkyra from another folder than ${join(root, "dist-chrome")}, so updating here would not change it. Load that folder on chrome://extensions, or update the copy the browser loads.`;
	}
	const mismatch = diagnoseVersions({ extension: extension.build, extensionOnDisk, location: extension.location, host: BUILD, cliOnDisk });
	const status: HostUpdateStatus = {
		type: "update_status",
		available: checks && check.available && !check.error,
		current: check.current,
		latest: check.latest,
		channel: check.channel,
		checkedAt: check.checkedAt,
		mode,
		policy: settings.policy,
		nextCheckAt: settings.policy === "off" ? undefined : (check.checkedAt || Date.now()) + CHECK_INTERVAL_MS,
		root,
		error: check.error,
		blocked,
		behind,
		needsBuild: pendingBuild,
		canRollback,
		rollbackTo,
		staged,
		updating: running !== undefined,
		location: extension.location,
		mismatch,
		lastUpdate: readLastUpdate(),
		hostBuild: BUILD,
		cliBuild: cliOnDisk,
		extensionBuild: extensionOnDisk,
	};
	lastStatus = status;
	return status;
}

export async function sendStatus(send: Send, force = false): Promise<HostUpdateStatus | undefined> {
	try {
		const status = await computeStatus(force);
		send(status);
		return status;
	} catch (err) {
		process.stderr.write(`[tabkyra-host] update status failed: ${String(err)}\n`);
		return undefined;
	}
}

// ---- actions ------------------------------------------------------------------------------

function progress(
	send: Send,
	action: UpdateAction,
	phase: UpdatePhase,
	message: string,
	extra: Partial<HostUpdateProgress> = {},
): HostUpdateProgress {
	const frame: HostUpdateProgress = { type: "update_progress", action, phase, message, at: Date.now(), ...extra };
	send(frame);
	return frame;
}

const PHASES: UpdatePhase[] = ["checking", "downloading", "verifying", "pulling", "installing", "building", "skills", "done", "failed"];

/** One step from the updater (its stdout or its progress file) as an update_progress frame. */
function forward(
	send: Send,
	action: UpdateAction,
	event: Partial<ProgressEvent> | { phase?: unknown; message?: unknown; staged?: unknown; reload?: unknown; extensionBuild?: unknown },
	at?: number,
	replay?: boolean,
): HostUpdateProgress | undefined {
	if (typeof event.phase !== "string" || !PHASES.includes(event.phase as UpdatePhase)) return undefined;
	return progress(send, action, event.phase as UpdatePhase, String(event.message ?? "").slice(0, 2000), {
		staged: event.staged === true ? true : undefined,
		reload: event.reload === true ? true : undefined,
		extensionBuild: typeof event.extensionBuild === "string" ? event.extensionBuild : undefined,
		...(at ? { at } : {}),
		...(replay ? { replay: true } : {}),
	});
}

/**
 * Run one of the fixed update commands as a child and stream its steps. The child is its own
 * process group and survives this host: if the browser closes the host mid-update, the update
 * finishes, and the next host follows it through its progress file (startUp).
 */
function runChild(action: HostRunAction, send: Send): void {
	const child = spawn(process.execPath, [cliEntry(), ...UPDATE_COMMANDS[action]], {
		env: toolEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
		detached: true,
	});
	const state: { action: HostRunAction; last?: HostUpdateProgress } = { action };
	running = state;
	let buffer = "";
	let stderr = "";
	let finished = false;
	const onLine = (line: string) => {
		if (!line.trim()) return;
		let event: { phase?: unknown };
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		const frame = forward(send, action, event);
		if (!frame) return;
		if (frame.phase === "done" || frame.phase === "failed") {
			finished = true;
			// The next step (activate after update) may come before the process has exited.
			if (running === state) running = undefined;
		}
		state.last = frame;
	};
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let nl = buffer.indexOf("\n");
		while (nl >= 0) {
			onLine(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
			nl = buffer.indexOf("\n");
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString("utf8")).slice(-2000);
	});
	const end = (code: number | null, error?: Error) => {
		if (running === state) running = undefined;
		if (buffer) onLine(buffer);
		if (!finished) {
			const reason = error?.message || stderr.trim().split("\n").slice(-3).join("\n") || `exit code ${code}`;
			failed(send, action, `The updater stopped: ${reason}.`);
		}
		void sendStatus(send);
	};
	child.on("error", (err) => end(null, err));
	child.on("close", (code) => end(code));
}

/**
 * An update_action frame from the extension. Anything but exactly `{type, action}` with a known
 * action is refused without running anything.
 */
export function handleUpdateAction(raw: unknown, send: Send): void {
	const action = parseUpdateRequest(raw);
	if (!action) {
		progress(send, "update", "failed", "Refused: an update request carries only an action name the host knows.");
		return;
	}
	startUp(send);
	if (action === "policy-off" || action === "policy-notify" || action === "policy-auto") {
		setPolicy(action === "policy-off" ? "off" : action === "policy-notify" ? "notify" : "auto");
		void sendStatus(send);
		return;
	}
	if (running) {
		// Say what is going on instead of starting a second updater; another action gets its own answer.
		if (action !== running.action) progress(send, action, "failed", `An update is already running (${running.action}); try again when it finishes.`);
		else if (running.last) send(running.last);
		else progress(send, running.action, "checking", "An update is already running.");
		return;
	}
	if (!helloSeen && action !== "check") {
		// Without the hello the host can't tell which folder the browser loads; don't guess.
		progress(send, action, "failed", "The extension hasn't said hello to the native host yet; try again in a moment.");
		return;
	}
	if (action === "check") {
		progress(send, "check", "checking", "Checking for updates");
		void sendStatus(send, true).then((status) => {
			if (!status) progress(send, "check", "failed", "The check failed.");
			else if (status.error) progress(send, "check", "failed", status.error);
			else progress(send, "check", "done", status.available ? `Update available: ${status.latest ?? "new build"}` : "Up to date");
		});
		return;
	}
	// Only re-registering a release's host is useful when the browser loads another folder.
	if (extension.location === "elsewhere" && !(action === "reinstall" && detectMode().mode === "release")) {
		void computeStatus().then((status) => progress(send, action, "failed", status.blocked ?? "The browser loads Tabkyra from another folder."));
		return;
	}
	runChild(action, send);
	void sendStatus(send);
}

/** Re-check once a day while the host runs (the browser keeps it running). */
export function startUpdateTimer(send: Send): void {
	const timer = setInterval(
		() => {
			const status = readStatus();
			if (!status || Date.now() - status.checkedAt >= CHECK_INTERVAL_MS) void sendStatus(send);
		},
		60 * 60 * 1000,
	);
	timer.unref();
}
