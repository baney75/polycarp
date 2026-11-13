import type { Skill } from "../storage/stores/skills-store.js";
import { BUILD } from "../update/build.js";

/** chrome.storage.local: the build the bundled skills were last saved for. */
export const SEEDED_KEY = "tabkyra.defaultSkillsSeeded";

export interface SeedDeps {
	stamp: string;
	storage: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
	skills: { getSkill(name: string): Promise<Skill | null>; saveSkill(skill: Skill): Promise<void> };
	load?: () => Promise<{
		defaultSkills: Skill[];
		shouldReplaceDefault(stored: Pick<Skill, "name" | "lastUpdated">, shipped: Skill): boolean;
	}>;
}

/** The version, plus the build id, so a rebuild of a checkout at the same version seeds too. */
export function seedStamp(): string {
	const version = chrome.runtime.getManifest().version;
	return BUILD ? `${version} ${BUILD.id}` : version;
}

/**
 * Saves the bundled skills when the extension changed since they were last saved. An open of the same build
 * neither loads default-skills.js (74 KB) nor reads a skill, so a default the person deleted comes back with
 * the next update, not on every open. Returns whether it seeded.
 */
export async function seedDefaultSkills(deps: SeedDeps): Promise<boolean> {
	if ((await deps.storage.get(SEEDED_KEY))[SEEDED_KEY] === deps.stamp) return false;
	const { defaultSkills, shouldReplaceDefault } = await (deps.load ?? (() => import("./default-skills.js")))();
	for (const skill of defaultSkills) {
		const existing = await deps.skills.getSkill(skill.name);
		if (!existing || shouldReplaceDefault(existing, skill)) await deps.skills.saveSkill(skill);
	}
	// Last, so a seed cut short runs again on the next open.
	await deps.storage.set({ [SEEDED_KEY]: deps.stamp });
	return true;
}
