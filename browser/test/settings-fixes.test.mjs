// Settings defects found before the Chrome Web Store release: each case fails if its defect returns.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { agentSetupPrompt, deviceSetupPrompt } from "../src/agent-setup-prompt.ts";
import { normalizeHostInput } from "../src/bridge/permissions.ts";
import { userScriptsHiddenHelp } from "../src/browser/userscripts-status.ts";
import { communitySwitchOn } from "../src/community/status.ts";
import { listableSkill, validateImportedSkills } from "../src/dialogs/skill-list.ts";
import { getFaviconUrl } from "../src/utils/favicon.ts";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const skill = (over = {}) => ({
	name: "a",
	domainPatterns: ["example.com"],
	shortDescription: "s",
	description: "d",
	createdAt: "2026-01-01T00:00:00.000Z",
	lastUpdated: "2026-01-01T00:00:00.000Z",
	examples: "",
	library: "",
	...over,
});

test("Settings offers no CORS proxy control", () => {
	const panel = read("src/sidepanel.ts");
	assert.doesNotMatch(panel, /ProxyTab/);
	assert.match(panel, /storage\.settings\.get<boolean>\("proxy\.enabled"\)/);
});

test("a pattern with no domain has no favicon and doesn't throw", () => {
	for (const pattern of [undefined, "", "*", "/path"]) assert.equal(getFaviconUrl(pattern), "", String(pattern));
	assert.match(getFaviconUrl("github.com/*"), /domain=github\.com&/);
});

test("a skill saved without list fields still lists", () => {
	const out = listableSkill({ name: "old" });
	assert.deepEqual(out.domainPatterns, []);
	assert.equal(out.shortDescription, "");
});

test("an import without the required shape is refused and names the problem", () => {
	assert.match(validateImportedSkills({}).error, /expected an array/);
	assert.deepEqual(validateImportedSkills([skill()]).skills, [skill()]);
	assert.ok(validateImportedSkills([skill({ domainPatterns: [] })]).skills, "an export of an empty list comes back in");
	const { domainPatterns: _, ...noPatterns } = skill();
	assert.match(validateImportedSkills([noPatterns]).error, /"a" has no valid domainPatterns/);
	assert.match(validateImportedSkills([skill({ domainPatterns: [1] })]).error, /domainPatterns/);
	assert.match(validateImportedSkills([skill(), skill({ name: "" })]).error, /number 2 has no valid name/);
	assert.match(validateImportedSkills([null]).error, /number 1/);
	assert.match(validateImportedSkills([skill({ library: 5 })]).error, /"a" has no valid library/);
});

test("screens that give a helper command also say how to get the helper", () => {
	const hint = read("src/components/HelperInstallHint.ts");
	assert.match(hint, /Settings > Agents/);
	assert.match(hint, /get Polycarp for Mac/);
	const subscriptions = read("src/subscriptions/SubscriptionsSection.ts");
	assert.match(subscriptions, /this\.noHost \? html`[^`]*\$\{helperInstallHint\(\)\}/);
	const skills = read("src/dialogs/SkillsTab.ts");
	assert.match(skills, /doctor\. \$\{helperInstallHint\(\)\}/);
	assert.match(skills, /once you have Polycarp's helper \(see Settings > Agents\)/);
});

test("the hidden userScripts API never sends a store copy to reload", () => {
	const store = userScriptsHiddenHelp(true, "polycarp browser");
	assert.match(store, /restart the browser/);
	assert.doesNotMatch(store, /reload/);
	assert.match(userScriptsHiddenHelp(false, "polycarp browser"), /polycarp browser reload/);
	assert.match(read("src/dialogs/BridgeTab.ts"), /userScriptsHiddenHelp\(runningFromStore\(\), hostCommand\(\)\)/);
});

test("nothing points to a Settings > Connect tab, which doesn't exist", () => {
	const noTab = /Settings [>›] Connect(?!ors)/;
	for (const file of ["src/dialogs/ConnectTab.ts", "src/agent-setup-prompt.ts"]) assert.doesNotMatch(read(file), noTab, file);
	const device = deviceSetupPrompt("1.2.3", "https://hub.example.com", "TK-ABCD-EFGH");
	assert.match(device, /Settings > Agents > Add a device/);
	assert.doesNotMatch(agentSetupPrompt("1.2.3"), noTab);
});

test("the community switch is off until the helper reports it on", () => {
	assert.equal(communitySwitchOn(undefined), false);
	assert.equal(communitySwitchOn({ enabled: false }), false);
	assert.equal(communitySwitchOn({ enabled: true }), true);
});

test("Allowed sites stores a hostname, because permissions compare hostnames only", () => {
	const cases = {
		"my_app.example.com": "my_app.example.com",
		"example.com:8080": "example.com",
		"HTTPS://Docs.Example.com:8443/a?b=1": "docs.example.com",
		"http://example.com/": "example.com",
		"localhost:3000": "localhost",
		"example.com.": "example.com",
		"[::1]:9000": "[::1]",
		"me:pw@example.org/x": "example.org",
	};
	for (const [input, host] of Object.entries(cases)) assert.deepEqual(normalizeHostInput(input), { host }, input);
	for (const input of ["*.example.com", "not a host", "ftp://example.com", "http://", "chrome-extension://abc"])
		assert.match(normalizeHostInput(input).error ?? "", /isn't a site address/, input);
});

test("Always allow names what stays refused", () => {
	const bridge = read("src/dialogs/BridgeTab.ts");
	assert.doesNotMatch(bridge, /agents can open any site\n/);
	assert.match(bridge, /any site except Polycarp's own pages, its approval page and its local services/);
});

test("a costs load failure shows an error, not an empty range", () => {
	const costs = read("src/dialogs/CostsTab.ts");
	assert.match(costs, /console\.error\("Failed to load costs:", err\);\s+this\.loadFailed = true;/);
	assert.ok(costs.indexOf("this.loadFailed\n") < costs.indexOf("No costs in this range"));
	assert.match(costs, /Couldn't load your costs/);
});
