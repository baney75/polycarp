/**
 * The flight recorder's buffer: the last minute of a live WebM, as a file that plays.
 *
 * MediaRecorder writes one stream. Only its first bytes (the EBML header, Info and Tracks) describe
 * it, and a cluster is decodable only when it starts at a key frame, so dropping the oldest chunks
 * of a stream leaves a file nothing can play. This reads the stream as it arrives, splits it into
 * clusters, and keeps the header once. Clusters older than the window are dropped only where the next
 * one starts at a key frame. A snapshot is the header plus the kept clusters, rewritten so the
 * first cluster is at time zero and every size is "unknown" (live-stream WebM, which players read).
 *
 * The window is a floor: the file starts at the last key frame at or before `windowMs` ago, so it
 * covers the window and up to one key frame interval more (Chrome's recorder makes one about every 10
 * seconds). Nothing is decoded; only element headers and each block's time and key frame mark are read.
 * Chrome writes every frame as a BlockGroup (a key frame is one with no ReferenceBlock); other writers use
 * SimpleBlocks (a flag bit). If the stream stops making sense the ring stops parsing and keeps what it had.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_REFERENCE_BLOCK = 0xfb;
/** Offsets into the old file: wrong once clusters are dropped, so they are not copied. */
const ID_POSITION = 0xa7;
const ID_PREV_SIZE = 0xab;
/** Direct children of the segment: one of these after a cluster's blocks ends an unsized cluster. */
const SEGMENT_CHILDREN = new Set([
	ID_CLUSTER,
	ID_INFO,
	ID_TRACKS,
	0x114d9b74, // SeekHead
	0x1c53bb6b, // Cues
	0x1254c367, // Tags
	0x1043a770, // Chapters
	0x1941a469, // Attachments
	0xec, // Void
]);

const UNKNOWN_SIZE = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

interface Header {
	id: number;
	/** Bytes the id and size take. */
	head: number;
	/** The payload size; null for "unknown". */
	size: number | null;
}

/** An element's id and size at `off`, `"need"` when more bytes must arrive, `"bad"` when it can't be one. */
function readHeader(buf: Uint8Array, off: number): Header | "need" | "bad" {
	if (off >= buf.length) return "need";
	const first = buf[off];
	const idLen = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : first & 0x10 ? 4 : 0;
	if (idLen === 0) return "bad";
	if (off + idLen >= buf.length) return "need";
	let id = 0;
	for (let i = 0; i < idLen; i++) id = id * 256 + buf[off + i];
	const sizeFirst = buf[off + idLen];
	let sizeLen = 1;
	while (sizeLen <= 8 && !(sizeFirst & (0x100 >> sizeLen))) sizeLen++;
	if (sizeLen > 8) return "bad";
	if (off + idLen + sizeLen > buf.length) return "need";
	let size = sizeFirst & (0xff >> sizeLen);
	let allOnes = size === 0xff >> sizeLen;
	for (let i = 1; i < sizeLen; i++) {
		const b = buf[off + idLen + i];
		size = size * 256 + b;
		if (b !== 0xff) allOnes = false;
	}
	return { id, head: idLen + sizeLen, size: allOnes ? null : size };
}

/** A Block's time relative to its cluster, and its flags byte. */
function readBlock(payload: Uint8Array): { rel: number; flags: number } | undefined {
	// Track number (a size-style integer), then 2 bytes of time (signed), then flags.
	let trackLen = 1;
	while (trackLen <= 8 && payload.length && !(payload[0] & (0x100 >> trackLen))) trackLen++;
	if (trackLen > 8 || payload.length < trackLen + 3) return undefined;
	const rel = (payload[trackLen] << 8) | payload[trackLen + 1];
	return { rel: rel & 0x8000 ? rel - 0x10000 : rel, flags: payload[trackLen + 2] };
}

/** When a frame is shown and whether it is a key frame, from a SimpleBlock or a BlockGroup. */
function blockInfo(id: number, payload: Uint8Array): { rel: number; keyframe: boolean } | undefined {
	if (id === ID_SIMPLE_BLOCK) {
		const b = readBlock(payload);
		return b && { rel: b.rel, keyframe: (b.flags & 0x80) !== 0 };
	}
	let block: { rel: number } | undefined;
	let delta = false;
	for (let off = 0; off < payload.length; ) {
		const h = readHeader(payload, off);
		if (typeof h === "string" || h.size === null || off + h.head + h.size > payload.length) break;
		if (h.id === ID_BLOCK) block = readBlock(payload.subarray(off + h.head, off + h.head + h.size));
		else if (h.id === ID_REFERENCE_BLOCK) delta = true;
		off += h.head + h.size;
	}
	return block && { rel: block.rel, keyframe: !delta };
}

