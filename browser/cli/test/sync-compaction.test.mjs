// Compaction: ops fold into the snapshot only once every current member has acked them, tombstones drop 90 days after
// they fold, and a member unseen for 90 days stops blocking, then rejoins by snapshot plus replay of its offline edits.
// Run with --experimental-strip-types: it imports src/sync/*.ts.
import assert from "node:assert/strict";
import test from "node:test";
import {
	adoptSnapshot,
	compact,
	createReplica,
	DAY_MS,
	defaultRegistry,
	delta,
	localOp,
	receiveOps,
	recordAck,
	stateBytes,
	view,
} from "../src/sync/index.ts";

const T = 1_700_000_000_000;
const registry = defaultRegistry();
const plainView = (replica) => JSON.parse(JSON.stringify(view(replica, registry)));
const members = { "dv-a": T, "dv-b": T, "dv-c": T };

/** Full exchange from one replica to another, with the ack back. */
function sync(from, to, now) {
	const d = delta(from, to.vv);
	assert.equal(d.kind, "ops");
	const next = receiveOps(to, registry, d.ops, now);
	return { from: recordAck(from, next.device, next.vv, now), to: next };
}

test("ops fold only after every current member acks them, without changing the live state", () => {
	let a = createReplica("dv-a", members);
	a = localOp(a, registry, { category: "dictionary", kind: "add", key: "polycarp", value: 1 }, T).replica;
	a = localOp(a, registry, { category: "settings-spaces", kind: "set", key: "layout", value: "grid" }, T + 1).replica;
	let b = createReplica("dv-b", members);
	let c = createReplica("dv-c", members);
	({ from: a, to: b } = sync(a, b, T + 2));
	const live = stateBytes(a);

	let folded = compact(a, registry, T + 3);
	assert.deepEqual(Object.keys(folded.log).sort(), ["dv-a:1", "dv-a:2"], "dv-c has not acked: nothing folds");
	assert.deepEqual({ ...folded.snapshot.vv }, {});

	a = recordAck(a, "dv-c", { "dv-a": 1 }, T + 4);
	folded = compact(a, registry, T + 5);
	assert.deepEqual(Object.keys(folded.log), ["dv-a:2"], "only what both acked folds");
	assert.deepEqual({ ...folded.snapshot.vv }, { "dv-a": 1 });
	assert.equal(stateBytes(folded), live, "folding does not change the live state");

	({ from: a, to: c } = sync(a, c, T + 6));
	folded = compact(a, registry, T + 7);
	assert.deepEqual(Object.keys(folded.log), []);
	assert.equal(stateBytes(folded), live);
	// A current peer still gets deltas, a newcomer the snapshot.
	assert.equal(delta(folded, c.vv).kind, "ops");
	assert.equal(delta(folded, {}).kind, "snapshot");
});

test("a folded tombstone drops 90 days after it folded, not before", () => {
	let a = createReplica("dv-a", { "dv-b": T });
	a = localOp(a, registry, { category: "dictionary", kind: "add", key: "teh", value: "the" }, T).replica;
	a = localOp(a, registry, { category: "dictionary", kind: "remove", key: "teh" }, T + 1).replica;
	assert.deepEqual(Object.keys(a.states.dictionary.tombs), ["dv-a:1"]);
	let now = T + 2;
	a = recordAck(a, "dv-b", a.vv, now);
	a = compact(a, registry, now);
	assert.deepEqual(Object.keys(a.snapshot.states.dictionary.tombs), ["dv-a:1"], "kept right after folding");
	now += 89 * DAY_MS;
	a = recordAck(a, "dv-b", a.vv, now);
	a = compact(a, registry, now);
	assert.deepEqual(Object.keys(a.snapshot.states.dictionary.tombs), ["dv-a:1"], "kept at 89 days");
	now += DAY_MS;
	a = recordAck(a, "dv-b", a.vv, now);
	a = compact(a, registry, now);
	assert.deepEqual(Object.keys(a.snapshot.states.dictionary.tombs), [], "dropped at 90 days");
	assert.deepEqual(Object.keys(a.states.dictionary.tombs), []);
	assert.deepEqual(plainView(a).dictionary, {});
});

test("a member unseen for 90 days stops blocking, then rejoins by snapshot and replays its offline edit", () => {
	let a = createReplica("dv-a", members);
	let b = createReplica("dv-b", members);
	let c = createReplica("dv-c", members);
	// Day 0: everyone in step.
	a = localOp(a, registry, { category: "settings-spaces", kind: "set", key: "layout", value: "grid" }, T).replica;
	({ from: a, to: b } = sync(a, b, T + 1));
	({ from: a, to: c } = sync(a, c, T + 1));
	// dv-c goes offline and changes the layout on day 1; nobody hears it.
	c = localOp(
		c,
		registry,
		{ category: "settings-spaces", kind: "set", key: "layout", value: "offline-edit" },
		T + DAY_MS,
	).replica;
	// Day 50: dv-a changes the same key later in time and adds a word; dv-b acks.
	const day50 = T + 50 * DAY_MS;
	a = localOp(
		a,
		registry,
		{ category: "settings-spaces", kind: "set", key: "layout", value: "a-later" },
		day50,
	).replica;
	a = localOp(a, registry, { category: "dictionary", kind: "add", key: "omarchy", value: 1 }, day50 + 1).replica;
	({ from: a, to: b } = sync(a, b, day50 + 2));

	// Day 60: dv-c still counts, so its missing ack blocks.
	assert.deepEqual(Object.keys(compact(a, registry, T + 60 * DAY_MS).log).sort(), ["dv-a:2", "dv-a:3"]);

	// Day 91: dv-c is absent and stops blocking.
	const day91 = T + 91 * DAY_MS;
	a = recordAck(a, "dv-b", b.vv, day91);
	a = compact(a, registry, day91);
	assert.deepEqual(Object.keys(a.log), [], "folded without dv-c");
	assert.deepEqual({ ...a.snapshot.vv }, { "dv-a": 3 });

	// dv-c returns: it is behind the snapshot, so it gets the snapshot, and replays its offline edit as a new op.
	const back = delta(a, c.vv);
	assert.equal(back.kind, "snapshot");
	const { replica, replayed } = adoptSnapshot(c, registry, back.snapshot, day91 + 10);
	c = replica;
	assert.equal(replayed.length, 1);
	assert.equal(replayed[0].value, "offline-edit");
	assert.equal(replayed[0].seq, 2, "the original keeps seq 1; the replay takes the next");
	assert.ok(replayed[0].at.wall >= day91 + 10, "the replay carries a fresh clock");
	a = recordAck(a, "dv-c", c.vv, day91 + 10);
	({ from: c, to: a } = sync(c, a, day91 + 11));
	({ from: c, to: b } = sync(c, b, day91 + 11));
	for (const r of [a, b, c]) {
		assert.equal(plainView(r)["settings-spaces"].layout, "offline-edit", `${r.device} keeps the offline edit`);
		assert.deepEqual(plainView(r).dictionary, { omarchy: 1 });
	}
	assert.equal(stateBytes(b), stateBytes(a));
	assert.equal(stateBytes(c), stateBytes(a));
});
