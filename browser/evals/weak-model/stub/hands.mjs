#!/usr/bin/env node
// A stand-in for `polycarp-spaces mcp`: the same JSON-RPC lines, the same tools/list (hands-tools.json, the real
// helper's), the same snapshot rows, refs, envelopes and error codes, over the small apps in apps.mjs instead of the
// Mac. Nothing it does reaches a real window. After every call it writes its world to --state, which the eval scores.
//   node stub/hands.mjs --state <file.json> --handoff <dir> [mcp --connector]
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { APPS, DOCUMENT_APPS } from "./apps.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = JSON.parse(readFileSync(join(here, "hands-tools.json"), "utf8"));
const TOOLS = new Map(SPEC.tools.map((t) => [t.name, t]));

const arg = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? undefined : process.argv[i + 1];
};
const stateFile = arg("state");
const handoff = resolve(arg("handoff") ?? process.cwd());

const AGENT_WORKSPACE = 9;
const VALUE_LIMIT = 120;
const DEFAULT_MAX = 400;
// Apps that hold the user's own data: the real helper sends them to the sandbox.
const SANDBOXED = /^(safari|notes|mail|messages|calendar|photos|contacts|reminders)$/i;

/** JSON with keys sorted, as the helper's envelopes are (Envelope.swift `line`). */
function sorted(v) {
	if (Array.isArray(v)) return v.map(sorted);
	if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
	return v;
}
const line = (env) => JSON.stringify(sorted(env));

const RETRY = {
	stale_ref: "after_snapshot",
	unknown_ref: "after_snapshot",
	ambiguous_target: "after_snapshot",
	stale_bare_row: "after_snapshot",
	timeout: "safe",
	app_not_found: "safe",
	window_not_found: "safe",
	bad_arguments: "safe",
	permission_denied: "safe",
	in_use: "safe",
};
class HandsError extends Error {
	/** `nextCall`: the helper's own next_call when it sets one (null for none); otherwise HandsNextCall's by code. */
	constructor(code, message, suggestion, retry, nextCall) {
		super(message);
		this.nextCallOverride = nextCall;
		this.code = code;
		this.suggestion = suggestion;
		this.retry = retry ?? RETRY[code] ?? "never";
	}
}
/** HandsNextCall.after: what to call after an error, for the window the request was about. */
function nextCall(code, window) {
	const snap = window ? { tool: "snapshot", arguments: { window } } : { tool: "windows", arguments: {} };
	const since = window ? { tool: "snapshot", arguments: { window, since: "latest" } } : { tool: "windows", arguments: {} };
	if (["outside_agent_workspace", "app_not_found", "window_not_found", "ambiguous_window", "ambiguous", "engine_error"].includes(code)) return { tool: "windows", arguments: {} };
	if (["unknown_ref", "stale_ref", "ambiguous_target", "stale_bare_row", "in_use"].includes(code)) return snap;
	if (["action_failed", "unverified", "timeout"].includes(code)) return since;
	return null;
}

// The world: windows by id, each with its app model. Closed windows stay, marked, so a task can score them.
const windows = new Map();
let nextWindow = 61001;
let nextPid = 70101;
const snapshots = new Map();
let latestListed;
/** Whether the session's latest read printed every row with its number (a since read or a find does not). */
let latestWasListed = false;
const lastRead = new Map();
let clipboard;

function save() {
	if (!stateFile) return;
	const world = {
		windows: [...windows.values()].map((w) => ({ id: w.id, app: w.app, title: w.model.title, open: !w.closed, state: w.model.export() })),
	};
	writeFileSync(`${stateFile}.tmp`, JSON.stringify(world, null, 1));
	renameSync(`${stateFile}.tmp`, stateFile);
}

// --- reading a window: rows like SnapshotRows.swift ---

