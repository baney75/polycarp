/**
 * `tabkyra sessions` and `tabkyra tabs`: the agent sessions and their tab groups, from the
 * terminal. Every command is a bridge method (src/bridge/sessions-admin.ts); none opens a
 * session of its own.
 */

import { BridgeClient, BridgeRpcError, isConnectionError, NOT_CONNECTED } from "./client.ts";
import { banner, c, sym } from "./ui.ts";

export const SESSIONS_USAGE =
	"Usage: tabkyra sessions [list] [--all] [--json] | show <name> | rename <old> <new> | end <name> [--close] | release <name> | focus|collapse|expand <name>  (each takes --json)";

interface Described {
	id: string;
	name: string;
	kind: "agent" | "panel";
	agent?: string;
	project?: string;
	label: string;
	group: { title: string; color?: string; collapsed?: boolean; windowId?: number } | null;
	color: string;
	tabCount: number;
	tabs?: Array<{ tabId: number; url: string; title: string; current: boolean }>;
	connected: number;
	createdAt: string | null;
	lastUsedAt: string | null;
}

/** A usage error: exit 2. */
export class SessionsUsageError extends Error {}

async function withClient<T>(fn: (client: BridgeClient) => Promise<T>): Promise<T> {
	const client = new BridgeClient({ name: "sessions" });
	try {
		try {
			await client.connect();
		} catch (err) {
			if (isConnectionError(err) || (err instanceof Error && err.message.startsWith("The bridge at "))) throw new Error(NOT_CONNECTED);
			throw err;
		}
		if (!client.extensionConnected) throw new Error(NOT_CONNECTED);
		return await fn(client);
	} finally {
		client.close();
	}
}

