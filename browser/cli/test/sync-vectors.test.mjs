// Shared test vectors for the sync wire format (test/fixtures/sync-vectors.json), meant for a later Rust or Swift port:
// canonical JSON, refused values, clock order and updates, op encodings and merge results. The file round-trips: each
// case is checked against the engine, and the engine regenerates the file byte for byte.
// Regenerate after an intended format change with SYNC_VECTORS_WRITE=1 (then review the diff).
// Run with --experimental-strip-types: it imports src/sync/*.ts.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	canonicalize,
	canonicalOpBytes,
	compareStamp,
	decodeOp,
	encodeOp,
	hlcReceive,
	hlcSend,
	isTooFarAhead,
	MERGE_TYPES,
	opId,
	parseCanonical,
} from "../src/sync/index.ts";

const FILE = join(import.meta.dirname, "fixtures", "sync-vectors.json");
const T = 1_700_000_000_000;

const CANONICAL_INPUTS = [
	"null",
	"true",
	"0",
	"-0",
	"-42",
	"9007199254740991",
	'""',
	'"plain"',
	'"quote \\" backslash \\\\ slash /"',
	'"\\b\\f\\n\\r\\t \\u0000 \\u001f \\u007f"',
	'"\\u00e9 \\u2028 \\u2029 \\ud83d\\ude00"',
	'"\\ud800 lone"',
	"[]",
	"[3, 1, 2]",
	"{}",
	'{"b": 1, "a": 2, "c": {"z": [], "y": null}}',
	'{"\\uff61": 1, "\\ud83d\\ude00": 2, "\\u00e9": 3, "z": 4, "Z": 5, "": 6}',
	'{"a": [{"d": 1, "c": 2}], "A": true}',
];
const REFUSED_INPUTS = ["1.5", "-0.25", "1e400", "9007199254740992", "-9007199254740992", "[0.1]", '{"a": 1.25}'];

function stamp(wall, count, device) {
	return { wall, count, device };
}

const OPS = [
	{
		v: 1,
		category: "settings-spaces",
		schema: 1,
		author: "dv-0a1b2c3d4e5f",
		seq: 1,
		at: { wall: T, count: 0 },
		kind: "set",
		key: "layout",
		value: { columns: 3, mode: "grid" },
	},
	{
		v: 1,
		category: "settings-spaces",
		schema: 1,
		author: "dv-0a1b2c3d4e5f",
		seq: 2,
		at: { wall: T, count: 1 },
		kind: "del",
		key: "layout",
	},
	{
		v: 1,
		category: "dictionary",
		schema: 1,
		author: "dv-ffeeddccbbaa",
		seq: 7,
		at: { wall: T + 5, count: 0 },
		kind: "add",
		key: "polycarp",
		value: { to: "Polycarp" },
		obs: ["dv-0a1b2c3d4e5f:3", "dv-0a1b2c3d4e5f:12"].sort(),
	},
	{
		v: 1,
		category: "history",
		schema: 1,
		author: "dv-ffeeddccbbaa",
		seq: 8,
		at: { wall: T + 6, count: 2 },
		kind: "append",
		key: "silas",
		value: { text: "café 😀" },
		sig: "c2lnbmF0dXJlLXBsYWNlaG9sZGVy",
	},
];

// Merge scenarios: ops applied in the listed order and reversed must give the same state.
function op(category, author, seq, wall, count, kind, key, extra = {}) {
	return { v: 1, category, schema: 1, author, seq, at: { wall, count }, kind, key, ...extra };
}
const MERGES = [
	{
		name: "lww: equal clocks, the greater device id wins",
		merge: "lww",
		ops: [
			op("settings-spaces", "dv-a", 1, T, 0, "set", "k", { value: "from a" }),
			op("settings-spaces", "dv-b", 1, T, 0, "set", "k", { value: "from b" }),
		],
	},
	{
		name: "lww: a later delete beats an earlier set",
		merge: "lww",
		ops: [
			op("settings-spaces", "dv-b", 1, T, 0, "set", "k", { value: 1 }),
			op("settings-spaces", "dv-a", 1, T + 1, 0, "del", "k"),
		],
	},
	{
		name: "awset: a concurrent add survives a remove that did not see it",
		merge: "awset",
		ops: [
			op("dictionary", "dv-a", 1, T, 0, "add", "w", { value: 1, obs: [] }),
			op("dictionary", "dv-b", 1, T + 1, 0, "add", "w", { value: 2, obs: [] }),
			op("dictionary", "dv-a", 2, T + 2, 0, "remove", "w", { obs: ["dv-a:1"] }),
		],
	},
	{
		name: "awset: an add that supersedes its earlier tag",
		merge: "awset",
		ops: [
			op("dictionary", "dv-a", 1, T, 0, "add", "w", { value: 1, obs: [] }),
			op("dictionary", "dv-a", 2, T + 1, 0, "add", "w", { value: 2, obs: ["dv-a:1"] }),
		],
	},
	{
		name: "log: delete wins and clear hides earlier entries",
		merge: "log",
		ops: [
			op("history", "dv-a", 1, T, 0, "append", "s", { value: "one" }),
			op("history", "dv-b", 1, T + 1, 0, "append", "s", { value: "two" }),
			op("history", "dv-a", 2, T + 2, 0, "append", "s", { value: "three" }),
			op("history", "dv-b", 2, T + 3, 0, "delete", "s", { obs: ["dv-a:2"] }),
			op("history", "dv-a", 3, T + 1, 5, "clear", "s"),
			op("history", "dv-b", 3, T + 4, 0, "append", "s", { value: "four" }),
		],
	},
];

function applyAll(type, ops) {
	return ops.reduce((state, o) => type.apply(state, o), type.empty());
}

