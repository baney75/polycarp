/**
 * User services (launchd on macOS, systemd --user on Linux) that keep `tabkyra serve`, `tabkyra hub serve`
 * or `tabkyra link run` running. Shared by remote setup, hub setup and link.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tabkyraBinary } from "./harness.ts";
import { configDir } from "./files.ts";

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

/** The service reads remote.json (or hub.json, link.json) and oauth.json from the same directory as this shell; the socket directory only when it was moved. Both as absolute paths, since a service doesn't start in this shell's directory. */
export function serviceEnvironment(): Record<string, string> {
	const out: Record<string, string> = { TABKYRA_CONFIG_DIR: resolve(configDir()) };
	if (process.env.TABKYRA_SOCKET_DIR) out.TABKYRA_SOCKET_DIR = resolve(process.env.TABKYRA_SOCKET_DIR);
	return out;
}

/** A user service: what runs (`tabkyra <args>`), and the names the service manager knows it by. */
export interface ServiceSpec {
	label: string;
	unit: string;
	args: string[];
	logName: string;
	description: string;
	/** The command that undoes setup, for messages ("tabkyra remote off"). */
	off: string;
	/** What setup keeps when a stop fails, for messages ("remote.json"). */
	kept: string;
}

export const SERVE_SERVICE: ServiceSpec = {
	label: "com.tabkyra.serve",
	unit: "tabkyra-serve.service",
	args: ["serve"],
	logName: "tabkyra-serve.log",
	description: "Tabkyra serve (MCP over HTTP for claude.ai, ChatGPT and grok.com)",
	off: "tabkyra remote off",
	kept: "remote.json",
};

export const HUB_SERVICE: ServiceSpec = {
	label: "com.tabkyra.hub",
	unit: "tabkyra-hub.service",
	args: ["hub", "serve"],
	logName: "tabkyra-hub.log",
	description: "Tabkyra hub (one connector URL for many devices)",
	off: "tabkyra hub off",
	kept: "hub.json",
};

export const LINK_SERVICE: ServiceSpec = {
	label: "com.tabkyra.link",
	unit: "tabkyra-link.service",
	args: ["link", "run"],
	logName: "tabkyra-link.log",
	description: "Tabkyra link (this device, behind a hub)",
	off: "tabkyra link off",
	kept: "link.json",
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

async function installWith(spec: ServiceSpec, exec: Runner): Promise<{ ok: boolean; message: string; file?: string }> {
	const binary = tabkyraBinary();
	const env = serviceEnvironment();
	if (process.platform === "darwin") {
		const log = launchdLog(spec);
		mkdirSync(dirname(log), { recursive: true });
		writeAtomic(plistPath(spec), plistText(binary, env, log, spec), 0o644);
		await exec("launchctl", ["bootout", launchdTarget(spec)]);
		await waitUntilUnloaded(spec, exec);
		const r = await exec("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plistPath(spec)]);
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

/** Stop and remove the user service. A failed stop keeps the service file so `remote off` can be run again. */
export function removeService(spec: ServiceSpec = SERVE_SERVICE): { ok: boolean; notes: string[]; failure?: string } {
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

