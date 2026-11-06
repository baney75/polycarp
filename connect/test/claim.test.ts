import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CfError } from "../src/types.ts";
import { TOKEN_PREFIX, clearDb, dump, makeDevice, setup, signedRequest } from "./helpers.ts";

beforeEach(clearDb);

const claim = async (h: ReturnType<typeof setup>, device: Awaited<ReturnType<typeof makeDevice>>, body: unknown = { port: 8787 }) => h.fetch(await signedRequest(device, h.clock, "POST", "/v1/claim", { body }));
const j = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe("claim", () => {
	it("makes one tunnel, ingress and DNS record, and returns the token and a random single-label hostname", async () => {
		const h = setup();
		const d = await makeDevice();
		const r = await claim(h, d, { port: 9100 });
		expect(r.status).toBe(200);
		const body = await j(r);
		expect(body.status).toBe("ok");
		expect(body.hostname).toMatch(/^pc-[a-z2-7]{20}\.example\.test$/);
		expect(String(body.tunnelToken)).toBe(`${TOKEN_PREFIX}tun-1`);
		expect(h.cf.tunnels.size).toBe(1);
		expect(h.cf.tunnels.get("tun-1")?.ingress).toEqual({ hostname: body.hostname, port: 9100 });
		expect(h.cf.dns.has(String(body.hostname))).toBe(true);
	});

	it("stores only tunnel id, hostname, device key hash and times: never the token or the public key", async () => {
		const h = setup();
		const d = await makeDevice();
		await claim(h, d);
		const all = await dump();
		expect(all).not.toContain(TOKEN_PREFIX);
		expect(all).not.toContain(d.pub);
		expect(all).not.toContain(d.ip);
		const row = await env.DB.prepare("SELECT * FROM devices").first<Record<string, unknown>>();
		expect(Object.keys(row ?? {}).sort()).toEqual(["created_at", "device_hash", "hostname", "invite_id", "last_seen", "reserved_at", "status", "tunnel_id"]);
		expect(row?.status).toBe("active");
		expect(row?.tunnel_id).toBe("tun-1");
	});

	it("is idempotent: a device that claims twice gets the same hostname and no second tunnel", async () => {
		const h = setup();
		const d = await makeDevice();
		const a = await j(await claim(h, d));
		const b = await j(await claim(h, d));
		expect(b.hostname).toBe(a.hostname);
		expect(b.tunnelToken).toBe(a.tunnelToken);
		expect(b.existing).toBe(true);
		expect(h.cf.tunnels.size).toBe(1);
	});

	it("builds a new tunnel when the old one was deleted behind its back", async () => {
		const h = setup();
		const d = await makeDevice();
		const a = await j(await claim(h, d));
		h.cf.tunnels.clear();
		h.cf.dns.clear();
		const b = await j(await claim(h, d));
		expect(b.status).toBe("ok");
		expect(b.hostname).not.toBe(a.hostname);
		expect(h.cf.tunnels.size).toBe(1);
	});

	it("never logs the tunnel token or the API token", async () => {
		const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
		const h = setup();
		const d = await makeDevice();
		await claim(h, d);
		h.cf.failOn = "dns";
		await claim(h, await makeDevice());
		const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
		expect(logged).not.toContain(TOKEN_PREFIX);
		expect(logged).not.toContain("test-token-never-real");
		spies.forEach((s) => s.mockRestore());
	});

	it("rejects bad input: port, body, signature, replay and clock skew", async () => {
		const h = setup();
		const d = await makeDevice();
		expect((await claim(h, d, { port: 80 })).status).toBe(400);
		expect((await claim(h, d, { port: "8787" })).status).toBe(400);
		const badSig = await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/claim", { body: { port: 8787 }, badSig: true }));
		expect(badSig.status).toBe(401);
		const tampered = await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/claim", { body: { port: 8787 }, signedBody: JSON.stringify({ port: 9999 }) }));
		expect(tampered.status).toBe(401);
		const old = await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/claim", { body: { port: 8787 }, time: h.clock.t - 400 }));
		expect(old.status).toBe(401);
		const first = await signedRequest(d, h.clock, "POST", "/v1/claim", { body: { port: 8787 }, nonce: "same-nonce-0123456789" });
		const again = await signedRequest(d, h.clock, "POST", "/v1/claim", { body: { port: 8787 }, nonce: "same-nonce-0123456789" });
		expect((await h.fetch(first)).status).toBe(200);
		expect((await h.fetch(again)).status).toBe(401);
		const noKey = await h.fetch(new Request("https://connect.test/v1/claim", { method: "POST", body: "{}" }));
		expect(noKey.status).toBe(401);
		expect(h.cf.tunnels.size).toBe(1);
	});

	it("rolls back the tunnel and DNS when a step fails, and says unavailable", async () => {
		const h = setup();
		h.cf.failOn = "dns";
		const d = await makeDevice();
		const r = await claim(h, d);
		expect(r.status).toBe(503);
		expect((await j(r)).status).toBe("unavailable");
		expect(h.cf.tunnels.size).toBe(0);
		expect(h.cf.dns.size).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(0);
	});
});

