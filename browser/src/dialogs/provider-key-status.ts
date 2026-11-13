/** The part of the provider key store this needs; a fake in tests. */
export interface KeyStore {
	list(): Promise<string[]>;
	get(provider: string): Promise<string | null>;
}

let last: Set<string> | undefined;

/**
 * The providers with a saved, non-empty key: one list, then every key read at once, so the panel waits for
 * one round of reads instead of one after another. The panel reads this at start and on every key change.
 */
export async function providersWithKeys(store: KeyStore): Promise<Set<string>> {
	const names = await store.list();
	const keys = await Promise.all(names.map((name) => store.get(name)));
	last = new Set(names.filter((_, i) => Boolean(keys[i])));
	return last;
}

/** The last answer, if any: Settings > Providers draws its rows in order from the first frame, then reads again. */
export function knownProvidersWithKeys(): ReadonlySet<string> | undefined {
	return last;
}