const CONTAINERS = new Set(["window", "group", "toolbar", "sheet", "menu"]);
const quoted = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r")}"`;
function shownValue(v) {
	if (v.length <= 24 && v.includes(".") && !/e/i.test(v) && Number.isFinite(Number(v)) && Math.abs(Number(v)) < 1e15) {
		let t = Number(v).toFixed(2);
		while (t.endsWith("0")) t = t.slice(0, -1);
		if (t.endsWith(".")) t = t.slice(0, -1);
		return t === "-0" ? "0" : t;
	}
	if (v.trim() !== "" && Number.isFinite(Number(v))) return v;
	return v.length > VALUE_LIMIT ? `${quoted(v.slice(0, VALUE_LIMIT))}…(+${v.length - VALUE_LIMIT} chars; get value for all)` : quoted(v);
}
const actionable = (n) => !!(n.press || n.set || n.type || n.toggle || n.choose || n.select || n.scroll || n.options);

/** The window's tree with an open popup's menu added under it. */
function tree(w) {
	const t = w.model.render();
	if (w.openMenu) {
		const walk = (n) => {
			if (n.key === w.openMenu && n.options) {
				n.children = [
					{
						key: `${n.key}:menu`,
						role: "menu",
						name: "",
						value: "",
						states: [],
						children: n.options.map((o) => ({
							key: `${n.key}:item:${o}`,
							role: "menuitem",
							name: o,
							value: "",
							states: n.value === o ? ["selected"] : [],
							children: [],
							press: () => {
								n.choose(o);
								w.openMenu = undefined;
								return true;
							},
						})),
					},
				];
			}
			for (const c of n.children ?? []) walk(c);
		};
		walk(t);
	}
	return t;
}

/** One row per shown element: [{depth, number?, role, name, value, states, key, node, parent}] with refs numbered in order. */
function rows(t, { interactive = false } = {}) {
	const out = [];
	let n = 0;
	const title = t.name;
	const walk = (node, depth, parent) => {
		const ref = !CONTAINERS.has(node.role);
		const echo = !ref && node.name === title && depth > 0;
		const shown = node.role !== "window" && (ref || node.name || node.value) && !echo && (!interactive || actionable(node) || node.value);
		let d = depth;
		let p = parent;
		if (shown) {
			out.push({ depth, number: ref ? ++n : undefined, role: node.role, name: node.name ?? "", value: node.value ?? "", states: node.states ?? [], key: node.key, node, parent });
			d = depth + 1;
			p = out.length - 1;
		}
		for (const c of node.children ?? []) walk(c, d, p);
	};
	walk(t, 0, undefined);
	return out;
}
const rowLine = (r) => {
	let s = `${"  ".repeat(r.depth)}${r.number ? `[${r.number}] ` : ""}${r.role}`;
	if (r.name) s += ` ${quoted(r.name)}`;
	if (r.value && r.value !== r.name) s += ` =${shownValue(r.value)}`;
	if (r.states.length) s += ` (${r.states.join(",")})`;
	return s;
};
const flat = (r) => rowLine({ ...r, depth: 0 });
const evidenceOf = (r) => `${r.role}|${r.name}|${r.value}|${r.states.join(",")}`;

let snapSeq = 0;
function newSnapshotId() {
	snapSeq++;
	return `s${(snapSeq * 7919 + 104729).toString(36).padStart(5, "0")}${"abcdefghijkmnpqrstuvwxyz"[snapSeq % 24]}${"23456789"[snapSeq % 8]}`;
}
function record(w, rs, { listed = true, view = "full" } = {}) {
	const id = newSnapshotId();
	snapshots.set(id, { window: w.id, refs: new Map(rs.filter((r) => r.number).map((r) => [r.number, r.key])) });
	if (listed) latestListed = id;
	latestWasListed = listed;
	lastRead.set(`${w.id}|${view}`, { id, rows: rs });
	return id;
}

// --- finding things ---

function windowOf(args) {
	if (args.window !== undefined) {
		const w = windows.get(args.window);
		if (!w || w.closed) throw new HandsError("window_not_found", `no window ${args.window} that Polycarp tracks`, "Run `polycarp-spaces agent windows` for the ids you can use.");
		return w;
	}
	const open = [...windows.values()].filter((w) => !w.closed && w.app.toLowerCase() === String(args.app).toLowerCase());
	if (!open.length) throw new HandsError("app_not_found", `no ${args.app} window on the agent workspace`, `Open it first: open {"app":"${args.app}"}.`);
	return open.at(-1);
}

function findKey(t, key) {
	let hit;
	const walk = (n) => {
		if (hit) return;
		if (n.key === key) hit = n;
		for (const c of n.children ?? []) walk(c);
	};
	walk(t);
	return hit;
}

/** The element a ref names now: a full ref, or a bare row number of the latest full read. */
function resolveRef(ref) {
	const s = String(ref ?? "").trim();
	if (/^e\d+$/.test(s))
		throw new HandsError(
			"bad_arguments",
			`${quoted(s)} is a browser ref from read_page; computer_* tools act on native windows`,
			`For a web page, use the browser tools (click, fill, select) with ${s}. For a native window, pass a row number like 5 or a full ref like @s8f3k2p9:e5 from computer_snapshot.`,
			"never",
		);
	let snapId;
	let n;
	const full = /^@([a-z0-9]+):e(\d+)$/.exec(s);
	const bare = /^\[?(\d+)\]?$/.exec(s);
	if (full) [, snapId, n] = [null, full[1], Number(full[2])];
	else if (bare) {
		if (!latestListed) throw new HandsError("unknown_ref", `row ${s} of no snapshot: this session hasn't read a window yet`, "Read the window with snapshot first, then act on a row number it prints.");
		if (!latestWasListed)
			throw new HandsError("stale_bare_row", `row ${s} could mean a row of an older read: your latest read listed only changes or matches`, "Nothing was sent. Read the window in full, then act on its row numbers, or pass a full ref.");
		snapId = latestListed;
		n = Number(bare[1]);
	} else throw new HandsError("bad_arguments", `${quoted(s)} isn't a ref`, "Pass a row number like 5 from your latest snapshot, or a full ref like @s8f3k2p9:e5.");
	const snap = snapshots.get(snapId);
	if (!snap) throw new HandsError("unknown_ref", `no snapshot ${snapId} in this session`, "Take a new snapshot and use the refs it prints.");
	const key = snap.refs.get(n);
	const w = windows.get(snap.window);
	if (!key) throw new HandsError("unknown_ref", `snapshot ${snapId} has no row ${n}`, "Take a new snapshot and use the refs it prints.");
	if (!w || w.closed) throw new HandsError("window_not_found", `window ${snap.window} is gone`, "Run `polycarp-spaces agent windows` for the ids you can use.");
	const t = tree(w);
	const el = findKey(t, key);
	if (!el) throw new HandsError("stale_ref", `@${snapId}:e${n} no longer points at an element: the window changed`, "Take a new snapshot and use the refs it prints.");
	return { w, el, ref: `@${snapId}:e${n}`, t };
}

