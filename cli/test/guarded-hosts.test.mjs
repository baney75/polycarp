// Issue #94, host side: which hostnames the native host tells the extension an agent may not open.
// Every config dir is a temp dir; nothing here touches ~/.config/tabkyra.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { rmSync, tempRoot } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = tempRoot("tabkyra-guarded-");
after(() => rmSync(root, { recursive: true, force: true }));
const { guardedHosts } = await loadTs(`export { guardedHosts } from "@src/guarded-hosts.ts";`);

function inConfig(name, files) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), typeof body === "string" ? body : JSON.stringify(body));
	const before = process.env.TABKYRA_CONFIG_DIR;
	process.env.TABKYRA_CONFIG_DIR = dir;
	try {
		return guardedHosts();
	} finally {
		if (before === undefined) delete process.env.TABKYRA_CONFIG_DIR;
		else process.env.TABKYRA_CONFIG_DIR = before;
	}
}

test("no remote, hub or link config guards nothing", () => {
	assert.deepEqual(inConfig("none", {}), []);
});

test("the public URL of remote.json and hub.json, and the hub a device linked to, are guarded", () => {
	assert.deepEqual(inConfig("remote", { "remote.json": { publicUrl: "https://Box.Example.ts.net:8443", port: 8787, route: "funnel" } }), ["box.example.ts.net"]);
	assert.deepEqual(inConfig("hub", { "hub.json": { publicUrl: "https://hub.example.com", port: 8788 } }), ["hub.example.com"]);
	assert.deepEqual(inConfig("link", { "link.json": { hubUrl: "https://hub.example.com", deviceId: "d1", secret: "s", name: "laptop" } }), ["hub.example.com"]);
	const all = inConfig("all", {
		"remote.json": { publicUrl: "https://a.example.com", port: 1, route: "custom" },
		"hub.json": { publicUrl: "https://b.example.com", port: 2 },
		"link.json": { hubUrl: "https://b.example.com", deviceId: "d1", secret: "s", name: "laptop" },
	});
	assert.deepEqual(all.sort(), ["a.example.com", "b.example.com"], "deduplicated");
});

test("a broken config file adds nothing and does not stop the others", () => {
	assert.deepEqual(inConfig("broken", { "remote.json": "{not json", "hub.json": { publicUrl: "https://hub.example.com", port: 8788 } }), ["hub.example.com"]);
});
