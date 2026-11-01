/**
 * Every `tabkyra` command, once. `--help`, the shell completions and the argument checks are all
 * generated from this table: a help row's flags are exactly the flags its subcommand accepts, so
 * help, completions and the parser can't disagree.
 */

import { SETUP_FLAGS, UPDATE_FLAGS } from "./parse-args.ts";

export interface SubcommandSpec {
	name: string;
	/** Its positional arguments as help shows them ("<name>", "[path...]"). Flags are added from `flags`. */
	args?: string;
	what: string;
	flags?: string[];
	/** Positional arguments after the subcommand, at most (default 0). */
	max?: number;
	/** Its arguments are file or folder paths: completions fall back to file names there. */
	paths?: boolean;
}

export interface CommandSpec {
	/** The command word, e.g. "status" or "skill". */
	name: string;
	/** Positional arguments as help shows them ("<host>", "[dir]"). Flags are added from `flags`. */
	args?: string;
	what: string;
	/** One line for the whole command in completions (commands with subcommands). */
	summary?: string;
	group: "Get started" | "Agents" | "Sessions" | "Remote" | "Library" | "Sites" | "Troubleshoot";
	flags?: string[];
	/** Second words (`skill install`, `token list`); each gets its own help row and flags. */
	subcommands?: SubcommandSpec[];
	/** Arguments after the command a command takes at most (default 0). Ignored with subcommands. */
	positional?: number;
	/** Its arguments are paths: completions fall back to file names. */
	paths?: boolean;
	/** The command parses its own arguments (setup, update, library, skill); argsProblem leaves it alone. */
	selfParsed?: boolean;
	/** The subcommand a bare `tabkyra <name>` runs (`tabkyra sessions` lists). */
	defaultSubcommand?: string;
	/** Values completed for the first argument (`completion zsh`). */
	values?: string[];
	/** Hidden from help and completions (aliases, internal entry points). */
	hidden?: boolean;
}

/** Options that take a value (`--top 3` or `--top=3`), with the placeholder help shows. */
export const VALUE_HINTS: Record<string, string> = {
	"--offset": "N",
	"--limit": "N",
	"--session": "<name>",
	"--top": "N",
	"--to": "<version>",
	"--cases": "<file>",
	"--base": "<checkout>",
	"--router": "<script>",
	"--port": "N",
	"--public-url": "https://host",
	"--redirect-host": "a,b",
	"--allow-host": "a,b",
	"--scope": "a,b",
	"--name": "<name>",
	"--timeout": "<seconds>",
	"--channel": "stable|nightly",
	"--auto-check": "on|off",
	"--quote": "TEXT",
	"--location": "TEXT",
	"--note": "TEXT",
	"--tag": "TAG",
	"--style": "apa|mla|...",
	"--format": "<format>",
	"--out": "FILE",
	"--folder": "NAME",
	"--file": "<file>",
	"--confirm": "<code>",
	"--repo": "owner/name",
	"--branch": "<branch>",
	"--serial": "N",
	"--source": "<commit>",
};

export const VALUE_FLAGS = new Set(Object.keys(VALUE_HINTS));

/** Value options whose value is a path: completions offer file names after them. */
const PATH_VALUES = new Set(["--cases", "--base", "--router", "--out", "--file"]);

