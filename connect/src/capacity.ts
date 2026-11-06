import { type Deps, type Env } from "./types.ts";
import { intVar } from "./util.ts";

export const CACHE_SECONDS = 60;

export interface Limits {
	hard: number;
	reserve: number;
	inviteAbove: number;
	/** hard - reserve: the most anyone gets without a reserve invite. */
	ceiling: number;
}

export function limitsOf(env: Env): Limits {
	const hard = Math.max(0, intVar(env.HARD_LIMIT, 1000));
	const reserve = Math.min(hard, Math.max(0, intVar(env.RESERVE, 10)));
	const ceiling = hard - reserve;
	const inviteAbove = Math.min(ceiling, Math.max(0, intVar(env.INVITE_ONLY_ABOVE, 900)));
	return { hard, reserve, inviteAbove, ceiling };
}

export type Status = "open" | "invite_only" | "at_capacity";

export const statusOf = (count: number, l: Limits): Status => (count >= l.ceiling ? "at_capacity" : count >= l.inviteAbove ? "invite_only" : "open");

/** A coarse band. The exact number is never shown: the account holds other tunnels too. */
export const remainingBand = (count: number, l: Limits): "plenty" | "some" | "few" | "none" => {
	const left = l.ceiling - count;
	return left > 200 ? "plenty" : left > 50 ? "some" : left > 0 ? "few" : "none";
};

export interface Counted {
	/** The Cloudflare account's live tunnel count as of fetchedAt (cached 60 s). */
	live: number;
	fetchedAt: number;
	/** Slots handed out since fetchedAt that the cached count can't have seen yet. */
	added: number;
	/** live + added: the number every decision uses. */
	count: number;
}

/**
 * The count every decision rests on. It comes from the Cloudflare API, never from D1 alone (the account has
 * other tunnels), is cached in D1 for 60 s, and is topped up by reservations made after it was read, so two
 * claims inside the cache window still see each other. If the API can't be read, this throws: callers fail closed.
 */
export async function countNow(env: Env, deps: Deps): Promise<Counted> {
	const now = deps.now();
	const limits = limitsOf(env);
	let live: number;
	let fetchedAt: number;
	const cached = await env.DB.prepare("SELECT value, at FROM meta WHERE key = 'live'").first<{ value: string; at: number }>();
	if (cached && now - cached.at < CACHE_SECONDS && now >= cached.at) {
		live = Number(cached.value);
		fetchedAt = cached.at;
	} else {
		live = await deps.cf(env).countTunnels();
		fetchedAt = now;
		await env.DB.prepare("INSERT INTO meta (key, value, at) VALUES ('live', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, at = excluded.at").bind(String(live), now).run();
	}
	// An API limit error means the account is full whatever the count says, for the next cache window.
	const hit = await env.DB.prepare("SELECT at FROM meta WHERE key = 'limit_hit'").first<{ at: number }>();
	if (hit && now - hit.at < CACHE_SECONDS) live = Math.max(live, limits.hard);
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE reserved_at >= ?").bind(fetchedAt).first<{ n: number }>();
	const added = row?.n ?? 0;
	return { live, fetchedAt, added, count: live + added };
}

export async function markLimitHit(env: Env, now: number): Promise<void> {
	await env.DB.prepare("INSERT INTO meta (key, value, at) VALUES ('limit_hit', '1', ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at").bind(now).run();
}

export const paused = (env: Env): boolean => /^(1|true|yes|on)$/i.test((env.PAUSED ?? "").trim());
