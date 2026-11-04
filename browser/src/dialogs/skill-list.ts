/**
 * Settings > Skills lists every skill Tabkyra has, never a sample: the bundled library, the
 * community skills the user receives, and the site skills in this browser. Pure, for the tab and
 * its tests.
 */

import { firstSentence } from "../composer/menus.js";

export interface LibraryRow {
	name: string;
	/** First sentence of the skill's description: the row's two lines. */
	summary: string;
	/** The whole description: the row's hover text. */
	description: string;
	source: "bundled" | "community";
	/** A site skill has the same name: on its sites, the / menu runs the site skill. */
	sharesNameWithSiteSkill?: boolean;
}

interface Described {
	name: string;
	description: string;
}

/** One query for both lists: trimmed, lowercase, without the "/" a user types to run a skill. */
export function normalizeSkillQuery(query: string): string {
	return query.trim().toLowerCase().replace(/^\//, "");
}

const matches = (q: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));

/** Bundled skills, then community skills whose names the library doesn't use, filtered by the query. */
export function libraryRows(
	bundled: readonly Described[],
	community: readonly Described[],
	query: string,
	siteSkillNames: ReadonlySet<string> = new Set(),
): LibraryRow[] {
	const q = normalizeSkillQuery(query);
	const taken = new Set(bundled.map((s) => s.name));
	return [
		...bundled.map((s) => ({ ...s, source: "bundled" as const })),
		// A community skill a bundled one already names isn't run, so it isn't listed; one that
		// shares a site skill's name is listed and flagged, like a bundled one.
		...community.filter((s) => !taken.has(s.name)).map((s) => ({ ...s, source: "community" as const })),
	]
		.filter((s) => matches(q, s.name, s.description))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((s) => ({
			name: s.name,
			summary: firstSentence(s.description),
			description: s.description,
			source: s.source,
			...(siteSkillNames.has(s.name) ? { sharesNameWithSiteSkill: true } : {}),
		}));
}
