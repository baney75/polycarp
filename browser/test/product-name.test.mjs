// The product is called Polycarp. Fails when "Tabkyra" appears in text a person can see: the extension's source, its static
// pages, the helper's source, and the manifest. What stays on purpose (the `tabkyra` command alias, the MCP server and tool
// names, the native host name ai.tabkyra.bridge, the manifest key, ~/.config/tabkyra) is written in AGENTS.md ("Names that
// keep the old name") and is lowercase or an identifier, which this scan leaves alone.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Lines that may say Tabkyra, by file, with the reason. A line carrying the marker comment is allowed too. */
const ALLOW = new Map([
	// The setup prompt names the section heading and the clone folder that earlier setups made.
	["src/agent-setup-prompt.ts", "earlier section heading and clone folder"],
	// The skill gate: its rules and tests match on these words (the install marker, "the tabkyra skill"), and the lint, its
	// router and the catalog are maintainer-reviewed. They change only in a change that is about them.
	["cli/src/skill-lint.ts", "skill lint matches the install marker"],
	["cli/src/skill-router.ts", "router reads \"tabkyra skill\" as a skill name"],
	["cli/src/skills-catalog.ts", "generated from skills/, which keep their names"],
]);
const MARKER = "product-name allowlist";

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (name === "node_modules" || name === "dist" || name === "dist-chrome") continue;
		if (statSync(path).isDirectory()) yield* walk(path);
		else if (/\.(ts|js|mjs|html|json|css)$/.test(name)) yield path;
	}
}

const TEXT_DIRS = ["src", "static", "cli/src"];
// Capitalized in prose, also right after a "\n" escape in source, where there is no word boundary to see.
const CAPITAL = /\bTabkyra\b/;
// Lowercase in prose: "the tabkyra side panel", "the matching tabkyra command". The command, the MCP server name, the host
// name and the folders are lowercase too, but none of them is followed by one of these words.
const PROSE = /(?<![/\w.@-])tabkyra (?:side panel|panel|command|extension|helper|app|host|bridge|cli)\b/i;
// "tabkyra setup" in text a person reads: the command to type is `polycarp browser setup`.
const COMMAND = /(?<![/\w.@-])tabkyra (?=(?:setup|doctor|install|update|reload|status|allow|deny|skill|theme|serve|hub|link|remote|token|threads|sessions|tabs|library|debug|host|pi-extension|copilot-sdk|completion|version|help|tunnel|sessions|reload)\b)/;

// The old name inside a sentence a person reads: "Use tabkyra to open...", "through tabkyra mcp". Comment lines are not read by anyone.
const SENTENCE = /(?<![/\w.@-])tabkyra mcp\b|\bUse tabkyra\b/;
const COMMENT = /^\s*(?:\/\/|\/?\*)/;

test("no user-visible text says Tabkyra", () => {
	const found = [];
	for (const dir of TEXT_DIRS) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file);
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((raw, i) => {
					// "\nTabkyra" in source has no word boundary; read the escapes as the spaces they print as.
					const line = raw.replace(/\\[nrt]/g, " ");
					if (!CAPITAL.test(line) && !COMMAND.test(line) && !PROSE.test(line) && !(SENTENCE.test(line) && !COMMENT.test(raw))) return;
					if (raw.includes(MARKER) || ALLOW.has(rel)) return;
					found.push(`${rel}:${i + 1}: ${raw.trim().slice(0, 100)}`);
				});
		}
	}
	assert.deepEqual(found, [], `say Polycarp, or \`polycarp browser <command>\`:\n${found.slice(0, 20).join("\n")}`);
});

function manifests() {
	const list = [join(root, "static/manifest.chrome.json")];
	const built = join(root, "dist-chrome/manifest.json");
	if (existsSync(built)) list.push(built);
	return list;
}

test("the manifest and every locale file name the product Polycarp", () => {
	for (const file of manifests()) {
		const m = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(m.name, "Polycarp", file);
		assert.doesNotMatch(String(m.description), /tabkyra/i, file);
		assert.doesNotMatch(String(m.action?.default_title), /tabkyra/i, file);
		assert.equal(m.default_locale, undefined, "a locale would need scanning too");
	}
	for (const base of [join(root, "static/_locales"), join(root, "_locales")]) {
		if (!existsSync(base)) continue;
		for (const file of walk(base)) assert.doesNotMatch(readFileSync(file, "utf8"), /tabkyra/i, file);
	}
});

test("the extension id still comes from the unchanged manifest key", () => {
	const m = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
	assert.match(m.key, /^MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2kC2\+fqshozr\+m\/uopS9WXvavWghH5\/l2yJbwV0sZZUpq0OOMfnVkGZLJtN7y\/n0ifjKi4NENTCFou2e7CfX8D2j\+0GSYuYFC/);
	assert.match(m.key, /8wIDAQAB$/);
});

test("the extension's stored data keeps its names", () => {
	// A renamed storage key or database would hide a person's chats, keys and skills after the update, so the storage code
	// may say Polycarp only in comments.
	const storage = readFileSync(join(root, "src/storage/app-storage.ts"), "utf8");
	assert.match(storage, /class TabkyraAppStorage/);
	for (const file of walk(join(root, "src/storage"))) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (/Polycarp/.test(line)) assert.match(line.trim(), /^(\/\/|\/?\*)/, `${relative(root, file)}: ${line.trim()}`);
		}
	}
});