function ago(iso: string | null): string {
	if (!iso) return "-";
	const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
	if (s < 60) return `${s} s ago`;
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

function state(s: Described): string {
	if (s.connected) return c.green(`connected${s.connected > 1 ? ` x${s.connected}` : ""}`);
	if (!s.group) return c.dim("no group");
	return s.group.collapsed ? "collapsed" : "idle";
}

const pad = (text: string, width: number) => {
	// Width counts visible characters; color codes don't shift the columns.
	const visible = text.replace(/\x1b\[[0-9;]*m/g, "").length;
	return text + " ".repeat(Math.max(1, width - visible));
};

function printList(list: Described[]): void {
	console.log(banner("sessions"));
	if (list.length === 0) {
		console.log(`\n${sym.dot} No agent sessions yet. An agent gets one on its first browser call.`);
		return;
	}
	console.log();
	console.log(c.dim(`${pad("NAME", 22)}${pad("AGENT", 9)}${pad("GROUP", 34)}${pad("TABS", 6)}${pad("STATE", 13)}LAST USED`));
	for (const s of list) {
		const group = s.group?.title ?? `Tabkyra · ${s.label}`;
		console.log(`${pad(c.bold(s.name), 22)}${pad(s.agent ?? (s.kind === "panel" ? "panel" : "-"), 9)}${pad(group, 34)}${pad(String(s.tabCount), 6)}${pad(state(s), 13)}${ago(s.lastUsedAt)}`);
	}
	console.log(c.dim(`\nTabkyra sessions show <name> lists a session's tabs; end, rename, focus, collapse and expand act on one.`));
}

function printOne(s: Described): void {
	console.log(banner(`session ${s.name}`));
	console.log();
	console.log(`${c.dim("Agent    ")} ${s.agent ?? "-"}${s.project ? c.dim(`  project ${s.project}`) : ""}`);
	console.log(`${c.dim("Group    ")} ${s.group ? `${s.group.title} (${s.group.color}${s.group.collapsed ? ", collapsed" : ""})` : "none open"}`);
	console.log(`${c.dim("State    ")} ${state(s)}`);
	console.log(`${c.dim("Created  ")} ${s.createdAt ? `${s.createdAt} (${ago(s.createdAt)})` : "-"}`);
	console.log(`${c.dim("Last used")} ${s.lastUsedAt ? `${s.lastUsedAt} (${ago(s.lastUsedAt)})` : "-"}`);
	console.log(`${c.dim("Resume   ")} tabkyra mcp --session ${s.name}`);
	console.log();
	if (!s.tabs?.length) console.log(`${sym.dot} No tabs.`);
	for (const t of s.tabs ?? []) console.log(`${t.current ? c.brass("*") : " "} ${String(t.tabId).padEnd(10)} ${t.title.slice(0, 50).padEnd(50)} ${c.dim(t.url)}`);
}

async function listAll(client: BridgeClient, all: boolean, tabs: boolean): Promise<Described[]> {
	return ((await client.call("sessions.list", { all, tabs }, 15000)) as { sessions: Described[] }).sessions;
}

/** The one session `name` picks, matched the way the extension matches it. */
async function one(client: BridgeClient, name: string): Promise<Described> {
	const list = await listAll(client, false, true);
	const q = name.toLowerCase();
	const exact = list.filter((s) => [s.name, s.id, s.label, s.group?.title ?? ""].some((v) => v.toLowerCase() === q));
	const hits = exact.length ? exact : list.filter((s) => s.name.toLowerCase().startsWith(q));
	if (hits.length === 1) return hits[0];
	if (hits.length === 0) throw new Error(`No agent session matches "${name}". tabkyra sessions lists them.`);
	throw new SessionsUsageError(`"${name}" matches ${hits.length} sessions: ${hits.map((h) => h.name).join(", ")}. Give the full name.`);
}

/** `tabkyra sessions ...`; returns the exit code. */
export async function runSessions(args: string[], flags: { json: boolean; all: boolean; close: boolean }): Promise<number> {
	const [sub = "list", ...rest] = args;
	// Checked before connecting: a typo is a usage error whether or not a browser is up.
	const ARITY: Record<string, [number, string]> = {
		list: [0, "no arguments"],
		show: [1, "a session name"],
		rename: [2, "the old and the new name"],
		end: [1, "a session name"],
		release: [1, "a session name"],
		focus: [1, "a session name"],
		collapse: [1, "a session name"],
		expand: [1, "a session name"],
	};
	if (!Object.hasOwn(ARITY, sub)) throw new SessionsUsageError(`Unknown subcommand "${sub}". ${SESSIONS_USAGE}`);
	if (rest.length !== ARITY[sub][0]) throw new SessionsUsageError(`tabkyra sessions ${sub} needs ${ARITY[sub][1]}. ${SESSIONS_USAGE}`);
	const out = (value: unknown, human: () => void) => {
		if (flags.json) console.log(JSON.stringify(value, null, 2));
		else human();
	};
	try {
		return await withClient(async (client) => {
			switch (sub) {
				case "list": {
					const list = await listAll(client, flags.all, false);
					out(list, () => printList(list));
					return 0;
				}
				case "show": {
					const s = await one(client, rest[0]);
					out(s, () => printOne(s));
					return 0;
				}
				case "rename": {
					const r = (await client.call("sessions.rename", { from: rest[0], to: rest[1] }, 15000)) as { renamed: string; to: string; group?: string };
					out(r, () => console.log(`${sym.ok} ${r.renamed} is now ${c.bold(r.to)}${r.group ? c.dim(` (${r.group})`) : ""}. Resume it with: tabkyra mcp --session ${r.to}`));
					return 0;
				}
				case "release":
				case "end": {
					const r = (await client.call("sessions.end", { name: rest[0], close: sub === "end" && flags.close }, 30000)) as { ended: string; tabs: number[]; closed: boolean };
					out(r, () =>
						console.log(
							`${sym.ok} Ended ${c.bold(r.ended)}: ${r.tabs.length} tab${r.tabs.length === 1 ? "" : "s"} ${r.closed ? "closed" : "handed to you, out of its group"}.`,
						),
					);
					return 0;
				}
				case "focus":
				case "collapse":
				case "expand": {
					const r = await client.call("sessions.group", { name: rest[0], action: sub }, 15000);
					out(r, () => console.log(`${sym.ok} ${sub === "focus" ? "Showing" : sub === "collapse" ? "Collapsed" : "Expanded"} ${c.bold(rest[0])}'s group.`));
					return 0;
				}
				default:
					throw new SessionsUsageError(`Unknown subcommand "${sub}". ${SESSIONS_USAGE}`);
			}
		});
	} catch (err) {
		if (err instanceof SessionsUsageError) throw err;
		// "No match" and refusals from the extension are failures (exit 1), with what to do next.
		if (err instanceof BridgeRpcError && err.rpc.code === "bad_params") throw new SessionsUsageError(err.rpc.message);
		if (err instanceof BridgeRpcError && /^Unknown method sessions\./.test(err.rpc.message))
			throw new Error("The Tabkyra extension in your browser is older than this CLI and has no sessions yet. Update it (tabkyra update) or reload it after a build (tabkyra reload).");
		throw err instanceof BridgeRpcError ? new Error(err.rpc.message) : err;
	}
}

/** `tabkyra tabs [name]`: every agent session's tabs, or one session's. */
export async function runTabs(args: string[], flags: { json: boolean }): Promise<number> {
	if (args.length > 1) throw new SessionsUsageError("Usage: tabkyra tabs [session] [--json]");
	return withClient(async (client) => {
		const list = args[0] ? [await one(client, args[0])] : await listAll(client, false, true);
		if (flags.json) {
			console.log(JSON.stringify(list.map((s) => ({ session: s.name, group: s.group?.title ?? null, tabs: s.tabs ?? [] })), null, 2));
			return 0;
		}
		console.log(banner("tabs"));
		if (list.every((s) => !s.tabs?.length)) console.log(`\n${sym.dot} No agent tabs open.`);
		for (const s of list) {
			if (!s.tabs?.length) continue;
			console.log(`\n${c.bold(s.name)} ${c.dim(s.group?.title ?? "")}`);
			for (const t of s.tabs) console.log(`${t.current ? c.brass("*") : " "} ${String(t.tabId).padEnd(10)} ${t.title.slice(0, 50).padEnd(50)} ${c.dim(t.url)}`);
		}
		return 0;
	});
}