export const COMMANDS: CommandSpec[] = [
	{ name: "setup", selfParsed: true, what: "Build, register, load, connect and add to your agents", group: "Get started", flags: SETUP_FLAGS },
	{ name: "status", what: "Is the extension connected? Which sites are allowed?", group: "Get started", flags: ["--json"] },
	{ name: "mcp", what: "MCP server on stdio (what Claude Code, Codex, OpenCode run)", group: "Agents", flags: ["--session"] },
	{
		name: "copilot-sdk",
		summary: "GitHub's Copilot SDK, for the side panel's Copilot sign-in",
		what: "GitHub's Copilot SDK",
		group: "Agents",
		defaultSubcommand: "status",
		subcommands: [
			{ name: "install", what: "Install the pinned SDK (about 160 MB) for Sign in with GitHub Copilot" },
			{ name: "status", what: "Is the SDK installed?" },
		],
	},
	{ name: "pi-extension", positional: 1, paths: true, args: "[dir]", what: "Write a pi extension to ~/.pi/agent/extensions/tabkyra.ts", group: "Agents" },
	{
		name: "skill",
		selfParsed: true,
		summary: "Install, list, lint, match and edit skills",
		what: "Agent skills",
		group: "Agents",
		subcommands: [
			{ name: "install", args: "[name...]", what: "Install the bundled skills into Claude Code, Codex and OpenCode", flags: ["--all", "--force"], max: 64 },
			{ name: "list", what: "The skills in use, what each is for, its version and source", flags: ["--json"] },
			{ name: "print", args: "[name]", what: "A skill as text for AGENTS.md; --raw is the exact SKILL.md", flags: ["--raw"], max: 1 },
			{ name: "lint", args: "[path...]", what: "Check skills for hidden text, injection and missing structure; --community adds the community rules", flags: ["--community"], max: 64, paths: true },
			{ name: "apply", args: "<folder>", what: "Check and show an edited skill; --yes backs up and installs it (/rsi)", flags: ["--yes"], max: 1, paths: true },
			{ name: "revert", args: "<name>", what: "Drop your edit and go back to the bundled skill", max: 1 },
			{ name: "match", args: '"<task>"', what: "Which skill fits a task, best first, or none", flags: ["--json", "--top"], max: 64 },
			{ name: "eval", what: "Run the router's regression and held-out cases and gates", flags: ["--json", "--update-baseline", "--cases", "--base", "--router"] },
			{ name: "versions", args: "<name>", what: "Bundled, local and backed-up versions of a skill", flags: ["--json"], max: 1 },
			{ name: "rollback", args: "<name>", what: "Restore a backed-up version, with apply's checks", flags: ["--to", "--yes"], max: 1 },
			{ name: "edit", args: "<name>", what: "Draft an edit in $EDITOR, show the diff, apply on yes", flags: ["--yes", "--draft-only"], max: 1 },
			{ name: "refresh", what: "Refresh installed bundled skills you haven't edited", flags: ["--json"] },
			{ name: "write", args: "<name>", what: "Check new SKILL.md text (--file or stdin) with the lint; --yes saves it as a local skill", flags: ["--file", "--yes"], max: 1 },
			{ name: "test", args: "<name|folder>", what: "Lint, community rules and the router eval CI runs, for one skill", flags: ["--cases", "--json"], max: 1, paths: true },
			{ name: "remove", args: "<name>", what: "Remove a local skill or edit (kept in history), or turn off a community skill", max: 1 },
			{ name: "enable", args: "<name>", what: "Turn a community skill you removed back on", max: 1 },
			{ name: "sync", what: "Fetch and verify the signed community catalog now; --off and --on opt out and in", flags: ["--on", "--off", "--json"] },
			{ name: "submit", args: "<name|folder>", what: "Preview a community skill pull request; --confirm <code> from the preview opens it with gh", flags: ["--cases", "--repo", "--branch", "--note", "--dry-run", "--confirm", "--json"], max: 1, paths: true },
			{ name: "catalog", args: "<checkout>", what: "Build the community catalog (run by CI before signing)", flags: ["--out", "--serial", "--source"], max: 1, paths: true },
		],
	},
	{
		name: "sessions",
		summary: "Agent sessions and their tab groups",
		what: "Agent sessions",
		group: "Sessions",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", what: "Every agent session: group, tabs, connected or idle", flags: ["--all", "--json"] },
			{ name: "show", args: "<name>", what: "One session: its group, tabs, times, and how to resume it", flags: ["--json"], max: 1 },
			{ name: "rename", args: "<old> <new>", what: "Rename; resume it later with tabkyra mcp --session <new>", flags: ["--json"], max: 2 },
			{ name: "end", args: "<name>", what: "End it: its tabs become yours (or close, with --close)", flags: ["--close", "--json"], max: 1 },
			{ name: "release", args: "<name>", what: "Hand all its tabs to you, out of the group, and end it", flags: ["--json"], max: 1 },
			{ name: "focus", args: "<name>", what: "Show its group to you", flags: ["--json"], max: 1 },
			{ name: "collapse", args: "<name>", what: "Fold its group", flags: ["--json"], max: 1 },
			{ name: "expand", args: "<name>", what: "Unfold its group", flags: ["--json"], max: 1 },
		],
	},
	{
		name: "threads",
		summary: "Past side panel chats, for you and your agents",
		what: "Past side panel chats",
		group: "Sessions",
		defaultSubcommand: "list",
		subcommands: [
			{ name: "list", args: "[words]", what: "Past chats, newest first (live, or from the local mirror)", flags: ["--json", "--offset", "--limit"], max: 64 },
			{ name: "show", args: "<id>", what: "One chat as text, 40 messages a page", flags: ["--json", "--offset", "--limit"], max: 1 },
			{ name: "search", args: "<words>", what: "Chats that mention all the words, with snippets", flags: ["--json", "--limit"], max: 64 },
			{ name: "export", args: "<id>", what: "One chat as Markdown or JSON", flags: ["--format", "--out"], max: 1 },
		],
	},
	{ name: "tabs", positional: 1, args: "[session]", what: "Every agent tab, by session", group: "Sessions", flags: ["--json"] },
	{
		name: "serve",
		what: "MCP over HTTP on loopback, for tunnels; every request needs a token (--public-url adds OAuth for web connectors)",
		group: "Remote",
		flags: ["--port", "--public-url", "--redirect-host", "--allow-host"],
	},
	{
		name: "token",
		summary: "Scoped, revocable tokens for serve",
		what: "Tokens for serve",
		group: "Remote",
		subcommands: [
			{ name: "create", args: "<name>", what: "A scoped, revocable token, shown once", flags: ["--scope"], max: 1 },
			{ name: "list", what: "Every token and when it was last used", flags: ["--json"] },
			{ name: "revoke", args: "<id|name|client id|grant id>", what: "End a token, an OAuth client and its grants, or one grant", max: 1 },
			{ name: "passcode", what: "A new passcode for the OAuth approval page, shown once" },
			{ name: "clients", what: "OAuth clients (claude.ai, ChatGPT, grok.com) and their grants", flags: ["--json"] },
			{ name: "scopes", what: "The scopes a token can have", flags: ["--json"] },
		],
	},
	{
		name: "hub",
		group: "Remote",
		summary: "Hub profile: read+navigate scopes, Funnel-off tunnel",
		what: "Hub token and Funnel-off Tailscale tunnel",
		subcommands: [
			{ name: "token", what: "Create a token scoped to browser.read and browser.navigate", flags: ["--name"] },
			{ name: "tunnel", what: "Open Tailscale serve for hub (Funnel stays off)", flags: ["--port"] },
		],
	},
	{
		name: "remote",
		summary: "One command to reach serve from claude.ai, ChatGPT and grok.com",
		what: "Remote access for web connectors",
		group: "Remote",
		subcommands: [
			{ name: "setup", what: "Tailscale Funnel (or your own --public-url), a passcode and a service that keeps serve running", flags: ["--public-url", "--port", "--no-service"] },
			{ name: "status", what: "Is it up and reachable from the internet?", flags: ["--json"] },
			{ name: "off", what: "Stop the service, turn Funnel off and remove remote.json" },
		],
	},
	{
		name: "tunnel",
		summary: "Reach serve over Tailscale or Cloudflare",
		what: "Tunnels for serve",
		group: "Remote",
		subcommands: [
			{ name: "tailscale", what: "Reach serve from your tailnet over HTTPS (--public: Funnel)", flags: ["--port", "--public", "--off"] },
			{ name: "cloudflare", what: "A free cloudflared quick tunnel", flags: ["--port", "--off"] },
		],
	},
	{
		name: "library",
		selfParsed: true,
		summary: "Verified sources: add, search, cite, export",
		what: "The source library",
		group: "Library",
		subcommands: [
			{ name: "add", args: "<doi|arxiv>", what: "Save a source, verified against its registry, OpenAlex and retractions", flags: ["--quote", "--location", "--note", "--tag"] },
			{ name: "search", args: "<words>", what: "Find saved sources", flags: ["--json"] },
			{ name: "list", what: "Every saved source", flags: ["--json"] },
			{ name: "cite", args: "<key>", what: "Format a reference", flags: ["--style"] },
			{ name: "export", what: "For Zotero, Word and LaTeX", flags: ["--format", "--out"] },
			{ name: "obsidian", args: "<vault>", what: "One note per source in <vault>/Sources", flags: ["--folder"], paths: true },
			{ name: "verify", args: "[key...]", what: "Re-run the registry and retraction checks" },
			{ name: "remove", args: "<key>", what: "Drop a source from the library" },
		],
	},
	{ name: "allow", positional: 1, args: "<host>", what: "Let agents open a site (subdomains included)", group: "Sites" },
	{ name: "ask", what: "Agents ask before opening a site not yet allowed (default)", group: "Sites" },
	{ name: "allow-all", what: "Agents may open any site without asking", group: "Sites" },
	{ name: "yolo", what: "Old name of allow-all", group: "Sites", hidden: true },
	{ name: "doctor", what: "Check everything; one fix per problem", group: "Troubleshoot", flags: ["--json"] },
	{
		name: "update",
		selfParsed: true,
		what: "Install the latest signed release",
		group: "Troubleshoot",
		flags: UPDATE_FLAGS,
	},
	{ name: "install", what: "Re-register the native host with every browser", group: "Troubleshoot", flags: ["--force"] },
	{ name: "reload", what: "Reload the extension after rebuilding dist-chrome", group: "Troubleshoot" },
	{ name: "debug", what: "Bridge state, request timings and a benchmark (JSON)", group: "Troubleshoot" },
	{ name: "completion", positional: 1, args: "zsh|bash|fish", what: 'Shell completions: eval "$(tabkyra completion zsh)"', group: "Troubleshoot", values: ["zsh", "bash", "fish"] },
	{ name: "version", what: "This CLI's version (also --version)", group: "Troubleshoot", flags: ["--json"] },
	{ name: "help", selfParsed: true, what: "This help (also --help)", group: "Troubleshoot", hidden: true },
	{ name: "host", selfParsed: true, what: "The native host the browser starts", group: "Troubleshoot", hidden: true },
];

