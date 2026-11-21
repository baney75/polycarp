// The three merge types. Each is a pure apply(state, op) -> state, a state-based merge(a, b) (the join of two states),
// and a view (what an adapter shows). apply is commutative, associative and idempotent over ops, so replicas that hold
// the same ops hold byte-identical canonical state whatever order the ops arrived in. Nothing mutates its input.
//
// lww   Last-writer-wins register map (settings, themes, skills, site permissions). Kinds: set (value), del.
//       The register with the greater stamp wins; equal stamps (only possible from a forged duplicate) fall back to the
//       canonical bytes, so even that converges.
// awset Add-wins observed-remove set with tombstones (dictionary, library). Kinds: add (value, obs = tags it replaces),
//       remove (obs = tags it saw). Each add is a tag (its op id). A remove tombstones only the tags it observed, so a
//       concurrent add survives. An element's value is its live tag with the greatest stamp (LWW item).
// log   Append-only log per stream (threads, history). Kinds: append (value), delete (obs = entry ids), clear. Entry
//       ids are op ids. Delete wins over the entry for good; clear hides every entry stamped before it.

import { canonicalize, type Json } from "./canonical.ts";
import { compareStamp, type Stamp } from "./hlc.ts";
import { type SyncOp, stampOf } from "./op.ts";
import { copyRec, get, has, type Rec, rec } from "./records.ts";

export type MergeName = "lww" | "awset" | "log";

export interface MergeType<S> {
	readonly name: MergeName;
	readonly kinds: readonly string[];
	/** Kinds that grant or add something. A narrow-only category refuses these from another device. */
	readonly widening: readonly string[];
	empty(): S;
	/** Why an op is not valid for this type (kind, value and obs shape), or null. */
	check(op: SyncOp): string | null;
	apply(state: S, op: SyncOp): S;
	merge(a: S, b: S): S;
	view(state: S): Json;
	/** Ids of the tombstones the state holds, for compaction. */
	tombstones(state: S): string[];
	/** The state without the named tombstones. */
	dropTombstones(state: S, ids: ReadonlySet<string>): S;
}

// ---------- lww ----------

export interface Register {
	at: Stamp;
	del: boolean;
	value: Json;
}
export type LwwState = Rec<Register>;

function registerWins(a: Register, b: Register): boolean {
	const order = compareStamp(a.at, b.at);
	if (order !== 0) return order > 0;
	return canonicalize(a) > canonicalize(b);
}

export const lww: MergeType<LwwState> = {
	name: "lww",
	kinds: ["set", "del"],
	widening: ["set"],
	empty: () => rec<Register>(),
	check(op) {
		if (op.kind === "set") return "value" in op && !("obs" in op) ? null : "set needs a value and no obs";
		if (op.kind === "del") return !("value" in op) && !("obs" in op) ? null : "del carries no value or obs";
		return `lww has no kind ${op.kind}`;
	},
	apply(state, op) {
		const incoming: Register = {
			at: stampOf(op),
			del: op.kind === "del",
			value: op.kind === "set" ? op.value! : null,
		};
		const current = get(state, op.key);
		if (current && !registerWins(incoming, current)) return state;
		const next = copyRec(state);
		next[op.key] = incoming;
		return next;
	},
	merge(a, b) {
		const out = copyRec(a);
		for (const key of Object.keys(b)) {
			const mine = get(out, key);
			if (!mine || registerWins(b[key], mine)) out[key] = b[key];
		}
		return out;
	},
	view(state) {
		const out = rec<Json>();
		for (const key of Object.keys(state)) if (!state[key].del) out[key] = state[key].value;
		return out;
	},
	tombstones: (state) => Object.keys(state).filter((key) => state[key].del),
	dropTombstones(state, ids) {
		const out = rec<Register>();
		for (const key of Object.keys(state)) if (!(state[key].del && ids.has(key))) out[key] = state[key];
		return out;
	},
};

// ---------- awset ----------

export interface Tag {
	key: string;
	at: Stamp;
	value: Json;
}
export interface AwSetState {
	/** Live tags by op id. */
	tags: Rec<Tag>;
	/** Removed tag ids. A tag here never comes back, even if its add arrives later. */
	tombs: Rec<true>;
}

function tagsOfKey(state: AwSetState, key: string): string[] {
	return Object.keys(state.tags)
		.filter((id) => state.tags[id].key === key)
		.sort();
}

export const awset: MergeType<AwSetState> & { tagsOf(state: AwSetState, key: string): string[] } = {
	name: "awset",
	kinds: ["add", "remove"],
	widening: ["add"],
	empty: () => ({ tags: rec<Tag>(), tombs: rec<true>() }),
	tagsOf: tagsOfKey,
	check(op) {
		if (op.kind === "add") return "value" in op && "obs" in op ? null : "add needs a value and obs";
		if (op.kind === "remove") return !("value" in op) && "obs" in op ? null : "remove needs obs and no value";
		return `awset has no kind ${op.kind}`;
	},
	apply(state, op) {
		const obs = op.obs ?? [];
		const tag = `${op.author}:${op.seq}`;
		const adds = op.kind === "add" && !has(state.tombs, tag) && !has(state.tags, tag);
		const newTombs = obs.filter((id) => !has(state.tombs, id));
		if (!adds && newTombs.length === 0) return state;
		const tags = copyRec(state.tags);
		const tombs = copyRec(state.tombs);
		for (const id of newTombs) {
			tombs[id] = true;
			delete tags[id];
		}
		if (adds) tags[tag] = { key: op.key, at: stampOf(op), value: op.value! };
		return { tags, tombs };
	},
	merge(a, b) {
		const tombs = copyRec(a.tombs);
		for (const id of Object.keys(b.tombs)) tombs[id] = true;
		const tags = rec<Tag>();
		for (const source of [a.tags, b.tags])
			for (const id of Object.keys(source)) if (!has(tombs, id)) tags[id] = source[id];
		return { tags, tombs };
	},
	view(state) {
		const best = rec<Tag>();
		for (const id of Object.keys(state.tags)) {
			const tag = state.tags[id];
			const current = get(best, tag.key);
			if (!current || compareStamp(tag.at, current.at) > 0) best[tag.key] = tag;
		}
		const out = rec<Json>();
		for (const key of Object.keys(best)) out[key] = best[key].value;
		return out;
	},
	tombstones: (state) => Object.keys(state.tombs),
	dropTombstones(state, ids) {
		const tombs = rec<true>();
		for (const id of Object.keys(state.tombs)) if (!ids.has(id)) tombs[id] = true;
		return { tags: state.tags, tombs };
	},
};

