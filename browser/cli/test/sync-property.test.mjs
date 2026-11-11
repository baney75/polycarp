// Convergence property for the sync engine: three replicas write random ops for each merge type, deliver them in random
// order with duplication, loss, delay, fast clocks and random compaction, then exchange deltas until quiet. All three must
// end with byte-identical canonical state and view, and a state-based merge of any two must equal either.
// Run with --experimental-strip-types: it imports src/sync/*.ts. SYNC_SEEDS=n runs n seeds; SYNC_SEED=s runs one.
import assert from "node:assert/strict";
import test from "node:test";
import {
	adoptSnapshot,
	canonicalize,
	compact,
	createReplica,
	defaultRegistry,
	delta,
	localOp,
	MERGE_TYPES,
	receiveOps,
	recordAck,
	releaseHeld,
	view,
} from "../src/sync/index.ts";

/** mulberry32: a small seeded PRNG, so a failing seed replays exactly. */
function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const registry = defaultRegistry();
const DEVICES = ["dv-a", "dv-b", "dv-c"];
const BASE = 1_700_000_000_000;
const SIX_MIN = 6 * 60 * 1000;

function randomEdit(rand, replica, device) {
	const pick = (list) => list[Math.floor(rand() * list.length)];
	if (rand() < 0.1) {
		const key = pick(["github.com", "example.org"]);
		return rand() < 0.6
			? { category: "site-permissions", kind: "set", key, value: true }
			: { category: "site-permissions", kind: "del", key };
	}
	const which = rand();
	if (which < 0.3) {
		const key = pick(["theme", "density", "layout", "zoom"]);
		return rand() < 0.75
			? { category: "settings-spaces", kind: "set", key, value: { n: Math.floor(rand() * 10) } }
			: { category: "settings-spaces", kind: "del", key };
	}
	if (which < 0.6) {
		const key = pick(["polycarp", "silas", "omarchy", "tailnet"]);
		return rand() < 0.65
			? { category: "dictionary", kind: "add", key, value: Math.floor(rand() * 10) }
			: { category: "dictionary", kind: "remove", key };
	}
	const category = which < 0.8 ? "history" : "threads";
	const key = category === "threads" ? `${device}/t${Math.floor(rand() * 2)}` : pick(["s1", "s2"]);
	const roll = rand();
	const entries = (view(replica, registry)[category]?.[key] ?? []).map((e) => e.id);
	if (roll < 0.2 && entries.length > 0) return { category, kind: "delete", key, obs: [pick(entries)] };
	if (roll < 0.25) return { category, kind: "clear", key };
	return { category, kind: "append", key, value: { text: `e${Math.floor(rand() * 100)}` } };
}

