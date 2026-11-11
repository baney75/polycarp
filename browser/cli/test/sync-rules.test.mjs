// Safety rules of the sync engine: narrow-only categories refuse widening ops from other devices, never-synced kinds
// cannot be registered, fast clocks are held, ops this build cannot read are kept and relayed, and src/sync stays pure.
// Run with --experimental-strip-types: it imports src/sync/*.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	compact,
	createRegistry,
	createReplica,
	DEFAULT_CATEGORIES,
	defaultRegistry,
	delta,
	localOp,
	MAX_AHEAD_MS,
	NeverSyncedError,
	receiveOps,
	recordAck,
	releaseHeld,
	stateBytes,
	suggestions,
	view,
} from "../src/sync/index.ts";

const T = 1_700_000_000_000;
const registry = defaultRegistry();
const plainView = (replica, reg = registry) => JSON.parse(JSON.stringify(view(replica, reg)));

function op(fields) {
	return { v: 1, schema: 1, at: { wall: T, count: 0 }, ...fields };
}

test("a forged widening op in a narrow-only category changes nothing; a revoke still lands", () => {
	let b = createReplica("dv-b", { "dv-a": T, "dv-c": T });
	b = localOp(b, registry, { category: "site-permissions", kind: "set", key: "github.com", value: true }, T).replica;
	b = localOp(b, registry, { category: "settings-sidepanel", kind: "set", key: "fontSize", value: 14 }, T).replica;
	const before = stateBytes(b);
	const forged = [
		op({ category: "site-permissions", author: "dv-a", seq: 1, kind: "set", key: "evil.example", value: true }),
		op({ category: "site-permissions", author: "dv-a", seq: 2, kind: "set", key: "github.com", value: "all" }),
		op({ category: "site-permissions", author: "dv-a", seq: 3, kind: "grant", key: "bank.example", value: true }),
		op({ category: "settings-sidepanel", author: "dv-a", seq: 4, kind: "set", key: "providerApiKey", value: "x" }),
		op({ category: "settings-sidepanel", author: "dv-a", seq: 5, kind: "set", key: "full_access", value: true }),
		op({ category: "tokens", author: "dv-a", seq: 6, kind: "set", key: "hub", value: "x" }),
	];
	const after = receiveOps(b, registry, forged, T + 1);
	assert.equal(stateBytes(after), before, "state is byte-identical after the forged ops");
	assert.deepEqual(plainView(after, registry)["site-permissions"], { "github.com": true });
	assert.deepEqual(
		{ ...after.skipped },
		{
			"dv-a:1": "widening",
			"dv-a:2": "widening",
			"dv-a:3": "malformed",
			"dv-a:4": "never-synced-key",
			"dv-a:5": "never-synced-key",
			"dv-a:6": "unknown-category",
		},
	);
	assert.deepEqual(suggestions(after), ["dv-a:1", "dv-a:2"], "widening ops become suggestions for a local click");
	// Kept and relayed, so the next device sees the same suggestion; still nothing applied.
	const relayed = delta(after, { "dv-b": after.seq }).ops.map((o) => `${o.author}:${o.seq}`);
	assert.deepEqual(relayed, ["dv-a:1", "dv-a:2", "dv-a:3", "dv-a:4", "dv-a:5", "dv-a:6"]);

	// A revoke from another device narrows.
	const revoke = op({
		category: "site-permissions",
		author: "dv-a",
		seq: 7,
		at: { wall: T + 5, count: 0 },
		kind: "del",
		key: "github.com",
	});
	let narrowed = receiveOps(after, registry, [revoke], T + 6);
	assert.deepEqual(plainView(narrowed, registry)["site-permissions"], {});
	// A later local allow beats the older revoke.
	narrowed = localOp(
		narrowed,
		registry,
		{ category: "site-permissions", kind: "set", key: "github.com", value: true },
		T + 10,
	).replica;
	assert.deepEqual(plainView(narrowed, registry)["site-permissions"], { "github.com": true });
});

test("never-synced kinds cannot be registered", () => {
	const names = [
		"secrets",
		"tokens",
		"sign-ins",
		"signin",
		"login",
		"oauth",
		"full-access",
		"fullaccess",
		"lends",
		"scopes",
		"computer-scopes",
		"provider-api-keys",
		"cookies",
		"permission-mode",
		"subscriptions",
		"sandbox",
		"hooks",
	];
	for (const name of names)
		assert.throws(
			() => createRegistry([{ name, merge: "lww", schema: 1, defaultOn: false, direction: "both" }]),
			NeverSyncedError,
			name,
		);
	// The shipped categories register, threads and history are off by default, site permissions narrow only.
	const shipped = createRegistry(DEFAULT_CATEGORIES);
	assert.equal(shipped.get("threads").defaultOn, false);
	assert.equal(shipped.get("history").defaultOn, false);
	assert.equal(shipped.get("dictionary").defaultOn, true);
	assert.equal(shipped.get("site-permissions").direction, "narrow");
	assert.throws(() => shipped.list().push({}), TypeError, "the registry is frozen");
	assert.throws(
		() => createRegistry([{ name: "hosts", merge: "awset", schema: 1, defaultOn: true, direction: "narrow" }]),
		/narrow-only category must be lww/,
	);
	assert.throws(() =>
		localOp(createReplica("dv-a"), shipped, { category: "tokens", kind: "set", key: "k", value: 1 }, T),
	);
});

