import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CfError } from "../src/types.ts";
import { clearDb, dump, makeDevice, setup, signedRequest } from "./helpers.ts";

beforeEach(clearDb);
const j = async (r: Response) => (await r.json()) as Record<string, any>;
const claim = async (h: ReturnType<typeof setup>, d: Awaited<ReturnType<typeof makeDevice>>) => h.fetch(await signedRequest(d, h.clock, "POST", "/v1/claim", { body: {} }));
const admin = (h: ReturnType<typeof setup>, method: string, path: string, body?: unknown, secret = "test-admin-secret-0123456789") =>
	h.fetch(new Request(`https://connect.test${path}`, { method, headers: { "x-admin-secret": secret, "cf-connecting-ip": "198.51.100.200" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

describe("DELETE /v1/claim and POST /v1/seen", () => {
	it("deletes the tunnel and DNS record, frees the slot, and is idempotent", async () => {
		const h = setup();
		h.cf.others = 989;
		const d = await makeDevice();
		const code = ((await j(await admin(h, "POST", "/v1/admin/invites", { tier: "standard" }))).codes as string[])[0];
		const c = await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/claim", { body: { invite: code } }));
		expect(c.status).toBe(200);
		expect(h.cf.tunnels.size).toBe(1);
		expect((await j(await h.fetch(new Request("https://connect.test/v1/capacity")))).status).toBe("at_capacity");
		const del = await h.fetch(await signedRequest(d, h.clock, "DELETE", "/v1/claim"));
		expect(await j(del)).toEqual({ status: "ok", released: true });
		expect(h.cf.tunnels.size).toBe(0);
		expect(h.cf.dns.size).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(0);
		h.clock.t += 61;
		expect((await j(await h.fetch(new Request("https://connect.test/v1/capacity")))).status).toBe("invite_only");
		expect(await j(await h.fetch(await signedRequest(d, h.clock, "DELETE", "/v1/claim")))).toEqual({ status: "ok", released: false });
	});

	it("needs a signature, and keeps the row if Cloudflare can't delete yet", async () => {
		const h = setup();
		const d = await makeDevice();
		await claim(h, d);
		expect((await h.fetch(new Request("https://connect.test/v1/claim", { method: "DELETE" }))).status).toBe(401);
		const other = await makeDevice();
		expect(await j(await h.fetch(await signedRequest(other, h.clock, "DELETE", "/v1/claim")))).toEqual({ status: "ok", released: false });
		expect(h.cf.tunnels.size).toBe(1);
		h.cf.failOn = "deleteTunnel";
		const r = await h.fetch(await signedRequest(d, h.clock, "DELETE", "/v1/claim"));
		expect(r.status).toBe(503);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(1);
	});

	it("heartbeat updates last-seen and tells an unknown device to turn on again", async () => {
		const h = setup();
		const d = await makeDevice();
		await claim(h, d);
		h.clock.t += 5000;
		expect(await j(await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/seen")))).toEqual({ status: "ok" });
		expect((await env.DB.prepare("SELECT last_seen FROM devices").first<{ last_seen: number }>())?.last_seen).toBe(h.clock.t);
		const stranger = await makeDevice();
		const r = await h.fetch(await signedRequest(stranger, h.clock, "POST", "/v1/seen"));
		expect(r.status).toBe(404);
		expect((await h.fetch(await signedRequest(d, h.clock, "POST", "/v1/seen", { badSig: true }))).status).toBe(401);
	});
});

describe("daily cron", () => {
	const DAY = 86_400;
	it("frees devices unseen for 60 days and keeps the rest", async () => {
		const h = setup();
		const [stale, fresh, edge] = [await makeDevice(), await makeDevice(), await makeDevice()];
		await claim(h, stale);
		await claim(h, fresh);
		await claim(h, edge);
		const hashes = (await env.DB.prepare("SELECT device_hash FROM devices ORDER BY created_at, rowid").all<{ device_hash: string }>()).results.map((r) => r.device_hash);
		const start = h.clock.t;
		await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_hash = ?").bind(start - 61 * DAY, hashes[0]).run();
		await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_hash = ?").bind(start - 59 * DAY, hashes[1]).run();
		await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_hash = ?").bind(start - 60 * DAY + 10, hashes[2]).run();
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect(h.cf.tunnels.size).toBe(2);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(2);
		expect(h.cf.dns.size).toBe(2);
		// Next day the edge device has crossed 60 days.
		h.clock.t += DAY;
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect(h.cf.tunnels.size).toBe(1);
	});

	it("cleans a setup that stalled halfway, and prunes old nonces and counters", async () => {
		const h = setup();
		const d = await makeDevice();
		await claim(h, d);
		await env.DB.prepare("UPDATE devices SET status = 'pending', reserved_at = ?").bind(h.clock.t - 700).run();
		h.clock.t += 5 * DAY;
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect(h.cf.tunnels.size).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM nonces").first<{ n: number }>())?.n).toBe(0);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM rate").first<{ n: number }>())?.n).toBe(0);
	});

	it("caps Cloudflare work per run and carries the rest to the next", async () => {
		const h = setup({ CRON_BATCH: "2" } as never);
		for (let i = 0; i < 5; i++) await claim(h, await makeDevice());
		h.clock.t += 61 * DAY;
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect(h.cf.tunnels.size).toBe(3);
		await h.worker.scheduled({} as ScheduledController, h.env);
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect(h.cf.tunnels.size).toBe(0);
	});

	it("keeps a row whose Cloudflare delete failed, to retry", async () => {
		const h = setup();
		await claim(h, await makeDevice());
		h.clock.t += 61 * DAY;
		h.cf.failOn = "deleteTunnel";
		h.cf.failWith = new CfError("boom", 500);
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())?.n).toBe(1);
		h.cf.failOn = undefined;
		await h.worker.scheduled({} as ScheduledController, h.env);
		expect(h.cf.tunnels.size).toBe(0);
	});
});

describe("waitlist", () => {
	const post = (h: ReturnType<typeof setup>, method: string, body: unknown, ip = "198.51.100.9") => h.fetch(new Request("https://connect.test/v1/waitlist", { method, headers: { "cf-connecting-ip": ip }, body: JSON.stringify(body) }));
	it("stores an email only when given, returns a delete token, and deletes with it", async () => {
		const h = setup();
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>())?.n).toBe(0);
		const a = await j(await post(h, "POST", { email: "Person@Example.com" }));
		expect(a.status).toBe("ok");
		const again = await j(await post(h, "POST", { email: "person@example.com" }));
		expect(again.deleteToken).toBe(a.deleteToken);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>())?.n).toBe(1);
		expect((await post(h, "DELETE", { email: "person@example.com", token: "nope" })).status).toBe(401);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>())?.n).toBe(1);
		expect((await post(h, "DELETE", { email: "person@example.com", token: a.deleteToken })).status).toBe(200);
		expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM waitlist").first<{ n: number }>())?.n).toBe(0);
		expect(await dump()).not.toContain("198.51.100.9");
	});
	it("rejects junk emails and rate limits per IP", async () => {
		const h = setup();
		expect((await post(h, "POST", { email: "not-an-email" })).status).toBe(400);
		expect((await post(h, "POST", {})).status).toBe(400);
		const codes: number[] = [];
		for (let i = 0; i < 11; i++) codes.push((await post(h, "POST", { email: `p${i}@example.com` }, "198.51.100.77")).status);
		expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
		expect(codes[10]).toBe(429);
	});
});

