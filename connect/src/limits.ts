import type { Env } from "./types.ts";
import { hmacHex } from "./util.ts";

/** Count one hit for `key` in the current window. True while the key is at or under `max`. */
export async function allow(db: D1Database, key: string, windowSeconds: number, max: number, nowSeconds: number): Promise<boolean> {
	const win = Math.floor(nowSeconds / windowSeconds);
	const row = await db
		.prepare("INSERT INTO rate (key, win, n, exp) VALUES (?, ?, 1, ?) ON CONFLICT (key, win) DO UPDATE SET n = n + 1 RETURNING n")
		.bind(key, win, (win + 2) * windowSeconds)
		.first<{ n: number }>();
	return (row?.n ?? 1) <= max;
}

/** A short keyed hash of the caller's IP: enough to rate limit, not an address anyone can read back. */
export async function ipKey(env: Env, request: Request): Promise<string> {
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	return (await hmacHex(env.IP_SALT, `ip:${ip}`)).slice(0, 24);
}
