import { type CfClient, CfError, type Env } from "./types.ts";

const API = "https://api.cloudflare.com/client/v4";
const LIMIT_WORDS = /limit|quota|maximum|too many|exceed/i;

interface Envelope<T> {
	success?: boolean;
	errors?: { code?: number; message?: string }[];
	result?: T;
	result_info?: { total_count?: number; count?: number };
}

/**
 * The real Cloudflare API client. The token goes in one header and nowhere else: it is never logged,
 * and error messages carry only Cloudflare's own error text, never a request or a response body.
 */
export function createCfClient(env: Env, fetchFn: typeof fetch = fetch): CfClient {
	const account = encodeURIComponent(env.CF_ACCOUNT_ID);
	const zone = encodeURIComponent(env.CF_ZONE_ID);

	async function call<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
		const res = await fetchFn(`${API}${path}`, {
			method,
			headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		let parsed: Envelope<T> = {};
		try {
			parsed = (await res.json()) as Envelope<T>;
		} catch {
			/* a non-JSON answer is handled as a failure below */
		}
		if (!res.ok || parsed.success === false) {
			const text = (parsed.errors ?? []).map((e) => e.message ?? "").filter(Boolean).join("; ") || `HTTP ${res.status}`;
			const limit = (res.status === 400 || res.status === 403 || res.status === 429) && LIMIT_WORDS.test(text);
			throw new CfError(`Cloudflare ${method} ${path.replace(/[0-9a-f]{32}|[0-9a-f-]{36}/g, ":id")} failed: ${text}`, res.status, limit, res.status === 404);
		}
		return parsed;
	}

	return {
		async countTunnels() {
			const r = await call<unknown[]>("GET", `/accounts/${account}/cfd_tunnel?is_deleted=false&per_page=1&page=1`);
			const total = r.result_info?.total_count;
			if (typeof total !== "number") throw new CfError("Cloudflare gave no tunnel count", 502);
			return total;
		},
		async createTunnel(name) {
			const r = await call<{ id?: string; token?: string }>("POST", `/accounts/${account}/cfd_tunnel`, { name, config_src: "cloudflare" });
			if (!r.result?.id) throw new CfError("Cloudflare made no tunnel id", 502);
			return { id: r.result.id, ...(typeof r.result.token === "string" ? { token: r.result.token } : {}) };
		},
		async putIngress(tunnelId, hostname, port) {
			await call("PUT", `/accounts/${account}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`, {
				config: { ingress: [{ hostname, service: `http://127.0.0.1:${port}` }, { service: "http_status:404" }] },
			});
		},
		async getToken(tunnelId) {
			const r = await call<string>("GET", `/accounts/${account}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`);
			if (typeof r.result !== "string" || !r.result) throw new CfError("Cloudflare gave no tunnel token", 502);
			return r.result;
		},
		async createDns(hostname, tunnelId) {
			await call("POST", `/zones/${zone}/dns_records`, { type: "CNAME", name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "polycarp-connect" });
		},
		async deleteDns(hostname) {
			const found = await call<{ id: string }[]>("GET", `/zones/${zone}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
			for (const record of found.result ?? []) await call("DELETE", `/zones/${zone}/dns_records/${encodeURIComponent(record.id)}`);
		},
		async deleteTunnel(tunnelId) {
			const id = encodeURIComponent(tunnelId);
			try {
				await call("DELETE", `/accounts/${account}/cfd_tunnel/${id}/connections`);
			} catch (err) {
				if (!(err instanceof CfError && err.notFound)) throw err;
			}
			await call("DELETE", `/accounts/${account}/cfd_tunnel/${id}`);
		},
	};
}
