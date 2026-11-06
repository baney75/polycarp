import { countNow, paused, remainingBand, statusOf, limitsOf } from "./capacity.ts";
import { allow, ipKey } from "./limits.ts";
import type { Deps, Env } from "./types.ts";
import { CORS, hmacHex, json, safeEqual } from "./util.ts";

export async function handleCapacity(env: Env, deps: Deps): Promise<Response> {
	try {
		const counted = await countNow(env, deps);
		const l = limitsOf(env);
		return json({ status: statusOf(counted.count, l), remaining: remainingBand(counted.count, l), paused: paused(env) }, 200, CORS);
	} catch {
		return json({ status: "unavailable", message: "Capacity can't be read right now." }, 503, CORS);
	}
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const normalizeEmail = (raw: unknown): string | undefined => (typeof raw === "string" && raw.trim().length <= 254 && EMAIL.test(raw.trim()) ? raw.trim().toLowerCase() : undefined);
const deleteToken = (env: Env, email: string) => hmacHex(env.IP_SALT, `waitlist:${email}`).then((h) => h.slice(0, 32));

/** Join (POST {email}) or leave (DELETE {email, token}). The email is stored only because the person typed it. */
export async function handleWaitlist(request: Request, env: Env, deps: Deps): Promise<Response> {
	const now = deps.now();
	if (!(await allow(env.DB, `wl:ip:${await ipKey(env, request)}`, 86_400, 10, now))) return json({ status: "rate_limited", message: "Too many requests from this network. Try again tomorrow." }, 429, CORS);
	let body: { email?: unknown; token?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ status: "error", message: "Send JSON like {\"email\": \"you@example.com\"}." }, 400, CORS);
	}
	const email = normalizeEmail(body.email);
	if (!email) return json({ status: "error", message: "That doesn't look like an email address." }, 400, CORS);
	const token = await deleteToken(env, email);
	if (request.method === "DELETE") {
		if (typeof body.token !== "string" || !safeEqual(body.token, token)) return json({ status: "unauthorized", message: "That delete token doesn't match this email." }, 401, CORS);
		await env.DB.prepare("DELETE FROM waitlist WHERE email = ?").bind(email).run();
		return json({ status: "ok", deleted: true }, 200, CORS);
	}
	await env.DB.prepare("INSERT OR IGNORE INTO waitlist (email, created_at) VALUES (?, ?)").bind(email, now).run();
	return json({ status: "ok", deleteToken: token, message: "You're on the waitlist. Keep the delete token: it removes your email." }, 200, CORS);
}
