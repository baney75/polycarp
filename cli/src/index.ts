import { existsSync } from "node:fs";
import { join } from "node:path";
import { BridgeClient, BridgeRpcError, isConnectionError, listSockets, NOT_CONNECTED } from "./client.ts";
import { runDoctor } from "./doctor.ts";
import { runNativeHost } from "./host.ts";
import { hostStatus, install, isInstalled } from "./install.ts";
import { runMcpServer } from "./mcp.ts";
import { EXTENSION_FILES, extensionDir } from "./paths.ts";
import { writePiExtension } from "./pi-extension.ts";
import { parseSetupArgs, parseUpdateArgs } from "./parse-args.ts";
import { runSetup } from "./setup.ts";
import { sdkInstalled } from "./subscriptions/copilot.ts";
import { installCopilotSdk } from "./subscriptions/install-sdk.ts";
import { LIBRARY_USAGE, runLibrary } from "./library.ts";
import { createToken, loadTokens, loadUsage, revokeToken, SCOPES, serve } from "./remote.ts";
import { listClients, normalizePublicUrl, type OAuthConfig, passcodeSet, revokeClient, revokeGrantById, setPasscode } from "./oauth.ts";
import { loadRemoteConfig, remoteFile, remoteOff, remoteSetup, remoteStatus } from "./remote-setup.ts";
import { createHubToken, hubTunnel, HUB_SCOPES } from "./hub.ts";
import { cloudflareTunnel, DEFAULT_PORT, tailscaleTunnel } from "./tunnel.ts";
import { runSessions, runTabs, SessionsUsageError } from "./sessions.ts";
import { runThreads, ThreadsUsageError } from "./threads.ts";
import { runSkill, runSkillSync } from "./skill.ts";
import { runSubmit } from "./skill-submit.ts";
import { banner, c, sym } from "./ui.ts";
import { runUpdate, UpdateError } from "./update.ts";
import { detectMode, recoverCheckoutQuietly } from "./checkout.ts";
import { type HostRunAction, runHostAction } from "./update-run.ts";
import { BUILD } from "../../src/update/build.ts";
import { argsProblem, COMMANDS, completionScript, EXIT_CODES, helpRows, VALUE_FLAGS, VISIBLE_COMMANDS } from "./commands.ts";
import { VERSION } from "./version.ts";

/** One help row. Padding counts visible characters, so color codes don't shift the column. */
const cmd = (usage: string, what: string) => {
	const [name, ...rest] = usage.split(" ");
	const full = `tabkyra ${usage}`;
	const head = `  ${c.bold(`tabkyra ${name}`)}${rest.length ? ` ${rest.join(" ")}` : ""}`;
	// A long usage puts its description on the next line, in the same column.
	if (full.length > 56) return `${head}\n${" ".repeat(60)}${what}`;
	return `${head}${" ".repeat(58 - full.length)}${what}`;
};

/** Grouped from the one command table (commands.ts), so help can't drift from the CLI. */
function help(): string {
	const section = (title: string) => `\n${c.brass(title)}`;
	const groups = [...new Set(VISIBLE_COMMANDS.map((x) => x.group))];
	const rows: string[] = [];
	for (const group of groups) {
		rows.push(section(group));
		for (const spec of VISIBLE_COMMANDS.filter((x) => x.group === group)) for (const [usage, what] of helpRows(spec)) rows.push(cmd(usage, what));
		if (group === "Agents") {
			rows.push(
				`  ${c.dim("Claude Code:")} claude mcp add --scope user tabkyra -- ~/.config/tabkyra/tabkyra mcp`,
				`  ${c.dim("Codex:")}       codex mcp add tabkyra -- ~/.config/tabkyra/tabkyra mcp`,
				`  ${c.dim("(tabkyra setup adds these for you; tabkyra doctor checks them.)")}`,
			);
		}
	}
	return [
		`${banner(VERSION)}`,
		c.dim("A browser your coding agents can drive, in its own tab group, under your command."),
		...rows,
		"",
		`${c.dim("Flags:")} --help, --version. Read commands that list [--json] print JSON for scripts.`,
		c.dim(EXIT_CODES),
		`${c.dim("Docs:")} https://github.com/baney75/tabkyra`,
		"",
	].join("\n");
}

