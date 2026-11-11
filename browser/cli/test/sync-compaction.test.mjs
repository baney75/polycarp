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
	suggestions,
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

test("a newcomer's snapshot ships no narrow-only state: a peer's allow becomes a suggestion, a revoke still lands", () => {
	let a = createReplica("dv-a", { "dv-b": T });
	a = localOp(
		a,
		registry,
		{ category: "site-permissions", kind: "set", key: "a-only.example", value: true },
		T,
	).replica;
	a = localOp(a, registry, { category: "site-permissions", kind: "del", key: "github.com" }, T + 5).replica;
	a = localOp(a, registry, { category: "dictionary", kind: "add", key: "polycarp", value: 1 }, T + 6).replica;
	a = recordAck(a, "dv-b", a.vv, T + 7);
	a = compact(a, registry, T + 8);
	assert.deepEqual(Object.keys(a.log), []);
	assert.deepEqual(plainView(a)["site-permissions"], { "a-only.example": true }, "the allow holds where it was made");
	const message = delta(a, {});
	assert.equal(message.kind, "snapshot");
	assert.equal(message.snapshot.snapshot.states["site-permissions"], undefined, "not folded into states");
	let n = createReplica("dv-n");
	n = localOp(
		n,
		registry,
		{ category: "site-permissions", kind: "set", key: "github.com", value: true },
		T + 1,
	).replica;
	n = adoptSnapshot(n, registry, message.snapshot, T + 10).replica;
	assert.deepEqual(plainView(n)["site-permissions"], {}, "the peer's allow is not adopted and the revoke lands");
	assert.deepEqual(suggestions(n), ["dv-a:1"]);
	assert.deepEqual(plainView(n).dictionary, { polycarp: 1 }, "other categories still arrive folded");

	// A snapshot that carries narrow-only state anyway (older code or forged) has that entry ignored.
	const forged = structuredClone(message.snapshot);
	forged.snapshot.states["site-permissions"] = {
		"evil.example": { at: { wall: T, count: 0, device: "dv-a" }, del: false, value: true },
	};
	const m = adoptSnapshot(createReplica("dv-m"), registry, forged, T + 10).replica;
	assert.deepEqual(plainView(m)["site-permissions"], {});
	assert.deepEqual(plainView(m).dictionary, { polycarp: 1 });
});

test("a 90-day rejoiner does not adopt a peer's allow from the snapshot", () => {
	let a = createReplica("dv-a", members);
	let c = createReplica("dv-c", members);
	c = localOp(c, registry, { category: "dictionary", kind: "add", key: "offline", value: 1 }, T + DAY_MS).replica;
	a = localOp(
		a,
		registry,
		{ category: "site-permissions", kind: "set", key: "a-only.example", value: true },
		T + 50 * DAY_MS,
	).replica;
	const day91 = T + 91 * DAY_MS;
	a = recordAck(a, "dv-b", a.vv, day91);
	a = compact(a, registry, day91);
	const back = delta(a, c.vv);
	assert.equal(back.kind, "snapshot");
	c = adoptSnapshot(c, registry, back.snapshot, day91 + 10).replica;
	assert.deepEqual(plainView(c)["site-permissions"] ?? {}, {});
	assert.deepEqual(suggestions(c), ["dv-a:1"]);
	assert.deepEqual(plainView(c).dictionary, { offline: 1 });
});

/** dv-c is absent past 90 days, makes `edits` offline, then rejoins by snapshot and syncs both ways. */
function rejoinAfter(edits) {
	let a = createReplica("dv-a", members);
	let b = createReplica("dv-b", members);
	let c = createReplica("dv-c", members);
	edits.forEach((edit, i) => {
		c = localOp(c, registry, edit, T + DAY_MS + i).replica;
	});
	a = localOp(a, registry, { category: "dictionary", kind: "add", key: "omarchy", value: 1 }, T + 2 * DAY_MS).replica;
	const day91 = T + 91 * DAY_MS;
	({ from: a, to: b } = sync(a, b, day91));
	a = compact(a, registry, day91);
	const back = delta(a, c.vv);
	assert.equal(back.kind, "snapshot");
	const adopted = adoptSnapshot(c, registry, back.snapshot, day91 + 10);
	c = adopted.replica;
	a = recordAck(a, "dv-c", c.vv, day91 + 10);
	({ from: c, to: a } = sync(c, a, day91 + 11));
	({ from: c, to: b } = sync(c, b, day91 + 11));
	return Object.assign([a, b, c], { replayed: adopted.replayed });
}

test("a word added and removed offline stays gone after a snapshot rejoin, and so does a deleted setting", () => {
	const replicas = rejoinAfter([
		{ category: "dictionary", kind: "add", key: "teh", value: "the" },
		{ category: "dictionary", kind: "remove", key: "teh" },
		{ category: "settings-spaces", kind: "set", key: "layout", value: "grid" },
		{ category: "settings-spaces", kind: "del", key: "layout" },
	]);
	for (const r of replicas) {
		assert.deepEqual(plainView(r).dictionary, { omarchy: 1 }, `${r.device}: the removed word stays gone`);
		assert.deepEqual(plainView(r)["settings-spaces"], {}, `${r.device}: the deleted setting stays gone`);
	}
	assert.equal(stateBytes(replicas[1]), stateBytes(replicas[0]));
	assert.equal(stateBytes(replicas[2]), stateBytes(replicas[0]));
});

test("a word added, removed and added again offline is present once after a snapshot rejoin", () => {
	const replicas = rejoinAfter([
		{ category: "dictionary", kind: "add", key: "teh", value: "the" },
		{ category: "dictionary", kind: "remove", key: "teh" },
		{ category: "dictionary", kind: "add", key: "teh", value: "the!" },
	]);
	assert.deepEqual(
		replicas.replayed.map((o) => o.value),
		["the!"],
		"only the add that still stands is replayed",
	);
	for (const r of replicas) {
		assert.deepEqual(plainView(r).dictionary, { omarchy: 1, teh: "the!" }, r.device);
		const tags = Object.values(r.states.dictionary.tags).filter((t) => t.key === "teh");
		assert.equal(tags.length, 1, `${r.device}: one live tag for the word`);
	}
	assert.equal(stateBytes(replicas[2]), stateBytes(replicas[0]));
});
