import { releaseDevice } from "./claim.ts";
import { CfError, type Deps, type DeviceRow, type Env } from "./types.ts";
import { intVar } from "./util.ts";

const DAY = 86_400;

/**
 * The daily pass. Frees slots whose device hasn't checked in for STALE_DAYS (60), clears setups that stalled
 * halfway, and prunes nonces and rate counters. CRON_BATCH caps the Cloudflare calls per run (a Worker has a
 * subrequest limit); what's left goes in the next pass.
 */
export async function runDaily(env: Env, deps: Deps): Promise<{ released: number; failed: number; pruned: boolean }> {
	const now = deps.now();
	const batch = Math.max(1, intVar(env.CRON_BATCH, 12));
	const staleBefore = now - Math.max(1, intVar(env.STALE_DAYS, 60)) * DAY;
	await env.DB.prepare("DELETE FROM nonces WHERE seen_at < ?").bind(now - 3600).run();
	await env.DB.prepare("DELETE FROM rate WHERE exp < ?").bind(now).run();
	const due = await env.DB.prepare("SELECT * FROM devices WHERE (status = 'active' AND last_seen < ?) OR (status = 'pending' AND reserved_at < ?) ORDER BY reserved_at LIMIT ?")
		.bind(staleBefore, now - 600, batch)
		.all<DeviceRow>();
	const cf = deps.cf(env);
	let released = 0;
	let failed = 0;
	for (const row of due.results) {
		try {
			await releaseDevice(env, cf, row);
			released++;
		} catch (err) {
			failed++;
			console.error("daily release failed:", err instanceof CfError ? err.message : "unexpected error");
		}
	}
	return { released, failed, pruned: true };
}