const target = (w) => ({ app: w.app, pid: w.pid, scope: "agent_workspace", window: w.id });

/** Runs a change and reports what the window shows differently, like the helper's ax_diff evidence. */
function acting(w, change) {
	const before = rows(tree(w)).map(evidenceOf);
	const exportBefore = JSON.stringify(w.model.export());
	const result = change();
	if (w.model.export().closed) w.closed = true;
	const after = w.closed ? [] : rows(tree(w)).map(evidenceOf);
	const added = after.filter((x) => !before.includes(x));
	const removed = before.filter((x) => !after.includes(x));
	const changed = added.length > 0 || removed.length > 0 || JSON.stringify(w.model.export()) !== exportBefore;
	return { result, evidence: { kind: "ax_diff", changed, added: added.slice(0, 12), added_count: added.length, removed: removed.slice(0, 12), removed_count: removed.length, elements_before: before.length, elements_after: after.length } };
}

// --- the verbs ---

/** RunSteps.maxSteps and RunSteps.verbs: the verbs that act on one window. */
const MAX_STEPS = 32;
const STEP_VERBS = ["click", "type", "set_value", "press", "click_at", "drag", "scroll", "select", "toggle", "menu"];
const stepsBad = (why) => new HandsError("bad_arguments", why, 'Example: {"steps":[{"tool":"click","args":{"ref":"5"}},{"tool":"type","args":{"ref":"7","text":"hi"}}]}', "safe", null);
/** ContextMenu.refClick: left (the default) presses; right opens the context menu; item goes only with right. */
function rightClick(args) {
	const example = 'Example: {"ref":"12","button":"right","item":"Rename"}';
	const button = String(args.button ?? "left").toLowerCase();
	if (button === "left") {
		if (args.item !== undefined) throw new HandsError("bad_arguments", "item goes with button: right", example, "safe", null);
		return false;
	}
	if (button !== "right") throw new HandsError("bad_arguments", "button must be left or right", example, "safe", null);
	if (args.item !== undefined && !String(args.item).trim()) throw new HandsError("bad_arguments", "item is empty", example, "safe", null);
	return true;
}