/** NOT_CONNECTED is written for agents; people at the terminal get the direct version. */
const NOT_CONNECTED_HERE =
	"Tabkyra isn't connected. Open Helium or Chrome with the Tabkyra extension loaded, or run `tabkyra doctor` to see why.";
const forPeople = (message: string) => (message === NOT_CONNECTED ? NOT_CONNECTED_HERE : message);

/** "https://GitHub.com/x" or "github.com" -> "github.com"; undefined for anything that isn't a host. */
function siteHost(value: string | undefined): string | undefined {
	if (!value || value.startsWith("-")) return undefined;
	let host = value.trim().toLowerCase();
	if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
		try {
			host = new URL(host).hostname;
		} catch {
			return undefined;
		}
	}
	host = host.replace(/\/.*$/, "").replace(/:\d+$/, "");
	// A real site has a dot ("github.com", "127.0.0.1"); a bare label like "com" would allow a whole TLD.
	if (host !== "localhost" && !host.includes(".")) return undefined;
	return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) ? host : undefined;
}

/** Errors that end a command: say what went wrong and the next step. */
class UsageError extends Error {}

async function withBridge<T>(name: string, fn: (client: BridgeClient) => Promise<T>): Promise<T> {
	const client = new BridgeClient({ name });
	try {
		try {
			await client.connect();
		} catch (err) {
			// No socket, a refused one, a wedged host: all mean the same thing to the person.
			if (isConnectionError(err) || (err instanceof Error && err.message.startsWith("The bridge at "))) throw new Error(NOT_CONNECTED);
			throw err;
		}
		if (!client.extensionConnected) throw new Error(NOT_CONNECTED);
		return await fn(client);
	} finally {
		client.close();
	}
}

interface StatusReport {
	connected: boolean;
	hosts: Array<{ browser: string; state: string; file: string }>;
	extensionVersion?: string;
	permissionMode?: string;
	allowedHosts?: string[];
	message?: string;
}

async function status(json: boolean): Promise<number> {
	const report: StatusReport = {
		connected: false,
		hosts: hostStatus().map((b) => ({ browser: b.name, state: b.state, file: b.file })),
	};
	try {
		for (const path of listSockets()) {
			const client = new BridgeClient({ name: "status" });
			try {
				await client.connect(path);
				if (!client.extensionConnected) continue;
				// 20 s: above the extension's 15 s session-open limit.
				const info = (await client.call("status", {}, 20000, { retry: false })) as {
					extensionVersion: string;
					permissionMode: string;
					allowedHosts: string[];
				};
				report.connected = true;
				report.extensionVersion = info.extensionVersion;
				report.permissionMode = info.permissionMode;
				report.allowedHosts = info.allowedHosts;
				report.message = undefined;
				break;
			} catch (err) {
				// Keep the reason; a later socket may still answer.
				report.message =
					err instanceof BridgeRpcError ? `The extension answered with an error: ${err.rpc.code}: ${err.rpc.message}` : err instanceof Error ? err.message : String(err);
			} finally {
				client.close();
			}
		}
	} catch (err) {
		report.message = err instanceof Error ? err.message : String(err);
	}
	if (!report.connected) report.message = forPeople(report.message ?? NOT_CONNECTED);

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return report.connected ? 0 : 1;
	}
	console.log(banner("status"));
	console.log();
	if (report.connected) {
		console.log(`${sym.ok} Extension connected ${c.dim(`(${report.extensionVersion})`)}`);
		const allowed = report.allowedHosts?.length ? report.allowedHosts.join(", ") : "none yet";
		console.log(
			report.permissionMode === "allow_all"
				? `${sym.warn} Agents may open any site ${c.dim("(tabkyra ask turns prompts back on)")}`
				: `${sym.ok} Agents ask before opening a new site. Allowed: ${allowed}`,
		);
	} else {
		console.log(`${sym.fail} ${report.message}`);
	}
	if (!isInstalled()) console.log(`${sym.fail} Native host not registered ${sym.arrow} ${c.bold("tabkyra setup")}`);
	for (const h of report.hosts) {
		const mark = h.state === "current" ? sym.ok : sym.fail;
		console.log(`${mark} ${h.browser.padEnd(13)} ${c.dim(h.state === "current" ? "host registered" : `host ${h.state}`)}`);
	}
	if (!report.connected) console.log(`\n${sym.arrow} Run ${c.bold("tabkyra doctor")} for the exact fix.`);
	return report.connected ? 0 : 1;
}

