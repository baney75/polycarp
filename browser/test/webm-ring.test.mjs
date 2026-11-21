// The flight recorder's buffer keeps the last minute of a live WebM as a file that still plays:
// the header once, clusters from a key frame on, and nothing older than the window.
import assert from "node:assert/strict";
import test from "node:test";
import { WebmRing } from "../src/browser/webm-ring.ts";

const concat = (parts) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};
const idBytes = (id) => {
	const b = [];
	for (let n = id; n > 0; n = Math.floor(n / 256)) b.unshift(n % 256);
	return Uint8Array.from(b);
};
const sizeBytes = (n) => {
	for (let len = 1; len <= 8; len++) {
		if (n < 2 ** (7 * len) - 1) {
			const b = [];
			let v = n;
			for (let i = 0; i < len; i++) {
				b.unshift(v % 256);
				v = Math.floor(v / 256);
			}
			b[0] |= 0x80 >> (len - 1);
			return Uint8Array.from(b);
		}
	}
	throw new Error("too big");
};
const UNKNOWN = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
const el = (id, payload, unknown = false) => concat([idBytes(id), unknown ? UNKNOWN : sizeBytes(payload.length), payload]);
const uint = (n) => {
	const b = [];
	for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256);
	return Uint8Array.from(b.length ? b : [0]);
};

const EBML = el(0x1a45dfa3, Uint8Array.of(0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d));
const INFO = el(0x1549a966, el(0x2ad7b1, uint(1_000_000)));
const TRACKS = el(0x1654ae6b, el(0xae, concat([el(0xd7, uint(1)), el(0x83, uint(1))])));
const SEGMENT_OPEN = concat([idBytes(0x18538067), UNKNOWN]);
const HEADER = concat([EBML, SEGMENT_OPEN, INFO, TRACKS]);

/**
 * A frame of one track (id 1) with a relative time and a payload of `size` bytes. Chrome's recorder writes
 * every frame as a BlockGroup (a delta frame carries a ReferenceBlock); other writers use SimpleBlocks.
 */
const block = (key, rel, size = 40, group = false) => {
	const head = Uint8Array.of(0x81, (rel >> 8) & 255, rel & 255);
	const data = new Uint8Array(size).fill(7);
	if (!group) return el(0xa3, concat([head, Uint8Array.of(key ? 0x80 : 0), data]));
	return el(0xa0, concat([el(0xa1, concat([head, Uint8Array.of(0), data])), ...(key ? [] : [el(0xfb, Uint8Array.of(0xfe))]), el(0x9b, uint(250))]));
};
/** A cluster at `ms` with a key frame first and 3 delta frames; unsized or sized. */
const cluster = (ms, { key = true, unsized = true, group = false } = {}) => {
	const body = concat([
		el(0xe7, uint(ms)),
		el(0xa7, uint(123)), // Position: not kept
		block(key, 0, 40, group),
		block(false, 250, 40, group),
		block(false, 500, 40, group),
		block(false, 750, 40, group),
	]);
	return unsized ? concat([idBytes(0x1f43b675), UNKNOWN, body]) : el(0x1f43b675, body);
};

