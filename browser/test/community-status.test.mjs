// communityLibrary (src/community/status.ts): which community skills the "/" menu offers.
import assert from "node:assert/strict";
import test from "node:test";
import { communityLibrary } from "../src/community/status.ts";

const skill = (name) => ({
	name,
	description: `${name} description`,
	version: "1",
	provenance: "community, catalog 42",
	sites: ["example.com", "example.org"],
	text: `# ${name}\nSteps.`,
});
const status = (over = {}) => ({
	type: "community_status",
	enabled: true,
	skills: [skill("alpha"), skill("beta")],
	removed: [],
	notes: [],
	...over,
});

test("no status or a disabled one offers nothing", () => {
	assert.deepEqual(communityLibrary(undefined, new Set()), []);
	assert.deepEqual(communityLibrary(status({ enabled: false }), new Set()), []);
});

test("names already taken are skipped", () => {
	const out = communityLibrary(status(), new Set(["alpha"]));
	assert.deepEqual(
		out.map((s) => s.name),
		["beta"],
	);
});

test("the text starts with a header naming provenance and sites", () => {
	const [first] = communityLibrary(status(), new Set());
	assert.equal(first.description, "alpha description");
	assert.ok(
		first.text.startsWith(
			"[community, catalog 42; written by the Tabkyra community and reviewed by a maintainer; scoped to example.com, example.org: use it only on those sites]\n\n# alpha",
		),
	);
});

test("a local edit of a community skill keeps its scope but claims no review", () => {
	const local = skill("gamma");
	local.provenance = "local override of the community skill (catalog 42, version abc)";
	const [first] = communityLibrary(status({ skills: [local] }), new Set());
	assert.ok(first.text.startsWith("[local override of the community skill (catalog 42, version abc); scoped to example.com, example.org: use it only on those sites]"));
	assert.doesNotMatch(first.text, /reviewed by a maintainer/);
});