export const VISIBLE_COMMANDS = COMMANDS.filter((c) => !c.hidden);

export function commandSpec(name: string): CommandSpec | undefined {
	// --version and -v are the version command.
	const key = name === "--version" || name === "-v" ? "version" : name === "--help" || name === "-h" ? "help" : name;
	return COMMANDS.find((c) => c.name === key);
}

/** "[--json] [--top N]": the flags as help and usage lines show them. */
export function flagHints(flags: string[] = []): string {
	return flags.map((f) => ` [${f}${VALUE_HINTS[f] ? ` ${VALUE_HINTS[f]}` : ""}]`).join("");
}

/** One help row per command, or per subcommand: [usage after "tabkyra ", what it does]. */
export function helpRows(spec: CommandSpec): Array<[string, string]> {
	if (spec.subcommands)
		return spec.subcommands.map((sub) => [`${spec.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}${flagHints(sub.flags)}`, sub.what]);
	return [[`${spec.name}${spec.args ? ` ${spec.args}` : ""}${flagHints(spec.flags)}`, spec.what]];
}

/**
 * Why `args` (everything after the command word) don't fit the command's spec, or undefined when
 * they do: an unknown option, a switch given a value, a value option without its value, or too
 * many arguments. Commands with subcommands are checked against the subcommand's own flags.
 */
