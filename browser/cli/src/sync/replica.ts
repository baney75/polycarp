// One device's replica: its op log, version vector, the acks it has from other members, ops held for a fast clock,
// and the snapshot compaction folds ops into. Every function is pure: it takes a replica and returns a new one, and
// time arrives as an argument (integer milliseconds). Nothing here reads a clock, touches a file or the network.
//
// Rules (plan section 2):
// - An op stamped more than 5 minutes ahead of the local wall clock is held: not logged, applied, acked or relayed,
//   and it does not move the clock. releaseHeld (and every receiveOps) admits it once the clock catches up.
// - Every admitted op stays in the log until compaction, applied or not, so it can be relayed. An op the registry will
//   not apply (unknown category, newer schema, a widening op in a narrow category) is listed in `skipped` and, when
//   compacted, kept in the snapshot rather than dropped.
// - Compaction folds an op into the snapshot once every current member has acked it. A member unseen for 90 days is
//   not current and stops blocking. A tombstone drops 90 days after it was folded, and only once every op that could
//   precede it (each member's own ops up to its ack at fold time) is folded too.
// - A peer whose vector is below the snapshot gets a snapshot, not a delta. adoptSnapshot takes it, keeps this
//   device's own unsent ops, and replays its offline edits as new ops (fresh clock), so they hold over older edits.

import { canonicalize, type Json } from "./canonical.ts";
import { type Hlc, hlcReceive, hlcSend, isTooFarAhead, ZERO_HLC } from "./hlc.ts";
import { type AwSetState, awset } from "./merge-types.ts";
import { compareOpOrder, isDeviceId, normalizeObs, OP_VERSION, opId, opProblem, type SyncOp } from "./op.ts";
import { copyRec, get, has, type Rec, rec } from "./records.ts";
import type { Registry, SkipReason } from "./registry.ts";
import { type VersionVector, vvCovers, vvGet, vvMerge, vvMin } from "./vv.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A member unseen this long stops blocking compaction. */
export const ABSENT_AFTER_MS = 90 * DAY_MS;
/** A folded tombstone is kept this long. */
export const TOMBSTONE_TTL_MS = 90 * DAY_MS;

export interface Snapshot {
	/** Ops folded in, per author. */
	vv: VersionVector;
	/** Category name to folded state. */
	states: Rec<unknown>;
	/** Folded ops this build did not apply, by op id. Never dropped, so they can be relayed and applied after an upgrade. */
	kept: Rec<SyncOp>;
}

export interface FoldRecord {
	/** Wall time the tombstone was first seen folded. */
	at: number;
	/** Each member's own ops up to here must be folded before it drops. */
	need: VersionVector;
}

export interface Replica {
	readonly device: string;
	readonly clock: Hlc;
	/** Last sequence number this device used. */
	readonly seq: number;
	/** What this replica holds, snapshot plus log, contiguous per author. */
	readonly vv: VersionVector;
	/** Ops not yet folded, by op id. */
	readonly log: Rec<SyncOp>;
	readonly snapshot: Snapshot;
	/** Live state per category: snapshot, applicable kept ops and the log. */
	readonly states: Rec<unknown>;
	/** Op id to why the registry did not apply it. Derived from the log and kept ops. */
	readonly skipped: Rec<SkipReason>;
	/** Ops waiting for the local clock, by op id. */
	readonly held: Rec<SyncOp>;
	/** Other members (from the signed roster in PR 5) and when each was last seen, wall ms. */
	readonly members: Rec<number>;
	/** The latest vector each member acked. */
	readonly acks: Rec<VersionVector>;
	/** Tombstones folded into the snapshot, keyed by category and tombstone id. */
	readonly folded: Rec<FoldRecord>;
}

export interface LocalEdit {
	category: string;
	kind: string;
	key: string;
	value?: Json;
	/** Defaults: awset add and remove observe every live tag of the key. log delete must name entry ids. */
	obs?: string[];
	/** Write an older schema (the lowest a member reads, negotiated in PR 5). Defaults to the registry's. */
	schema?: number;
}

export type Delta = { kind: "ops"; ops: SyncOp[] } | { kind: "snapshot"; snapshot: SnapshotMessage };

export interface SnapshotMessage {
	from: string;
	vv: VersionVector;
	snapshot: Snapshot;
	ops: SyncOp[];
}

