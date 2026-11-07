/**
 * Coding harnesses Polycarp can serve: how to find them, whether the MCP server is
 * configured, and how to add it. Claude Code and Codex have `mcp add` commands; the
 * others get a config block to paste, because editing their JSON for the user would
 * risk clobbering comments and other servers.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { cliLauncherPath, launcherWorks } from "./install.ts";
import { COMPILED } from "./self.ts";

/**
 * true: the entry runs this CLI with `mcp`. false: no entry. "stale": the entry points at
 * something that no longer exists, so replacing it loses nothing. "other": it runs some
 * other existing command (a wrapper, another install); left alone unless the user says so.
 * undefined: we couldn't tell (unparseable config, harness CLI error).
 */
export type Configured = boolean | "stale" | "other" | undefined;

/** What agents call the MCP server. Its tools keep their names. */
export const MCP_NAME = "polycarp";
/** The name it had. An entry under it is replaced, wherever the helper finds one. */
export const OLD_MCP_NAME = "tabkyra";

export type HarnessId = "claude" | "codex" | "opencode" | "cursor" | "omp" | "pi";

export interface Harness {
	id: HarnessId;
	name: string;
	/** True when the harness is installed for this user. */
	detected: boolean;
	configured: Configured;
	/** The command the existing entry runs, when there is one. */
	currentCommand?: string;
	note?: string;
	/** The entry found is under the old name. */
	oldName?: boolean;
	/** Command that removes a stale entry before re-adding it. */
	removeCommand?: string[];
	/** Command that adds the server, when the harness has one. */
	addCommand?: string[];
	/** Where to paste `snippet`, when there is no add command. */
	configFile?: string;
	snippet?: string;
}