// ---------- log ----------

export interface Entry {
	at: Stamp;
	value: Json;
}
export interface Stream {
	entries: Rec<Entry>;
	deleted: Rec<true>;
	/** Entries stamped before this are gone. */
	clear: Stamp | null;
}
export type LogState = Rec<Stream>;

const emptyStream = (): Stream => ({ entries: rec<Entry>(), deleted: rec<true>(), clear: null });

function before(at: Stamp, clear: Stamp | null): boolean {
	return clear !== null && compareStamp(at, clear) < 0;
}

/** Tombstone ids for logs pair the stream with the entry, as canonical JSON. */
function logTombId(stream: string, entry: string): string {
	return canonicalize([stream, entry]);
}

export const log: MergeType<LogState> = {
	name: "log",
	kinds: ["append", "delete", "clear"],
	widening: ["append"],
	empty: () => rec<Stream>(),
	check(op) {
		if (op.kind === "append") return "value" in op && !("obs" in op) ? null : "append needs a value and no obs";
		if (op.kind === "delete")
			return !("value" in op) && (op.obs?.length ?? 0) > 0 ? null : "delete needs obs and no value";
		if (op.kind === "clear") return !("value" in op) && !("obs" in op) ? null : "clear carries no value or obs";
		return `log has no kind ${op.kind}`;
	},
	apply(state, op) {
		const stream = get(state, op.key) ?? emptyStream();
		const at = stampOf(op);
		let next: Stream;
		if (op.kind === "append") {
			const id = `${op.author}:${op.seq}`;
			if (has(stream.entries, id) || has(stream.deleted, id) || before(at, stream.clear)) return state;
			const entries = copyRec(stream.entries);
			entries[id] = { at, value: op.value! };
			next = { ...stream, entries };
		} else if (op.kind === "delete") {
			const fresh = (op.obs ?? []).filter((id) => !has(stream.deleted, id));
			if (fresh.length === 0) return state;
			const entries = copyRec(stream.entries);
			const deleted = copyRec(stream.deleted);
			for (const id of fresh) {
				deleted[id] = true;
				delete entries[id];
			}
			next = { ...stream, entries, deleted };
		} else {
			if (stream.clear && compareStamp(at, stream.clear) <= 0) return state;
			const entries = rec<Entry>();
			for (const id of Object.keys(stream.entries))
				if (!before(stream.entries[id].at, at)) entries[id] = stream.entries[id];
			next = { ...stream, entries, clear: at };
		}
		const out = copyRec(state);
		out[op.key] = next;
		return out;
	},
	merge(a, b) {
		const out = copyRec(a);
		for (const key of Object.keys(b)) {
			const x = get(out, key);
			const y = b[key];
			if (!x) {
				out[key] = y;
				continue;
			}
			const clear = !x.clear
				? y.clear
				: !y.clear
					? x.clear
					: compareStamp(x.clear, y.clear) >= 0
						? x.clear
						: y.clear;
			const deleted = copyRec(x.deleted);
			for (const id of Object.keys(y.deleted)) deleted[id] = true;
			const entries = rec<Entry>();
			for (const source of [x.entries, y.entries])
				for (const id of Object.keys(source))
					if (!has(deleted, id) && !before(source[id].at, clear)) entries[id] = source[id];
			out[key] = { entries, deleted, clear };
		}
		return out;
	},
	view(state) {
		const out = rec<Json>();
		for (const key of Object.keys(state)) {
			const entries = state[key].entries;
			out[key] = Object.keys(entries)
				.sort((p, q) => compareStamp(entries[p].at, entries[q].at))
				.map((id) => ({ id, value: entries[id].value }));
		}
		return out;
	},
	tombstones(state) {
		const out: string[] = [];
		for (const key of Object.keys(state))
			for (const id of Object.keys(state[key].deleted)) out.push(logTombId(key, id));
		return out;
	},
	dropTombstones(state, ids) {
		const out = rec<Stream>();
		for (const key of Object.keys(state)) {
			const stream = state[key];
			const deleted = rec<true>();
			for (const id of Object.keys(stream.deleted)) if (!ids.has(logTombId(key, id))) deleted[id] = true;
			out[key] = { ...stream, deleted };
		}
		return out;
	},
};

export type AnyMergeType = MergeType<any>;

export const MERGE_TYPES: Readonly<Record<MergeName, AnyMergeType>> = Object.freeze({ lww, awset, log });
