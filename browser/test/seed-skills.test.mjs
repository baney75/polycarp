import assert from "node:assert/strict";
import test from "node:test";
import { SEEDED_KEY, seedDefaultSkills, seedStamp } from "../src/tools/seed-skills.ts";

function fakes(stored = {}, saved = {}) {
	const calls = { load: 0, getSkill: 0, saveSkill: [] };
	const deps = {
		stamp: "1.2.4 b2",
		storage: { get: async (key) => (key in stored ? { [key]: stored[key] } : {}), set: async (items) => Object.assign(stored, items) },
		skills: {
			getSkill: async (name) => {
				calls.getSkill++;
				return saved[name] ?? null;
			},
			saveSkill: async (skill) => {
				calls.saveSkill.push(skill.name);
				saved[skill.name] = skill;
			},
		},
		load: async () => {
			calls.load++;
			return {
				defaultSkills: [
					{ name: "old", lastUpdated: "2026-01-01" },
					{ name: "new-default", lastUpdated: "2026-11-13" },
				],
				shouldReplaceDefault: () => false,
			};
		},
	};
	return { deps, calls, stored, saved };
}

test("an open with the same build neither loads default-skills nor reads a skill", async () => {
	const { deps, calls } = fakes({ [SEEDED_KEY]: "1.2.4 b2" });
	assert.equal(await seedDefaultSkills(deps), false);
	assert.deepEqual(calls, { load: 0, getSkill: 0, saveSkill: [] });
});

test("a new version seeds a new default, keeps a saved one, and records the build last", async () => {
	const { deps, calls, stored } = fakes({ [SEEDED_KEY]: "1.2.3 b1" }, { old: { name: "old", lastUpdated: "2026-01-01" } });
	assert.equal(await seedDefaultSkills(deps), true);
	assert.equal(calls.load, 1);
	assert.deepEqual(calls.saveSkill, ["new-default"]);
	assert.equal(stored[SEEDED_KEY], "1.2.4 b2");
	assert.equal(await seedDefaultSkills(deps), false, "the next open is quiet");
	assert.equal(calls.load, 1);
});

test("a seed cut short runs again on the next open", async () => {
	const { deps, stored } = fakes();
	deps.skills.saveSkill = async () => {
		throw new Error("quota");
	};
	await assert.rejects(seedDefaultSkills(deps));
	assert.equal(stored[SEEDED_KEY], undefined);
});

test("the stamp is the manifest version when the code runs unbundled", () => {
	globalThis.chrome = { runtime: { getManifest: () => ({ version: "9.9.9" }) } };
	try {
		assert.equal(seedStamp(), "9.9.9");
	} finally {
		delete globalThis.chrome;
	}
});
