// The category registry: what may sync and how. It enforces the plan's safety rules in code:
// - Never-synced kinds cannot be registered. A category whose name (or, for settings-like categories, an op key) names
//   a secret, token, sign-in, Full Access, a lend, a scope or the like throws at registration, so no adapter for it can
//   exist and a forged op for it has nowhere to land.
// - Permission-like categories are narrow-only: another device's op that would widen (a set, an add, an append) is
//   refused and changes nothing; the replica lists it as a suggestion for a local click (PR 7). Narrow-only categories
//   must be lww, where a revoke is a del and a later local allow beats an older revoke by its clock.
// - An op for a category this build does not know, or with a newer schema than it knows, is stored and relayed but not
//   applied. It is applied after an upgrade, from the log or the snapshot's kept ops.
// The registry is frozen once built.

import { type AnyMergeType, MERGE_TYPES, type MergeName } from "./merge-types.ts";
import { isCategoryName, type SyncOp } from "./op.ts";

export type Direction = "both" | "narrow";

export interface CategoryDef {
	readonly name: string;
	readonly merge: MergeName;
	/** Highest schema version this build reads and writes for the category. */
	readonly schema: number;
	/** Whether a new device syncs it before the owner changes anything. */
	readonly defaultOn: boolean;
	/** "narrow": another device can only take away (revoke), never grant. */
	readonly direction: Direction;
	/** log only: a stream key must start with "<author>/", and only that author appends, deletes or clears in it. */
	readonly singleWriter?: boolean;
	/** lww only: refuse op keys that name a never-synced kind (for settings maps). */
	readonly guardKeys?: boolean;
}

export type SkipReason =
	| "unknown-category"
	| "newer-schema"
	| "malformed"
	| "widening"
	| "single-writer"
	| "never-synced-key";

export type Decision = { apply: true; def: CategoryDef; type: AnyMergeType } | { apply: false; reason: SkipReason };

export interface Registry {
	get(name: string): CategoryDef | undefined;
	list(): readonly CategoryDef[];
	typeOf(name: string): AnyMergeType | undefined;
	/** Whether the replica on `localDevice` applies this op, and if not, why. */
	decide(op: SyncOp, localDevice: string): Decision;
}

export class NeverSyncedError extends Error {
	constructor(name: string, term: string) {
		super(`"${name}" names ${term}, which never syncs`);
		this.name = "NeverSyncedError";
	}
}

// Words that mark data which never syncs: provider keys, tokens, OAuth and sign-ins, the link secret, cookies, Full
// Access, lends, scopes, permission mode, sandbox and hook settings (plan section 2, "Never syncs").
const DENIED_WORDS = new Set([
	"secret",
	"secrets",
	"token",
	"tokens",
	"password",
	"passwords",
	"passcode",
	"passcodes",
	"passphrase",
	"credential",
	"credentials",
	"cookie",
	"cookies",
	"key",
	"keys",
	"apikey",
	"apikeys",
	"keypair",
	"privatekey",
	"oauth",
	"auth",
	"signin",
	"signins",
	"signon",
	"login",
	"logins",
	"fullaccess",
	"lend",
	"lends",
	"lending",
	"scope",
	"scopes",
	"subscription",
	"subscriptions",
	"sandbox",
	"hook",
	"hooks",
	"permissionmode",
]);
const DENIED_PAIRS = new Set([
	"sign in",
	"sign ins",
	"sign on",
	"log in",
	"full access",
	"permission mode",
	"private key",
]);

