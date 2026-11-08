/**
 * User services (launchd on macOS, systemd --user on Linux) that keep `polycarp browser serve`, `polycarp browser hub serve`
 * or `polycarp browser link run` running. Shared by remote setup, hub setup and link.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { launcherBinary } from "./harness.ts";
import { cliLauncherPath, ensureLauncherIsSelf } from "./install.ts";
import { configDir, configDirOverride, legacyConfigDir } from "./files.ts";
import { COMMAND_NAME } from "./self.ts";
import { envVar } from "./env.ts";

export function writeAtomic(path: string, text: string, mode: number): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode });
	renameSync(tmp, path);
}

/** stdio is explicit: a child never inherits this process's stdout, which is the native host's channel to the browser. */
export function run(cmd: string, args: string[], timeoutMs = 60_000): { code: number; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
	const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	// A timeout or spawn error still keeps what the command printed: tailscale prints its sign-in URL before it waits.
	if (r.error) return { code: 1, out: [output, r.error.message].filter(Boolean).join("\n") };
	return { code: r.status ?? 1, out: output };
}

/**
 * `run` without blocking the event loop, for the native host, which relays every agent's traffic. Same
 * explicit stdio and the same 60 s limit; `timeoutMs` is for tests. A command that outlives the limit
 * is killed and its pipes closed, so a grandchild that holds them cannot keep this waiting.
 */
export function runAsync(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		let out = "";
		let done = false;
		const finish = (code: number, extra?: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			const text = [out.trim(), extra].filter(Boolean).join("\n");
			resolve({ code, out: text });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch (err) {
			resolve({ code: 1, out: err instanceof Error ? err.message : String(err) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish(1, `${cmd} timed out after ${Math.round(timeoutMs / 1000)} s`);
		}, timeoutMs);
		for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
		child.on("error", (err) => finish(1, err.message));
		child.on("close", (code) => finish(code ?? 1));
	});
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));


const xml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** systemd expands % specifiers in unit files, so a literal % is written %%. In ExecStart it also expands $, so a literal $ is written $$. */
const systemdQuote = (text: string, execStart = false) => {
	const escaped = (execStart ? text.replace(/\$/g, "$$$$") : text).replace(/%/g, "%%");
	return /^[A-Za-z0-9_./:@+=,-]+$/.test(text) ? escaped : `"${escaped.replace(/(["\\])/g, "\\$1")}"`;
};

/**
 * The service reads remote.json (or hub.json, link.json) and oauth.json from the same directory as this shell; the socket directory only when it was moved. Both as absolute paths, since a service doesn't start in this shell's directory.
 * `inherited` is what a service being replaced had saved: used for a folder this shell does not choose itself.
 */
export function serviceEnvironment(inherited: { config?: string; socket?: string } = {}): Record<string, string> {
	const config = configDirOverride() ? configDir() : (inherited.config ?? configDir());
	// The older names too: after `update --rollback` the launcher runs a release that reads only those.
	const out: Record<string, string> = { POLYCARP_BROWSER_CONFIG_DIR: resolve(config), TABKYRA_CONFIG_DIR: resolve(config) };
	const socket = envVar("SOCKET_DIR") ?? inherited.socket;
	if (socket) {
		out.POLYCARP_SOCKET_DIR = resolve(socket);
		out.TABKYRA_SOCKET_DIR = resolve(socket);
	}
	return out;
}

const unxml = (text: string) => text.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));