function buildVectors() {
	return {
		about: "Polycarp sync engine test vectors (browser/cli/src/sync). Canonical JSON: keys sorted by UTF-16 code unit, safe integers only, JSON.stringify string escapes, no whitespace. Stamps order by wall, count, then device id. Ops more than 300000 ms ahead of the local wall clock are held.",
		version: 1,
		canonical: CANONICAL_INPUTS.map((input) => ({ input, output: canonicalize(JSON.parse(input)) })),
		refused: REFUSED_INPUTS,
		hlc: {
			compare: [
				[stamp(T, 0, "dv-a"), stamp(T + 1, 0, "dv-a")],
				[stamp(T, 1, "dv-b"), stamp(T, 2, "dv-a")],
				[stamp(T, 0, "dv-a"), stamp(T, 0, "dv-b")],
				[stamp(T, 0, "dv-B"), stamp(T, 0, "dv-a")],
				[stamp(T, 0, "dv-a"), stamp(T, 0, "dv-a")],
			].map(([a, b]) => ({ a, b, order: compareStamp(a, b) })),
			send: [
				[{ wall: T, count: 4 }, T + 10],
				[{ wall: T, count: 4 }, T],
				[{ wall: T, count: 4 }, T - 50],
			].map(([local, wall]) => ({ local, wall, out: hlcSend(local, wall) })),
			receive: [
				[{ wall: T, count: 1 }, { wall: T, count: 3 }, T],
				[{ wall: T + 5, count: 1 }, { wall: T, count: 9 }, T],
				[{ wall: T, count: 1 }, { wall: T + 5, count: 9 }, T],
				[{ wall: T, count: 1 }, { wall: T, count: 9 }, T + 100],
			].map(([local, remote, wall]) => ({ local, remote, wall, out: hlcReceive(local, remote, wall) })),
			held: [
				[{ wall: T + 300_000, count: 0 }, T],
				[{ wall: T + 300_001, count: 0 }, T],
				[{ wall: T + 360_000, count: 0 }, T],
			].map(([remote, wall]) => ({ remote, wall, held: isTooFarAhead(remote, wall) })),
		},
		ops: OPS.map((o) => ({ op: o, id: opId(o), canonical: encodeOp(o), signed: canonicalOpBytes(o) })),
		merges: MERGES.map((m) => {
			const type = MERGE_TYPES[m.merge];
			const state = applyAll(type, m.ops);
			return {
				name: m.name,
				merge: m.merge,
				ops: m.ops,
				state: canonicalize(state),
				view: canonicalize(type.view(state)),
			};
		}),
	};
}

function fileText() {
	return `${JSON.stringify(buildVectors(), null, "\t")}\n`;
}

if (process.env.SYNC_VECTORS_WRITE === "1") writeFileSync(FILE, fileText());

const vectors = JSON.parse(readFileSync(FILE, "utf8"));

test("the vectors file is what the engine produces", () => {
	assert.equal(readFileSync(FILE, "utf8"), fileText());
});

test("canonical vectors round-trip and refused values are refused", () => {
	assert.ok(vectors.canonical.length >= 15);
	for (const { input, output } of vectors.canonical) {
		assert.equal(canonicalize(JSON.parse(input)), output, input);
		assert.equal(canonicalize(parseCanonical(output)), output, output);
	}
	assert.equal(vectors.canonical.find((c) => c.input === "-0").output, "0");
	for (const input of vectors.refused) assert.throws(() => canonicalize(JSON.parse(input)), /safe integer/, input);
	assert.throws(() => parseCanonical('{"b":1,"a":2}'), /canonical form/);
	assert.throws(() => parseCanonical('{"a": 1}'), /canonical form/);
	assert.throws(() => canonicalize({ a: undefined }));
	assert.throws(() => canonicalize(new Date(0)));
});

test("clock vectors hold", () => {
	for (const { a, b, order } of vectors.hlc.compare) {
		assert.equal(compareStamp(a, b), order);
		assert.equal(compareStamp(b, a), -order || 0);
	}
	for (const { local, wall, out } of vectors.hlc.send) assert.deepEqual(hlcSend(local, wall), out);
	for (const { local, remote, wall, out } of vectors.hlc.receive)
		assert.deepEqual(hlcReceive(local, remote, wall), out);
	for (const { remote, wall, held } of vectors.hlc.held) assert.equal(isTooFarAhead(remote, wall), held);
	assert.deepEqual(
		vectors.hlc.held.map((h) => h.held),
		[false, true, true],
	);
});

test("op vectors decode, re-encode and keep their ids", () => {
	for (const { op, id, canonical, signed } of vectors.ops) {
		const decoded = decodeOp(canonical);
		assert.equal(encodeOp(decoded), canonical);
		assert.equal(encodeOp(op), canonical);
		assert.equal(opId(decoded), id);
		assert.equal(canonicalOpBytes(decoded), signed);
		assert.ok(!signed.includes('"sig"'));
	}
	assert.throws(() => decodeOp('{"v":2}'), /malformed op/);
});

test("merge vectors give the same state in either order", () => {
	for (const { name, merge, ops, state, view } of vectors.merges) {
		const type = MERGE_TYPES[merge];
		const forward = applyAll(type, ops);
		const backward = applyAll(type, [...ops].reverse());
		assert.equal(canonicalize(forward), state, name);
		assert.equal(canonicalize(backward), state, `${name} (reversed)`);
		assert.equal(canonicalize(type.view(forward)), view, name);
		const half = Math.ceil(ops.length / 2);
		const merged = type.merge(applyAll(type, ops.slice(0, half)), applyAll(type, ops.slice(half)));
		assert.equal(canonicalize(merged), state, `${name} (merged halves)`);
	}
});
