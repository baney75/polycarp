import { verifySigned, useNonce } from "./auth.ts";
import { countNow, limitsOf, markLimitHit, paused, statusOf } from "./capacity.ts";
import { allow, ipKey } from "./limits.ts";
import { type CfClient, CfError, type Deps, type DeviceRow, type Env } from "./types.ts";
import { intVar, json, randomBase32, sha256Hex } from "./util.ts";

const PENDING_FRESH_SECONDS = 120;
const DAY = 86_400;
const HOUR = 3600;

const FULL_MESSAGE = "Polycarp's free connections are full right now. You can join the waitlist, or enter an invite code.";

export function normalizeInvite(raw: string): string {
	return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
export const inviteHash = (raw: string): Promise<string> => sha256Hex(normalizeInvite(raw));

const atCapacity = () => json({ status: "at_capacity", message: FULL_MESSAGE, waitlist: "/v1/waitlist" }, 503);
const unavailable = () => json({ status: "unavailable", message: "Polycarp's connection service can't be reached right now. Try again in a few minutes." }, 503);

/** Remove everything a device holds: DNS, tunnel, then the row. A Cloudflare failure other than "already gone" keeps the row so a later pass can retry. */
export async function releaseDevice(env: Env, cf: CfClient, row: DeviceRow): Promise<void> {
	if (row.hostname) {
		try {
			await cf.deleteDns(row.hostname);
		} catch (err) {
			if (!(err instanceof CfError && err.notFound)) throw err;
		}
	}
	if (row.tunnel_id) {
		try {
			await cf.deleteTunnel(row.tunnel_id);
		} catch (err) {
			if (!(err instanceof CfError && err.notFound)) throw err;
		}
	}
	await env.DB.prepare("DELETE FROM devices WHERE device_hash = ?").bind(row.device_hash).run();
}

/** The common front of every signed write: per-IP limit, signature, replay check, per-device limit. */
async function guard(request: Request, env: Env, deps: Deps, kind: string): Promise<{ deviceHash: string; body: string } | Response> {
	const now = deps.now();
	const ip = await ipKey(env, request);
	if (!(await allow(env.DB, `w:ip:${ip}`, HOUR, 120, now))) return json({ status: "rate_limited", message: "Too many requests from this network. Try again later." }, 429);
	const signed = await verifySigned(request, now);
	if (signed instanceof Response) return signed;
	if (!(await useNonce(env.DB, signed.nonceKey, now))) return json({ status: "unauthorized", message: "That request was already used." }, 401);
	if (!(await allow(env.DB, `w:dev:${signed.deviceHash}:${kind}`, HOUR, kind === "seen" ? 30 : 20, now))) return json({ status: "rate_limited", message: "Too many requests from this device. Try again later." }, 429);
	return { deviceHash: signed.deviceHash, body: signed.body };
}

async function findDevice(env: Env, deviceHash: string): Promise<DeviceRow | null> {
	return env.DB.prepare("SELECT * FROM devices WHERE device_hash = ?").bind(deviceHash).first<DeviceRow>();
}

export async function handleClaim(request: Request, env: Env, deps: Deps): Promise<Response> {
	if (paused(env)) return json({ status: "paused", message: "Polycarp is not handing out new connections right now. Check back later." }, 503);
	const g = await guard(request, env, deps, "claim");
	if (g instanceof Response) return g;
	const now = deps.now();
	// The per-IP daily limit is the abuse brake: a claim needs only a device key, and keys are free to make.
	const ip = await ipKey(env, request);
	if (!(await allow(env.DB, `claim:ip:${ip}`, DAY, intVar(env.CLAIMS_PER_IP_PER_DAY, 10), now))) {
		return json({ status: "rate_limited", message: "This network has asked for too many connections today. Try again tomorrow." }, 429);
	}
	if (!(await allow(env.DB, `claim:dev:${g.deviceHash}`, DAY, 10, now))) return json({ status: "rate_limited", message: "This device has asked for too many connections today. Try again tomorrow." }, 429);

	let parsed: { port?: unknown; invite?: unknown } = {};
	if (g.body) {
		try {
			parsed = JSON.parse(g.body) as typeof parsed;
		} catch {
			return json({ status: "error", message: "The request body isn't JSON." }, 400);
		}
	}
	const port = parsed.port === undefined ? 8787 : parsed.port;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) return json({ status: "error", message: "port must be a whole number from 1024 to 65535." }, 400);
	const inviteRaw = typeof parsed.invite === "string" && parsed.invite.trim() ? parsed.invite.trim().slice(0, 64) : undefined;

	const cf = deps.cf(env);
	try {
		// 1. A device that already has a tunnel gets it back. Claim is idempotent.
		let existing = await findDevice(env, g.deviceHash);
		if (existing?.status === "active" && existing.tunnel_id && existing.hostname) {
			try {
				const token = await cf.getToken(existing.tunnel_id);
				await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_hash = ?").bind(now, g.deviceHash).run();
				return json({ status: "ok", hostname: existing.hostname, tunnelToken: token, existing: true });
			} catch (err) {
				if (!(err instanceof CfError && err.notFound)) throw err;
				// The tunnel was deleted behind our back: forget it and make a new one.
				await releaseDevice(env, cf, existing);
				existing = null;
			}
		} else if (existing) {
			if (existing.reserved_at > now - PENDING_FRESH_SECONDS) return json({ status: "in_progress", message: "This device's connection is still being set up. Try again in a minute." }, 409);
			await releaseDevice(env, cf, existing);
		}

		// 2. Capacity, from the live API count.
		const limits = limitsOf(env);
		const counted = await countNow(env, deps);
		const status = statusOf(counted.count, limits);
		let inviteRow: { id: number; tier: string } | null = null;
		// An invite is looked up only when the door isn't open, and spent only if it is needed.
		if (inviteRaw && status !== "open") {
			inviteRow = await env.DB.prepare("SELECT id, tier FROM invites WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL").bind(await inviteHash(inviteRaw)).first<{ id: number; tier: string }>();
		}
		if (status === "at_capacity" && !(inviteRow?.tier === "reserve" && counted.count < limits.hard)) return atCapacity();
		if (status === "invite_only" && !inviteRow) {
			return json({ status: inviteRaw ? "invite_invalid" : "invite_required", message: inviteRaw ? "That invite code isn't valid, or it was already used." : "New connections need an invite code right now. Enter one, or join the waitlist.", waitlist: "/v1/waitlist" }, 403);
		}
		const ceiling = inviteRow?.tier === "reserve" ? limits.hard : limits.ceiling;

		// 3. Hold a slot before touching Cloudflare. One statement, so two claims can't both take the last one.
		const hostname = `pc-${randomBase32(20)}.${env.TUNNEL_HOST_SUFFIX}`;
		const reserved = await env.DB.prepare(
			"INSERT INTO devices (device_hash, status, hostname, reserved_at, created_at, last_seen) SELECT ?, 'pending', ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM devices WHERE reserved_at >= ?) < ?",
		)
			.bind(g.deviceHash, hostname, now, now, now, counted.fetchedAt, Math.max(0, ceiling - counted.live))
			.run();
		if ((reserved.meta.changes ?? 0) !== 1) return atCapacity();

		// 4. Spend the invite, atomically. A code used a moment ago by someone else loses.
		if (inviteRow) {
			const spent = await env.DB.prepare("UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(now, inviteRow.id).run();
			if ((spent.meta.changes ?? 0) !== 1) {
				await env.DB.prepare("DELETE FROM devices WHERE device_hash = ?").bind(g.deviceHash).run();
				return json({ status: "invite_invalid", message: "That invite code isn't valid, or it was already used." }, 403);
			}
			await env.DB.prepare("UPDATE devices SET invite_id = ? WHERE device_hash = ?").bind(inviteRow.id, g.deviceHash).run();
		}

		// 5. Make the tunnel, its ingress and its DNS record. Any failure undoes what was made.
		try {
			const created = await cf.createTunnel(hostname.split(".")[0] ?? hostname);
			const tunnelId = created.id;
			await env.DB.prepare("UPDATE devices SET tunnel_id = ? WHERE device_hash = ?").bind(tunnelId, g.deviceHash).run();
			await cf.putIngress(tunnelId, hostname, port);
			await cf.createDns(hostname, tunnelId);
			const token = created.token ?? (await cf.getToken(tunnelId));
			await env.DB.prepare("UPDATE devices SET status = 'active', last_seen = ? WHERE device_hash = ?").bind(now, g.deviceHash).run();
			return json({ status: "ok", hostname, tunnelToken: token, existing: false });
		} catch (err) {
			const row = await findDevice(env, g.deviceHash);
			if (row) {
				try {
					await releaseDevice(env, cf, row);
				} catch {
					/* the row stays pending with its tunnel id, and the daily pass retries */
				}
			}
			if (inviteRow) await env.DB.prepare("UPDATE invites SET used_at = NULL WHERE id = ?").bind(inviteRow.id).run();
			if (err instanceof CfError && err.limit) {
				await markLimitHit(env, now);
				return atCapacity();
			}
			throw err;
		}
	} catch (err) {
		console.error("claim failed:", err instanceof CfError ? err.message : "unexpected error");
		return unavailable();
	}
}

export async function handleSeen(request: Request, env: Env, deps: Deps): Promise<Response> {
	const g = await guard(request, env, deps, "seen");
	if (g instanceof Response) return g;
	const r = await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_hash = ? AND status = 'active'").bind(deps.now(), g.deviceHash).run();
	if ((r.meta.changes ?? 0) !== 1) return json({ status: "not_found", message: "This device has no connection. Turn it on again." }, 404);
	return json({ status: "ok" });
}

export async function handleRelease(request: Request, env: Env, deps: Deps): Promise<Response> {
	const g = await guard(request, env, deps, "release");
	if (g instanceof Response) return g;
	const row = await findDevice(env, g.deviceHash);
	if (!row) return json({ status: "ok", released: false });
	try {
		await releaseDevice(env, deps.cf(env), row);
	} catch (err) {
		console.error("release failed:", err instanceof CfError ? err.message : "unexpected error");
		return json({ status: "unavailable", message: "Couldn't free the connection yet. Try again in a few minutes." }, 503);
	}
	return json({ status: "ok", released: true });
}
