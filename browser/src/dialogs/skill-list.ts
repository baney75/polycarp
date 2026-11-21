/**
 * Settings > Skills lists every skill Polycarp has, never a sample: the bundled library, the
 * community skills the user receives, and the site skills in this browser. Pure, for the tab and
 * its tests.
 */

import { firstSentence } from "../composer/menus.js";
import type { Skill } from "../storage/stores/skills-store.js";

const SKILL_TEXT_FIELDS = [
	"name",
	"shortDescription",
	"description",
	"createdAt",
	"lastUpdated",
	"examples",
	"library",
] as const;

/**
 * Checks a parsed skills file before anything is saved. An empty domainPatterns list passes: the
 * editor can save one, so an export must be able to come back in.
 */
export function validateImportedSkills(value: unknown): { skills: Skill[] } | { error: string } {
	if (!Array.isArray(value)) return { error: "Invalid skills file: expected an array of skills" };
	for (const [index, item] of value.entries()) {
		const skill = (item ?? {}) as Record<string, unknown>;
		const label = typeof skill.name === "string" && skill.name ? `"${skill.name}"` : `number ${index + 1}`;
		const bad = SKILL_TEXT_FIELDS.find((field) => typeof skill[field] !== "string");
		if (bad || !skill.name) return { error: `Invalid skills file: skill ${label} has no valid ${bad ?? "name"}.` };
		const patterns = skill.domainPatterns;
		if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string"))
			return { error: `Invalid skills file: skill ${label} has no valid domainPatterns list.` };
	}
	return { skills: value as Skill[] };
}

/** A skill saved before imports were checked can lack these fields; the list must still draw. */
export function listableSkill(skill: Skill): Skill {
	return {
		...skill,
		name: String(skill.name ?? ""),
		domainPatterns: Array.isArray(skill.domainPatterns)
			? skill.domainPatterns.filter((p) => typeof p === "string")
			: [],
		shortDescription: typeof skill.shortDescription === "string" ? skill.shortDescription : "",
	};
}

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
