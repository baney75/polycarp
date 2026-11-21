/**
 * `[uint32 LE length][UTF-8 JSON]` framing, the same on stdio (native messaging)
 * and on the unix socket. One parser instance per stream.
 */

export interface FrameBatch {
	/** Every complete, well-formed message now available, in order. */
	messages: unknown[];
	/** The first bad frame in this chunk (over the size limit, or not JSON), if any. */
	error?: Error;
}

export class FrameParser {
	private buffer: Buffer = Buffer.alloc(0);
	/** Bytes of an oversized frame still to discard, so the stream stays in step. */
	private skip = 0;

	constructor(private readonly maxFrame: number) {}

	/**
	 * Feed bytes. Good frames are returned even when a bad one sits among them; a bad frame
	 * is consumed (an oversized body is skipped as it arrives), so later frames still parse.
	 */
	push(chunk: Buffer): FrameBatch {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const messages: unknown[] = [];
		let error: Error | undefined;
		for (;;) {
			if (this.skip > 0) {
				const n = Math.min(this.skip, this.buffer.length);
				this.buffer = this.buffer.subarray(n);
				this.skip -= n;
				if (this.skip > 0) break;
			}
			if (this.buffer.length < 4) break;
			const length = this.buffer.readUInt32LE(0);
			if (length > this.maxFrame) {
				error ??= new Error(`Frame of ${length} bytes exceeds limit ${this.maxFrame}`);
				this.buffer = this.buffer.subarray(4);
				this.skip = length;
				continue;
			}
			if (this.buffer.length < 4 + length) break;
			const body = this.buffer.subarray(4, 4 + length).toString("utf8");
			this.buffer = this.buffer.subarray(4 + length);
			try {
				messages.push(JSON.parse(body));
			} catch (err) {
				error ??= new Error(`Malformed frame: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return error ? { messages, error } : { messages };
	}
}

export function encodeFrame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32LE(body.length, 0);
	return Buffer.concat([header, body]);
}