const UPDATE_USAGE = "Usage: tabkyra update [--check] [--json] [--rollback] [--yes] [--channel stable|nightly] [--auto-check on|off]";
/** The fixed command lines the native host runs for the side panel (cli/src/update-host.ts). */
const HOST_UPDATE_ACTIONS: Record<string, HostRunAction> = {
	"--host": "update",
	"--host --activate": "activate",
	"--host --rollback": "rollback",
	"--host --reinstall": "reinstall",
};

function checkArgs(command: string, args: string[]): void {
	const problem = argsProblem(command, args);
	if (problem) throw new UsageError(problem);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const [command] = argv;
	const flag = (name: string) => argv.includes(name);
	/** `--name value` or `--name=value`. */
	const option = (name: string): string | undefined => {
		const eq = argv.find((a) => a.startsWith(`${name}=`));
		if (eq) return eq.slice(name.length + 1);
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (command && command !== "host" && (flag("--help") || flag("-h"))) {
		process.stdout.write(help());
		return;
	}
	// `host` is spawned by the browser with its origin as an argument; leave it alone.
	if (command && command !== "host") checkArgs(command, argv.slice(1));
	// Bad setup or update options are refused before anything below touches the checkout.
	const setupArgs = command === "setup" ? parseSetupArgs(argv.slice(1)) : undefined;
	if (typeof setupArgs === "string") throw new UsageError(`${setupArgs} Usage: tabkyra setup [--yes] [--no-wait] [--timeout <seconds>]`);
	const updateArgs = command === "update" && argv[1] !== "--host" ? parseUpdateArgs(argv.slice(1)) : undefined;
	if (typeof updateArgs === "string") throw new UsageError(`${updateArgs} ${UPDATE_USAGE}`);
	// A checkout whose install or rollback a crash interrupted is repaired by any of these, so
	// the side panel isn't the only way back (docs/updates.md).
	if (command === "doctor" || command === "status" || command === "update" || command === "setup") {
		const { mode, root } = detectMode();
		if (mode === "checkout") {
			const note = recoverCheckoutQuietly(root);
			if (note) console.error(`${sym.warn} ${note}`);
		}
	}
	switch (command) {
		case "setup": {
			if (!setupArgs) throw new UsageError("Usage: tabkyra setup [--yes] [--no-wait] [--timeout <seconds>]");
			process.exitCode = await runSetup(setupArgs);
			return;
		}
		case "doctor":
			process.exitCode = await runDoctor({ json: flag("--json") });
			return;
		case "update": {
			if (argv[1] === "--host") {
				// Run by the native host, never with anything the extension sent (docs/updates.md).
				const action = HOST_UPDATE_ACTIONS[argv.slice(1).join(" ")];
				if (!action) throw new UsageError(`Unknown host update action. ${UPDATE_USAGE}`);
				process.exitCode = await runHostAction(action);
				return;
			}
			if (!updateArgs) throw new UsageError(UPDATE_USAGE);
			process.exitCode = await runUpdate(updateArgs);
			return;
		}
		case "status":
			process.exitCode = await status(flag("--json"));
			return;
		case "host":
			runNativeHost();
			return;
		case "mcp":
			await runMcpServer({ session: option("--session") });
			return;
		case "threads": {
			const rest = argv.slice(1).filter((a, i, all) => !a.startsWith("-") && !VALUE_FLAGS.has(all[i - 1] ?? ""));
			try {
				process.exitCode = await runThreads(rest, { json: flag("--json"), offset: option("--offset"), limit: option("--limit"), format: option("--format"), out: option("--out") });
			} catch (err) {
				if (err instanceof ThreadsUsageError) throw new UsageError(err.message);
				throw err;
			}
			return;
		}
		case "sessions":
		case "tabs": {
			const rest = argv.slice(1).filter((a) => !a.startsWith("-"));
			try {
				process.exitCode =
					command === "tabs"
						? await runTabs(rest, { json: flag("--json") })
						: await runSessions(rest, { json: flag("--json"), all: flag("--all"), close: flag("--close") });
			} catch (err) {
				if (err instanceof SessionsUsageError) throw new UsageError(err.message);
				throw err;
			}
			return;
		}
		case "install": {
			const result = install({ force: flag("--force") });
			console.log(`${sym.ok} Launcher ${c.dim(result.launcher)}`);
			for (const f of result.written) console.log(`${sym.ok} Wrote ${c.dim(f)}`);
			for (const f of result.skipped) console.log(`${sym.ok} Current ${c.dim(f)}`);
			if (result.written.length + result.skipped.length === 0) {
				console.log(`${sym.fail} No Chromium browser profile found. Open your browser once, then run this again.`);
				process.exitCode = 1;
				return;
			}
			if (result.written.length > 0) console.log(c.dim("If the extension was already loaded, reload it once on chrome://extensions."));
			return;
		}
		case "allow": {
			const host = siteHost(argv[1]);
			if (!host) throw new UsageError("Which site? Give a host name, for example: tabkyra allow github.com");
			const result = await withBridge("allow", (client) => client.call("permission.allow", { host }, 5000));
			const stored = (result as { allowed?: string }).allowed ?? host;
			console.log(`${sym.ok} Agents may open ${c.bold(stored)} and its subdomains.`);
			return;
		}
		case "allow-all":
		case "yolo": // old name, kept as a hidden alias
		case "ask": {
			const mode = command === "ask" ? "ask" : "allow_all";
			await withBridge(command, (client) => client.call("permission.setMode", { mode }, 5000));
			console.log(
				mode === "ask"
					? `${sym.ok} Agents will ask before opening a site you haven't allowed.`
					: `${sym.warn} Agents may now open any site without asking. ${c.dim("Undo with: tabkyra ask")}`,
			);
			return;
		}
		case "debug": {
			await withBridge("debug", async (client) => {
				const info = (await client.call("bridge.debug", {}, 5000)) as Record<string, unknown>;
				const bench = (await client.call("bridge.bench", {}, 30000)) as Record<string, unknown>;
				console.log(JSON.stringify({ ...info, bench }, null, 2));
			});
			return;
		}
		case "reload": {
			// Refuse to reload onto a broken bundle: a half-written dist-chrome unloads the extension.
			const dist = extensionDir();
			const missing = EXTENSION_FILES.filter((f) => !existsSync(join(dist, f)));
			if (existsSync(dist) && missing.length > 0) {
				throw new Error(`dist-chrome is incomplete (missing ${missing.join(", ")}). Run \`npm run build\` in the repo first.`);
			}
			await withBridge("reload", (client) => client.call("bridge.reload", {}, 5000));
			console.log(`${sym.ok} Reloading the extension. It reconnects in a few seconds.`);
			return;
		}
		case "skill": {
			const args = argv.slice(1);
			const flagName = (a: string) => (VALUE_FLAGS.has(a.split("=")[0]) ? a.split("=")[0] : a);
			const [sub, ...rest] = args.filter((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(args[i - 1] ?? ""));
			// Flags and argument counts each subcommand accepts; anything else is a usage error.
			const SKILL_SUB: Record<string, { flags: string[]; max: number }> = Object.fromEntries(
				(COMMANDS.find((x) => x.name === "skill")?.subcommands ?? []).map((x) => [x.name, { flags: x.flags ?? [], max: x.max ?? 0 }]),
			);
			const spec = sub && Object.hasOwn(SKILL_SUB, sub) ? SKILL_SUB[sub] : undefined;
			const badFlag = args.find((a) => a.startsWith("-") && !(spec?.flags ?? []).includes(flagName(a)));
			if (spec && (badFlag || rest.length > spec.max)) {
				throw new UsageError(`tabkyra skill ${sub} ${badFlag ? `doesn't take ${badFlag}` : "takes fewer arguments"}. Flags: ${spec.flags.join(" ") || "none"}.`);
			}
			if (!sub || !spec) {
				throw new UsageError(
					'Usage: tabkyra skill install [name...] [--all] [--force] | list [--json] | print [name] [--raw] | lint [path...] [--community] | apply <folder> [--yes] | revert <name> | match "<task>" [--json] [--top N] | eval [--json] [--update-baseline] [--cases <file>] [--base <checkout>] [--router <script>] | versions <name> | rollback <name> --to <version> [--yes] | edit <name> [--yes] [--draft-only] | refresh [--json] | write <name> [--file <file>] [--yes] | test <name|folder> [--cases <file>] | remove <name> | enable <name> | sync [--on|--off] | submit <name|folder> [--cases <file>] [--dry-run] [--confirm <code>] | catalog <checkout> --out <file> --serial N',
				);
			}
			for (const name of VALUE_FLAGS) {
				if (spec.flags.includes(name) && flag(name) && option(name) === undefined) throw new UsageError(`${name} needs a value.`);
			}
			if (sub === "submit") {
				if (rest.length !== 1) throw new UsageError("Usage: tabkyra skill submit <name|folder> [--cases <file>] [--note TEXT] [--dry-run] [--confirm <code>] [--repo owner/name] [--branch <branch>] [--json]");
				process.exitCode = await runSubmit({
					target: rest[0],
					cases: option("--cases"),
					repo: option("--repo"),
					branch: option("--branch"),
					note: option("--note"),
					dryRun: flag("--dry-run"),
					confirm: option("--confirm"),
					json: flag("--json"),
				});
				return;
			}
			const skillFlags = {
				force: flag("--force"),
				all: flag("--all"),
				raw: flag("--raw"),
				yes: flag("--yes"),
				json: flag("--json"),
				updateBaseline: flag("--update-baseline"),
				draftOnly: flag("--draft-only"),
				top: option("--top"),
				to: option("--to"),
				cases: option("--cases"),
				base: option("--base"),
				router: option("--router"),
				file: option("--file"),
				community: flag("--community"),
				on: flag("--on"),
				off: flag("--off"),
				out: option("--out"),
				serial: option("--serial"),
				source: option("--source"),
			};
			process.exitCode = sub === "sync" ? await runSkillSync(rest, skillFlags) : runSkill(sub, rest, skillFlags);
			return;
		}
		case "library": {
			try {
				process.exitCode = await runLibrary(argv.slice(1));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes(LIBRARY_USAGE)) throw new UsageError(message);
				// A bad DOI or an unreachable registry is the input's problem, not the install's.
				console.error(`${sym.fail} ${message}`);
				process.exitCode = 1;
			}
			return;
		}
		case "serve": {
			// remote.json (tabkyra remote setup) supplies what flags leave out; flags win.
			const rawPublic = option("--public-url");
			const saved = rawPublic === undefined ? loadRemoteConfig() : undefined;
			if (saved) console.log(`Using ${remoteFile()} (tabkyra remote off removes it).`);
			const port = Number(option("--port") ?? saved?.port ?? DEFAULT_PORT);
			if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError("--port takes a port number.");
			const list = (name: string) => (option(name) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
			const redirectHosts = option("--redirect-host") !== undefined ? list("--redirect-host") : (saved?.redirectHosts ?? []);
			const allowedHosts = option("--allow-host") !== undefined ? list("--allow-host") : (saved?.allowHosts ?? []);
			let oauth: OAuthConfig | undefined;
			if (rawPublic !== undefined || saved) {
				try {
					oauth = { publicUrl: normalizePublicUrl(rawPublic ?? saved?.publicUrl ?? ""), redirectHosts, scopes: SCOPES };
				} catch (err) {
					throw new UsageError(err instanceof Error ? err.message : String(err));
				}
			} else if (option("--redirect-host") !== undefined || option("--allow-host") !== undefined) {
				throw new UsageError("--redirect-host and --allow-host need --public-url.");
			}
			if (oauth && !passcodeSet()) console.log(`${sym.warn} No OAuth passcode yet; nobody can approve a connection. Run: tabkyra token passcode`);
			else if (!oauth && loadTokens().every((t) => t.revokedAt)) console.log(`${sym.warn} No tokens yet; every request will be refused. Create one: tabkyra token create <name> --scope browser.read`);
			const { url } = await serve({ port, host: "127.0.0.1", oauth, allowedHosts });
			console.log(`${sym.ok} MCP over HTTP at ${url} (loopback only; every request needs a token). Ctrl-C stops it.`);
			if (oauth) console.log(`${sym.ok} OAuth on for ${oauth.publicUrl}/mcp: add that URL as a custom connector, then approve it with your passcode.`);
			await new Promise(() => {});
			return;
		}
		case "token": {
			const [sub, name] = argv.slice(1).filter((a) => !a.startsWith("-") && a !== option("--scope"));
			if (sub === "create") {
				if (!name) throw new UsageError("Usage: tabkyra token create <name> --scope browser.read,library.read");
				const scopes = (option("--scope") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
				try {
					const { record, token } = createToken(name, scopes);
					console.log(`${sym.ok} Token ${record.id} for ${record.name}: ${record.scopes.join(", ")}`);
					console.log(`\n  ${token}\n`);
					console.log(c.dim("Shown once. Give it to the agent as an Authorization: Bearer header. tabkyra token revoke " + record.id + " ends it."));
				} catch (err) {
					throw new UsageError(err instanceof Error ? err.message : String(err));
				}
				return;
			}
			if (sub === "list") {
				const usage = loadUsage();
				if (flag("--json")) {
					// The token is never stored; its hash stays out of the output too.
					console.log(JSON.stringify(loadTokens().map(({ sha256: _hash, lastUsedAt, ...t }) => ({ ...t, lastUsed: usage[t.id] ?? lastUsedAt ?? null })), null, 2));
					return;
				}
				for (const t of loadTokens()) {
					const lastUsed = usage[t.id] ?? t.lastUsedAt;
					console.log(`${t.id}  ${t.name.padEnd(16)} ${t.revokedAt ? c.dim("revoked") : "active "}  ${t.scopes.join(",")}  ${c.dim(lastUsed ? `last used ${lastUsed}` : "never used")}`);
				}
				return;
			}
			if (sub === "passcode") {
				const passcode = setPasscode();
				console.log(`${sym.ok} OAuth passcode:\n\n  ${passcode}\n`);
				console.log(c.dim("Shown once. Type it on the approval page when claude.ai, ChatGPT or grok.com connects. Keep it in a password manager, but not one the browser Tabkyra drives can fill. Running this again replaces it and clears approval rate limits; grants already approved keep working."));
				return;
			}
			if (sub === "clients") {
				const clients = listClients();
				if (flag("--json")) {
					console.log(JSON.stringify(clients, null, 2));
					return;
				}
				if (!clients.length) console.log(`${sym.dot} No OAuth clients.`);
				for (const cl of clients) {
					console.log(`${cl.client_id}  ${cl.client_name}  ${c.dim(cl.redirect_hosts.join(","))}  ${c.dim(cl.last_used ? `last used ${cl.last_used}` : "never approved")}`);
					for (const g of cl.grants) console.log(`    ${g.id}  ${g.scopes.join(",")}`);
				}
				return;
			}
			if (sub === "revoke") {
				if (!name) throw new UsageError("Usage: tabkyra token revoke <id|name|client id|grant id>");
				if (name.startsWith("o-")) {
					if (revokeGrantById(name)) {
						console.log(`${sym.ok} Ended grant ${name}.`);
						return;
					}
				}
				if (name.startsWith("tkc_") && revokeClient(name)) {
					console.log(`${sym.ok} Removed OAuth client ${name} and its grants.`);
					return;
				}
				// Not a live grant or client: a static token named like one (made before such names were refused) still matches below.
				const n = revokeToken(name);
				console.log(n ? `${sym.ok} Revoked ${n} token${n === 1 ? "" : "s"}.` : `${sym.dot} No active token matches ${name}.`);
				process.exitCode = n ? 0 : 1;
				return;
			}
			if (sub === "scopes") {
				if (flag("--json")) {
					console.log(JSON.stringify(SCOPES, null, 2));
					return;
				}
				for (const [scope, { what, tools }] of Object.entries(SCOPES)) console.log(`${c.bold(scope.padEnd(18))} ${what}\n${"".padEnd(19)}${c.dim(tools.join(", "))}`);
				return;
			}
			throw new UsageError("Usage: tabkyra token create <name> --scope a,b | list | revoke <id|name|client id|grant id> | scopes | passcode | clients");
		}
		case "remote": {
			const sub = argv.slice(1).find((a) => !a.startsWith("-") && a !== option("--public-url") && a !== option("--port"));
			if (sub === "setup") {
				const rawPublic = option("--public-url");
				const rawPort = option("--port");
				const port = rawPort === undefined ? undefined : Number(rawPort);
				if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UsageError("--port takes a port number from 1 to 65535.");
				let publicUrl: string | undefined;
				if (rawPublic !== undefined) {
					try {
						publicUrl = normalizePublicUrl(rawPublic);
					} catch (err) {
						throw new UsageError(err instanceof Error ? err.message : String(err));
					}
				}
				process.exitCode = await remoteSetup({ publicUrl, port, service: !flag("--no-service") });
				return;
			}
			if (sub === "status") {
				process.exitCode = await remoteStatus({ json: flag("--json") });
				return;
			}
			if (sub === "off") {
				process.exitCode = await remoteOff();
				return;
			}
			throw new UsageError("Usage: tabkyra remote setup [--public-url https://host] [--port N] [--no-service] | status [--json] | off");
		}
		case "hub": {
			const sub = argv.slice(1).find((a) => !a.startsWith("-"));
			if (sub === "token") {
				checkArgs("hub", argv.slice(1));
				const name = option("--name") ?? "hub";
				const { token, id } = createHubToken(name);
				console.log(`${sym.ok} Hub token ${name} (${id}) scopes: ${HUB_SCOPES.join(", ")}`);
				console.log(token);
				break;
			}
			if (sub === "tunnel") {
				checkArgs("hub", argv.slice(1));
				const port = Number(option("--port") ?? DEFAULT_PORT);
				if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("--port takes a port number from 1 to 65535.");
				const result = hubTunnel(port);
				console.log(`${result.ok ? sym.ok : sym.fail} ${result.message}`);
				if (result.url) console.log(result.url);
				process.exitCode = result.ok ? 0 : 1;
				break;
			}
			throw new UsageError(
				"Usage: tabkyra hub token [--name hub] | tabkyra hub tunnel [--port N]\nHub profile: scopes browser.read + browser.navigate; tunnel uses Tailscale serve (Funnel off).",
			);
		}
		case "tunnel": {
			const kind = argv.slice(1).find((a) => !a.startsWith("-") && a !== option("--port"));
			const port = Number(option("--port") ?? DEFAULT_PORT);
			if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("--port takes a port number from 1 to 65535.");
			const result =
				kind === "tailscale"
					? tailscaleTunnel({ port, public: flag("--public"), off: flag("--off") })
					: kind === "cloudflare"
						? await cloudflareTunnel({ port, off: flag("--off") })
						: undefined;
			if (!result) throw new UsageError("Usage: tabkyra tunnel tailscale|cloudflare [--port N] [--public] [--off]");
			if (flag("--public") && kind === "tailscale" && !flag("--off")) console.log(`${sym.warn} --public uses Tailscale Funnel: anyone on the internet can reach it, and the token is the only lock.`);
			console.log(`${result.ok ? sym.ok : sym.fail} ${result.message}`);
			process.exitCode = result.ok ? 0 : 1;
			return;
		}
		case "copilot-sdk": {
			const sub = argv[1] ?? "status";
			if (sub === "install") {
				const result = installCopilotSdk();
				console.log(`${result.ok ? sym.ok : sym.fail} ${result.message}`);
				process.exitCode = result.ok ? 0 : 1;
				return;
			}
			if (sub !== "status") throw new UsageError("Usage: tabkyra copilot-sdk install|status");
			console.log(sdkInstalled() ? `${sym.ok} GitHub's Copilot SDK is installed.` : `${sym.warn} Not installed. Run \`tabkyra copilot-sdk install\`.`);
			return;
		}
		case "pi-extension":
			console.log(`${sym.ok} Wrote ${writePiExtension(argv[1])}`);
			return;
		case "completion": {
			const script = completionScript(argv[1] ?? "");
			if (!script) throw new UsageError("Usage: tabkyra completion zsh|bash|fish. For zsh: eval \"$(tabkyra completion zsh)\" in ~/.zshrc");
			process.stdout.write(script);
			return;
		}
		case "--version":
		case "-v":
		case "version":
			if (flag("--json")) console.log(JSON.stringify({ version: VERSION, commit: BUILD?.commit ?? "", builtAt: BUILD?.builtAt ?? "" }));
			else console.log(VERSION);
			return;
		case undefined:
		case "--help":
		case "-h":
		case "help":
			process.stdout.write(help());
			return;
		default:
			throw new UsageError(`Unknown command "${command}". Run \`tabkyra --help\` to see the commands.`);
	}
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`${sym.fail} ${forPeople(message)}`);
	if (!(err instanceof UsageError) && !(err instanceof UpdateError) && message !== NOT_CONNECTED) console.error(`${sym.arrow} Run ${c.bold("tabkyra doctor")} to find the cause.`);
	process.exit(err instanceof UsageError ? 2 : 1);
});