test("an op from 6 minutes in the future is held, then applied once the clock catches up", () => {
	const early = op({
		category: "dictionary",
		author: "dv-a",
		seq: 1,
		at: { wall: T + 6 * 60 * 1000, count: 0 },
		kind: "add",
		key: "polycarp",
		value: 1,
		obs: [],
	});
	let b = createReplica("dv-b", { "dv-a": T });
	const before = stateBytes(b);
	b = receiveOps(b, registry, [early], T);
	assert.equal(stateBytes(b), before, "held, not applied");
	assert.deepEqual(Object.keys(b.held), ["dv-a:1"]);
	assert.deepEqual({ ...b.vv }, {}, "not acked");
	assert.deepEqual({ ...b.clock }, { wall: 0, count: 0 }, "a held op does not move the clock");
	assert.deepEqual(delta(b, {}).ops, [], "not relayed while held");
	b = receiveOps(b, registry, [early], T + 30_000);
	assert.deepEqual(Object.keys(b.held), ["dv-a:1"], "still more than 5 minutes ahead");
	b = releaseHeld(b, registry, T + 60_000);
	assert.deepEqual(Object.keys(b.held), []);
	assert.deepEqual(plainView(b, registry).dictionary, { polycarp: 1 });
	assert.deepEqual({ ...b.vv }, { "dv-a": 1 });
	// Exactly 5 minutes ahead is not held.
	const edge = op({
		category: "dictionary",
		author: "dv-c",
		seq: 1,
		at: { wall: T + MAX_AHEAD_MS, count: 0 },
		kind: "add",
		key: "silas",
		value: 2,
		obs: [],
	});
	const c = receiveOps(createReplica("dv-d"), registry, [edge], T);
	assert.deepEqual(Object.keys(c.held), []);
	assert.deepEqual(plainView(c, registry).dictionary, { silas: 2 });
});

test("an unknown-category op and a newer-schema op are kept and relayed, not applied", () => {
	const newer = createRegistry([
		...DEFAULT_CATEGORIES.filter((c) => c.name !== "dictionary"),
		{ name: "dictionary", merge: "awset", schema: 2, defaultOn: true, direction: "both" },
		{ name: "bookmarks", merge: "lww", schema: 1, defaultOn: true, direction: "both" },
	]);
	const members = { "dv-a": T, "dv-b": T, "dv-c": T };
	let b = createReplica("dv-b", members);
	b = localOp(b, newer, { category: "bookmarks", kind: "set", key: "home", value: "https://example.org" }, T).replica;
	b = localOp(b, newer, { category: "dictionary", kind: "add", key: "polycarp", value: { v2: true } }, T + 1).replica;
	b = localOp(b, newer, { category: "dictionary", kind: "add", key: "silas", value: 1, schema: 1 }, T + 2).replica;
	const sent = delta(b, {}).ops;

	let a = createReplica("dv-a", members);
	a = receiveOps(a, registry, sent, T + 3);
	assert.deepEqual(plainView(a, registry), { dictionary: { silas: 1 } }, "only the schema-1 op applied");
	assert.deepEqual({ ...a.skipped }, { "dv-b:1": "unknown-category", "dv-b:2": "newer-schema" });
	assert.deepEqual({ ...a.vv }, { "dv-b": 3 }, "stored and acked");

	// Relayed to a newer device, which applies them.
	let c = createReplica("dv-c", members);
	c = receiveOps(c, newer, delta(a, {}).ops, T + 4);
	assert.deepEqual(plainView(c, newer), {
		bookmarks: { home: "https://example.org" },
		dictionary: { polycarp: { v2: true }, silas: 1 },
	});

	// Compaction keeps them; a newcomer gets them in the snapshot; an upgrade applies them.
	a = recordAck(a, "dv-b", a.vv, T + 5);
	a = recordAck(a, "dv-c", a.vv, T + 5);
	a = compact(a, registry, T + 6);
	assert.deepEqual(Object.keys(a.log), []);
	assert.deepEqual(Object.keys(a.snapshot.kept).sort(), ["dv-b:1", "dv-b:2"]);
	const forNewcomer = delta(a, {});
	assert.equal(forNewcomer.kind, "snapshot");
	assert.deepEqual(Object.keys(forNewcomer.snapshot.snapshot.kept).sort(), ["dv-b:1", "dv-b:2"]);
	const upgraded = compact(a, newer, T + 7);
	assert.deepEqual(plainView(upgraded, newer), plainView(c, newer), "after an upgrade the kept ops apply");
	assert.deepEqual(Object.keys(upgraded.snapshot.kept), []);
});

test("src/sync is pure: no I/O, network, crypto, clock reads or randomness", () => {
	const dir = join(import.meta.dirname, "..", "src", "sync");
	const forbidden = [
		/from\s+"node:/,
		/from\s+"(?!\.\/)[^"]+"/,
		/\brequire\s*\(/,
		/\bimport\s*\(/,
		/\bDate\b/,
		/\bperformance\b/,
		/Math\.random/,
		/\bprocess\./,
		/\bfetch\s*\(/,
		/\bcrypto\b/,
		/\bset(Timeout|Interval|Immediate)\b/,
		/\bglobalThis\b/,
	];
	const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
	assert.ok(files.length >= 8);
	for (const file of files) {
		// Code only: comments may name what the module does not do.
		const text = readFileSync(join(dir, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
		for (const rule of forbidden) assert.doesNotMatch(text, rule, `${file} matches ${rule}`);
	}
});
