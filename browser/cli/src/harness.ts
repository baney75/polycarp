/**
 * Coding harnesses Tabkyra can serve: how to find them, whether the MCP server is
 * configured, and how to add it. Claude Code and Codex have `mcp add` commands; the
 * others get a config block to paste, because editing their JSON for the user would
 * risk clobbering comments and other servers.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { cliLauncherPath } from "./install.ts";

/**
 * true: the entry runs this CLI with `mcp`. false: no entry. "stale": the entry points at
 * something that no longer exists, so replacing it loses nothing. "other": it runs some
 * other existing command (a wrapper, another install); left alone unless the user says so.
 * undefined: we couldn't tell (unparseable config, harness CLI error).
 */
export type Configured = boolean | "stale" | "other" | undefined;

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

/** The absolute path harness configs run: the launcher `tabkyra install` writes. */
export function tabkyraBinary(): string {
	return cliLauncherPath();
}

/** The launcher exists, is executable, and the script it runs is still there. */
export function launcherValid(): boolean {
	const path = cliLauncherPath();
	try {
		if (process.platform !== "win32" && (statSync(path).mode & 0o111) === 0) return false;
		const script = readFileSync(path, "utf8").match(/"([^"]+)"\s+(?:"\$@"|%\*)/)?.[1];
		return Boolean(script && existsSync(script));
	} catch {
		return false;
	}
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
	if (command === cliLauncherPath()) {
		if (!launcherValid()) return "stale";
		// The right launcher with other arguments is a deliberate customization, not breakage.
		return args.join(" ") === "mcp" ? true : "other";
	}
	if (!resolved || !existsSync(resolved)) return "stale";
	const script = process.argv[1];
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
}

/** The tabkyra entry under `key` in a JSON config. Unparseable files are "unknown", not "configured". */
function jsonServerState(file: string, key: string, commandOf: (entry: Record<string, unknown>) => { command?: unknown; args?: unknown }): EntryState {
	if (!existsSync(file)) return { configured: false };
	const data = readJson(file);
	if (!data) return { configured: undefined };
	const servers = data[key] as Record<string, Record<string, unknown>> | undefined;
	const entry = servers?.tabkyra;
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
	const result = spawnSync(binary, ["mcp", "get", "tabkyra"], { encoding: "utf8", timeout: 15000, cwd: homedir() });
	if (result.error || result.signal) return { configured: undefined };
	if (result.status !== 0) return { configured: false };
	const out = result.stdout ?? "";
	// Claude Code: only a user-scope entry serves every project.
	if (fields.scope && !fields.scope.test(out)) {
		const scope = out.match(/^\s*Scope:\s*(.+)$/m)?.[1]?.trim() ?? "another scope";
		return { configured: undefined, note: `Claude Code has a tabkyra entry in ${scope}, not in user scope.` };
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
	list.push({
		id: "claude",
		name: "Claude Code",
		detected: Boolean(claude),
		...(claude
			? cliServerState(claude, { command: /^\s*Command:\s*(.+)$/m, args: /^\s*Args:\s*(.*)$/m, scope: /^\s*Scope:\s*User/m })
			: { configured: undefined }),
		addCommand: ["claude", "mcp", "add", "--scope", "user", "tabkyra", "--", binary, "mcp"],
		removeCommand: ["claude", "mcp", "remove", "--scope", "user", "tabkyra"],
	});

	const codex = which("codex");
	list.push({
		id: "codex",
		name: "Codex",
		detected: Boolean(codex),
		...(codex ? cliServerState(codex, { command: /^\s*command:\s*(.+)$/m, args: /^\s*args:\s*(.*)$/m }) : { configured: undefined }),
		addCommand: ["codex", "mcp", "add", "tabkyra", "--", binary, "mcp"],
		removeCommand: ["codex", "mcp", "remove", "tabkyra"],
	});

	const opencodeFile = join(configHome, "opencode", "opencode.json");
	list.push({
		id: "opencode",
		name: "OpenCode",
		detected: Boolean(which("opencode")) || existsSync(join(configHome, "opencode")),
		...jsonServerState(opencodeFile, "mcp", (e) => (Array.isArray(e.command) ? { command: e.command[0], args: e.command.slice(1) } : { command: e.command, args: e.args })),
		configFile: opencodeFile,
		snippet: snippet({ mcp: { tabkyra: { type: "local", command: [binary, "mcp"], enabled: true } } }),
	});

	const cursorFile = join(home, ".cursor", "mcp.json");
	list.push({
		id: "cursor",
		name: "Cursor",
		detected: Boolean(which("cursor") || which("cursor-agent")) || existsSync(join(home, ".cursor")),
		...jsonServerState(cursorFile, "mcpServers", (e) => ({ command: e.command, args: e.args })),
		configFile: cursorFile,
		snippet: snippet({ mcpServers: { tabkyra: { command: binary, args: ["mcp"] } } }),
	});

	const ompFile = join(home, ".omp", "agent", "mcp.json");
	list.push({
		id: "omp",
		name: "OMP",
		detected: Boolean(which("omp")) || existsSync(join(home, ".omp")),
		...jsonServerState(ompFile, "mcpServers", (e) => ({ command: e.command, args: e.args })),
		configFile: ompFile,
		snippet: snippet({ mcpServers: { tabkyra: { type: "stdio", command: binary, args: ["mcp"], enabled: true } } }),
	});

	// pi has no MCP client; `tabkyra pi-extension` writes a native pi extension instead.
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