describe("capacity bands", () => {
	it("is open below 900", async () => {
		const h = setup();
		h.cf.others = 898;
		expect((await claim(h, await makeDevice())).status).toBe(200);
		const cap = await j(await h.fetch(new Request("https://connect.test/v1/capacity")));
		expect(cap.status).toBe("open");
	});

	it("needs an invite code from 900 to 989, and an invite is single use", async () => {
		const h = setup();
		h.cf.others = 900;
		const a = await makeDevice();
		const none = await claim(h, a);
		expect(none.status).toBe(403);
		expect((await j(none)).status).toBe("invite_required");
		const wrong = await claim(h, a, { port: 8787, invite: "PC-WRONG-WRONG-WRONG-WRONG" });
		expect((await j(wrong)).status).toBe("invite_invalid");
		const code = await mintInvite(h, "standard");
		expect(code).toMatch(/^PC-[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
		const ok = await claim(h, a, { port: 8787, invite: code.toLowerCase() });
		expect(ok.status).toBe(200);
		const other = await makeDevice();
		const reused = await claim(h, other, { port: 8787, invite: code });
		expect((await j(reused)).status).toBe("invite_invalid");
		expect(h.cf.tunnels.size).toBe(1);
	});

	it("an invite isn't spent when the door is open, and a failed claim gives it back", async () => {
		const h = setup();
		const code = await mintInvite(h, "standard");
		expect((await claim(h, await makeDevice(), { port: 8787, invite: code })).status).toBe(200);
		const row = await env.DB.prepare("SELECT used_at FROM invites").first<{ used_at: number | null }>();
		expect(row?.used_at).toBeNull();
		h.cf.others = 905;
		h.clock.t += 120;
		h.cf.failOn = "ingress";
		expect((await claim(h, await makeDevice(), { port: 8787, invite: code })).status).toBe(503);
		expect((await env.DB.prepare("SELECT used_at FROM invites").first<{ used_at: number | null }>())?.used_at).toBeNull();
		h.cf.failOn = undefined;
		expect((await claim(h, await makeDevice(), { port: 8787, invite: code })).status).toBe(200);
	});

	it("is at capacity from 990 whatever the invite, with a waitlist offer", async () => {
		const h = setup();
		h.cf.others = 990;
		const code = await mintInvite(h, "standard");
		const r = await claim(h, await makeDevice(), { port: 8787, invite: code });
		expect(r.status).toBe(503);
		const body = await j(r);
		expect(body.status).toBe("at_capacity");
		expect(body.waitlist).toBe("/v1/waitlist");
		expect(String(body.message)).toContain("waitlist");
		expect(h.cf.tunnels.size).toBe(0);
	});

	it("lets a reserve invite use the last slots, but never past the hard limit", async () => {
		const h = setup();
		h.cf.others = 995;
		const reserve = await mintInvite(h, "reserve");
		expect((await claim(h, await makeDevice(), { port: 8787, invite: reserve })).status).toBe(200);
		h.cf.others = 1000;
		h.clock.t += 120;
		const again = await mintInvite(h, "reserve");
		expect((await j(await claim(h, await makeDevice(), { port: 8787, invite: again }))).status).toBe("at_capacity");
	});

	it("counts the live account, not just D1: tunnels that aren't ours fill the band", async () => {
		const h = setup();
		h.cf.others = 989;
		const code = await mintInvite(h, "standard");
		expect((await claim(h, await makeDevice(), { port: 8787, invite: code })).status).toBe(200);
		const cap = await j(await h.fetch(new Request("https://connect.test/v1/capacity")));
		expect(cap.status).toBe("at_capacity");
	});

	it("two simultaneous claims at the edge can't overshoot: one wins, one is at capacity", async () => {
		const h = setup();
		h.cf.others = 989;
		const code1 = await mintInvite(h, "standard");
		const code2 = await mintInvite(h, "standard");
		const [a, b] = [await makeDevice(), await makeDevice()];
		const [ra, rb] = await Promise.all([claim(h, a, { port: 8787, invite: code1 }), claim(h, b, { port: 8787, invite: code2 })]);
		const statuses = [(await j(ra)).status, (await j(rb)).status].sort();
		expect(statuses).toEqual(["at_capacity", "ok"]);
		expect(h.cf.tunnels.size).toBe(1);
		expect(h.cf.others + h.cf.tunnels.size).toBe(990);
		// The loser's invite is not spent.
		const unused = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL").first<{ n: number }>();
		expect(unused?.n).toBe(1);
	});

	it("a claim right after another, inside the 60 s cache, still sees the slot taken", async () => {
		const h = setup();
		h.cf.others = 989;
		const c1 = await mintInvite(h, "standard");
		const c2 = await mintInvite(h, "standard");
		expect((await claim(h, await makeDevice(), { port: 8787, invite: c1 })).status).toBe(200);
		const second = await claim(h, await makeDevice(), { port: 8787, invite: c2 });
		expect((await j(second)).status).toBe("at_capacity");
		expect(h.cf.calls.filter((c) => c === "count").length).toBe(1);
	});

	it("many parallel claims at the edge take exactly the slots left", async () => {
		const h = setup();
		h.cf.others = 987;
		const devices = await Promise.all(Array.from({ length: 6 }, () => makeDevice()));
		const codes = await Promise.all(devices.map(() => mintInvite(h, "standard")));
		const results = await Promise.all(devices.map((d, i) => claim(h, d, { port: 8787, invite: codes[i] })));
		const oks = (await Promise.all(results.map(async (r) => (await j(r)).status))).filter((s) => s === "ok").length;
		expect(oks).toBe(3);
		expect(h.cf.tunnels.size).toBe(3);
	});

	it("treats a Cloudflare limit error as at capacity, undoes the work, and closes the door for a minute", async () => {
		const h = setup();
		h.cf.failOn = "create";
		h.cf.failWith = new CfError("tunnel limit exceeded", 400, true);
		const r = await claim(h, await makeDevice());
		expect((await j(r)).status).toBe("at_capacity");
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(0);
		h.cf.failOn = undefined;
		const cap = await j(await h.fetch(new Request("https://connect.test/v1/capacity")));
		expect(cap.status).toBe("at_capacity");
		expect((await j(await claim(h, await makeDevice()))).status).toBe("at_capacity");
		h.clock.t += 61;
		expect((await claim(h, await makeDevice())).status).toBe(200);
	});

	it("fails closed when the live count can't be read", async () => {
		const h = setup();
		h.cf.countFails = true;
		const r = await claim(h, await makeDevice());
		expect(r.status).toBe(503);
		expect((await j(r)).status).toBe("unavailable");
		expect(h.cf.tunnels.size).toBe(0);
		expect((await h.fetch(new Request("https://connect.test/v1/capacity"))).status).toBe(503);
	});
});

describe("GET /v1/capacity", () => {
	it("gives a status and a coarse band, never an exact count, and caches the live count for 60 s", async () => {
		const h = setup();
		h.cf.others = 123;
		const get = async () => h.fetch(new Request("https://connect.test/v1/capacity"));
		const a = await j(await get());
		expect(a).toEqual({ status: "open", remaining: "plenty", paused: false });
		expect(JSON.stringify(a)).not.toContain("123");
		h.cf.others = 930;
		await get();
		expect(h.cf.calls.filter((c) => c === "count").length).toBe(1);
		h.clock.t += 61;
		const b = await j(await get());
		expect(b.status).toBe("invite_only");
		expect(b.remaining).toBe("some");
		expect(h.cf.calls.filter((c) => c === "count").length).toBe(2);
		h.cf.others = 985;
		h.clock.t += 61;
		expect((await j(await get())).remaining).toBe("few");
		h.cf.others = 990;
		h.clock.t += 61;
		expect(await j(await get())).toEqual({ status: "at_capacity", remaining: "none", paused: false });
	});

	it("honors the limits in the environment", async () => {
		const h = setup({ HARD_LIMIT: "100", RESERVE: "5", INVITE_ONLY_ABOVE: "50" } as never);
		h.cf.others = 60;
		expect((await j(await h.fetch(new Request("https://connect.test/v1/capacity")))).status).toBe("invite_only");
		h.clock.t += 61;
		h.cf.others = 95;
		expect((await j(await h.fetch(new Request("https://connect.test/v1/capacity")))).status).toBe("at_capacity");
	});
});

describe("kill switch and rate limits", () => {
	it("PAUSED makes claim answer paused, and turning off still works", async () => {
		const h = setup();
		const d = await makeDevice();
		await claim(h, d);
		const paused = setup({ PAUSED: "1" } as never);
		paused.cf.tunnels = h.cf.tunnels;
		paused.cf.dns = h.cf.dns;
		const r = await claim(paused, await makeDevice());
		expect(r.status).toBe(503);
		expect((await j(r)).status).toBe("paused");
		expect((await j(await paused.fetch(new Request("https://connect.test/v1/capacity")))).paused).toBe(true);
		const off = await paused.fetch(await signedRequest(d, paused.clock, "DELETE", "/v1/claim"));
		expect((await j(off)).status).toBe("ok");
		expect(paused.cf.tunnels.size).toBe(0);
	});

	it("limits claims per IP per day", async () => {
		const h = setup({ CLAIMS_PER_IP_PER_DAY: "2" } as never);
		const results: number[] = [];
		for (let i = 0; i < 3; i++) results.push((await h.fetch(await signedRequest(await makeDevice(), h.clock, "POST", "/v1/claim", { body: {}, ip: "198.51.100.7" }))).status);
		expect(results).toEqual([200, 200, 429]);
		h.clock.t += 86_400;
		expect((await h.fetch(await signedRequest(await makeDevice(), h.clock, "POST", "/v1/claim", { body: {}, ip: "198.51.100.7" }))).status).toBe(200);
	});

	it("limits claims per device per day", async () => {
		const h = setup();
		const d = await makeDevice();
		const codes: number[] = [];
		for (let i = 0; i < 11; i++) codes.push((await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/claim", { body: {}, ip: `192.0.2.${i + 1}` }))).status);
		expect(codes.slice(0, 10).every((c) => c === 200 || c === 429)).toBe(true);
		expect(codes[10]).toBe(429);
	});
});

async function mintInvite(h: ReturnType<typeof setup>, tier: "standard" | "reserve"): Promise<string> {
	const r = await h.fetch(new Request("https://connect.test/v1/admin/invites", { method: "POST", headers: { "x-admin-secret": "test-admin-secret-0123456789" }, body: JSON.stringify({ tier }) }));
	return ((await r.json()) as { codes: string[] }).codes[0] as string;
}
