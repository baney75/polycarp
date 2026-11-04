// A custom element name Tabkyra defines must not already belong to pi-web-ui or mini-lit:
// the `if (!customElements.get(...))` guard would skip our define, and `new` on the
// unregistered class throws "Illegal constructor" when the settings dialog opens.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

function names(dir) {
	const found = new Set();
	if (!existsSync(dir)) return found;
	const walk = (d) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) {
				if (n !== "node_modules") walk(p);
			} else if (/\.ts$/.test(n)) {
				const text = readFileSync(p, "utf8");
				for (const m of text.matchAll(/(?:@customElement\(|customElements\.define\()\s*"([a-z0-9-]+)"/g)) found.add(m[1]);
			}
		}
	};
	walk(dir);
	return found;
}

test("our custom element names are not taken upstream", (t) => {
	const upstreamDir = join(repo, "..", "pi-mono", "packages", "web-ui", "src");
	if (!existsSync(upstreamDir)) return t.skip("pi-mono is not checked out");
	const upstream = new Set([...names(upstreamDir), ...names(join(repo, "..", "mini-lit", "src"))]);
	const ours = names(join(repo, "src"));
	const clashes = [...ours].filter((n) => upstream.has(n));
	assert.deepEqual(clashes, [], `Rename these elements; pi-web-ui or mini-lit already defines them: ${clashes.join(", ")}`);
});