function readUint(bytes: Uint8Array): number {
	let n = 0;
	for (const b of bytes) n = n * 256 + b;
	return n;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

function idBytes(id: number): Uint8Array {
	const bytes: number[] = [];
	for (let n = id; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
	return Uint8Array.from(bytes);
}

/** A Timecode element holding `ms`. */
function timecodeElement(ms: number): Uint8Array {
	const bytes: number[] = [];
	for (let n = Math.max(0, Math.round(ms)); n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
	if (bytes.length === 0) bytes.push(0);
	return concat([idBytes(ID_TIMECODE), Uint8Array.of(0x80 | bytes.length), Uint8Array.from(bytes)]);
}

interface Cluster {
	/** In ms, as the recorder wrote it. */
	timecode: number;
	/** When its last frame is shown, in the same time. */
	end: number;
	/** Its first block is a key frame: the file can start here. */
	keyframe: boolean;
	/** The cluster's elements except its Timecode, as written. */
	body: Uint8Array;
}

interface OpenCluster {
	timecode?: number;
	/** The latest a frame in it is shown, relative to timecode. */
	lastRel: number;
	keyframe?: boolean;
	parts: Uint8Array[];
	bytes: number;
	/** Bytes of the cluster not read yet, when its size was given. */
	remaining: number | null;
}

export interface WebmRingOptions {
	/** How much recent video to keep, in ms (default 60,000). */
	windowMs?: number;
	/** Most bytes of clusters to hold (default 32 MiB). Past it the oldest go, key frame or not. */
	maxBytes?: number;
}

export class WebmRing {
	readonly windowMs: number;
	readonly maxBytes: number;
	private pending: Uint8Array = new Uint8Array(0);
	private ebml?: Uint8Array;
	private info?: Uint8Array;
	private tracks?: Uint8Array;
	private clusters: Cluster[] = [];
	private open?: OpenCluster;
	private held = 0;
	private broken = false;

	constructor(options: WebmRingOptions = {}) {
		this.windowMs = options.windowMs ?? 60_000;
		this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
	}

	/** Bytes of video held now (finished clusters and the one being written). */
	get bytes(): number {
		return this.held + (this.open?.bytes ?? 0);
	}

	/** How much time the kept clusters cover, in ms. */
	get spanMs(): number {
		const oldest = this.clusters[0]?.timecode ?? this.open?.timecode;
		const newest = this.newest();
		return oldest === undefined || newest === undefined ? 0 : newest - oldest;
	}

	/** The stream stopped making sense; what came before is still kept. */
	get stopped(): boolean {
		return this.broken;
	}

	/** Feed the recorder's next bytes, in order. Any split of the stream works. */
	push(chunk: Uint8Array): void {
		if (this.broken || chunk.length === 0) return;
		this.pending = this.pending.length ? concat([this.pending, chunk]) : chunk;
		this.parse();
		this.trim();
	}

	/** A WebM of the kept video, or undefined while there is none yet. */
	snapshot(): Uint8Array | undefined {
		const all = [...this.clusters];
		if (this.open && this.open.timecode !== undefined && this.open.parts.length)
			all.push({
				timecode: this.open.timecode,
				end: this.open.timecode + this.open.lastRel,
				keyframe: this.open.keyframe === true,
				body: concat(this.open.parts),
			});
		if (!this.ebml || !this.info || !this.tracks || all.length === 0) return undefined;
		const base = all[0].timecode;
		const parts = [this.ebml, idBytes(ID_SEGMENT), UNKNOWN_SIZE, this.info, this.tracks];
		for (const c of all) parts.push(idBytes(ID_CLUSTER), UNKNOWN_SIZE, timecodeElement(c.timecode - base), c.body);
		return concat(parts);
	}

	/** When the latest frame held is shown. */
	private newest(): number | undefined {
		const last = this.clusters[this.clusters.length - 1]?.end;
		const open = this.open?.timecode === undefined ? undefined : this.open.timecode + this.open.lastRel;
		return last === undefined ? open : open === undefined ? last : Math.max(last, open);
	}

	private fail(): void {
		this.broken = true;
		this.pending = new Uint8Array(0);
	}

	private parse(): void {
		for (;;) {
			const more = this.open ? this.parseInCluster(this.open) : this.parseTop();
			if (!more || this.broken) return;
		}
	}

	/** One element outside a cluster. Returns false when it needs more bytes. */
	private parseTop(): boolean {
		const h = readHeader(this.pending, 0);
		if (h === "need") return false;
		if (h === "bad") {
			this.fail();
			return false;
		}
		if (h.id === ID_SEGMENT) {
			this.pending = this.pending.subarray(h.head);
			return true;
		}
		if (h.id === ID_CLUSTER) {
			this.open = { parts: [], bytes: 0, remaining: h.size, lastRel: 0 };
			this.pending = this.pending.subarray(h.head);
			return true;
		}
		if (h.size === null) {
			this.fail();
			return false;
		}
		const total = h.head + h.size;
		if (this.pending.length < total) return false;
		const element = this.pending.slice(0, total);
		this.pending = this.pending.subarray(total);
		if (h.id === ID_EBML) this.ebml ??= element;
		else if (h.id === ID_INFO) this.info ??= element;
		else if (h.id === ID_TRACKS) this.tracks ??= element;
		return true;
	}

	/** One child of the open cluster, or the end of it. Returns false when it needs more bytes. */
	private parseInCluster(c: OpenCluster): boolean {
		if (c.remaining === 0) {
			this.close(c);
			return true;
		}
		const h = readHeader(this.pending, 0);
		if (h === "need") return false;
		if (h === "bad") {
			this.fail();
			return false;
		}
		if (SEGMENT_CHILDREN.has(h.id)) {
			this.close(c);
			return true;
		}
		if (h.size === null) {
			this.fail();
			return false;
		}
		const total = h.head + h.size;
		if (this.pending.length < total) return false;
		const payload = this.pending.subarray(h.head, total);
		const element = this.pending.slice(0, total);
		this.pending = this.pending.subarray(total);
		if (c.remaining !== null) c.remaining = Math.max(0, c.remaining - total);
		if (h.id === ID_TIMECODE) c.timecode = readUint(payload);
		else if (h.id !== ID_POSITION && h.id !== ID_PREV_SIZE) {
			if (h.id === ID_SIMPLE_BLOCK || h.id === ID_BLOCK_GROUP) {
				const block = blockInfo(h.id, payload);
				if (block) {
					c.lastRel = Math.max(c.lastRel, block.rel);
					// The first frame decides whether the cluster can start a file.
					c.keyframe ??= block.keyframe;
				} else c.keyframe ??= false;
			}
			c.parts.push(element);
			c.bytes += element.length;
		}
		return true;
	}

	private close(c: OpenCluster): void {
		this.open = undefined;
		if (c.timecode === undefined || c.parts.length === 0) return;
		this.clusters.push({
			timecode: c.timecode,
			end: c.timecode + c.lastRel,
			keyframe: c.keyframe === true,
			body: concat(c.parts),
		});
		this.held += c.bytes;
	}

	/** Drop the oldest clusters the window and the byte limit no longer need. */
	private trim(): void {
		const newest = this.newest();
		if (newest === undefined) return;
		const drop = () => {
			this.held -= this.clusters[0].body.length;
			this.clusters.shift();
		};
		// The file starts at the last key frame that is at least a window old, so the window is whole.
		// Before the first key frame there is nothing to start from, so those clusters go too.
		let start = this.clusters[0]?.keyframe ? 0 : this.clusters.findIndex((c) => c.keyframe);
		for (let i = Math.max(1, start); i < this.clusters.length; i++)
			if (this.clusters[i].keyframe && newest - this.clusters[i].timecode >= this.windowMs) start = i;
		for (; start > 0; start--) drop();
		// Over the byte limit: shed from the front, down to the next key frame when there is one.
		while (this.bytes > this.maxBytes && this.clusters.length > 1) {
			drop();
			while (this.clusters.length > 1 && !this.clusters[0].keyframe && this.bytes > this.maxBytes) drop();
		}
	}
}