const verbs = {
	windows() {
		return {
			agent_workspace: AGENT_WORKSPACE,
			access: "default",
			windows: [...windows.values()]
				.filter((w) => !w.closed)
				.map((w) => ({
					id: w.id,
					pid: w.pid,
					app: w.app,
					title: w.model.title,
					workspace: AGENT_WORKSPACE,
					scope: "agent_workspace",
					kind: "window",
					...(w.model.sheet ? { sheet: true, sheet_note: "a sheet is up on this window: its elements are in this window's snapshot, marked sheet" } : {}),
				})),
		};
	},
	workspaces() {
		return {
			agent_workspace: AGENT_WORKSPACE,
			agent_workspace_shown: false,
			workspaces: [
				{ number: 1, name: "Main", shown: true, agent: false },
				{ number: AGENT_WORKSPACE, name: "Agent", shown: false, agent: true, windows: [...windows.values()].filter((w) => !w.closed).map((w) => w.id) },
			],
		};
	},
	open(args) {
		const name = String(args.app);
		if (SANDBOXED.test(name)) throw new HandsError("needs_sandbox", `${name} holds the user's own data, so agents work on it in the sandbox`, "That is a later phase; do the task another way or ask the user.");
		const App = Object.values(APPS).find((A) => A.app.toLowerCase() === name.toLowerCase());
		if (!App) throw new HandsError("app_not_found", `no app named ${name} on this Mac`, "Check the app's name.");
		const targets = args.targets ?? [];
		const files = targets.map((t) => {
			const p = isAbsolute(t) ? resolve(t) : resolve(handoff, t);
			const rel = relative(handoff, p);
			if (rel.startsWith("..") || isAbsolute(rel)) throw new HandsError("bad_arguments", `${t} is outside the agent handoff folder`, `Only files in the agent handoff folder (${handoff}) can be opened.`);
			if (!existsSync(p)) throw new HandsError("bad_arguments", `no file ${t} in the agent handoff folder`, `Files are opened from ${handoff}.`);
			return p;
		});
		if (args.new_window === false && !files.length) {
			const mine = [...windows.values()].filter((w) => !w.closed && w.app === App.app).at(-1);
			if (mine) return { app: App.app, window: mine.id, pid: mine.pid, reused: true, workspace: String(AGENT_WORKSPACE), focus: { changed: false, returned: false } };
		}
		if (DOCUMENT_APPS.has(App.app) && App.app === "Leaflet" && !files.length) throw new HandsError("bad_arguments", "Leaflet opens a document: pass it in targets", `Pass a file from the agent handoff folder (${handoff}).`);
		const made = (files.length ? files : [undefined]).map((f) => {
			const w = { id: nextWindow++, pid: nextPid++, app: App.app, model: new App(f), closed: false };
			windows.set(w.id, w);
			return w;
		});
		const w = made[0];
		return {
			app: App.app,
			window: w.id,
			pid: w.pid,
			reused: false,
			workspace: String(AGENT_WORKSPACE),
			focus: { changed: false, returned: false },
			note: "started a separate copy on the agent workspace",
			...(made.length > 1 ? { windows: made.map((x) => x.id) } : {}),
		};
	},
	snapshot(args) {
		const w = windowOf(args);
		if (args.format && !["rows", "json"].includes(args.format)) throw new HandsError("bad_arguments", `format is rows or json, not ${args.format}`, usage("snapshot"));
		if (args.since !== undefined && args.since !== "latest") throw new HandsError("bad_arguments", `since takes "latest", not ${args.since}`, usage("snapshot"));
		const view = `${!!args.interactive}`;
		const t = tree(w);
		const rs = rows(t, { interactive: !!args.interactive });
		const shotError = args.screenshot ? { screenshot_error: "Screen Recording is off for Polycarp, so no picture; the rows are the window's contents" } : {};
		if (args.format === "json") {
			const id = record(w, rs, { view });
			const nums = new Map(rs.filter((r) => r.number).map((r) => [r.key, r.number]));
			const strip = (n) => ({
				role: n.role,
				...(n.name ? { name: n.name } : {}),
				...(n.value ? { value: n.value } : {}),
				...(n.states?.length ? { states: n.states } : {}),
				...(nums.has(n.key) ? { ref_id: `@${id}:e${nums.get(n.key)}` } : {}),
				...(n.children?.length ? { children: n.children.map(strip) } : {}),
			});
			return { app: w.app, snapshot_id: id, ref_count: nums.size, complete: true, target: target(w), tree: strip(t), ...shotError };
		}
		const prev = lastRead.get(`${w.id}|${view}`);
		if (args.since === "latest" && prev) {
			const id = record(w, rs, { listed: false, view });
			const old = new Map(prev.rows.map((r) => [r.key, r]));
			const now = new Set(rs.map((r) => r.key));
			const changes = [];
			for (const r of rs) {
				const was = old.get(r.key);
				if (!was) changes.push(["+", r]);
				else if (was.name !== r.name || was.value !== r.value || was.states.join() !== r.states.join()) changes.push(["~", r]);
			}
			for (const r of prev.rows) if (!now.has(r.key)) changes.push(["-", { ...r, number: undefined }]);
			if (!changes.length) return { format: "rows", text: `snapshot ${id} · window ${w.id} · no change since ${prev.id}`, ...shotError };
			const count = (k) => changes.filter(([c]) => c === k).length;
			const lines = [`snapshot ${id} · window ${w.id} · since ${prev.id}: ${count("+")} added, ${count("~")} changed, ${count("-")} removed · act by full ref @${id}:eN`];
			for (const [c, r] of changes) {
				const under = c === "+" && r.parent !== undefined && rs[r.parent]?.number ? ` under [${rs[r.parent].number}]` : "";
				lines.push(`${c} ${flat(r)}${under}`);
			}
			return { format: "rows", text: lines.join("\n"), ...shotError };
		}
		const id = record(w, rs, { view });
		const q = String(args.query ?? "").trim();
		const terms = q
			.toLowerCase()
			.split("|")
			.map((x) => x.trim())
			.filter(Boolean);
		let picked = rs.map((_, i) => i);
		if (terms.length) {
			const keep = new Set();
			rs.forEach((r, i) => {
				if (!terms.some((x) => `${r.role} ${r.name} ${r.value}`.toLowerCase().includes(x))) return;
				for (let at = i; at !== undefined && !keep.has(at); at = rs[at].parent) keep.add(at);
			});
			picked = [...keep].sort((a, b) => a - b);
		}
		const refs = rs.filter((r) => r.number).length;
		let lines;
		if (!terms.length)
			lines = [`snapshot ${id} · window ${w.id} ${quoted(w.model.title)} (${w.app}) · ${refs} refs`, `act by row number {"ref":"5"} or full ref @${id}:e5`];
		else if (!picked.length) lines = [`snapshot ${id} · window ${w.id} · no row matches ${quoted(q)} (${rs.length} rows in all). Try one shorter word, or snapshot without query.`];
		else lines = [`snapshot ${id} · window ${w.id} · query ${quoted(q)}: ${picked.length} of ${rs.length} rows`];
		const limit = Math.max(1, args.max_elements ?? DEFAULT_MAX);
		lines.push(...picked.slice(0, limit).map((i) => rowLine(rs[i])));
		if (picked.length > limit) {
			const also = args.interactive ? ',"interactive":true' : "";
			const all = terms.length ? `{"window":${w.id}${also},"query":${quoted(q)},"max_elements":${picked.length}}` : `{"window":${w.id}${also},"max_elements":${picked.length}}`;
			const narrower = terms.length ? "" : ` or {"window":${w.id}${also},"query":"<a word from the row you want>"}`;
			lines.push(`truncated: ${limit} of ${picked.length} rows shown. For the rest call snapshot with ${all}${narrower}`);
		}
		return { format: "rows", text: lines.join("\n"), ...shotError };
	},
	find(args) {
		const w = windowOf(args);
		const rs = rows(tree(w));
		const has = (field, want) => !want || String(field ?? "").toLowerCase().includes(String(want).toLowerCase());
		const hits = rs.filter((r) => r.number && has(r.role, args.role) && has(r.name, args.name) && has(r.value, args.value) && has(`${r.name} ${r.value}`, args.text));
		const id = record(w, rs, { listed: false, view: "find" });
		return {
			snapshot_id: id,
			target: target(w),
			matches: hits.slice(0, args.limit ?? 20).map((r) => ({ ref: `@${id}:e${r.number}`, role: r.role, ...(r.name ? { name: r.name } : {}), ...(r.value ? { value: r.value } : {}), ...(r.states.length ? { states: r.states } : {}) })),
			count: hits.length,
		};
	},
	get(args) {
		const { w, el, ref } = resolveRef(args.ref);
		const property = args.property ?? "value";
		const all = {
			value: el.value ?? "",
			text: [el.name, el.value].filter(Boolean).join(" "),
			title: el.name ?? "",
			role: el.role,
			bounds: { x: 20, y: 40, width: 200, height: 24 },
			states: el.states ?? [],
		};
		if (!(property in all)) throw new HandsError("bad_arguments", `property is value, text, title, role, bounds or states, not ${property}`, usage("get"));
		if (args.copy) clipboard = typeof all[property] === "string" ? all[property] : JSON.stringify(all[property]);
		return { ref, property, [property]: all[property], target: target(w), ...(args.copy ? { copied: true } : {}) };
	},
	click(args) {
		const { w, el, ref } = resolveRef(args.ref);
		if (rightClick(args))
			throw new HandsError(
				"outside_agent_workspace",
				"a right click opens its menu where Donovan can see it unless the agent workspace is on screen under the window; it isn't, so nothing was sent",
				"Use `click` without button for the element's own action, or `menu` for the app's menu bar.",
				"never",
				null,
			);
		if (el.states?.includes("disabled")) throw new HandsError("action_failed", `${el.role} ${quoted(el.name)} is disabled: the press did nothing`, "Read the window again: something else must change first.");
		let landed = "press";
		const { evidence } = acting(w, () => {
			if (el.press) return el.press();
			if (el.toggle) return el.toggle();
			if (el.select) {
				landed = "selection_write";
				return el.select();
			}
			if (el.options) {
				w.openMenu = w.openMenu === el.key ? undefined : el.key;
				return true;
			}
			return false;
		});
		save();
		return { action: "click", ref, landed, evidence, target: target(w), verified: evidence.changed };
	},
	type(args) {
		const { w, el, ref } = resolveRef(args.ref);
		if (!el.type) throw new HandsError("not_supported", `${el.role} ${quoted(el.name)} takes no text`, "Type into a text field or text area.");
		const text = args.paste ? clipboard : args.text;
		if (text === undefined) throw new HandsError("bad_arguments", "nothing copied in this session", "Copy text first with get {ref, copy: true}.");
		const { evidence } = acting(w, () => el.type(text));
		const now = findKey(tree(w), el.key);
		save();
		return { action: "type", ref, value: now?.value ?? "", evidence, target: target(w), verified: true };
	},
	set_value(args) {
		const { w, el, ref } = resolveRef(args.ref);
		if (!el.set) throw new HandsError("not_supported", `${el.role} ${quoted(el.name)} has no value to set`, "Set the value of a text field, text area or slider.");
		const { evidence } = acting(w, () => el.set(String(args.value)));
		const now = findKey(tree(w), el.key);
		save();
		return { action: "set_value", ref, value: now?.value ?? "", evidence, target: target(w), verified: true };
	},
	toggle(args) {
		const { w, el, ref } = resolveRef(args.ref);
		if (!el.toggle) throw new HandsError("not_supported", `${el.role} ${quoted(el.name)} isn't a checkbox, switch or disclosure`, "Toggle a checkbox, switch or disclosure.");
		const { evidence } = acting(w, () => el.toggle());
		const now = findKey(tree(w), el.key);
		save();
		return { action: "toggle", ref, value: now?.value ?? "", evidence, target: target(w), verified: true };
	},
	select(args) {
		const { w, el, ref } = resolveRef(args.ref);
		if (el.options) {
			const o = el.options.find((x) => x.toLowerCase() === String(args.option).trim().toLowerCase());
			if (!o) throw new HandsError("action_failed", `${quoted(el.name)} has no option ${quoted(args.option)}`, `Its options: ${el.options.join(", ")}.`);
			const { evidence } = acting(w, () => {
				el.choose(o);
				w.openMenu = undefined;
			});
			save();
			return { action: "select", ref, value: o, evidence, target: target(w), verified: true };
		}
		if (el.role === "table") {
			const row = (el.children ?? []).find((r) => JSON.stringify(r).toLowerCase().includes(String(args.option).toLowerCase()) && r.select);
			if (!row) throw new HandsError("action_failed", `no row of ${quoted(el.name)} shows ${quoted(args.option)}`, "Read the list again for the rows it has.");
			const { evidence } = acting(w, () => row.select());
			save();
			return { action: "select", ref, value: args.option, evidence, target: target(w), verified: true };
		}
		throw new HandsError("not_supported", `${el.role} ${quoted(el.name)} has no options to choose`, "Choose in a popup button, menu or list.");
	},
	press(args) {
		const { w, el, ref } = resolveRef(args.ref);
		const keys = String(args.key).trim().split(/\s+/).slice(0, 64);
		const { evidence } = acting(w, () => {
			for (const k of keys) {
				// Command-W is File > Close, as in any Mac app: a document with unsaved changes asks first.
				if (k.toLowerCase() === "cmd+w") {
					if (w.model.close) w.model.close();
					else w.closed = true;
					break;
				}
				if (el.type && [...k].length === 1 && !(w.model instanceof APPS.Jotter)) el.type(k);
				else if (el.type && k.toLowerCase() === "space" && !(w.model instanceof APPS.Jotter)) el.type(" ");
				else w.model.pressKey(k);
			}
		});
		save();
		if (!evidence.changed)
			throw new HandsError("unverified", `nothing read back from window ${w.id} shows ${keys.join(" ")} landed`, "Read the window with since \"latest\" before anything else; don't repeat the keys.", "never");
		const sheet = !w.closed && w.model.export().sheet === true;
		return { action: "press", ref, keys, evidence, target: target(w), verified: true, ...(sheet ? { opened: [{ window: w.id, kind: "sheet", waiting: true }] } : {}) };
	},
	scroll(args) {
		const { w, el, ref } = resolveRef(args.ref);
		if (!["up", "down", "left", "right"].includes(args.direction)) throw new HandsError("bad_arguments", `direction is up, down, left or right, not ${args.direction}`, usage("scroll"));
		const { evidence } = acting(w, () => el.scroll?.(args.direction));
		save();
		return { action: "scroll", ref, evidence, target: target(w), verified: evidence.changed };
	},
	menu(args) {
		const w = windowOf({ window: args.window });
		const path = String(args.path);
		if (/^(apple|window|help)\b/i.test(path) || /\b(copy|cut|paste|open|open recent|print|share|emoji|dictation|speech)\b/i.test(path.split(">").at(-1)))
			throw new HandsError("not_supported", `menu ${quoted(path)} is refused`, "Do it another way: menus that reach the clipboard, open files or leave the app aren't run.");
		let said;
		const { evidence } = acting(w, () => (said = w.model.menu?.(path)));
		save();
		if (said === undefined) throw new HandsError("action_failed", `${w.app} has no menu item ${quoted(path)}`, "Name the titles from the menu bar down, like File > Save.");
		return { action: "menu", path, evidence, target: target(w), verified: true, ...(said === "sheet" ? { opened: [{ window: w.id, kind: "sheet" }] } : {}) };
	},
	close(args) {
		const w = windowOf({ window: args.window });
		const said = w.model.close ? w.model.close() : ((w.model.closed = true), "closed");
		if (said === "closed" || w.model.export().closed !== false) w.closed = true;
		save();
		if (said === "sheet")
			return {
				closed: false,
				window: w.id,
				opened: [{ window: w.id, kind: "sheet", waiting: true }],
				note: "the window asked first: a sheet is up on it. Snapshot the window and answer it (Don't Save or Cancel; Save saves the document you opened).",
			};
		return { closed: true, window: w.id };
	},
	shot(args) {
		windowOf({ window: args.window });
		throw new HandsError("permission_denied", "Polycarp can't capture windows: Screen Recording is off for it", "Read the window with snapshot instead.");
	},
	click_at(args) {
		const w = windowOf({ window: args.window });
		if (rightClick(args))
			throw new HandsError(
				"outside_agent_workspace",
				"a right click opens its menu where Donovan can see it unless the agent workspace is on screen under the window; it isn't, so nothing was posted",
				"Use `click` on a ref for the element's own action, or `menu` for the app's menu bar.",
				"never",
				null,
			);
		throw new HandsError("unverified", `neither window ${w.id}'s tree nor the pixels around ${args.x},${args.y} changed`, "Act on an element by ref instead: snapshot the window for refs.", "never");
	},
	drag(args) {
		const w = windowOf({ window: args.window });
		throw new HandsError("unverified", `nothing along the drag in window ${w.id} changed`, "Act on an element by ref instead: snapshot the window for refs.", "never");
	},
	/** RunSteps and HandsRouter+Steps: every step checked and its ref resolved before any runs, then each in turn, stopping at
	 * the first that fails, isn't verified or raises a sheet; one read of what changed ends it. */
	run_steps(args) {
		const list = args.steps;
		if (!Array.isArray(list) || !list.length) throw stepsBad("steps is missing: pass a list of {tool, args}");
		if (list.length > MAX_STEPS) throw stepsBad(`at most ${MAX_STEPS} steps, not ${list.length}`);
		const steps = list.map((step, i) => {
			const n = i + 1;
			const { tool, args: inner, ...beside } = step ?? {};
			if (typeof tool !== "string") throw stepsBad(`step ${n} has no tool`);
			const name = (tool.startsWith("computer_") ? tool.slice("computer_".length) : tool).replace(/-/g, "_");
			if (!STEP_VERBS.includes(name)) throw stepsBad(`step ${n}: ${tool} can't be a step; steps are ${STEP_VERBS.map((v) => v.replace(/_/g, "-")).join(", ")}`);
			const a = { ...(inner ?? {}), ...beside };
			if (a.wait === undefined && args.wait !== undefined) a.wait = args.wait;
			try {
				check(name, a);
			} catch (e) {
				if (!(e instanceof HandsError)) throw e;
				throw new HandsError("bad_arguments", `step ${n} (${name.replace(/_/g, "-")}): ${e.message}`, `${e.suggestion}. Nothing ran.`, "safe", null);
			}
			return { name, args: a };
		});
		// Row numbers mean the latest snapshot before the run, resolved now: a step's own reads never shift them.
		const ids = steps.map((st, i) => {
			try {
				if (st.args.ref !== undefined) {
					const r = resolveRef(st.args.ref);
					st.args.ref = r.ref;
					return r.w.id;
				}
				return windowOf(st.args).id;
			} catch (e) {
				if (!(e instanceof HandsError)) throw e;
				throw new HandsError(e.code, `step ${i + 1}: ${e.message}`, `${e.suggestion}. Nothing ran.`, e.retry, e.nextCallOverride);
			}
		});
		const lines = [];
		let stop;
		let last = ids[0];
		let opened;
		for (let i = 0; i < steps.length; i++) {
			const w = windows.get(ids[i]);
			if (!w || w.closed) {
				stop = "gone";
				break;
			}
			last = ids[i];
			const env = call(steps[i].name, { ...steps[i].args });
			if (!env.ok) stop = "failed";
			else if (env.data.opened) stop = "opened";
			else if (env.data.verified === false) stop = "unverified";
			const l = { step: i + 1, tool: steps[i].name.replace(/_/g, "-"), ok: env.ok };
			if (env.error) l.error = { code: env.error.code, message: env.error.message, suggestion: env.error.suggestion };
			if (env.data) {
				for (const k of ["verified", "landed", "opened"]) if (env.data[k] !== undefined) l[k] = env.data[k];
				if (env.data.evidence?.value !== undefined) l.value = env.data.evidence.value;
				if (stop) l.result = env.data;
			}
			lines.push(l);
			if (stop) {
				opened = env.data?.opened;
				break;
			}
		}
		const dialog = (Array.isArray(opened) ? opened[0] : opened)?.window;
		const read = call("snapshot", dialog !== undefined ? { window: dialog, format: "rows", max_elements: 60 } : { window: last, since: "latest" });
		const done = lines.filter((l) => l.ok).length;
		const answer = { steps: lines, done, of: steps.length, complete: stop === undefined && done === steps.length };
		if (stop) {
			const rest = steps.length - lines.length;
			const left = rest > 0 ? `; the ${rest} after it did not run` : "";
			const n = lines.length;
			answer.stopped = stop;
			answer.note = {
				failed: `step ${n} failed${left}. Its error says what to do.`,
				unverified: `step ${n} ran but nothing read back shows it landed${left}. Check the read below before going on.`,
				opened: `step ${n} raised a dialog or sheet${left}. Answer it (the read below shows it), then continue.`,
				gone: `the window of step ${n + 1} went away, so the last ${rest} did not run.`,
			}[stop];
		}
		if (read.ok) answer.read = read.data;
		else answer.read_error = read.error.message;
		return answer;
	},
	arrange() {
		return { arranged: [...windows.values()].filter((w) => !w.closed).map((w) => w.id) };
	},
	move(args) {
		const w = windowOf({ window: args.window });
		return { window: w.id, workspace: AGENT_WORKSPACE };
	},
};