function shuffle(rand, list) {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// Narrow-only state is per device by design (each keeps its own allows), so convergence is checked on the shared
// categories and the narrow rule is checked directly.
const NARROW = "site-permissions";
function withoutNarrow(record) {
	const { [NARROW]: _narrow, ...rest } = record;
	return rest;
}
function snapshotOf(replicas) {
	return replicas.map((r) => ({
		state: canonicalize(withoutNarrow(r.states)),
		view: canonicalize(withoutNarrow(view(r, registry))),
	}));
}
function assertNarrow(seed, r) {
	const regs = r.states[NARROW] ?? {};
	for (const key of Object.keys(regs))
		if (!regs[key].del)
			assert.equal(regs[key].at.device, r.device, `seed ${seed}: ${r.device} holds ${regs[key].at.device}'s allow`);
}

function runSeed(seed) {
	const rand = prng(seed);
	const members = Object.fromEntries(DEVICES.map((d) => [d, BASE]));
	let replicas = DEVICES.map((d) => createReplica(d, members));
	const wall = DEVICES.map(() => BASE);
	const queue = [];
	let step = 0;
	const steps = 40 + Math.floor(rand() * 40);
	for (; step < steps; step++) {
		for (let i = 0; i < wall.length; i++) wall[i] += Math.floor(rand() * 3);
		const roll = rand();
		const i = Math.floor(rand() * 3);
		if (roll < 0.45) {
			// A fast clock sometimes: its ops are held by the others until their clocks catch up.
			const skew = rand() < 0.08 ? SIX_MIN : 0;
			const edit = randomEdit(rand, replicas[i], DEVICES[i]);
			replicas[i] = localOp(replicas[i], registry, edit, wall[i] + skew).replica;
		} else if (roll < 0.85) {
			let j = Math.floor(rand() * 2);
			if (j >= i) j++;
			const belief = replicas[i].acks[DEVICES[j]] ?? {};
			const d = delta(replicas[i], belief);
			if (d.kind === "ops" && d.ops.length > 0) {
				let ops = shuffle(rand, d.ops).filter(() => rand() > 0.15);
				if (rand() < 0.3) ops = ops.concat(ops.slice(0, 2));
				queue.push({ to: j, from: i, ops, due: step + Math.floor(rand() * 6) });
			}
		} else if (roll < 0.92) {
			replicas[i] = compact(replicas[i], registry, wall[i]);
		}
		// Deliver what is due, in random order, sometimes twice.
		for (const message of shuffle(
			rand,
			queue.filter((m) => m.due <= step),
		)) {
			queue.splice(queue.indexOf(message), 1);
			if (rand() < 0.1) queue.push({ ...message, due: step + 1 + Math.floor(rand() * 4) });
			const { to, from } = message;
			if (message.ack) {
				replicas[to] = recordAck(replicas[to], DEVICES[from], message.ack, wall[to]);
				continue;
			}
			replicas[to] = receiveOps(replicas[to], registry, message.ops, wall[to]);
			queue.push({ to: from, from: to, ack: replicas[to].vv, due: step + Math.floor(rand() * 4) });
		}
	}
	// Quiet period: clocks pass the fast writer, then full anti-entropy until nothing moves.
	for (let i = 0; i < wall.length; i++) wall[i] += 10 * 60 * 1000;
	replicas = replicas.map((r, i) => releaseHeld(r, registry, wall[i]));
	for (let round = 0; round < 20; round++) {
		let moved = false;
		for (let i = 0; i < 3; i++)
			for (let j = 0; j < 3; j++) {
				if (i === j) continue;
				const d = delta(replicas[i], replicas[j].vv);
				assert.equal(d.kind, "ops", `seed ${seed}: a current peer was sent a snapshot`);
				if (d.ops.length === 0) continue;
				moved = true;
				replicas[j] = receiveOps(replicas[j], registry, d.ops, wall[j]);
				replicas[i] = recordAck(replicas[i], DEVICES[j], replicas[j].vv, wall[i]);
			}
		if (!moved) break;
	}
	return replicas;
}

function checkSeed(seed) {
	const replicas = runSeed(seed);
	for (const r of replicas) assert.deepEqual(Object.keys(r.held), [], `seed ${seed}: ops still held`);
	for (const r of replicas) assertNarrow(seed, r);
	const [a, b, c] = snapshotOf(replicas);
	assert.equal(b.state, a.state, `seed ${seed}: state of dv-b differs from dv-a`);
	assert.equal(c.state, a.state, `seed ${seed}: state of dv-c differs from dv-a`);
	assert.equal(b.view, a.view, `seed ${seed}: view of dv-b differs from dv-a`);
	assert.equal(c.view, a.view, `seed ${seed}: view of dv-c differs from dv-a`);
	for (const name of Object.keys(replicas[0].states)) {
		if (name === NARROW) continue;
		const type = MERGE_TYPES[registry.get(name).merge];
		const merged = type.merge(replicas[1].states[name], replicas[2].states[name]);
		assert.equal(
			canonicalize(merged),
			canonicalize(replicas[0].states[name]),
			`seed ${seed}: merge of ${name} differs`,
		);
	}
	// A newcomer joins from dv-a: by snapshot when dv-a compacted, otherwise by ops. Same shared state, no foreign allow.
	const d = delta(replicas[0], {});
	const newcomer =
		d.kind === "snapshot"
			? adoptSnapshot(createReplica("dv-n"), registry, d.snapshot, BASE + 3_600_000).replica
			: receiveOps(createReplica("dv-n"), registry, d.ops, BASE + 3_600_000);
	assertNarrow(seed, newcomer);
	const [n] = snapshotOf([newcomer]);
	assert.equal(n.state, a.state, `seed ${seed}: the newcomer's state differs from dv-a`);
	replicas.snapshotJoin =
		d.kind === "snapshot" && Object.values(d.snapshot.snapshot.kept).some((o) => o.category === NARROW);
	return replicas;
}

test("three replicas converge to byte-identical state under random delivery, for every merge type", () => {
	const only = process.env.SYNC_SEED;
	const seeds = only ? [Number(only)] : Array.from({ length: Number(process.env.SYNC_SEEDS ?? 500) }, (_, i) => i + 1);
	const types = new Set();
	let ops = 0;
	let narrowSnapshots = 0;
	for (const seed of seeds) {
		let replicas;
		try {
			replicas = checkSeed(seed);
		} catch (error) {
			console.error(`sync property test failed on seed ${seed} (rerun with SYNC_SEED=${seed})`);
			throw error;
		}
		for (const name of Object.keys(replicas[0].states)) types.add(registry.get(name).merge);
		ops += Object.keys(replicas[0].log).length;
		if (replicas.snapshotJoin) narrowSnapshots++;
	}
	if (!only) {
		assert.ok(seeds.length >= 500);
		assert.deepEqual([...types].sort(), ["awset", "log", "lww"], "every merge type was exercised");
		assert.ok(ops > seeds.length * 5, "the runs wrote ops");
		assert.ok(narrowSnapshots > 50, `snapshots carried narrow ops in ${narrowSnapshots} seeds`);
	}
});