export function createReplica(device: string, members: Rec<number> = rec<number>()): Replica {
	if (!isDeviceId(device)) throw new Error(`bad device id ${JSON.stringify(device)}`);
	const m = copyRec(members);
	delete m[device];
	return {
		device,
		clock: ZERO_HLC,
		seq: 0,
		vv: rec<number>(),
		log: rec<SyncOp>(),
		snapshot: { vv: rec<number>(), states: rec<unknown>(), kept: rec<SyncOp>() },
		states: rec<unknown>(),
		skipped: rec<SkipReason>(),
		held: rec<SyncOp>(),
		members: m,
		acks: rec<VersionVector>(),
		folded: rec<FoldRecord>(),
	};
}

/** The canonical bytes of the live state, the thing replicas must agree on. */
export function stateBytes(replica: Replica): string {
	return canonicalize(replica.states);
}

/** What adapters show: each category's view. */
export function view(replica: Replica, registry: Registry): Rec<Json> {
	const out = rec<Json>();
	for (const name of Object.keys(replica.states)) {
		const type = registry.typeOf(name);
		if (type) out[name] = type.view(replica.states[name]);
	}
	return out;
}

/** Op ids the replica refused as widening, for the "suggestions" a local click turns into an allow (PR 7). */
export function suggestions(replica: Replica): string[] {
	return Object.keys(replica.skipped)
		.filter((id) => replica.skipped[id] === "widening")
		.sort();
}

// ---------- applying ----------

function applyTo(
	states: Rec<unknown>,
	skipped: Rec<SkipReason>,
	registry: Registry,
	device: string,
	op: SyncOp,
): boolean {
	const decision = registry.decide(op, device);
	if (!decision.apply) {
		skipped[opId(op)] = decision.reason;
		return false;
	}
	delete skipped[opId(op)];
	const current = get(states, op.category) ?? decision.type.empty();
	states[op.category] = decision.type.apply(current, op);
	return true;
}

function sortedOps(ops: Rec<SyncOp>): SyncOp[] {
	return Object.values(ops).sort(compareOpOrder);
}

/** Live state from scratch: snapshot, then kept ops, then the log. Equal to the incremental result (apply commutes). */
export function rebuild(replica: Replica, registry: Registry): Replica {
	const states = copyRec(replica.snapshot.states);
	const skipped = rec<SkipReason>();
	for (const op of sortedOps(replica.snapshot.kept)) applyTo(states, skipped, registry, replica.device, op);
	for (const op of sortedOps(replica.log)) applyTo(states, skipped, registry, replica.device, op);
	return { ...replica, states, skipped };
}

function advanceVv(vv: VersionVector, log: Rec<SyncOp>, authors: Iterable<string>): VersionVector {
	const out = copyRec(vv);
	for (const author of authors) {
		let n = vvGet(out, author);
		while (has(log, `${author}:${n + 1}`)) n++;
		if (n > 0) out[author] = n;
	}
	return out;
}

/** Whether the replica already has an op (folded, logged or held). */
function holds(replica: Replica, op: SyncOp): boolean {
	const id = opId(op);
	return vvCovers(replica.snapshot.vv, op.author, op.seq) || has(replica.log, id) || has(replica.held, id);
}

/**
 * Write a local edit. Throws when the registry would not apply it (a device never writes what it cannot read).
 * Returns the new replica and the op to send.
 */
export function localOp(
	replica: Replica,
	registry: Registry,
	edit: LocalEdit,
	now: number,
): { replica: Replica; op: SyncOp } {
	const def = registry.get(edit.category);
	if (!def) throw new Error(`unknown category ${edit.category}`);
	const clock = hlcSend(replica.clock, now);
	const seq = replica.seq + 1;
	let obs = edit.obs;
	if (obs === undefined && def.merge === "awset")
		obs = awset.tagsOf((get(replica.states, edit.category) as AwSetState | undefined) ?? awset.empty(), edit.key);
	const op: SyncOp = {
		v: OP_VERSION,
		category: edit.category,
		schema: edit.schema ?? def.schema,
		author: replica.device,
		seq,
		at: clock,
		kind: edit.kind,
		key: edit.key,
	};
	if (edit.value !== undefined) op.value = edit.value;
	if (obs !== undefined) op.obs = normalizeObs(obs);
	const problem = opProblem(op);
	if (problem) throw new Error(`bad local op: ${problem}`);
	const decision = registry.decide(op, replica.device);
	if (!decision.apply) throw new Error(`local op refused: ${decision.reason}`);
	const states = copyRec(replica.states);
	const skipped = copyRec(replica.skipped);
	applyTo(states, skipped, registry, replica.device, op);
	const log = copyRec(replica.log);
	log[opId(op)] = op;
	return {
		replica: { ...replica, clock, seq, log, states, skipped, vv: advanceVv(replica.vv, log, [replica.device]) },
		op,
	};
}