function usage(name) {
	const t = TOOLS.get(name);
	const req = new Set(t?.inputSchema?.required ?? []);
	const parts = Object.keys(t?.inputSchema?.properties ?? {}).map((p) => (req.has(p) ? `<${p}>` : `[--${p} <${p}>]`));
	return `usage: polycarp-spaces agent ${name.replace(/_/g, "-")} ${parts.join(" ")}`.trim();
}

/** HandsParse.call: the arguments are checked as the helper checks them before anything is done. */
function check(name, args) {
	if (name === "lend" || name === "return") throw new HandsError("needs_lend", `agents can't lend apps; ${args.app ?? "the app"} is not on the agent workspace`, "Ask the user to lend it.", "never");
	const t = TOOLS.get(name);
	if (!t || !verbs[name]) throw new HandsError("bad_arguments", `unknown tool ${name}`, "Call tools/list for the tools.");
	const props = t.inputSchema.properties ?? {};
	for (const [k, v] of Object.entries(args)) {
		const p = props[k];
		if (!p) throw new HandsError("bad_arguments", `unknown argument ${k}`, usage(name));
		const objects = p.type === "array" && p.items?.type === "object";
		if (objects && typeof v === "string") {
			// HandsParse: a list of objects may come as its JSON text.
			try {
				args[k] = JSON.parse(v);
			} catch {}
		}
		const x = args[k];
		const isObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
		const ok = p.type === "integer" ? Number.isInteger(x) : p.type === "boolean" ? typeof x === "boolean" : objects ? Array.isArray(x) && x.every(isObject) : p.type === "array" ? Array.isArray(x) && x.every((y) => typeof y === "string") : true;
		if (!ok) throw new HandsError("bad_arguments", `${k} takes ${p.type === "integer" ? "a number" : p.type === "boolean" ? "true or false" : objects ? "a list of objects" : "a list of strings"}`, usage(name));
		if (p.type === "string" && typeof v !== "string") args[k] = JSON.stringify(v);
	}
	for (const r of t.inputSchema.required ?? []) if (args[r] === undefined) throw new HandsError("bad_arguments", `${r} is missing`, usage(name));
	if (name === "type" && (args.text === undefined) === !args.paste) throw new HandsError("bad_arguments", args.paste ? "pass text or paste: true, not both" : "text is missing (or pass paste: true)", usage(name));
	if ((name === "snapshot" || name === "find") && args.app === undefined && args.window === undefined) throw new HandsError("bad_arguments", "say which window: app or window", usage(name));
	if (args.wait !== undefined && (args.wait < 0 || args.wait > 60)) throw new HandsError("bad_arguments", `wait is seconds from 0 to 60, not ${args.wait}`, usage(name));
}

