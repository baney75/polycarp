export interface Env {
	DB: D1Database;
	/** Secrets (wrangler secret put). */
	CF_API_TOKEN: string;
	ADMIN_SECRET: string;
	IP_SALT: string;
	/** Plain vars (wrangler.jsonc). */
	CF_ACCOUNT_ID: string;
	CF_ZONE_ID: string;
	TUNNEL_HOST_SUFFIX: string;
	HARD_LIMIT: string;
	RESERVE: string;
	INVITE_ONLY_ABOVE: string;
	PAUSED?: string;
	CLAIMS_PER_IP_PER_DAY?: string;
	STALE_DAYS?: string;
	CRON_BATCH?: string;
}

/** What the Worker needs from the Cloudflare API. Tests pass a fake; production uses cf.ts. */
export interface CfClient {
	/** Tunnels in the whole account that aren't deleted, other people's and ours. */
	countTunnels(): Promise<number>;
	createTunnel(name: string): Promise<{ id: string; token?: string }>;
	putIngress(tunnelId: string, hostname: string, port: number): Promise<void>;
	getToken(tunnelId: string): Promise<string>;
	createDns(hostname: string, tunnelId: string): Promise<void>;
	deleteDns(hostname: string): Promise<void>;
	deleteTunnel(tunnelId: string): Promise<void>;
}

export interface Deps {
	cf: (env: Env) => CfClient;
	now: () => number;
}

export class CfError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly limit = false,
		readonly notFound = false,
	) {
		super(message);
	}
}

export interface DeviceRow {
	device_hash: string;
	status: "pending" | "active";
	hostname: string | null;
	tunnel_id: string | null;
	reserved_at: number;
	created_at: number;
	last_seen: number;
	invite_id: number | null;
}
