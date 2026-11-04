import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "index.js");
const root = mkdtempSync(join(tmpdir(), "tabkyra-hub-"));
const env = { HOME: join(root, "home"), PATH: dirname(process.execPath), NO_COLOR: "1", TABKYRA_SOCKET_DIR: join(root, "sock") };
mkdirSync(env.HOME, { recursive: true });
mkdirSync(env.TABKYRA_SOCKET_DIR, { mode: 0o700 });

function run(args, extra = {}) {
	const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: "utf8" });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Fake `tailscale` that logs argv and returns canned status JSON. */
function installTailscaleStub({ allowFunnel443 = false } = {}) {
	const bin = join(root, `bin-${allowFunnel443 ? "funnel" : "serve"}`);
	mkdirSync(bin, { recursive: true });
	const log = join(bin, "argv.log");
	const script = join(bin, "tailscale");
	const allow = allowFunnel443 ? '{"AllowFunnel":{"node.tailnet.ts.net:443":true}}' : "{}";
	writeFileSync(
		script,
		`#!/bin/sh
echo "$@" >> "${log}"
case "$1" in
  status)
    echo '{"Self":{"DNSName":"node.tailnet.ts.net."}}'
    ;;
  serve)
    if [ "$2" = "status" ]; then
      echo '${allow}'
    else
      # serve --bg ... should succeed for the Funnel-off path
      exit 0
    fi
    ;;
  funnel)
    echo "hub must not call funnel" >&2
    exit 99
    ;;
  *)
    echo "unexpected: $*" >&2
    exit 98
    ;;
esac
`,
	);
	chmodSync(script, 0o755);
	return { bin, log };
}

test("hub token scopes are browser.read and browser.navigate only", () => {
	const r = run(["hub", "token", "--name", "hub1"]);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /browser\.read, browser\.navigate/);
	assert.match(r.out, /tkr_/);
	const listed = run(["token", "list", "--json"]);
	assert.equal(listed.code, 0, listed.out);
	const tokens = JSON.parse(listed.out);
	const hub = (Array.isArray(tokens) ? tokens : tokens.tokens).find((t) => t.name === "hub1");
	assert.ok(hub);
	assert.deepEqual(hub.scopes.sort(), ["browser.navigate", "browser.read"]);
});

test("hub tunnel keeps Funnel off (calls serve, never funnel)", () => {
	const { bin, log } = installTailscaleStub({ allowFunnel443: false });
	const r = run(["hub", "tunnel", "--port", "8787"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, /tailnet/i);
	assert.doesNotMatch(r.out, /\bfunnel\b/i);
	const argv = readFileSync(log, "utf8");
	assert.match(argv, /^serve /m);
	assert.doesNotMatch(argv, /^funnel /m);
	assert.match(argv, /--set-path=\/tabkyra/);
	assert.match(argv, /http:\/\/127\.0\.0\.1:8787/);
});

test("hub tunnel refuses when Funnel is already on for :443", () => {
	const { bin, log } = installTailscaleStub({ allowFunnel443: true });
	const r = run(["hub", "tunnel"], { PATH: `${bin}:${dirname(process.execPath)}` });
	assert.equal(r.code, 1, r.out);
	assert.match(r.out, /Funnel is on for port 443/);
	const argv = readFileSync(log, "utf8");
	assert.doesNotMatch(argv, /^funnel /m);
	// Must not have started serve after seeing Funnel on
	assert.doesNotMatch(argv, /^serve --bg/m);
});

test("hub tunnel without Tailscale fails closed", () => {
	const bin = join(root, "bin-empty");
	mkdirSync(bin, { recursive: true });
	const r = run(["hub", "tunnel"], { PATH: bin });
	assert.equal(r.code, 1);
	assert.match(r.out, /Tailscale isn't installed/);
	assert.doesNotMatch(r.out, /\bfunnel\b/i);
});
