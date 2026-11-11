/**
 * User services (launchd on macOS, systemd --user on Linux, a per-user Task Scheduler task on Windows) that keep `polycarp browser serve`, `polycarp browser hub serve`
 * or `polycarp browser link run` running. Shared by remote setup, hub setup and link.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { launcherBinary } from "./harness.ts";
import { cliLauncherPath, ensureLauncherIsSelf } from "./install.ts";
import { configDir, configDirOverride, legacyConfigDir } from "./files.ts";
import { COMMAND_NAME } from "./self.ts";
import { envVar } from "./env.ts";
import { tasklistCall, tasklistImage } from "./tool-paths.ts";

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

const runSync: SyncRunner = (cmd, args) => run(cmd, args);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type SyncRunner = (cmd: string, args: string[]) => { code: number; out: string };

/**
 * For tests: act as another platform, with a stand-in for the service manager and the Windows account, so the commands can be
 * checked on any computer without running one. Production code never sets it.
 */
export interface ServiceSeam {
	platform?: NodeJS.Platform;
	exec?: SyncRunner;
	/** The DOMAIN\user a Windows task is made for; "" acts as an account Windows didn't name. */
	windowsUser?: string;
	/** The launcher a service runs, in place of launcherBinary(). */
	launcher?: string;
	/** How long to wait for a killed Windows program to be gone. */
	stopWaitMs?: number;
}
let seam: ServiceSeam = {};
export function setServiceSeamForTests(next: ServiceSeam): void {
	seam = next;
}
const platform = (): NodeJS.Platform => seam.platform ?? process.platform;


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
		if (platform() === "darwin") {
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

/** A user service: what runs (`polycarp-browser <args>`), and the names the service manager knows it by. */
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

// ---------- Windows: a per-user Task Scheduler task ----------

/*
 * Windows has no per-user service manager like launchd or systemd --user, so each service is a Task Scheduler task made for
 * this account alone, without administrator rights: it starts at this user's logon and runs with the user's own limited rights,
 * with no password stored. The task runs a small batch script beside it that sets the folders, appends the program's output to
 * a log file (Windows has no journal) and starts the program again 10 seconds after it stops, as KeepAlive and Restart=always do.
 *
 * Microsoft's documentation for what is written here:
 * - schtasks /Create /XML, /Run, /End, /Delete and /Query: learn.microsoft.com/windows-server/administration/windows-commands/schtasks
 * - the task XML: learn.microsoft.com/windows/win32/taskschd/task-scheduler-schema. A LogonTrigger whose UserId names one user
 *   starts when that user logs on; with no UserId it starts for any user (taskschd/logontrigger-userid). LogonType
 *   InteractiveToken runs only while the user is logged on and needs no stored password, and RunLevel LeastPrivilege is not
 *   elevated (taskschd/taskschedulerschema-principal-principaltype-element). schtasks has no flag for restart on failure, so the
 *   task is written as XML with RestartOnFailure, whose Count is an unsignedByte
 *   (taskschd/taskschedulerschema-restartonfailure-settingstype-element). It covers a script that could not start at all; the
 *   script's own loop covers a program that stops.
 */

const windowsServiceDir = () => join(configDir(), "services");
const windowsScriptPath = (spec: ServiceSpec) => join(windowsServiceDir(), `${spec.label}.cmd`);
const windowsTaskXmlPath = (spec: ServiceSpec) => join(windowsServiceDir(), `${spec.label}.xml`);
const windowsLog = (spec: ServiceSpec) => join(configDir(), "logs", spec.logName);
const systemRoot = () => process.env.SystemRoot || "C:\\Windows";
/** By full path, so a schtasks or cmd elsewhere on PATH is never run in their place. */
export const schtasksPath = () => win32.join(systemRoot(), "System32", "schtasks.exe");
const cmdPath = () => win32.join(systemRoot(), "System32", "cmd.exe");

/** The account the task is for, as Windows names it (DOMAIN\user), or undefined when the environment doesn't say. */
function windowsUser(): string | undefined {
	if (seam.windowsUser !== undefined) return seam.windowsUser || undefined;
	const name = process.env.USERNAME;
	if (!name) return undefined;
	return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/**
 * A path the batch script and the task can name safely. Inside double quotes cmd reads & | < > ( ) and spaces as plain text,
 * but a quote or line break ends the value, and % and ^ change under CALL, so those are refused rather than escaped.
 */
export function windowsPathProblem(path: string): string | undefined {
	return /["\r\n\0%^]/.test(path) ? `${path} has a character (" % ^ or a line break) that a Windows task can't run safely` : undefined;
}

/** The folder variables the script sets from its own location, never from a path written into it. */
const CONFIG_KEYS = new Set(["POLYCARP_BROWSER_CONFIG_DIR", "TABKYRA_CONFIG_DIR"]);

/**
 * The batch script the task runs. It names no folder of this computer: cmd reads a batch file in the console's code page, so
 * a profile folder such as C:\Users\José written into it as UTF-8 would be misread. Every path comes from %~dp0, the script's own
 * folder as Windows hands it over (the config folder is the one above it, where the launcher is too), and the script is plain
 * ASCII. `chcp 65001` then has cmd read the launcher it calls, which names Node's path, as UTF-8. Lines end in CRLF.
 */
export function windowsScriptText(launcherName: string, env: Record<string, string>, spec: ServiceSpec = SERVE_SERVICE): string {
	if (!/^[A-Za-z0-9._-]+$/.test(launcherName)) throw new Error(`${launcherName} isn't a launcher name a Windows task can run`);
	if (!/^[A-Za-z0-9._-]+$/.test(spec.logName)) throw new Error(`${spec.logName} isn't a log name a Windows task can write`);
	if (!spec.args.every((a) => /^[a-z][a-z-]*$/.test(a))) throw new Error(`${spec.args.join(" ")} isn't a command a Windows task can run`);
	const extra: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`${name} isn't a variable name a Windows task can set`);
		if (CONFIG_KEYS.has(name)) continue;
		if (!/^[\x20-\x7e]*$/.test(value) || /["%^]/.test(value)) throw new Error(`${name}=${value} isn't a value a Windows task can set safely: it must be plain ASCII without " % or ^`);
		extra.push(`set "${name}=${value}"`);
	}
	return [
		"@echo off",
		`rem ${spec.label}: started at logon by the Task Scheduler task of the same name. ${spec.off} removes both.`,
		"setlocal DisableDelayedExpansion",
		"chcp 65001 >nul",
		// The task runs with your logon, so Windows shows its console window; the title says what it is and that closing it stops it.
		`title ${spec.label} (Polycarp; closing this window stops it until you log on again)`,
		'for %%I in ("%~dp0..") do set "POLYCARP_HOME=%%~fI"',
		...[...CONFIG_KEYS].filter((k) => k in env).map((k) => `set "${k}=%POLYCARP_HOME%"`),
		...extra,
		`set "POLYCARP_LOG=%POLYCARP_HOME%\\logs\\${spec.logName}"`,
		// The program records its pid here (recordServicePid), so stop and uninstall can end it and what it started.
		`set "${PID_FILE_VAR}=%POLYCARP_HOME%\\services\\${spec.label}.pid"`,
		":run",
		// Past 10 MB the log becomes <log>.1 (replacing the one before), so a program that keeps failing can't fill the disk.
		'if exist "%POLYCARP_LOG%" for %%F in ("%POLYCARP_LOG%") do if %%~zF GTR 10485760 move /y "%POLYCARP_LOG%" "%POLYCARP_LOG%.1" >nul 2>&1',
		'>>"%POLYCARP_LOG%" 2>&1 (',
		"\techo [%DATE% %TIME%] starting",
		`\tcall "%POLYCARP_HOME%\\${launcherName}" ${spec.args.join(" ")}`,
		")",
		"rem Wait 10 seconds before starting again (ping waits without a console, where timeout cannot).",
		'"%SystemRoot%\\System32\\ping.exe" -n 11 127.0.0.1 >nul',
		"goto run",
		"",
	].join("\r\n");
}

/** The task definition for `schtasks /Create /XML`, as Task Scheduler itself exports one. */
export function windowsTaskXml(script: string, user: string, spec: ServiceSpec = SERVE_SERVICE): string {
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(spec.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>255</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(cmdPath())}</Command>
      <Arguments>${xml(`/d /s /c ""${script}""`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks reads a task file as UTF-16 with a byte order mark, the way it exports one. Written through a temp file like the rest. */
function writeUtf16(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\r?\n/g, "\r\n"), "utf16le")]), { mode: 0o600 });
	renameSync(tmp, path);
}

const PID_FILE_VAR = "POLYCARP_SERVICE_PID_FILE";
const windowsPidPath = (spec: ServiceSpec) => join(windowsServiceDir(), `${spec.label}.pid`);

/**
 * Called first thing by the CLI. When a Windows task started it, write this process's pid, program name and start time where
 * the task's script asked, so stop and uninstall can end it: ending the task ends only cmd.exe, and Node would keep running. The
 * start time tells this process apart from a later one Windows gives the same pid. The record is deleted on exit, and the
 * variable is cleared so programs this one starts don't overwrite it. A record that can't be written means stop reports that
 * it can't confirm the program ended (stopPlan).
 */
export function recordServicePid(
	o: { env?: NodeJS.ProcessEnv; pid?: number; execPath?: string; platform?: NodeJS.Platform; startMs?: number; onExit?: (fn: () => void) => void } = {},
): void {
	const env = o.env ?? process.env;
	const file = env[PID_FILE_VAR];
	if ((o.platform ?? process.platform) !== "win32" || !file) return;
	delete env[PID_FILE_VAR];
	const pid = o.pid ?? process.pid;
	try {
		// performance.timeOrigin is when this process started, in ms since 1970 (nodejs.org/api/perf_hooks.html).
		writeFileSync(file, `${pid}\n${win32.basename(o.execPath ?? process.execPath)}\n${Math.round(o.startMs ?? performance.timeOrigin)}\n`);
	} catch {
		return;
	}
	(o.onExit ?? ((fn) => process.on("exit", fn)))(() => {
		try {
			if ((readIfFile(file) ?? "").split(/\r?\n/)[0] === String(pid)) rmSync(file, { force: true });
		} catch {
			/* best effort: a stale record is told apart by its start time */
		}
	});
}

/** How far apart Node's start time and Windows' may be for the same process. A reused pid starts after the first one ended. */
const START_SLACK_MS = 2000;
const powershellPath = () => win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** A process's start time in ms since 1970: Get-Process's StartTime (learn.microsoft.com/powershell/module/microsoft.powershell.management/get-process). */
const startTimeCall = (pid: number): [string, string[]] => [powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`]];

type Answer = { code: number; out: string };
type StopStep = { run: [string, string[]] } | { sleep: number };

/**
 * End the program the task started, and everything it started, then confirm it is gone. Its pid, program and start time come
 * from the record it wrote; a pid now used by another process (other program, or the same one started later) is left alone,
 * and nothing is killed unless the start time matches. `taskWasRunning` is /End's exit code saying it ended a running task: then
 * a missing record is not proof the program stopped. The steps are yielded so the native host can run them without blocking.
 * Returns undefined on success, else the sentence to show.
 */
function* stopPlan(spec: ServiceSpec, taskWasRunning: boolean): Generator<StopStep, string | undefined, Answer | undefined> {
	const file = windowsPidPath(spec);
	const noRecord = `The ${spec.label} task was running, but its program left no record of its pid, so Polycarp can't tell whether it stopped: close the window titled ${spec.label} if it is open, or end its program in Task Manager, then run ${spec.off} again.`;
	const gone = () => {
		rmSync(file, { force: true });
		return taskWasRunning ? noRecord : undefined;
	};
	const [pidText, image, startText] = (readIfFile(file) ?? "").split(/\r?\n/);
	const pid = Number(pidText);
	if (!Number.isInteger(pid) || pid <= 4 || !image) return gone();
	const unconfirmed = `Polycarp couldn't confirm that pid ${pid} is still the ${image} its ${spec.label} task started, so it ended nothing: end that program in Task Manager (Details, PID ${pid}) if it is Polycarp's, then run ${spec.off} again.`;
	const same = (seen: string | undefined) => seen !== undefined && seen !== "unknown" && seen.toLowerCase() === image.toLowerCase();
	const look = function* (): Generator<StopStep, string | undefined | "unknown", Answer | undefined> {
		return tasklistImage(pid, (yield { run: tasklistCall(pid) }) as Answer);
	};
	let seen = yield* look();
	if (seen === "unknown") return `Windows couldn't say whether ${image} (pid ${pid}) is still running. Run: taskkill /PID ${pid} /T /F, then ${spec.off} again.`;
	if (!same(seen)) return gone();
	const recorded = Number(startText);
	const started = (yield { run: startTimeCall(pid) }) as Answer;
	const actual = started.code === 0 ? Number(started.out.trim()) : Number.NaN;
	if (!Number.isFinite(recorded) || !Number.isFinite(actual)) return same(yield* look()) ? unconfirmed : gone();
	if (Math.abs(actual - recorded) > START_SLACK_MS) return gone();
	yield { run: [win32.join(systemRoot(), "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"]] };
	const deadline = Date.now() + (seam.stopWaitMs ?? 5000);
	for (;;) {
		seen = yield* look();
		if (!same(seen) || Date.now() >= deadline) break;
		yield { sleep: 100 };
	}
	if (seen === "unknown" || same(seen)) return `${image} (pid ${pid}) is still running after taskkill. Run: taskkill /PID ${pid} /T /F, or close its window, then ${spec.off} again.`;
	rmSync(file, { force: true });
	return undefined;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run a stop plan with the CLI's blocking runner (remove is synchronous). */
function stopWindowsSync(spec: ServiceSpec, taskWasRunning: boolean, exec: SyncRunner): string | undefined {
	const plan = stopPlan(spec, taskWasRunning);
	let step = plan.next();
	while (!step.done) {
		const s = step.value;
		if ("sleep" in s) {
			sleepSync(s.sleep);
			step = plan.next(undefined);
		} else step = plan.next(exec(...s.run));
	}
	return step.value;
}

/** Run a stop plan with the install's runner, without blocking the event loop (the native host relays while it waits). */
async function stopWindows(spec: ServiceSpec, taskWasRunning: boolean, exec: Runner): Promise<string | undefined> {
	const plan = stopPlan(spec, taskWasRunning);
	let step = plan.next();
	while (!step.done) {
		const s = step.value;
		if ("sleep" in s) {
			await sleep(s.sleep);
			step = plan.next(undefined);
		} else step = plan.next(await exec(...s.run));
	}
	return step.value;
}

async function installWindows(spec: ServiceSpec, exec: Runner, binary: string, env: Record<string, string>): Promise<InstallResult> {
	const keepRunning = `keep it running yourself: ${binary} ${spec.args.join(" ")}`;
	const keepRunningSentence = `Keep it running yourself: ${binary} ${spec.args.join(" ")}.`;
	const user = windowsUser();
	if (!user) return { ok: false, message: `Windows didn't say which account this is (USERNAME is empty), so no task was made. Sign in to Windows normally, or ${keepRunning}` };
	const script = windowsScriptPath(spec);
	const log = windowsLog(spec);
	const home = resolve(configDir());
	const problem = windowsPathProblem(home);
	if (problem) return { ok: false, message: `${problem}, so no task was made. Set POLYCARP_BROWSER_CONFIG_DIR to a folder without it and run setup again, or ${keepRunning}.` };
	// cmd `call`s the launcher, so it must be a program or a batch file. On Windows install writes polycarp.cmd
	// (CLI_LAUNCHER_NAME in files.ts, writeScript in install.ts); anything else is refused, never started and left to fail in a loop.
	if (!/\.(exe|cmd|bat)$/i.test(binary)) return { ok: false, message: `The launcher ${binary} isn't a .exe, .cmd or .bat file, so Windows can't run it and no task was made. Run ${COMMAND_NAME} install on this computer, then setup again.` };
	// The script finds the launcher and the folders from its own place, so they must be where it looks.
	if (resolve(dirname(binary)) !== home) return { ok: false, message: `The launcher ${binary} isn't in the config folder ${home}, so no task was made. Run ${COMMAND_NAME} install, then setup again, or ${keepRunning}.` };
	const strayConfig = [...CONFIG_KEYS].map((k) => env[k]).find((v) => v !== undefined && resolve(v) !== home);
	if (strayConfig) return { ok: false, message: `The service would use ${strayConfig}, not the config folder ${home} its script sits in, so no task was made. ${keepRunningSentence}` };
	let text: string;
	try {
		text = windowsScriptText(basename(binary), env, spec);
	} catch (err) {
		return { ok: false, message: `${err instanceof Error ? err.message : String(err)}, so no task was made. ${keepRunningSentence}` };
	}
	// A copy already running reads its script as it loops, so it is stopped, and confirmed gone, before the script changes.
	if (existsSync(script)) {
		// /End exits 0 only when it ended a running task.
		const ended = await exec(schtasksPath(), ["/End", "/TN", spec.label]);
		const stuck = await stopWindows(spec, ended.code === 0, exec);
		if (stuck) return { ok: false, file: script, message: `${stuck} The script wasn't changed.` };
	}
	mkdirSync(dirname(log), { recursive: true });
	writeAtomic(script, text, 0o644);
	const xmlFile = windowsTaskXmlPath(spec);
	writeUtf16(xmlFile, windowsTaskXml(script, user, spec));
	let created: { code: number; out: string };
	try {
		created = await exec(schtasksPath(), ["/Create", "/TN", spec.label, "/XML", xmlFile, "/F"]);
	} finally {
		rmSync(xmlFile, { force: true });
	}
	if (created.code !== 0) {
		return {
			ok: false,
			file: script,
			// schtasks words its errors in the system's language, so every refusal gets the sentence, not just an English one.
			message: `Windows didn't make a scheduled task for ${user} (${created.out}); Polycarp never asks for administrator rights, so if your organization blocks scheduled tasks, ask its admin to allow them, or ${keepRunning}.`,
		};
	}
	// The task replaces a running copy itself (StopExisting), so /Run always starts the new script.
	const started = await exec(schtasksPath(), ["/Run", "/TN", spec.label]);
	if (started.code !== 0) return { ok: false, file: script, message: `schtasks /Run /TN ${spec.label} failed: ${started.out}. The task is made and starts at your next logon.` };
	return { ok: true, file: script, message: `Service installed (Task Scheduler task ${spec.label}, starts at logon; script ${script}); logs in ${log}.` };
}

/** The file that says a service is installed: the plist, the unit, or on Windows the script its task runs. */
export const serviceFile = (spec: ServiceSpec = SERVE_SERVICE): string | undefined =>
	platform() === "darwin" ? plistPath(spec) : platform() === "linux" ? unitPath(spec) : platform() === "win32" ? windowsScriptPath(spec) : undefined;
const launchdLog = (spec: ServiceSpec) => join(homedir(), "Library", "Logs", spec.logName);
export const serviceLogHint = (spec: ServiceSpec = SERVE_SERVICE) => (platform() === "darwin" ? launchdLog(spec) : platform() === "win32" ? windowsLog(spec) : `journalctl --user -u ${spec.unit}`);

/** After bootout, launchd can still list the service for a moment; bootstrap into that fails. */
async function waitUntilUnloaded(spec: ServiceSpec, exec: Runner): Promise<void> {
	const deadline = Date.now() + 5000;
	while ((await exec("launchctl", ["print", launchdTarget(spec)])).code === 0 && Date.now() < deadline) await sleep(250);
}

type Runner = (cmd: string, args: string[]) => Promise<{ code: number; out: string }> | { code: number; out: string };

/** Install and (re)start the user service. Returns the step that failed, if any; the file is written either way. Blocks the event loop while the service manager runs: for the CLI. */
export function installService(spec: ServiceSpec = SERVE_SERVICE): Promise<{ ok: boolean; message: string; file?: string }> {
	return installWith(spec, seam.exec ?? run);
}

/** The same install without blocking the event loop: for the native host, which keeps relaying while the service manager works. */
export function installServiceAsync(spec: ServiceSpec = SERVE_SERVICE, timeoutMs?: number): Promise<{ ok: boolean; message: string; file?: string }> {
	return installWith(spec, seam.exec ?? ((cmd, args) => runAsync(cmd, args, timeoutMs)));
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
	if (platform() !== "darwin" || !spec.legacy) return;
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
	// Windows never had a service under the old names.
	if (!old || !file || platform() === "win32" || !existsSync(file)) return NOTHING_RETIRED;
	const saved = savedFolders(old);
	const failure = (r: { code: number; out: string }, what: string) => (r.code === 0 ? undefined : `${what} failed: ${r.out}`);
	if (platform() === "darwin") {
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
		if (platform() === "darwin") await exec("launchctl", ["bootout", launchdTarget(spec)]);
		else if (platform() === "linux") await exec("systemctl", ["--user", "disable", "--now", spec.unit]);
	} catch {
		/* keep going */
	}
	try {
		if (file) {
			if (before !== undefined) writeAtomic(file, before, 0o644);
			else if (readIfFile(file) !== undefined) rmSync(file, { force: true });
		}
		if (platform() === "linux") await exec("systemctl", ["--user", "daemon-reload"]);
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
	const binary = seam.launcher ?? launcherBinary();
	const env = serviceEnvironment(saved);
	if (platform() === "darwin") {
		const log = launchdLog(spec);
		mkdirSync(dirname(log), { recursive: true });
		writeAtomic(plistPath(spec), plistText(binary, env, log, spec), 0o644);
		await exec("launchctl", ["bootout", launchdTarget(spec)]);
		await waitUntilUnloaded(spec, exec);
		const r = await bootstrapWithRetry(spec, exec);
		return { ok: r.code === 0, file: plistPath(spec), message: r.code === 0 ? `Service installed (${plistPath(spec)}); logs in ${log}.` : `launchctl bootstrap failed: ${r.out}. Run: launchctl bootstrap gui/${process.getuid?.() ?? 0} ${plistPath(spec)}` };
	}
	if (platform() === "linux") {
		writeAtomic(unitPath(spec), unitText(binary, env, spec), 0o644);
		for (const args of [["daemon-reload"], ["enable", spec.unit], ["restart", spec.unit]]) {
			const r = await exec("systemctl", ["--user", ...args]);
			if (r.code !== 0) return { ok: false, file: unitPath(spec), message: `systemctl --user ${args.join(" ")} failed: ${r.out}. The unit is at ${unitPath(spec)}.` };
		}
		return { ok: true, file: unitPath(spec), message: `Service installed (${unitPath(spec)}); journalctl --user -u ${spec.unit} shows its log.` };
	}
	if (platform() === "win32") return installWindows(spec, exec, binary, env);
	return { ok: false, message: `No service manager is set up for ${platform()}. Keep it running yourself: ${binary} ${spec.args.join(" ")}` };
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
	const run = seam.exec ?? runSync;
	if (platform() === "darwin" && existsSync(plistPath(spec))) {
		const r = run("launchctl", ["bootout", launchdTarget(spec)]);
		// bootout also fails when the service was never loaded; that is already stopped.
		if (r.code !== 0 && run("launchctl", ["print", launchdTarget(spec)]).code === 0) {
			return { ok: false, notes: [], failure: `launchctl bootout failed: ${r.out}. The service is still installed and ${spec.kept} is kept. Run: launchctl bootout ${launchdTarget(spec)}, then ${spec.off} again.` };
		}
		rmSync(plistPath(spec), { force: true });
		return { ok: true, notes: [`Stopped and removed ${plistPath(spec)}.`] };
	}
	if (platform() === "win32" && existsSync(windowsScriptPath(spec))) {
		// Ending a task that isn't running fails, which is the state wanted; the delete is what has to work.
		// /End ends only cmd.exe, and exits 0 only when the task was running; the program it started is ended by pid, and has to
		// be gone before the task is.
		const ended = run(schtasksPath(), ["/End", "/TN", spec.label]);
		const stuck = stopWindowsSync(spec, ended.code === 0, run);
		if (stuck) return { ok: false, notes: [], failure: `${stuck} The ${spec.label} task and ${spec.kept} are kept.` };
		const r = run(schtasksPath(), ["/Delete", "/TN", spec.label, "/F"]);
		if (r.code !== 0 && run(schtasksPath(), ["/Query", "/TN", spec.label]).code === 0) {
			return { ok: false, notes: [], failure: `schtasks /Delete /TN ${spec.label} failed: ${r.out}. The task is still there and ${spec.kept} is kept. Run: schtasks /End /TN ${spec.label} and schtasks /Delete /TN ${spec.label} /F, then ${spec.off} again.` };
		}
		rmSync(windowsScriptPath(spec), { force: true });
		return { ok: true, notes: [`Stopped and removed the ${spec.label} task and ${windowsScriptPath(spec)}; its log stays at ${windowsLog(spec)}.`] };
	}
	if (platform() === "linux" && existsSync(unitPath(spec))) {
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


/**
 * Read-only: is the service running right now? launchd's `state = running`, or systemd's `active`. False when the manager says it
 * isn't (or doesn't know it). Undefined where it can't be read reliably: on Windows schtasks words a task's status in the system's
 * language.
 */
export function serviceRunning(spec: ServiceSpec): boolean | undefined {
	if (process.platform === "darwin") {
		const r = run("launchctl", ["print", launchdTarget(spec)], 10_000);
		return r.code === 0 && /\bstate = running\b/.test(r.out);
	}
	if (process.platform === "linux") return run("systemctl", ["--user", "is-active", spec.unit], 10_000).out.trim() === "active";
	return undefined;
}