/** Read a WebM the way a player would: the clusters' timecodes and whether each starts at a key frame. */
function inspect(bytes) {
	let at = 0;
	const out = { ebml: 0, segments: 0, infos: 0, tracks: 0, clusters: [], positions: 0 };
	const header = () => {
		const first = bytes[at];
		const idLen = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : 4;
		let id = 0;
		for (let i = 0; i < idLen; i++) id = id * 256 + bytes[at + i];
		const sf = bytes[at + idLen];
		let sl = 1;
		while (!(sf & (0x100 >> sl))) sl++;
		let size = sf & (0xff >> sl);
		let ones = size === 0xff >> sl;
		for (let i = 1; i < sl; i++) {
			size = size * 256 + bytes[at + idLen + i];
			if (bytes[at + idLen + i] !== 0xff) ones = false;
		}
		return { id, head: idLen + sl, size: ones ? null : size };
	};
	let cluster;
	while (at < bytes.length) {
		const h = header();
		if (h.id === 0x1a45dfa3 || h.id === 0x1549a966 || h.id === 0x1654ae6b) {
			out[h.id === 0x1a45dfa3 ? "ebml" : h.id === 0x1549a966 ? "infos" : "tracks"]++;
			at += h.head + h.size;
		} else if (h.id === 0x18538067) {
			out.segments++;
			assert.equal(h.size, null, "the segment is unsized");
			at += h.head;
		} else if (h.id === 0x1f43b675) {
			assert.equal(h.size, null, "a cluster is unsized");
			cluster = { timecode: undefined, key: undefined, blocks: 0 };
			out.clusters.push(cluster);
			at += h.head;
		} else {
			assert.ok(cluster, "elements outside a cluster are the header's");
			const payload = bytes.subarray(at + h.head, at + h.head + h.size);
			if (h.id === 0xe7) cluster.timecode = payload.reduce((n, b) => n * 256 + b, 0);
			else if (h.id === 0xa3) {
				cluster.blocks++;
				if (cluster.key === undefined) cluster.key = (payload[3] & 0x80) !== 0;
			} else if (h.id === 0xa0) {
				cluster.blocks++;
				// A key frame is a group with no ReferenceBlock.
				if (cluster.key === undefined) cluster.key = !payload.includes(0xfb);
			} else if (h.id === 0xa7) out.positions++;
			at += h.head + h.size;
		}
	}
	return out;
}

/** Feed `stream` in pieces of random sizes (seeded), so element boundaries land anywhere. */
function feed(ring, stream, seed = 1) {
	let s = seed;
	const next = () => {
		s = (s * 1103515245 + 12345) & 0x7fffffff;
		return s;
	};
	for (let at = 0; at < stream.length; ) {
		const n = 1 + (next() % 997);
		ring.push(stream.subarray(at, at + n));
		at += n;
	}
}