export function argsProblem(command: string, args: string[]): string | undefined {
	const spec = commandSpec(command);
	if (!spec || spec.selfParsed) return undefined;
	const name = (a: string) => a.split("=")[0];
	const positional = args.filter((a, i) => !a.startsWith("-") && !(VALUE_FLAGS.has(args[i - 1] ?? "") && !args[i - 1].includes("=")));
	let flags = spec.flags ?? [];
	let max = spec.positional ?? 0;
	let usage = `Usage: tabkyra ${helpRows(spec)[0][0]}`;
	if (spec.subcommands) {
		const sub = spec.subcommands.find((x) => x.name === (positional[0] ?? spec.defaultSubcommand));
		// An unknown or missing subcommand is the command's own usage error, with its list.
		if (!sub) return undefined;
		flags = sub.flags ?? [];
		max = (positional[0] === undefined ? 0 : 1) + (sub.max ?? 0);
		usage = `Usage: tabkyra ${spec.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}${flagHints(flags)}`;
	}
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (!a.startsWith("-")) continue;
		if (!flags.includes(name(a))) return `Unknown option "${name(a)}". ${usage}`;
		// A switch takes no value: "--off=1" must not pass here and then go unseen (the dispatcher
		// matches switches exactly).
		if (a.includes("=") && !VALUE_FLAGS.has(name(a))) return `${name(a)} takes no value. ${usage}`;
		if (VALUE_FLAGS.has(name(a))) {
			const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
			if (value === undefined || value === "" || (!a.includes("=") && value.startsWith("-"))) return `${name(a)} needs a value. ${usage}`;
		}
	}
	if (positional.length > max) return `Unexpected argument "${positional[max]}". ${usage}`;
	return undefined;
}

