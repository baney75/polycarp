// Null-prototype records. Keys in sync state come from other devices, so a key such as "__proto__" or "constructor"
// must be an ordinary key, never a prototype lookup or a prototype change.

export type Rec<T> = { [key: string]: T };

export function rec<T>(): Rec<T> {
	return Object.create(null) as Rec<T>;
}

export function copyRec<T>(source: Rec<T>): Rec<T> {
	return Object.assign(rec<T>(), source);
}

export function has(record: Rec<unknown>, key: string): boolean {
	return Object.hasOwn(record, key);
}

export function get<T>(record: Rec<T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Rebuild any parsed JSON object tree with null-prototype records, so decoded state is as safe as built state. */
export function toRecords(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toRecords);
	if (value === null || typeof value !== "object") return value;
	const out = rec<unknown>();
	for (const key of Object.keys(value)) out[key] = toRecords((value as Rec<unknown>)[key]);
	return out;
}