describe("admin", () => {
	it("needs the secret header", async () => {
		const h = setup();
		expect((await admin(h, "GET", "/v1/admin/invites", undefined, "wrong")).status).toBe(401);
		expect((await h.fetch(new Request("https://connect.test/v1/admin/invites"))).status).toBe(401);
		const off = setup({ ADMIN_SECRET: "" } as never);
		expect((await admin(off, "GET", "/v1/admin/invites", undefined, "")).status).toBe(404);
	});
	it("creates, lists and revokes single-use invites; codes are stored only as hashes", async () => {
		const h = setup();
		const made = await j(await admin(h, "POST", "/v1/admin/invites", { count: 2, note: "for a friend", tier: "reserve" }));
		expect(made.codes).toHaveLength(2);
		const code = made.codes[0] as string;
		expect(await dump()).not.toContain(code);
		const list = await j(await admin(h, "GET", "/v1/admin/invites"));
		expect(list.invites).toHaveLength(2);
		expect(JSON.stringify(list)).not.toContain(code);
		expect(list.invites[0]).toMatchObject({ tier: "reserve", note: "for a friend", used_at: null, revoked_at: null });
		const id = list.invites[0].id;
		expect((await admin(h, "DELETE", `/v1/admin/invites/${id}`)).status).toBe(200);
		expect((await admin(h, "DELETE", `/v1/admin/invites/${id}`)).status).toBe(404);
		h.cf.others = 950;
		// The list is newest first, so invites[0] is the second code made, and that is the one revoked.
		const r = await h.fetch(await signedRequest(await makeDevice(), h.clock, "POST", "/v1/claim", { body: { invite: made.codes[1] } }));
		expect((await j(r)).status).toBe("invite_invalid");
	});
	it("lists and removes the waitlist, and shows stats", async () => {
		const h = setup();
		await h.fetch(new Request("https://connect.test/v1/waitlist", { method: "POST", body: JSON.stringify({ email: "a@example.com" }) }));
		const wl = await j(await admin(h, "GET", "/v1/admin/waitlist"));
		expect(wl.waitlist).toHaveLength(1);
		expect((await admin(h, "DELETE", `/v1/admin/waitlist/${wl.waitlist[0].id}`)).status).toBe(200);
		expect((await j(await admin(h, "GET", "/v1/admin/waitlist"))).waitlist).toHaveLength(0);
		h.cf.others = 40;
		await claim(h, await makeDevice());
		const stats = await j(await admin(h, "GET", "/v1/admin/stats"));
		expect(stats).toMatchObject({ status: "ok", accountTunnels: 40, devices: [{ status: "active", n: 1 }] });
	});
});

describe("routing", () => {
	it("answers the root, 404s unknown paths, and refuses to run unconfigured", async () => {
		const h = setup();
		expect((await h.fetch(new Request("https://connect.test/"))).status).toBe(200);
		expect((await h.fetch(new Request("https://connect.test/nope"))).status).toBe(404);
		const bare = setup({ CF_ZONE_ID: "REPLACE_WITH_ZONE_ID" } as never);
		expect((await bare.fetch(new Request("https://connect.test/v1/capacity"))).status).toBe(503);
		const opt = await h.fetch(new Request("https://connect.test/v1/capacity", { method: "OPTIONS" }));
		expect(opt.status).toBe(204);
	});
});
