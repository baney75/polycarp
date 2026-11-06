import { describe, expect, it } from "vitest";
import { createCfClient } from "../src/cf.ts";
import { CfError, type Env } from "../src/types.ts";

const env = { CF_API_TOKEN: "tok-should-only-be-a-header", CF_ACCOUNT_ID: "acct", CF_ZONE_ID: "zone" } as Env;

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
function stub(answers: { status?: number; body: unknown }[]) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body as string | undefined });
		const a = answers.shift() ?? { body: { success: true, result: {} } };
		return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
	}) as unknown as typeof fetch;
	return { calls, fetchFn };
}

describe("the real Cloudflare client (against a stub fetch, never the network)", () => {
	it("counts tunnels from result_info and asks for non-deleted ones", async () => {
		const s = stub([{ body: { success: true, result: [], result_info: { total_count: 412 } } }]);
		expect(await createCfClient(env, s.fetchFn).countTunnels()).toBe(412);
		expect(s.calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel?is_deleted=false&per_page=1&page=1");
		expect(s.calls[0]?.headers.authorization).toBe(`Bearer ${env.CF_API_TOKEN}`);
	});
	it("creates a remotely managed tunnel, sets ingress to the local port, and adds a proxied CNAME", async () => {
		const s = stub([{ body: { success: true, result: { id: "t1" } } }, { body: { success: true, result: {} } }, { body: { success: true, result: {} } }, { body: { success: true, result: "TOKEN" } }]);
		const cf = createCfClient(env, s.fetchFn);
		expect(await cf.createTunnel("pc-abc")).toEqual({ id: "t1" });
		await cf.putIngress("t1", "pc-abc.example.test", 8787);
		await cf.createDns("pc-abc.example.test", "t1");
		expect(await cf.getToken("t1")).toBe("TOKEN");
		expect(JSON.parse(s.calls[0]?.body ?? "{}")).toEqual({ name: "pc-abc", config_src: "cloudflare" });
		expect(s.calls[1]).toMatchObject({ method: "PUT", url: "https://api.cloudflare.com/client/v4/accounts/acct/cfd_tunnel/t1/configurations" });
		expect(JSON.parse(s.calls[1]?.body ?? "{}")).toEqual({ config: { ingress: [{ hostname: "pc-abc.example.test", service: "http://127.0.0.1:8787" }, { service: "http_status:404" }] } });
		expect(JSON.parse(s.calls[2]?.body ?? "{}")).toMatchObject({ type: "CNAME", name: "pc-abc.example.test", content: "t1.cfargotunnel.com", proxied: true });
		expect(s.calls[3]?.url).toContain("/cfd_tunnel/t1/token");
	});
	it("deletes DNS records by name, then the tunnel's connections, then the tunnel", async () => {
		const s = stub([{ body: { success: true, result: [{ id: "r1" }, { id: "r2" }] } }, { body: { success: true } }, { body: { success: true } }, { body: { success: true } }, { body: { success: true } }]);
		const cf = createCfClient(env, s.fetchFn);
		await cf.deleteDns("pc-abc.example.test");
		await cf.deleteTunnel("t1");
		expect(s.calls.map((c) => `${c.method} ${c.url.replace("https://api.cloudflare.com/client/v4", "")}`)).toEqual([
			"GET /zones/zone/dns_records?type=CNAME&name=pc-abc.example.test",
			"DELETE /zones/zone/dns_records/r1",
			"DELETE /zones/zone/dns_records/r2",
			"DELETE /accounts/acct/cfd_tunnel/t1/connections",
			"DELETE /accounts/acct/cfd_tunnel/t1",
		]);
	});
	it("flags a limit error, marks 404 as not-found, and keeps the token and bodies out of error text", async () => {
		const s = stub([
			{ status: 400, body: { success: false, errors: [{ code: 1, message: "You have reached the maximum number of tunnels" }], result: { token: "LEAK" } } },
			{ status: 404, body: { success: false, errors: [{ message: "not found" }] } },
			{ status: 500, body: { success: false, errors: [] } },
		]);
		const cf = createCfClient(env, s.fetchFn);
		const limit = await cf.createTunnel("x").catch((e: unknown) => e);
		expect(limit).toBeInstanceOf(CfError);
		expect((limit as CfError).limit).toBe(true);
		expect(String((limit as CfError).message)).not.toContain("LEAK");
		expect(String((limit as CfError).message)).not.toContain(env.CF_API_TOKEN);
		const gone = await cf.getToken("t1").catch((e: unknown) => e);
		expect((gone as CfError).notFound).toBe(true);
		const down = await cf.countTunnels().catch((e: unknown) => e);
		expect((down as CfError).limit).toBe(false);
	});
});
