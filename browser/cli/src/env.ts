/**
 * Environment variables the helper reads. Each has a `POLYCARP_` name and the older `TABKYRA_` name; the new one wins
 * and the old one is still read, so a service file, a shell profile or a script written before the rename keeps working.
 * Read through here, never `process.env.TABKYRA_*` directly.
 */

/** The variable `name` (without prefix) from `source`: POLYCARP_<name> if set and non-empty, else TABKYRA_<name>. */
export function envVar(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
	return source[`POLYCARP_${name}`] || source[`TABKYRA_${name}`] || undefined;
}

/** True when either name is set to something non-empty. */
export function envSet(name: string, source: Record<string, string | undefined> = process.env): boolean {
	return envVar(name, source) !== undefined;
}