/** First match for `name` on PATH, or undefined. */
export function which(name: string): string | undefined {
	const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of extensions) {
			const candidate = join(dir, name + ext);
			if (existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

/** The absolute path harness configs run: the launcher `polycarp browser install` writes. */
export function tabkyraBinary(): string {
	return cliLauncherPath();
}

/** The agent launcher exists, is executable, and the program it runs is still there. */
export function launcherValid(): boolean {
	return launcherWorks(cliLauncherPath());
}

function sameFile(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/** Classify an entry's command line against this CLI. */
export function classify(command: string | undefined, args: string[]): Configured {
	if (!command) return undefined;
	const resolved = isAbsolute(command) ? command : which(command);
	if (resolved && basename(resolved) === "polycarp" && args.join(" ") === "browser mcp") return existsSync(resolved) ? true : "stale";
	if (command === cliLauncherPath()) {
		if (!launcherValid()) return "stale";
		// The right launcher with other arguments is a deliberate customization, not breakage.
		return args.join(" ") === "mcp" ? true : "other";
	}
	if (!resolved || !existsSync(resolved)) return "stale";
	const script = COMPILED ? process.execPath : process.argv[1];
	// `node /path/to/tabkyra mcp` is this CLI too.
	if (/^node(\.exe)?$/.test(basename(resolved)) && args.length === 2 && sameFile(args[0], script) && args[1] === "mcp") return true;
	if (sameFile(resolved, script)) return args.join(" ") === "mcp" ? true : "other";
	return "other";
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

interface EntryState {
	configured: Configured;
	currentCommand?: string;
	/** Why the state is what it is, when that isn't obvious. */
	note?: string;
	oldName?: boolean;
}

/** The tabkyra entry under `key` in a JSON config. Unparseable files are "unknown", not "configured". */
function jsonServerState(file: string, key: string, commandOf: (entry: Record<string, unknown>) => { command?: unknown; args?: unknown }): EntryState {
	if (!existsSync(file)) return { configured: false };
	const data = readJson(file);
	if (!data) return { configured: undefined };
	const servers = data[key] as Record<string, Record<string, unknown>> | undefined;
	const current = servers?.[MCP_NAME];
	const old = servers?.[OLD_MCP_NAME];
	if (!current && old && typeof old === "object") return { configured: "stale", oldName: true, note: "It's under the old name." };
	const entry = current;
	if (!entry || typeof entry !== "object") return { configured: false };
	const { command, args } = commandOf(entry);
	const cmd = typeof command === "string" ? command : undefined;
	const argList = Array.isArray(args) ? args.map(String) : [];
	return { configured: classify(cmd, argList), currentCommand: cmd };
}

/**
 * `claude mcp get` / `codex mcp get` run from the home directory. A clean non-zero exit
 * means no entry; a crash, timeout or output we can't parse means we can't tell.
 */
function cliServerState(binary: string, fields: { command: RegExp; args: RegExp; scope?: RegExp }): EntryState {
	// Windows harness CLIs are .cmd shims that spawnSync can't run without a shell.
	if (process.platform === "win32") return { configured: undefined, note: "Not checked on Windows." };
	const result = spawnSync(binary, ["mcp", "get", MCP_NAME], { encoding: "utf8", timeout: 15000, cwd: homedir() });
	if (result.error || result.signal) return { configured: undefined };
	if (result.status !== 0) {
		const old = spawnSync(binary, ["mcp", "get", OLD_MCP_NAME], { encoding: "utf8", timeout: 15000, cwd: homedir() });
		return !old.error && !old.signal && old.status === 0
			? { configured: "stale", oldName: true, note: "It's under the old name." }
			: { configured: false };
	}
	const out = result.stdout ?? "";
	// Claude Code: only a user-scope entry serves every project.
	if (fields.scope && !fields.scope.test(out)) {
		const scope = out.match(/^\s*Scope:\s*(.+)$/m)?.[1]?.trim() ?? "another scope";
		return { configured: undefined, note: `Claude Code has a polycarp entry in ${scope}, not in user scope.` };
	}
	const command = out.match(fields.command)?.[1]?.trim();
	if (command === undefined) return { configured: undefined };
	const args = (out.match(fields.args)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
	return { configured: classify(command, args), currentCommand: command };
}

/** Pretty JSON with short arrays kept on one line, ready to paste into a config. */
function snippet(value: unknown): string {
	return JSON.stringify(value, null, 2).replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_m, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`);
}

export function harnesses(binary = tabkyraBinary()): Harness[] {
	const home = homedir();
	const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
	const list: Harness[] = [];

	const claude = which("claude");
	const claudeEntry: EntryState = claude ? cliServerState(claude, { command: /^\s*Command:\s*(.+)$/m, args: /^\s*Args:\s*(.*)$/m, scope: /^\s*Scope:\s*User/m }) : { configured: undefined };
	list.push({
		id: "claude",
		name: "Claude Code",
		detected: Boolean(claude),
		...claudeEntry,
		addCommand: ["claude", "mcp", "add", "--scope", "user", MCP_NAME, "--", binary, "mcp"],
		removeCommand: ["claude", "mcp", "remove", "--scope", "user", claudeEntry.oldName ? OLD_MCP_NAME : MCP_NAME],
	});

	const codex = which("codex");
	const codexEntry: EntryState = codex ? cliServerState(codex, { command: /^\s*command:\s*(.+)$/m, args: /^\s*args:\s*(.*)$/m }) : { configured: undefined };
	list.push({
		id: "codex",
		name: "Codex",
		detected: Boolean(codex),
		...codexEntry,
		addCommand: ["codex", "mcp", "add", MCP_NAME, "--", binary, "mcp"],
		removeCommand: ["codex", "mcp", "remove", codexEntry.oldName ? OLD_MCP_NAME : MCP_NAME],
	});

	const opencodeFile = join(configHome, "opencode", "opencode.json");
	list.push({
		id: "opencode",
		name: "OpenCode",
		detected: Boolean(which("opencode")) || existsSync(join(configHome, "opencode")),
		...jsonServerState(opencodeFile, "mcp", (e) => (Array.isArray(e.command) ? { command: e.command[0], args: e.command.slice(1) } : { command: e.command, args: e.args })),
		configFile: opencodeFile,
		snippet: snippet({ mcp: { [MCP_NAME]: { type: "local", command: [binary, "mcp"], enabled: true } } }),
	});

	const cursorFile = join(home, ".cursor", "mcp.json");
	list.push({
		id: "cursor",
		name: "Cursor",
		detected: Boolean(which("cursor") || which("cursor-agent")) || existsSync(join(home, ".cursor")),
		...jsonServerState(cursorFile, "mcpServers", (e) => ({ command: e.command, args: e.args })),
		configFile: cursorFile,
		snippet: snippet({ mcpServers: { [MCP_NAME]: { command: binary, args: ["mcp"] } } }),
	});

	const ompFile = join(home, ".omp", "agent", "mcp.json");
	list.push({
		id: "omp",
		name: "OMP",
		detected: Boolean(which("omp")) || existsSync(join(home, ".omp")),
		...jsonServerState(ompFile, "mcpServers", (e) => ({ command: e.command, args: e.args })),
		configFile: ompFile,
		snippet: snippet({ mcpServers: { [MCP_NAME]: { type: "stdio", command: binary, args: ["mcp"], enabled: true } } }),
	});

	// pi has no MCP client; `polycarp browser pi-extension` writes a native pi extension instead.
	// Setup prints that command rather than running it, like the other print-only harnesses.
	const piFile = join(home, ".pi", "agent", "extensions", "tabkyra.ts");
	list.push({
		id: "pi",
		name: "pi",
		detected: Boolean(which("pi")) || existsSync(join(home, ".pi")),
		configured: existsSync(piFile),
		configFile: piFile,
		snippet: `${binary} pi-extension`,
	});

	return list;
}

/** Shell-quote a command for display. */
export function shellJoin(argv: string[]): string {
	return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ");
}

/** Run a harness command, inheriting the terminal. Returns true on exit 0. */
export function runCommand(argv: string[]): boolean {
	try {
		execFileSync(argv[0], argv.slice(1), { stdio: "inherit", timeout: 30000 });
		return true;
	} catch {
		return false;
	}
}