function words(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** The never-synced term a name contains, or null. Checks single words, adjacent pairs and the name run together. */
export function deniedTerm(name: string): string | null {
	const list = words(name);
	for (const word of list) if (DENIED_WORDS.has(word)) return word;
	for (let i = 0; i + 1 < list.length; i++) {
		const pair = `${list[i]} ${list[i + 1]}`;
		if (DENIED_PAIRS.has(pair)) return pair;
		if (DENIED_WORDS.has(`${list[i]}${list[i + 1]}`)) return pair;
	}
	const joined = list.join("");
	for (const pair of DENIED_PAIRS) if (joined === pair.replace(" ", "")) return pair;
	return null;
}

function validate(def: CategoryDef, seen: Set<string>): CategoryDef {
	if (!isCategoryName(def.name)) throw new Error(`bad category name ${JSON.stringify(def.name)}`);
	const term = deniedTerm(def.name);
	if (term) throw new NeverSyncedError(def.name, term);
	if (seen.has(def.name)) throw new Error(`category ${def.name} registered twice`);
	if (!Object.hasOwn(MERGE_TYPES, def.merge)) throw new Error(`category ${def.name}: unknown merge type ${def.merge}`);
	if (!Number.isSafeInteger(def.schema) || def.schema < 1) throw new Error(`category ${def.name}: bad schema`);
	if (typeof def.defaultOn !== "boolean") throw new Error(`category ${def.name}: defaultOn must be a boolean`);
	if (def.direction !== "both" && def.direction !== "narrow") throw new Error(`category ${def.name}: bad direction`);
	if (def.direction === "narrow" && def.merge !== "lww")
		throw new Error(`category ${def.name}: a narrow-only category must be lww`);
	if (def.singleWriter && def.merge !== "log") throw new Error(`category ${def.name}: singleWriter is for logs`);
	if (def.guardKeys && def.merge !== "lww") throw new Error(`category ${def.name}: guardKeys is for lww`);
	return Object.freeze({ ...def });
}

export function createRegistry(defs: readonly CategoryDef[]): Registry {
	const seen = new Set<string>();
	const byName = new Map<string, CategoryDef>();
	for (const def of defs) {
		const checked = validate(def, seen);
		seen.add(checked.name);
		byName.set(checked.name, checked);
	}
	const list = Object.freeze([...byName.values()]);
	const registry: Registry = {
		get: (name) => byName.get(name),
		list: () => list,
		typeOf: (name) => {
			const def = byName.get(name);
			return def ? MERGE_TYPES[def.merge] : undefined;
		},
		decide(op, localDevice) {
			const def = byName.get(op.category);
			if (!def) return { apply: false, reason: "unknown-category" };
			if (op.schema > def.schema) return { apply: false, reason: "newer-schema" };
			const type = MERGE_TYPES[def.merge];
			if (type.check(op) !== null) return { apply: false, reason: "malformed" };
			if (def.direction === "narrow" && op.author !== localDevice && type.widening.includes(op.kind))
				return { apply: false, reason: "widening" };
			if (def.singleWriter && !op.key.startsWith(`${op.author}/`)) return { apply: false, reason: "single-writer" };
			if (def.guardKeys && deniedTerm(op.key) !== null) return { apply: false, reason: "never-synced-key" };
			return { apply: true, def, type };
		},
	};
	return Object.freeze(registry);
}

/** The categories the plan names (section 2, data model). Adapters arrive in PRs 6 to 8; nothing syncs yet. */
export const DEFAULT_CATEGORIES: readonly CategoryDef[] = Object.freeze([
	{ name: "settings-sidepanel", merge: "lww", schema: 1, defaultOn: true, direction: "both", guardKeys: true },
	{ name: "settings-silas", merge: "lww", schema: 1, defaultOn: true, direction: "both", guardKeys: true },
	{ name: "settings-spaces", merge: "lww", schema: 1, defaultOn: true, direction: "both", guardKeys: true },
	{ name: "themes", merge: "lww", schema: 1, defaultOn: true, direction: "both" },
	{ name: "dictionary", merge: "awset", schema: 1, defaultOn: true, direction: "both" },
	{ name: "library", merge: "awset", schema: 1, defaultOn: true, direction: "both" },
	{ name: "skills", merge: "lww", schema: 1, defaultOn: true, direction: "both" },
	{ name: "history", merge: "log", schema: 1, defaultOn: false, direction: "both" },
	{ name: "threads", merge: "log", schema: 1, defaultOn: false, direction: "both", singleWriter: true },
	{ name: "site-permissions", merge: "lww", schema: 1, defaultOn: true, direction: "narrow" },
] satisfies CategoryDef[]);

export const defaultRegistry = (): Registry => createRegistry(DEFAULT_CATEGORIES);