/** Exit codes every command uses; also printed by --help. */
export const EXIT_CODES =
	"Exit codes: 0 success, 1 failed, not connected or nothing found, 2 usage error; update --check 100 when an update exists, library add 3 retracted and 4 unchecked.";

function sh(word: string): string {
	return word.replace(/[^A-Za-z0-9_.:,|/-]/g, "");
}

/** Descriptions are quoted for each shell; strip what could end the quote. */
function desc(text: string): string {
	return text.replace(/["'`$\\[\]:]/g, "").replace(/\s+/g, " ");
}

/**
 * Completion scripts. Each offers a command's subcommands, then only the chosen subcommand's
 * flags; where a command or subcommand takes paths (and after --out, --cases, --base, --router)
 * the shell's own file completion runs, so installing these never takes path completion away.
 */
export function completionScript(shell: string): string | undefined {
	const cmds = VISIBLE_COMMANDS;
	const pathFlags = [...PATH_VALUES].map(sh).join(" ");
	if (shell === "zsh") {
		const lines = [
			"#compdef tabkyra",
			'# tabkyra completion for zsh. Load it with: eval "$(tabkyra completion zsh)"',
			"_tabkyra() {",
			"  local -a commands subs flags",
			"  local paths=0",
			"  commands=(",
			...cmds.map((c) => `    '${sh(c.name)}:${desc(c.summary ?? c.what)}'`),
			"  )",
			"  if (( CURRENT == 2 )); then",
			"    _describe -t commands 'tabkyra command' commands",
			"    return",
			"  fi",
			"  case $words[2] in",
		];
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			if (!subs.length && !c.flags?.length && !c.values?.length && !c.paths) continue;
			lines.push(`    ${sh(c.name)})`);
			if (subs.length) {
				lines.push(`      subs=(${subs.map((s) => `'${sh(s.name)}:${desc(s.what)}'`).join(" ")})`);
				lines.push("      case $words[3] in");
				for (const s of subs) {
					if (!s.flags?.length && !s.paths) continue;
					lines.push(`        ${sh(s.name)}) flags=(${(s.flags ?? []).map(sh).join(" ")}); paths=${s.paths ? 1 : 0} ;;`);
				}
				lines.push("      esac");
			} else {
				if (c.values?.length) lines.push(`      subs=(${c.values.map((v) => `'${sh(v)}'`).join(" ")})`);
				lines.push(`      flags=(${(c.flags ?? []).map(sh).join(" ")}); paths=${c.paths ? 1 : 0}`);
			}
			lines.push("      ;;");
		}
		lines.push(
			"  esac",
			"  if (( CURRENT == 3 )) && (( ${#subs} )); then",
			"    _describe -t subcommands 'subcommand' subs",
			"  elif [[ $PREFIX == -* ]]; then",
			"    compadd -- $flags",
			`  elif (( paths )) || [[ " ${pathFlags} " == *" \${words[CURRENT-1]} "* ]]; then`,
			"    _files",
			"  fi",
			"}",
			"# compdef exists once compinit has run. If the zshrc runs it later (oh-my-zsh, zinit,",
			"# prezto), register at the first prompt instead of running compinit a second time.",
			"if (( $+functions[compdef] )); then",
			"  compdef _tabkyra tabkyra",
			"else",
			"  autoload -Uz add-zsh-hook",
			"  _tabkyra_register() {",
			"    (( $+functions[compdef] )) && compdef _tabkyra tabkyra",
			"    add-zsh-hook -d precmd _tabkyra_register",
			"  }",
			"  add-zsh-hook precmd _tabkyra_register",
			"fi",
			"",
		);
		return lines.join("\n");
	}
	if (shell === "bash") {
		const valueCases = Object.entries(VALUE_HINTS)
			.filter(([f]) => !PATH_VALUES.has(f))
			.map(([f, hint]) => {
				// A hint like "stable|nightly" lists the values; anything else is free text.
				const values = /^[a-z0-9]+(\|[a-z0-9]+)+$/.test(hint) ? hint.split("|").join(" ") : "";
				return `    ${sh(f)}) ${values ? `COMPREPLY=( $(compgen -W "${values}" -- "$cur") ); ` : ""}compopt +o default 2>/dev/null; return ;;`;
			});
		const lines = [
			'# tabkyra completion for bash. Load it with: eval "$(tabkyra completion bash)"',
			"_tabkyra() {",
			'  local cur="${COMP_WORDS[COMP_CWORD]}" prev="${COMP_WORDS[COMP_CWORD-1]}" paths=0',
			"  COMPREPLY=()",
			'  if [ "$COMP_CWORD" -eq 1 ]; then',
			`    COMPREPLY=( $(compgen -W "${cmds.map((c) => sh(c.name)).join(" ")}" -- "$cur") )`,
			"    compopt +o default 2>/dev/null",
			"    return",
			"  fi",
			'  case "$prev" in',
			"    # A path after --out and friends: file completion (-o default).",
			`    ${[...PATH_VALUES].map(sh).join("|")}) return ;;`,
			"    # Any other value: its values when they are a fixed list, never the flags.",
			...valueCases,
			"  esac",
			'  local words=""',
			'  case "${COMP_WORDS[1]}" in',
		];
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			if (subs.length) {
				lines.push(`    ${sh(c.name)})`);
				lines.push(`      if [ "$COMP_CWORD" -eq 2 ]; then words="${subs.map((s) => sh(s.name)).join(" ")}"; else`);
				lines.push('        case "${COMP_WORDS[2]}" in');
				for (const s of subs) if (s.flags?.length || s.paths) lines.push(`          ${sh(s.name)}) words="${(s.flags ?? []).map(sh).join(" ")}"${s.paths ? "; paths=1" : ""} ;;`);
				lines.push("        esac");
				lines.push("      fi ;;");
			} else {
				const all = [...(c.values ?? []), ...(c.flags ?? [])];
				if (all.length || c.paths) lines.push(`    ${sh(c.name)}) words="${all.map(sh).join(" ")}"${c.paths ? "; paths=1" : ""} ;;`);
			}
		}
		lines.push(
			"  esac",
			"  # Where a path goes, a word without a dash completes as a file name, not as a flag.",
			'  if [ "$paths" = 1 ] && [[ "$cur" != -* ]]; then return; fi',
			'  COMPREPLY=( $(compgen -W "$words" -- "$cur") )',
			"  # File names only where the command takes a path (compopt needs bash 4; older bash keeps them).",
			'  [ "$paths" = 1 ] || compopt +o default 2>/dev/null',
			"}",
			"complete -o bashdefault -o default -F _tabkyra tabkyra",
			"",
		);
		return lines.join("\n");
	}
	if (shell === "fish") {
		const lines = ["# tabkyra completion for fish. Load it with: tabkyra completion fish | source"];
		for (const c of cmds) lines.push(`complete -c tabkyra -n __fish_use_subcommand -f -a ${sh(c.name)} -d '${desc(c.summary ?? c.what)}'`);
		for (const c of cmds) {
			const subs = c.subcommands ?? [];
			const names = subs.map((s) => sh(s.name)).join(" ");
			for (const s of subs) {
				lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}; and not __fish_seen_subcommand_from ${names}' -f -a ${sh(s.name)} -d '${desc(s.what)}'`);
				for (const f of s.flags ?? [])
					lines.push(
						`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}; and __fish_seen_subcommand_from ${sh(s.name)}' -l ${sh(f.replace(/^--/, ""))}${VALUE_FLAGS.has(f) ? (PATH_VALUES.has(f) ? " -r -F" : " -r") : ""}`,
					);
			}
			for (const s of subs)
				if (!s.paths) lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}; and __fish_seen_subcommand_from ${sh(s.name)}' -f`);
			// No file names where a command takes none.
			if (!subs.length && !c.paths) lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}' -f`);
			for (const v of c.values ?? []) lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}' -f -a ${sh(v)}`);
			for (const f of c.flags ?? [])
				lines.push(`complete -c tabkyra -n '__fish_seen_subcommand_from ${sh(c.name)}' -l ${sh(f.replace(/^--/, ""))}${VALUE_FLAGS.has(f) ? " -r" : ""}`);
		}
		lines.push("");
		return lines.join("\n");
	}
	return undefined;
}
