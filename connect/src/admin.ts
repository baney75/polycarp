import { inviteHash } from "./claim.ts";
import { countNow, limitsOf } from "./capacity.ts";
import { allow, ipKey } from "./limits.ts";
import type { Deps, Env } from "./types.ts";
import { json, randomBase32, safeEqual } from "./util.ts";

/** A new invite code: PC-XXXX-XXXX-XXXX-XXXX, 80 bits. Shown once; only its hash is kept. */
const newCode = (): string => `PC-${(randomBase32(16).toUpperCase().match(/.{4}/g) ?? []).join("-")}`;

export async function handleAdmin(request: Request, env: Env, deps: Deps, path: string): Promise<Response> {
	if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 16) return json({ status: "error", message: "Admin is off: ADMIN_SECRET isn't set." }, 404);
	const now = deps.now();
	if (!(await allow(env.DB, `admin:ip:${await ipKey(env, request)}`, 3600, 120, now))) return json({ status: "rate_limited" }, 429);
	if (!safeEqual(request.headers.get("x-admin-secret") ?? "", env.ADMIN_SECRET)) return json({ status: "unauthorized" }, 401);
	const method = request.method;
	const parts = path.split("/").filter(Boolean); // ["v1","admin",...]
	const [, , area, id] = parts;

	if (area === "invites") {
		if (method === "POST" && !id) {
			let body: { count?: unknown; tier?: unknown; note?: unknown } = {};
			try {
				body = (await request.json()) as typeof body;
			} catch {
				/* defaults */
			}
			const count = typeof body.count === "number" && Number.isInteger(body.count) ? Math.min(50, Math.max(1, body.count)) : 1;
			const tier = body.tier === "reserve" ? "reserve" : "standard";
			const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;
			const codes: string[] = [];
			for (let i = 0; i < count; i++) {
				const code = newCode();
				await env.DB.prepare("INSERT INTO invites (code_hash, prefix, tier, note, created_at) VALUES (?, ?, ?, ?, ?)").bind(await inviteHash(code), code.slice(0, 7), tier, note, now).run();
				codes.push(code);
			}
			return json({ status: "ok", tier, codes }, 201);
		}
		if (method === "GET" && !id) {
			const rows = await env.DB.prepare("SELECT id, prefix, tier, note, created_at, used_at, revoked_at FROM invites ORDER BY id DESC LIMIT 500").all();
			return json({ status: "ok", invites: rows.results });
		}
		if (method === "DELETE" && id && /^\d+$/.test(id)) {
			const r = await env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL").bind(now, Number(id)).run();
			return (r.meta.changes ?? 0) === 1 ? json({ status: "ok", revoked: Number(id) }) : json({ status: "not_found", message: "No unused invite with that id." }, 404);
		}
	}
	if (area === "waitlist") {
		if (method === "GET" && !id) {
			const rows = await env.DB.prepare("SELECT id, email, created_at FROM waitlist ORDER BY id LIMIT 5000").all();
			return json({ status: "ok", waitlist: rows.results });
		}
		if (method === "DELETE" && id && /^\d+$/.test(id)) {
			const r = await env.DB.prepare("DELETE FROM waitlist WHERE id = ?").bind(Number(id)).run();
			return (r.meta.changes ?? 0) === 1 ? json({ status: "ok" }) : json({ status: "not_found" }, 404);
		}
	}
	if (area === "stats" && method === "GET") {
		const counted = await countNow(env, deps);
		const l = limitsOf(env);
		const devices = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM devices GROUP BY status").all<{ status: string; n: number }>();
		return json({ status: "ok", accountTunnels: counted.live, reservedSinceRead: counted.added, effective: counted.count, limits: l, devices: devices.results });
	}
	return json({ status: "not_found" }, 404);
}
