import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
	const migrations = await readD1Migrations("./migrations");
	return {
		plugins: [
			cloudflareTest({
				miniflare: {
					compatibilityDate: "2026-10-01",
					compatibilityFlags: ["nodejs_compat"],
					d1Databases: ["DB"],
					bindings: {
						TEST_MIGRATIONS: migrations,
						CF_API_TOKEN: "test-token-never-real",
						ADMIN_SECRET: "test-admin-secret-0123456789",
						IP_SALT: "test-salt-0123456789",
						CF_ACCOUNT_ID: "acct",
						CF_ZONE_ID: "zone",
						TUNNEL_HOST_SUFFIX: "example.test",
						HARD_LIMIT: "1000",
						RESERVE: "10",
						INVITE_ONLY_ABOVE: "900",
						PAUSED: "0",
						CLAIMS_PER_IP_PER_DAY: "10",
						STALE_DAYS: "60",
						CRON_BATCH: "12",
					},
				},
			}),
		],
		test: { setupFiles: ["./test/setup.ts"] },
	};
});
