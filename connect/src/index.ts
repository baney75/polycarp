/**
 * Polycarp Connect: hands out Cloudflare named tunnels so a person's web agents can reach Polycarp's browser.
 * Provisioning only. No traffic passes through this Worker, and it never sees a person's passcode or OAuth.
 */

import { handleAdmin } from "./admin.ts";
import { createCfClient } from "./cf.ts";
import { handleClaim, handleRelease, handleSeen } from "./claim.ts";
import { runDaily } from "./cron.ts";
import { handleCapacity, handleWaitlist } from "./public.ts";
import type { Deps, Env } from "./types.ts";
import { CORS, json } from "./util.ts";

const realDeps: Deps = { cf: (env) => createCfClient(env), now: () => Math.floor(Date.now() / 1000) };

function configProblem(env: Env): string | undefined {
	if (!env.CF_API_TOKEN) return "CF_API_TOKEN isn't set.";
	if (!env.IP_SALT || env.IP_SALT.length < 16) return "IP_SALT isn't set.";
	if (!env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID.startsWith("REPLACE")) return "CF_ACCOUNT_ID isn't set.";
	if (!env.CF_ZONE_ID || env.CF_ZONE_ID.startsWith("REPLACE")) return "CF_ZONE_ID isn't set.";
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(env.TUNNEL_HOST_SUFFIX ?? "")) return "TUNNEL_HOST_SUFFIX isn't a domain.";
	return undefined;
}

export function createWorker(deps: Deps = realDeps) {
	return {
		async fetch(request: Request, env: Env): Promise<Response> {
			const url = new URL(request.url);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			const method = request.method;
			if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			const problem = configProblem(env);
			if (problem && path !== "/") {
				console.error("config:", problem);
				return json({ status: "unavailable", message: "This service isn't set up yet." }, 503);
			}
			if (path === "/" && method === "GET") return json({ service: "polycarp-connect", note: "Provisioning only. No traffic passes through here." });
			if (path === "/v1/capacity" && method === "GET") return handleCapacity(env, deps);
			if (path === "/v1/claim") {
				if (method === "POST") return handleClaim(request, env, deps);
				if (method === "DELETE") return handleRelease(request, env, deps);
			}
			if (path === "/v1/seen" && method === "POST") return handleSeen(request, env, deps);
			if (path === "/v1/waitlist" && (method === "POST" || method === "DELETE")) return handleWaitlist(request, env, deps);
			if (path.startsWith("/v1/admin/")) return handleAdmin(request, env, deps, path);
			return json({ status: "not_found" }, 404);
		},
		async scheduled(_event: ScheduledController, env: Env): Promise<void> {
			if (configProblem(env)) return;
			await runDaily(env, deps);
		},
	};
}

export default createWorker();
