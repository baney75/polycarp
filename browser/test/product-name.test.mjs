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
	// The tab group title an earlier version used; groups it left behind are still recognized and tidied.
	["src/browser/session.ts", "legacy tab group title"],
	["src/bridge/native.ts", "legacy tab group title"],
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
const CAPITAL = /\bTabkyra\b/;
// "tabkyra setup" in text a person reads: the command to type is `polycarp browser setup`.
const COMMAND = /(?<![/\w.@-])tabkyra (?=(?:setup|doctor|install|update|reload|status|allow|deny|skill|theme|serve|hub|link|remote|token|threads|sessions|tabs|library|debug|host|pi-extension|copilot-sdk|completion|version|help)\b)/;

test("no user-visible text says Tabkyra", () => {
	const found = [];
	for (const dir of TEXT_DIRS) {
		for (const file of walk(join(root, dir))) {
			const rel = relative(root, file);
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, i) => {
					if (!CAPITAL.test(line) && !COMMAND.test(line)) return;
					if (line.includes(MARKER) || ALLOW.has(rel)) {
						if (line.includes(MARKER) || /Tabkyra/.test(line)) return;
					}
					found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
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

test("the icons are the Polycarp mark from brand/export", () => {
	const same = (a, b) => assert.ok(readFileSync(join(root, a)).equals(readFileSync(join(root, "..", b))), `${a} is ${b}`);
	same("static/icon-16.png", "brand/export/macos/icon-16.png");
	same("static/icon-32.png", "brand/export/macos/icon-32.png");
	same("static/icon-48.png", "brand/export/linux/icon-48.png");
	same("static/icon-128.png", "brand/export/macos/icon-128.png");
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