function admit(replica: Replica, registry: Registry, ops: readonly SyncOp[], now: number): Replica {
	if (ops.length === 0) return replica;
	const log = copyRec(replica.log);
	const states = copyRec(replica.states);
	const skipped = copyRec(replica.skipped);
	let clock = replica.clock;
	let seq = replica.seq;
	const authors = new Set<string>();
	for (const op of ops) {
		log[opId(op)] = op;
		clock = hlcReceive(clock, op.at, now);
		// An op of our own we no longer had (a rebuilt log): never reuse its sequence number.
		if (op.author === replica.device) seq = Math.max(seq, op.seq);
		authors.add(op.author);
		applyTo(states, skipped, registry, replica.device, op);
	}
	return { ...replica, log, states, skipped, clock, seq, vv: advanceVv(replica.vv, log, authors) };
}

/**
 * Take ops from another replica, in any order, with duplicates. Malformed ops are dropped (they cannot be keyed or
 * relayed safely). Ops already held are ignored; the first body seen for an op id wins (signatures in PR 5 make two
 * bodies for one id detectable). Held ops whose time has come are admitted first.
 */
export function receiveOps(replica: Replica, registry: Registry, incoming: readonly unknown[], now: number): Replica {
	let next = releaseHeld(replica, registry, now);
	const ready: SyncOp[] = [];
	const seen = new Set<string>();
	let held: Rec<SyncOp> | null = null;
	for (const raw of incoming) {
		if (opProblem(raw) !== null) continue;
		const op = raw as SyncOp;
		const id = opId(op);
		if (seen.has(id) || holds(next, op)) continue;
		seen.add(id);
		if (isTooFarAhead(op.at, now)) {
			held ??= copyRec(next.held);
			held[id] = op;
		} else ready.push(op);
	}
	if (held) next = { ...next, held };
	return admit(next, registry, ready, now);
}

/** Admit held ops that are no longer too far ahead of `now`. */
export function releaseHeld(replica: Replica, registry: Registry, now: number): Replica {
	const ids = Object.keys(replica.held);
	if (ids.length === 0) return replica;
	const held = copyRec(replica.held);
	const ready: SyncOp[] = [];
	for (const id of ids.sort()) {
		if (isTooFarAhead(held[id].at, now)) continue;
		ready.push(held[id]);
		delete held[id];
	}
	if (ready.length === 0) return replica;
	return admit({ ...replica, held }, registry, ready, now);
}

// ---------- exchange ----------

/** What a peer with vector `peer` lacks: ops past its vector, or the whole snapshot when it is behind the snapshot. */
export function delta(replica: Replica, peer: VersionVector): Delta {
	for (const author of Object.keys(replica.snapshot.vv))
		if (vvGet(peer, author) < replica.snapshot.vv[author])
			return { kind: "snapshot", snapshot: snapshotMessage(replica) };
	const ops = sortedOps(replica.log).filter((op) => !vvCovers(peer, op.author, op.seq));
	return { kind: "ops", ops };
}

export function snapshotMessage(replica: Replica): SnapshotMessage {
	return { from: replica.device, vv: replica.vv, snapshot: replica.snapshot, ops: sortedOps(replica.log) };
}

/** Record that a member acked a vector (it holds those ops) and was seen at `now`. */
export function recordAck(replica: Replica, member: string, acked: VersionVector, now: number): Replica {
	if (member === replica.device || !has(replica.members, member)) return replica;
	const acks = copyRec(replica.acks);
	acks[member] = vvMerge(get(acks, member) ?? rec<number>(), acked);
	const members = copyRec(replica.members);
	members[member] = Math.max(members[member], now);
	return { ...replica, acks, members };
}

/** Replace the member list (the signed roster, PR 5). A new member counts as seen at `now`; a removed one's acks go. */
export function setMembers(replica: Replica, ids: readonly string[], now: number): Replica {
	const members = rec<number>();
	const acks = rec<VersionVector>();
	for (const id of ids) {
		if (id === replica.device) continue;
		members[id] = get(replica.members, id) ?? now;
		const ack = get(replica.acks, id);
		if (ack) acks[id] = ack;
	}
	return { ...replica, members, acks };
}

/** Members seen within ABSENT_AFTER_MS of `now`. */
export function currentMembers(replica: Replica, now: number): string[] {
	return Object.keys(replica.members)
		.filter((id) => now - replica.members[id] < ABSENT_AFTER_MS)
		.sort();
}

// ---------- compaction ----------

/** The vector every current member has acked (and this replica holds). Empty when no other member is current. */
export function foldFrontier(replica: Replica, now: number): VersionVector {
	const current = currentMembers(replica, now);
	if (current.length === 0) return rec<number>();
	return vvMin(
		replica.vv,
		current.map((id) => get(replica.acks, id) ?? rec<number>()),
	);
}