function call(name, args) {
	const window = args.window ?? undefined;
	try {
		check(name, args);
		const data = verbs[name](args);
		save();
		return { ok: true, data };
	} catch (e) {
		if (!(e instanceof HandsError)) throw e;
		save();
		let w = window;
		if (w === undefined && args.ref) {
			const m = /^@([a-z0-9]+):e\d+$/.exec(String(args.ref).trim());
			w = (m && snapshots.get(m[1])?.window) ?? (latestListed && snapshots.get(latestListed)?.window);
		}
		return { ok: false, error: { code: e.code, message: e.message, retry: e.retry, suggestion: e.suggestion, next_call: e.nextCallOverride !== undefined ? e.nextCallOverride : nextCall(e.code, w) } };
	}
}

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

save();
createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (text) => {
	let m;
	try {
		m = JSON.parse(text);
	} catch {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
		return;
	}
	if (m.id === undefined || !m.method) return;
	if (m.method === "initialize")
		return reply(m.id, {
			protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "polycarp-connector", version: "stub" },
			instructions: SPEC.instructions,
		});
	if (m.method === "ping") return reply(m.id, {});
	if (m.method === "tools/list") return reply(m.id, { tools: SPEC.tools });
	if (m.method === "tools/call") {
		const name = m.params?.name;
		const env = call(name, { ...(m.params?.arguments ?? {}) });
		const rowsText = env.ok && env.data?.format === "rows" ? env.data.text : undefined;
		// As MCP.swift's splitRead: a run's closing read in rows goes out as its own part, after the step lines.
		const read = rowsText === undefined && env.ok && env.data?.read?.format === "rows" && typeof env.data.read.text === "string" ? env.data.read.text : undefined;
		if (read !== undefined) {
			const { text: _rows, ...rest } = env.data.read;
			env.data = { ...env.data, read: { ...rest, text_below: true } };
		}
		const content = [{ type: "text", text: rowsText ?? line(env) }];
		if (read !== undefined) content.push({ type: "text", text: read });
		if (rowsText !== undefined && env.data.screenshot_error) content.push({ type: "text", text: `screenshot failed: ${env.data.screenshot_error}` });
		return reply(m.id, { content, isError: !env.ok });
	}
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } })}\n`);
});
