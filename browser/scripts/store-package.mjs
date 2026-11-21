// What the Chrome Web Store zip may hold. `prepare` strips a build folder and `check` fails on anything
// left over. test/store-package.test.mjs runs the same functions.
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const NOTICE = `Polycarp browser extension. AGPL-3.0: see LICENSE.
Source: https://github.com/baney75/polycarp/tree/main/browser
Built on 0xSero's agent bridge (https://github.com/0xSero/sitegeist) and Mario Zechner's Sitegeist
(https://github.com/badlogic/sitegeist).
`;

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}

const isStripped = (rel) => rel.endsWith(".map") || /^debug\.(html|js)$/.test(rel);

export function prepare(folder, sourceRoot) {
	for (const path of [...walk(folder)]) if (isStripped(relative(folder, path))) rmSync(path);
	const manifestPath = join(folder, "manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	delete manifest.key;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	copyFileSync(join(sourceRoot, "LICENSE"), join(folder, "LICENSE"));
	writeFileSync(join(folder, "NOTICE"), NOTICE);
}

/** Every problem with a prepared folder; empty when the store may have it. */
export function problems(folder) {
	const found = [];
	for (const path of walk(folder)) {
		const rel = relative(folder, path);
		if (isStripped(rel)) found.push(`${rel} must not ship`);
		if (rel.endsWith(".pem")) found.push(`${rel} is a key file`);
		if (rel.endsWith(".html") && /debug\.js/.test(readFileSync(path, "utf8")))
			found.push(`${rel} loads the debug page`);
	}
	const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
	if ("key" in manifest) found.push("manifest has a key");
	if ("update_url" in manifest) found.push("manifest has an update_url");
	if (manifest.description.length > 132) found.push("description is over the store limit of 132 characters");
	for (const file of ["LICENSE", "NOTICE"]) if (!existsSync(join(folder, file))) found.push(`${file} is missing`);
	return found;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const [, , command, folder, sourceRoot] = process.argv;
	if (command === "prepare") prepare(folder, sourceRoot);
	else if (command === "check") {
		const found = problems(folder);
		for (const p of found) console.error(p);
		if (found.length) process.exit(1);
	} else {
		console.error("usage: store-package.mjs prepare <folder> <source root> | check <folder>");
		process.exit(2);
	}
}