/**
 * Fold every op the current members all acked into the snapshot, re-try kept ops against this build's registry, and
 * drop tombstones whose time is up. The live state is rebuilt from the result.
 */
export function compact(replica: Replica, registry: Registry, now: number): Replica {
	const frontier = foldFrontier(replica, now);
	const states = copyRec(replica.snapshot.states);
	const kept = rec<SyncOp>();
	const scratch = rec<SkipReason>();
	for (const op of sortedOps(replica.snapshot.kept))
		if (!applyTo(states, scratch, registry, replica.device, op)) kept[opId(op)] = op;
	const log = copyRec(replica.log);
	for (const op of sortedOps(replica.log)) {
		if (!vvCovers(frontier, op.author, op.seq)) continue;
		if (!applyTo(states, scratch, registry, replica.device, op)) kept[opId(op)] = op;
		delete log[opId(op)];
	}
	const snapVv = vvMerge(replica.snapshot.vv, frontier);

	// Tombstones: note when each was first folded and what must be folded before it may go.
	const current = currentMembers(replica, now);
	const need = rec<number>();
	const ownSeq = vvGet(replica.vv, replica.device);
	if (ownSeq > 0) need[replica.device] = ownSeq;
	for (const id of current) {
		const own = vvGet(get(replica.acks, id) ?? rec<number>(), id);
		if (own > 0) need[id] = own;
	}
	const folded = rec<FoldRecord>();
	for (const name of Object.keys(states)) {
		const type = registry.typeOf(name);
		if (!type) continue;
		const drop = new Set<string>();
		for (const tomb of type.tombstones(states[name])) {
			const key = canonicalize([name, tomb]);
			const record = get(replica.folded, key) ?? { at: now, need };
			const ready =
				now - record.at >= TOMBSTONE_TTL_MS &&
				Object.keys(record.need).every((id) => vvCovers(snapVv, id, record.need[id]));
			if (ready) drop.add(tomb);
			else folded[key] = record;
		}
		if (drop.size > 0) states[name] = type.dropTombstones(states[name], drop);
	}
	const snapshot: Snapshot = { vv: snapVv, states, kept };
	return rebuild({ ...replica, log, snapshot, folded }, registry);
}

// ---------- rejoin ----------

/** Kinds replayed with a fresh clock on rejoin: edits whose outcome depends on their time. */
function replayable(op: SyncOp, registry: Registry): boolean {
	const def = registry.get(op.category);
	if (!def) return false;
	if (def.merge === "lww") return true;
	if (def.merge === "awset") return op.kind === "add";
	return false;
}

/**
 * Rejoin after an absence: adopt a peer's snapshot and log, keep every op of ours (and any other op) the peer lacks,
 * then replay this device's own offline edits as new ops with a fresh clock. The originals stay in the log so no
 * sequence number is skipped or reused; the replays win over them and over older edits elsewhere. Log appends and
 * set removes are not replayed: their meaning does not depend on their time.
 */
export function adoptSnapshot(
	replica: Replica,
	registry: Registry,
	message: SnapshotMessage,
	now: number,
): { replica: Replica; replayed: SyncOp[] } {
	const extra = sortedOps(replica.log).filter((op) => !vvCovers(message.vv, op.author, op.seq));
	const log = rec<SyncOp>();
	for (const op of message.ops) if (opProblem(op) === null) log[opId(op)] = op;
	for (const op of extra) log[opId(op)] = op;
	let clock = replica.clock;
	for (const op of Object.values(log)) if (!isTooFarAhead(op.at, now)) clock = hlcReceive(clock, op.at, now);
	const authors = new Set(Object.keys(log).map((id) => id.slice(0, id.lastIndexOf(":"))));
	const vv = advanceVv(message.snapshot.vv, log, authors);
	let next = rebuild(
		{
			...replica,
			clock,
			seq: Math.max(replica.seq, vvGet(message.vv, replica.device)),
			vv,
			log,
			snapshot: {
				vv: copyRec(message.snapshot.vv),
				states: copyRec(message.snapshot.states),
				kept: copyRec(message.snapshot.kept),
			},
			folded: rec<FoldRecord>(),
		},
		registry,
	);
	const replayed: SyncOp[] = [];
	for (const op of extra) {
		if (op.author !== replica.device || !replayable(op, registry) || has(next.skipped, opId(op))) continue;
		const edit: LocalEdit = { category: op.category, kind: op.kind, key: op.key, schema: op.schema };
		if ("value" in op) edit.value = op.value;
		const out = localOp(next, registry, edit, now);
		next = out.replica;
		replayed.push(out.op);
	}
	return { replica: next, replayed };
}
