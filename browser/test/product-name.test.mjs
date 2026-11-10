// The product is called Polycarp. Fails when "Tabkyra" appears in text a person can see: the extension's source, its static
// pages, the helper's source, and the manifest. What stays on purpose (MCP tool names, the manifest key, stored data, the
// fallbacks that keep older installs working) is written in AGENTS.md ("Names that keep the old name") and is lowercase or
// an identifier, which this scan leaves alone. The renamed identifiers (native host, socket folder, hub headers, User-Agent,
// npm command) are guarded below so the old ones come back only as the named fallbacks.
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
	// The skill gate: its rules and tests match on these words (the install marker, the old skill name tabkyra), and the lint, its
	// router and the catalog are maintainer-reviewed. They change only in a change that is about them.
	["cli/src/skill-lint.ts", "skill lint matches the install marker"],
	["cli/src/skill-router.ts", "router reads tabkyra as the polycarp-browser skill's old name"],
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

// The identifiers renamed from tabkyra, and the code lines that may still hold the old one: each is a fallback for an install
// made before the rename (AGENTS.md says how long they stay). Comments are not counted. A new use fails here.
const RENAMED = /ai\.tabkyra\.bridge|tabkyra-bridge|x-tabkyra-hub|tabkyra-cli/;
const RENAMED_ALLOWED = new Map([
	["src/bridge/protocol.ts", 1], // LEGACY_NATIVE_HOST_NAME
	["src/bridge/native.ts", 1], // the keepalive alarm's name, which no one sees
	["cli/src/paths.ts", 2], // the old socket folder and pipe, searched after the new ones
	["cli/src/pi-extension.ts", 1], // the same, in the generated pi extension
	["cli/src/remote.ts", 2], // LEGACY_HUB_SCOPES_HEADER and LEGACY_HUB_CALLER_HEADER
]);

test("renamed identifiers come back only as the named fallbacks", () => {
	const counts = new Map();
	const found = [];
	for (const dir of TEXT_DIRS) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file);
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (!RENAMED.test(line) || COMMENT.test(line)) return;
					counts.set(rel, (counts.get(rel) ?? 0) + 1);
					found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
				});
		}
	}
	assert.deepEqual(Object.fromEntries(counts), Object.fromEntries(RENAMED_ALLOWED), `use com.polycarp.browser, polycarp-bridge, x-polycarp-hub or USER_AGENT:\n${found.join("\n")}`);
});

test("the helper's npm package installs polycarp-browser and the polycarp command the skills name, and no old alias", () => {
	const pkg = JSON.parse(readFileSync(join(root, "cli/package.json"), "utf8"));
	assert.deepEqual(Object.keys(pkg.bin).sort(), ["polycarp", "polycarp-browser"], "no tabkyra or sitegeist alias");
	const lock = JSON.parse(readFileSync(join(root, "cli/package-lock.json"), "utf8"));
	// npm writes the lockfile's names sorted, so the order is not part of the check.
	assert.deepEqual(Object.keys(lock.packages[""].bin ?? {}).sort(), ["polycarp", "polycarp-browser"], "the lockfile agrees");
});
