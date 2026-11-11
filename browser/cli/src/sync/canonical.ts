// Canonical JSON for sync ops and state. One value has exactly one encoding, so two replicas that hold the same state
// produce the same bytes, and a later Rust or Swift port can check itself against test/fixtures/sync-vectors.json.
//
// Rules (shared with the vectors file):
// - Object keys are sorted by UTF-16 code unit, as JavaScript's default sort does (RFC 8785 order).
// - Numbers must be safe integers (-(2^53-1) to 2^53-1). A fraction, NaN, Infinity or a larger integer is refused, so
//   nothing that means an integer can travel as a float. -0 encodes as 0.
// - Strings use JSON.stringify's escapes: \" \\ \b \f \n \r \t, other control characters as lowercase \u00xx, a lone
//   surrogate as \udxxx, everything else (including U+2028 and U+2029) as itself.
// - No whitespace. Arrays keep their order. undefined, functions, bigint and non-plain objects are refused.
// Pure: no I/O, no clock, no platform calls.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class CanonicalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CanonicalError";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function encodeInto(value: unknown, out: string[], path: string): void {
	if (value === null) {
		out.push("null");
		return;
	}
	switch (typeof value) {
		case "boolean":
			out.push(value ? "true" : "false");
			return;
		case "number":
			if (!Number.isSafeInteger(value)) throw new CanonicalError(`${path}: ${value} is not a safe integer`);
			out.push(Object.is(value, -0) ? "0" : String(value));
			return;
		case "string":
			out.push(JSON.stringify(value));
			return;
		case "object":
			break;
		default:
			throw new CanonicalError(`${path}: ${typeof value} has no JSON form`);
	}
	if (Array.isArray(value)) {
		out.push("[");
		for (let i = 0; i < value.length; i++) {
			if (i > 0) out.push(",");
			encodeInto(value[i], out, `${path}[${i}]`);
		}
		out.push("]");
		return;
	}
	if (!isPlainObject(value)) throw new CanonicalError(`${path}: only plain objects encode`);
	const keys = Object.keys(value).sort();
	out.push("{");
	let first = true;
	for (const key of keys) {
		const item = value[key];
		if (item === undefined) throw new CanonicalError(`${path}.${key}: undefined has no JSON form`);
		if (!first) out.push(",");
		first = false;
		out.push(JSON.stringify(key), ":");
		encodeInto(item, out, `${path}.${key}`);
	}
	out.push("}");
}

/** The canonical encoding of a value. Throws CanonicalError for anything the rules above refuse. */
export function canonicalize(value: unknown): string {
	const out: string[] = [];
	encodeInto(value, out, "$");
	return out.join("");
}

/** Parse text that must already be canonical: a value whose canonical encoding differs from the text is refused. */
export function parseCanonical(text: string): Json {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new CanonicalError(`not JSON: ${(error as Error).message}`);
	}
	if (canonicalize(value) !== text) throw new CanonicalError("not in canonical form");
	return value as Json;
}

/** Whether a value is encodable (deep check, same rules as canonicalize). */
export function isCanonicalJson(value: unknown): value is Json {
	try {
		canonicalize(value);
		return true;
	} catch {
		return false;
	}
}
