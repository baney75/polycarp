/**
 * Where Tailscale's and Cloudflare's own installers put their commands on Windows, for when the program is not on PATH (a
 * scheduled task, or a shell opened before the install changed PATH). Only these fixed folders are searched: a path nobody
 * asked for is never run.
 *
 * - tailscale.exe: the MSI's default folder is C:\Program Files\Tailscale (tailscale.com/kb/1189/install-windows-msi).
 * - cloudflared.exe: the MSI installs to <Program Files>\cloudflared, the 64-bit folder for the amd64 build and the 32-bit one
 *   for the 386 build (cloudflared.wxs at the pinned release, github.com/cloudflare/cloudflared, ProgramFiles64Folder and
 *   ProgramFilesFolder; issue #992 reports older x64 MSIs that used Program Files (x86)), so both are searched.
 */
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { which } from "./harness.ts";

export type WindowsTool = "tailscale" | "cloudflared";

/** What a lookup reads, so tests can ask for Windows on any computer. Production code passes nothing. */
export interface ToolLookup {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	exists?: (path: string) => boolean;
	which?: (name: string) => string | undefined;
}

/** The install folders to search on Windows, in order. %ProgramFiles% and %ProgramFiles(x86)% as Windows sets them. */
export function windowsInstallPaths(tool: WindowsTool, env: NodeJS.ProcessEnv = process.env): string[] {
	const programFiles = env.ProgramFiles || "C:\\Program Files";
	if (tool === "tailscale") return [win32.join(programFiles, "Tailscale", "tailscale.exe")];
	const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
	return [win32.join(programFiles, "cloudflared", "cloudflared.exe"), win32.join(programFilesX86, "cloudflared", "cloudflared.exe")];
}

/** On Windows: `<tool>.exe` on PATH, then the installer's folders. Undefined when neither has it. */
export function windowsTool(tool: WindowsTool, lookup: ToolLookup = {}): string | undefined {
	const exists = lookup.exists ?? existsSync;
	return (lookup.which ?? which)(`${tool}.exe`) ?? windowsInstallPaths(tool, lookup.env).find((path) => exists(path));
}

/**
 * The program name Windows reports for `pid`, from tasklist.exe by full path: undefined when no process has that pid, "unknown"
 * when tasklist itself failed (learn.microsoft.com/windows-server/administration/windows-commands/tasklist).
 */
export function windowsProcessImage(pid: number, exec: (cmd: string, args: string[]) => { code: number; out: string }, env: NodeJS.ProcessEnv = process.env): string | undefined | "unknown" {
	const r = exec(win32.join(env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe"), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
	if (r.code !== 0) return "unknown";
	for (const line of r.out.split(/\r?\n/)) {
		const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
		if (m && Number(m[2]) === pid) return m[1];
	}
	return undefined;
}