/** The folders an installed service had saved in its plist or unit (either variable name), or nothing. Never throws. */
function savedFolders(spec: ServiceSpec): { config?: string; socket?: string } {
	const file = serviceFile(spec);
	const found = new Map<string, string>();
	try {
		if (!file || !existsSync(file)) return {};
		const text = readFileSync(file, "utf8");
		if (process.platform === "darwin") {
			for (const m of text.matchAll(/<key>([A-Z_]+)<\/key>\s*<string>([^<]*)<\/string>/g)) found.set(m[1], unxml(m[2]));
		} else {
			for (const m of text.matchAll(/^Environment=(.*)$/gm)) {
				let line = m[1].trim();
				if (line.startsWith('"') && line.endsWith('"')) line = line.slice(1, -1).replace(/\\(["\\])/g, "$1");
				const eq = line.indexOf("=");
				if (eq > 0) found.set(line.slice(0, eq), line.slice(eq + 1).replace(/%%/g, "%"));
			}
		}
	} catch {
		return {};
	}
	const config = found.get("POLYCARP_BROWSER_CONFIG_DIR") ?? found.get("TABKYRA_CONFIG_DIR");
	const socket = found.get("POLYCARP_SOCKET_DIR") ?? found.get("TABKYRA_SOCKET_DIR");
	return { config: config && isAbsolute(config) ? migratedFolder(config) : undefined, socket: socket && isAbsolute(socket) ? socket : undefined };
}

/** The old default config folder now lives at the new one (the migration left a symlink); a folder that still holds the state stays as it is. */
function migratedFolder(dir: string): string {
	try {
		if (resolve(dir) === resolve(legacyConfigDir()) && lstatSync(dir).isSymbolicLink()) return configDir();
	} catch {
		/* keep it */
	}
	return dir;
}

/** A user service: what runs (`tabkyra <args>`), and the names the service manager knows it by. */
export interface ServiceSpec {
	label: string;
	unit: string;
	args: string[];
	logName: string;
	description: string;
	/** The command that undoes setup, for messages ("polycarp browser remote off"). */
	off: string;
	/** What setup keeps when a stop fails, for messages ("remote.json"). */
	kept: string;
	/** The names this service had before the rename. Installing retires a service under them; removing removes it. */
	legacy?: { label: string; unit: string; logName: string };
}

const legacyNames = (name: string) => ({ label: `com.tabkyra.${name}`, unit: `tabkyra-${name}.service`, logName: `tabkyra-${name}.log` });

export const SERVE_SERVICE: ServiceSpec = {
	label: "com.polycarp.serve",
	unit: "polycarp-serve.service",
	args: ["serve"],
	logName: "polycarp-serve.log",
	description: "Polycarp serve (MCP over HTTP for claude.ai, ChatGPT and grok.com)",
	off: `${COMMAND_NAME} remote off`,
	kept: "remote.json",
	legacy: legacyNames("serve"),
};

export const HUB_SERVICE: ServiceSpec = {
	label: "com.polycarp.hub",
	unit: "polycarp-hub.service",
	args: ["hub", "serve"],
	logName: "polycarp-hub.log",
	description: "Polycarp hub (one connector URL for many devices)",
	off: `${COMMAND_NAME} hub off`,
	kept: "hub.json",
	legacy: legacyNames("hub"),
};

export const LINK_SERVICE: ServiceSpec = {
	label: "com.polycarp.link",
	unit: "polycarp-link.service",
	args: ["link", "run"],
	logName: "polycarp-link.log",
	description: "Polycarp link (this device, behind a hub)",
	off: `${COMMAND_NAME} link off`,
	kept: "link.json",
	legacy: legacyNames("link"),
};

const plistPath = (spec: ServiceSpec) => join(homedir(), "Library", "LaunchAgents", `${spec.label}.plist`);
const unitPath = (spec: ServiceSpec) => join(homedir(), ".config", "systemd", "user", spec.unit);
const launchdTarget = (spec: ServiceSpec) => `gui/${process.getuid?.() ?? 0}/${spec.label}`;

export function plistText(binary: string, env: Record<string, string>, log: string, spec: ServiceSpec = SERVE_SERVICE): string {
	const vars = Object.entries(env)
		.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>\n`)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${spec.label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(binary)}</string>
${spec.args.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}
	</array>
${vars ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${vars}\t</dict>\n` : ""}	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
}

export function unitText(binary: string, env: Record<string, string>, spec: ServiceSpec = SERVE_SERVICE): string {
	const vars = Object.entries(env)
		.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}\n`)
		.join("");
	return `[Unit]
Description=${spec.description}

[Service]
ExecStart=${systemdQuote(binary, true)} ${spec.args.join(" ")}
${vars}Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export const serviceFile = (spec: ServiceSpec = SERVE_SERVICE): string | undefined => (process.platform === "darwin" ? plistPath(spec) : process.platform === "linux" ? unitPath(spec) : undefined);
const launchdLog = (spec: ServiceSpec) => join(homedir(), "Library", "Logs", spec.logName);
export const serviceLogHint = (spec: ServiceSpec = SERVE_SERVICE) => (process.platform === "darwin" ? launchdLog(spec) : `journalctl --user -u ${spec.unit}`);

/** After bootout, launchd can still list the service for a moment; bootstrap into that fails. */
async function waitUntilUnloaded(spec: ServiceSpec, exec: Runner): Promise<void> {
	const deadline = Date.now() + 5000;
	while ((await exec("launchctl", ["print", launchdTarget(spec)])).code === 0 && Date.now() < deadline) await sleep(250);
}

type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }> | { code: number; out: string };

/** Install and (re)start the user service. Returns the step that failed, if any; the file is written either way. Blocks the event loop while the service manager runs: for the CLI. */
export function installService(spec: ServiceSpec = SERVE_SERVICE): Promise<{ ok: boolean; message: string; file?: string }> {
	return installWith(spec, run);
}

/** The same install without blocking the event loop: for the native host, which keeps relaying while the service manager works. */
export function installServiceAsync(spec: ServiceSpec = SERVE_SERVICE, timeoutMs?: number): Promise<{ ok: boolean; message: string; file?: string }> {
	return installWith(spec, (cmd, args) => runAsync(cmd, args, timeoutMs));
}

/** The service as it was named before the rename, shaped like a spec so the same file and log helpers work on it. */
function legacySpec(spec: ServiceSpec): ServiceSpec | undefined {
	return spec.legacy ? { ...spec, ...spec.legacy, legacy: undefined } : undefined;
}

/** True when a service under the old name is installed here. */
export function legacyServiceInstalled(spec: ServiceSpec): boolean {
	const old = legacySpec(spec);
	const file = old ? serviceFile(old) : undefined;
	return Boolean(file && existsSync(file));
}

/** Give the old log the new name, unless the new one exists already. A rename keeps the history. */
function moveLegacyLog(spec: ServiceSpec): void {
	if (process.platform !== "darwin" || !spec.legacy) return;
	const from = launchdLog({ ...spec, logName: spec.legacy.logName });
	const to = launchdLog(spec);
	try {
		if (existsSync(from) && !existsSync(to)) renameSync(from, to);
	} catch {
		/* the log is not worth failing a migration for */
	}
}

interface Retired {
	ok: boolean;
	message?: string;
	/** What the old service had saved for its folders, for the new one. */
	saved: { config?: string; socket?: string };
	/** Bring the old service back, when the new one could not be installed. Returns what went wrong, if anything. */
	restore: () => Promise<string | undefined>;
	/** Delete the old service's file and move its log: the new one is running. */
	finish: () => Promise<void>;
}

const NOTHING_RETIRED: Retired = { ok: true, saved: {}, restore: async () => undefined, finish: async () => {} };

/**
 * Stop the service under the old name, if one is installed, so the new one can take its port. Its file stays until `finish`,
 * so a failed install can `restore` it and the person is no worse off.
 */
async function retireLegacy(spec: ServiceSpec, exec: Runner): Promise<Retired> {
	const old = legacySpec(spec);
	const file = old ? serviceFile(old) : undefined;
	if (!old || !file || !existsSync(file)) return NOTHING_RETIRED;
	const saved = savedFolders(old);
	const failure = (r: { code: number; out: string }, what: string) => (r.code === 0 ? undefined : `${what} failed: ${r.out}`);
	if (process.platform === "darwin") {
		const r = await exec("launchctl", ["bootout", launchdTarget(old)]);
		// bootout also fails when the service was never loaded; that is already stopped.
		if (r.code !== 0 && (await exec("launchctl", ["print", launchdTarget(old)])).code === 0) {
			return { ...NOTHING_RETIRED, ok: false, message: `launchctl bootout ${launchdTarget(old)} failed: ${r.out}. The old ${old.label} service is still running, so nothing was changed.` };
		}
		await waitUntilUnloaded(old, exec);
		return {
			ok: true,
			saved,
			restore: async () => {
				const uid = process.getuid?.() ?? 0;
				return failure(await exec("launchctl", ["bootstrap", `gui/${uid}`, file]), `launchctl bootstrap gui/${uid} ${file}`);
			},
			finish: async () => {
				rmSync(file, { force: true });
				moveLegacyLog(spec);
			},
		};
	}
	const r = await exec("systemctl", ["--user", "disable", "--now", old.unit]);
	if (r.code !== 0) return { ...NOTHING_RETIRED, ok: false, message: `systemctl --user disable --now ${old.unit} failed: ${r.out}. The old service is still installed, so nothing was changed.` };
	return {
		ok: true,
		saved,
		restore: async () => failure(await exec("systemctl", ["--user", "enable", "--now", old.unit]), `systemctl --user enable --now ${old.unit}`),
		finish: async () => {
			rmSync(file, { force: true });
			await exec("systemctl", ["--user", "daemon-reload"]);
		},
	};
}

type InstallResult = { ok: boolean; message: string; file?: string };

async function installWith(spec: ServiceSpec, exec: Runner): Promise<InstallResult> {
	// The service runs the launcher. One that points at some other program (an old checkout, an npm link) would start old code.
	const launcher = cliLauncherPath();
	const launcherBefore = readIfFile(launcher);
	ensureLauncherIsSelf();
	// The launcher is shared with every agent's config, so an install that is undone puts it back too.
	const restoreLauncher = () => {
		if (launcherBefore !== undefined && readIfFile(launcher) !== launcherBefore) writeAtomic(launcher, launcherBefore, 0o755);
	};
	const retired = await retireLegacy(spec, exec);
	if (!retired.ok) {
		restoreLauncher();
		return { ok: false, message: retired.message ?? "The old service could not be stopped." };
	}
	const target = serviceFile(spec);
	// A file already there under the new name is kept as it was if this install has to be undone.
	const before = target ? readIfFile(target) : undefined;
	// With no old service to bring back, a failed install behaves as it always did: the file stays for the person to bootstrap by hand.
	if (retired === NOTHING_RETIRED) return installFresh(spec, exec);
	let result: InstallResult;
	try {
		result = await installFresh(spec, exec, retired.saved);
	} catch (err) {
		result = { ok: false, message: `The new service could not be installed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (result.ok) {
		await retired.finish();
		return result;
	}
	// Failed: take the new service away completely before the old one comes back, so never both are enabled.
	await undoFresh(spec, exec, target, before);
	restoreLauncher();
	const problem = await retired.restore();
	return { ...result, message: problem ? `${result.message} The old service could not be restarted: ${problem}` : `${result.message} The old ${spec.legacy?.label ?? "service"} service was restored.` };
}

const readIfFile = (path: string): string | undefined => {
	try {
		return lstatSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
	} catch {
		return undefined;
	}
};

/** Stop and disable the service this install wrote, and delete its file (or put back what was there). Best effort: each step runs. */
async function undoFresh(spec: ServiceSpec, exec: Runner, file: string | undefined, before: string | undefined): Promise<void> {
	try {
		if (process.platform === "darwin") await exec("launchctl", ["bootout", launchdTarget(spec)]);
		else if (process.platform === "linux") await exec("systemctl", ["--user", "disable", "--now", spec.unit]);
	} catch {
		/* keep going */
	}
	try {
		if (file) {
			if (before !== undefined) writeAtomic(file, before, 0o644);
			else if (readIfFile(file) !== undefined) rmSync(file, { force: true });
		}
		if (process.platform === "linux") await exec("systemctl", ["--user", "daemon-reload"]);
	} catch {
		/* the file may be unwritable, which is why we are here */
	}
}

/** launchctl exits 5 (Input/output error) when asked to bootstrap while launchd is still tearing the same job down. */
const BOOTSTRAP_RETRY_MS = 5000;
const BOOTSTRAP_PAUSE_MS = 500;

async function bootstrapWithRetry(spec: ServiceSpec, exec: Runner): Promise<{ code: number; out: string }> {
	const deadline = Date.now() + BOOTSTRAP_RETRY_MS;
	for (;;) {
		const r = await exec("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath(spec)]);
		if (r.code !== 5 || Date.now() + BOOTSTRAP_PAUSE_MS > deadline) return r;
		await sleep(BOOTSTRAP_PAUSE_MS);
	}
}

async function installFresh(spec: ServiceSpec, exec: Runner, saved: { config?: string; socket?: string } = {}): Promise<InstallResult> {
	const binary = launcherBinary();
	const env = serviceEnvironment(saved);
	if (process.platform === "darwin") {
		const log = launchdLog(spec);
		mkdirSync(dirname(log), { recursive: true });
		writeAtomic(plistPath(spec), plistText(binary, env, log, spec), 0o644);
		await exec("launchctl", ["bootout", launchdTarget(spec)]);
		await waitUntilUnloaded(spec, exec);
		const r = await bootstrapWithRetry(spec, exec);
		return { ok: r.code === 0, file: plistPath(spec), message: r.code === 0 ? `Service installed (${plistPath(spec)}); logs in ${log}.` : `launchctl bootstrap failed: ${r.out}. Run: launchctl bootstrap gui/${process.getuid?.() ?? 0} ${plistPath(spec)}` };
	}
	if (process.platform === "linux") {
		writeAtomic(unitPath(spec), unitText(binary, env, spec), 0o644);
		for (const args of [["daemon-reload"], ["enable", spec.unit], ["restart", spec.unit]]) {
			const r = await exec("systemctl", ["--user", ...args]);
			if (r.code !== 0) return { ok: false, file: unitPath(spec), message: `systemctl --user ${args.join(" ")} failed: ${r.out}. The unit is at ${unitPath(spec)}.` };
		}
		return { ok: true, file: unitPath(spec), message: `Service installed (${unitPath(spec)}); journalctl --user -u ${spec.unit} shows its log.` };
	}
	return { ok: false, message: `No service manager is set up for ${process.platform}. Keep it running yourself: ${binary} ${spec.args.join(" ")}` };
}

/**
 * Services installed under the old tabkyra names are installed again under the polycarp ones (same arguments, the current
 * launcher) and the old ones stopped and deleted. Runs from install, setup and update, never from a service itself: a service
 * that retired its own old label would stop itself.
 */
export async function migrateLegacyServices(): Promise<Array<{ label: string } & InstallResult>> {
	const out: Array<{ label: string } & InstallResult> = [];
	for (const spec of [SERVE_SERVICE, HUB_SERVICE, LINK_SERVICE]) {
		if (!legacyServiceInstalled(spec)) continue;
		out.push({ label: spec.label, ...(await installService(spec)) });
	}
	return out;
}

/** Stop and remove the user service. A failed stop keeps the service file so `remote off` can be run again. */
export function removeService(spec: ServiceSpec = SERVE_SERVICE): { ok: boolean; notes: string[]; failure?: string } {
	const result = removeOne(spec);
	const old = legacySpec(spec);
	if (!old || !result.ok) return result;
	const gone = removeOne(old);
	if (gone.ok) moveLegacyLog(spec);
	return gone.ok ? { ok: true, notes: [...result.notes, ...gone.notes] } : gone;
}

function removeOne(spec: ServiceSpec): { ok: boolean; notes: string[]; failure?: string } {
	if (process.platform === "darwin" && existsSync(plistPath(spec))) {
		const r = run("launchctl", ["bootout", launchdTarget(spec)]);
		// bootout also fails when the service was never loaded; that is already stopped.
		if (r.code !== 0 && run("launchctl", ["print", launchdTarget(spec)]).code === 0) {
			return { ok: false, notes: [], failure: `launchctl bootout failed: ${r.out}. The service is still installed and ${spec.kept} is kept. Run: launchctl bootout ${launchdTarget(spec)}, then ${spec.off} again.` };
		}
		rmSync(plistPath(spec), { force: true });
		return { ok: true, notes: [`Stopped and removed ${plistPath(spec)}.`] };
	}
	if (process.platform === "linux" && existsSync(unitPath(spec))) {
		const r = run("systemctl", ["--user", "disable", "--now", spec.unit]);
		if (r.code !== 0) {
			return { ok: false, notes: [], failure: `systemctl --user disable --now ${spec.unit} failed: ${r.out}. The service is still installed and ${spec.kept} is kept. Run that command yourself, then ${spec.off} again.` };
		}
		rmSync(unitPath(spec), { force: true });
		run("systemctl", ["--user", "daemon-reload"]);
		return { ok: true, notes: [`Stopped and removed ${unitPath(spec)}.`] };
	}
	return { ok: true, notes: [] };
}