for (const group of [false, true]) {
	const style = group ? "BlockGroups, as Chrome writes them" : "SimpleBlocks";
	const make = (ms, options = {}) => cluster(ms, { group, ...options });

	test(`${style}: a stream under the window is kept whole, header once, and plays from zero`, () => {
		const ring = new WebmRing({ windowMs: 60_000 });
		const stream = concat([HEADER, ...[0, 1000, 2000, 3000, 4000].map((ms) => make(ms))]);
		feed(ring, stream);
		const file = inspect(ring.snapshot());
		assert.deepEqual([file.ebml, file.segments, file.infos, file.tracks], [1, 1, 1, 1]);
		assert.deepEqual(
			file.clusters.map((c) => c.timecode),
			[0, 1000, 2000, 3000, 4000],
		);
		assert.ok(file.clusters.every((c) => c.key === true && c.blocks === 4));
		assert.equal(file.positions, 0, "old file offsets are not copied");
		assert.equal(ring.spanMs, 4750, "the span runs to the last frame, not the last cluster's start");
	});

	test(`${style}: only the last 60 seconds are kept: older clusters are dropped, from a key frame on`, () => {
		const ring = new WebmRing({ windowMs: 60_000 });
		const times = Array.from({ length: 200 }, (_, i) => 5000 + i * 1000); // 200 s, starting at an odd time
		feed(ring, concat([HEADER, ...times.map((ms) => make(ms))]), 7);
		const file = inspect(ring.snapshot());
		assert.ok(ring.spanMs >= 60_000 && ring.spanMs < 62_000, `span ${ring.spanMs}`);
		// Rebased to zero, so a player sees a file that starts at 0 and lasts about a minute.
		assert.equal(file.clusters[0].timecode, 0);
		const length = file.clusters.at(-1).timecode;
		assert.ok(length >= 59_000 && length < 62_000, `length ${length}`);
		assert.ok(file.clusters.length < 65, `${file.clusters.length} clusters kept of 200`);
		assert.ok(file.clusters[0].key, "the file starts at a key frame");
		assert.ok(ring.bytes < concat([HEADER, ...times.slice(0, 70).map((ms) => make(ms))]).length, "memory holds about a minute");
	});

	test(`${style}: a window ends only at a key frame: the file never starts on a delta cluster`, () => {
		const ring = new WebmRing({ windowMs: 10_000 });
		// A key frame every 4 s; the clusters between are deltas.
		const clusters = Array.from({ length: 40 }, (_, i) => make(i * 1000, { key: i % 4 === 0 }));
		feed(ring, concat([HEADER, ...clusters]), 3);
		const file = inspect(ring.snapshot());
		assert.ok(file.clusters[0].key);
		assert.ok(ring.spanMs >= 10_000 && ring.spanMs <= 14_800, `span ${ring.spanMs}`);
	});

	test(`${style}: clusters with a size are read the same, and the cluster being written is in the snapshot`, () => {
		const ring = new WebmRing({ windowMs: 3000 });
		const sized = [0, 1000, 2000, 3000, 4000, 5000].map((ms) => make(ms, { unsized: false }));
		const open = make(6000); // unsized and still open: no next cluster follows it
		feed(ring, concat([HEADER, ...sized, open]), 11);
		const file = inspect(ring.snapshot());
		assert.deepEqual(
			file.clusters.map((c) => c.timecode),
			[0, 1000, 2000, 3000],
		);
		assert.equal(file.clusters.at(-1).blocks, 4, "the open cluster's finished blocks are kept");
	});

	test(`${style}: the byte limit sheds the oldest video even inside the window`, () => {
		const ring = new WebmRing({ windowMs: 600_000, maxBytes: 4000 });
		feed(ring, concat([HEADER, ...Array.from({ length: 100 }, (_, i) => make(i * 1000))]), 5);
		assert.ok(ring.bytes <= 4000 + 400, `${ring.bytes} bytes held`);
		const file = inspect(ring.snapshot());
		assert.equal(file.clusters.at(-1).timecode - file.clusters[0].timecode + 750, ring.spanMs);
		assert.ok(file.clusters[0].key);
	});
}

test("nothing to save before a header and a cluster have arrived", () => {
	const ring = new WebmRing();
	assert.equal(ring.snapshot(), undefined);
	ring.push(HEADER.subarray(0, 20));
	assert.equal(ring.snapshot(), undefined);
	feed(ring, HEADER.subarray(20));
	assert.equal(ring.snapshot(), undefined, "a header alone is not a recording");
	feed(ring, cluster(0), 2);
	ring.push(Uint8Array.of(0x1f, 0x43, 0xb6, 0x75, 0x01)); // the start of the next cluster
	assert.ok(ring.snapshot());
});

test("garbage stops the ring and keeps what was good", () => {
	const ring = new WebmRing();
	feed(ring, concat([HEADER, cluster(0), cluster(1000)]));
	ring.push(Uint8Array.of(0x00, 0x00, 0x00, 0x00));
	assert.equal(ring.stopped, true);
	ring.push(cluster(2000));
	assert.ok(inspect(ring.snapshot()).clusters.length >= 1, "the good part is still there");
});

test("the byte limit never leaves a delta frame at the front of the file", () => {
	const big = (ms, key) => cluster(ms, { key });
	const held = concat([HEADER, big(0, true), ...[1000, 2000, 3000, 4000].map((ms) => big(ms, false)), big(5000, true), big(6000, false)]);
	const limit = new WebmRing({ windowMs: 600_000, maxBytes: Math.floor(held.length * 0.8) });
	feed(limit, concat([held, cluster(7000, { key: false })]), 3);
	assert.ok(inspect(limit.snapshot()).clusters[0].key, "the file starts at a key frame");
});
