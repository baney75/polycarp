// Issue #94, host side: which hostnames the native host tells the extension an agent may not open.
// Every config dir is a temp dir; nothing here touches ~/.config/polycarp/browser.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { rmSync, tempRoot } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = tempRoot("tabkyra-guarded-");
after(() => rmSync(root, { recursive: true, force: true }));
const { guardedHosts } = await loadTs(`export { guardedHosts } from "@src/guarded-hosts.ts";`);

const loopbackOf = (...ports) => ports.flatMap((p) => ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${p}`));
const publicOnly = (hosts) => hosts.filter((h) => !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(h));

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
	assert.deepEqual(inConfig("none", {}), loopbackOf(8787), "only the default serve port on loopback");
});

test("the public URL of remote.json and hub.json, and the hub a device linked to, are guarded", () => {
	assert.deepEqual(publicOnly(inConfig("remote", { "remote.json": { publicUrl: "https://Box.Example.ts.net:8443", port: 8787, route: "funnel" } })), ["box.example.ts.net"]);
	assert.deepEqual(publicOnly(inConfig("hub", { "hub.json": { publicUrl: "https://hub.example.com", port: 8788 } })), ["hub.example.com"]);
	assert.deepEqual(publicOnly(inConfig("link", { "link.json": { hubUrl: "https://hub.example.com", deviceId: "d1", secret: "s", name: "laptop" } })), ["hub.example.com"]);
	const all = publicOnly(inConfig("all", {
		"remote.json": { publicUrl: "https://a.example.com", port: 1, route: "custom" },
		"hub.json": { publicUrl: "https://b.example.com", port: 2 },
		"link.json": { hubUrl: "https://b.example.com", deviceId: "d1", secret: "s", name: "laptop" },
	}));
	assert.deepEqual(all.sort(), ["a.example.com", "b.example.com"], "deduplicated");
});

test("a broken config file adds nothing and does not stop the others", () => {
	assert.deepEqual(publicOnly(inConfig("broken", { "remote.json": "{not json", "hub.json": { publicUrl: "https://hub.example.com", port: 8788 } })), ["hub.example.com"]);
});

test("loopback aliases of the serve and hub ports are guarded as host:port, and nothing else local", () => {
	const hosts = inConfig("ports", {
		"remote.json": { publicUrl: "https://a.example.com", port: 9001, route: "custom" },
		"hub.json": { publicUrl: "https://b.example.com", port: 9002 },
	});
	for (const entry of loopbackOf(8787, 9001, 9002)) assert.ok(hosts.includes(entry), `${entry} is guarded`);
	assert.equal(hosts.some((h) => h === "localhost" || h === "127.0.0.1"), false, "no bare loopback host: other ports stay open");
});
