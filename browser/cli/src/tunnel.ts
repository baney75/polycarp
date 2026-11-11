/**
 * `polycarp browser tunnel`: reach `polycarp browser serve` from another device or a cloud agent through a
 * tunnel the user owns, which terminates TLS. Nothing is exposed until the user runs one.
 *
 * - tailscale: `tailscale serve` publishes https://<this machine>.<tailnet>.ts.net/polycarp
 *   to the user's own tailnet only. `--public` uses `tailscale funnel` instead, which is
 *   reachable from the internet; the token is then the only lock, so it warns.
 * - cloudflare: a `cloudflared` quick tunnel (free, no account) gives a random
 *   https://*.trycloudflare.com URL that changes each time. For a stable name, use
 *   `remote setup --cloudflare <name>` on the person's own account (cloudflare.ts). Polycarp never makes accounts.
 *
 * Polycarp doesn't install either tool.
 */

import { COMMAND_NAME } from "./self.ts";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { which } from "./harness.ts";
import { envVar } from "./env.ts";
import { configDir } from "./files.ts";
import { windowsProcessImage, windowsTool } from "./tool-paths.ts";

export const DEFAULT_PORT = 8787;
const SERVE_PATH = "/polycarp";
/** Where an earlier version published it. Removed when it points at this serve (below); otherwise it counts as someone else's. */
const OLD_SERVE_PATH = "/tabkyra";

function run(cmd: string, args: string[]): { code: number; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30_000 });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export interface TunnelResult {
	url?: string;
	message: string;
	ok: boolean;
}

/** What port 443 serves here, or undefined when Tailscale's answer can't be read. */
function servedOn443(bin: string): [string, { Proxy?: string }][] | undefined {
	try {
		const web = (JSON.parse(run(bin, ["serve", "status", "--json"]).out || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web ?? {};
		return Object.entries(web)
			.filter(([hostPort]) => hostPort.endsWith(":443"))
			.flatMap(([, v]) => Object.entries(v.Handlers ?? {}));
	} catch {
		return undefined;
	}
}

/** Both paths, so a person who upgraded with the old one still published can turn it off. One pointing at another program is theirs, and is said out loud. */
function tailscaleOff(bin: string, mode: string, port: number): TunnelResult {
	const handlers = servedOn443(bin);
	const has = (path: string) => handlers?.some(([p]) => p === path) ?? true;
	const stopped: string[] = [];
	const failures: string[] = [];
	const current = run(bin, [mode, "--https=443", `--set-path=${SERVE_PATH}`, "off"]);
	if (current.code === 0) stopped.push(SERVE_PATH);
	// Tailscale refuses to turn off what isn't there, which is the state asked for.
	else if (has(SERVE_PATH)) failures.push(current.out);
	const old = handlers?.find(([p]) => p === OLD_SERVE_PATH)?.[1];
	if (old?.Proxy === `http://127.0.0.1:${port}`) {
		const r = run(bin, ["serve", "--https=443", `--set-path=${OLD_SERVE_PATH}`, "off"]);
		if (r.code === 0) stopped.push(OLD_SERVE_PATH);
		else failures.push(r.out);
	}
	if (failures.length) return { ok: false, message: failures.join(" ") };
	const leftAlone = old && old.Proxy !== `http://127.0.0.1:${port}` ? ` ${OLD_SERVE_PATH} points at ${old.Proxy ?? "something else"}, so it was left on. If that's an old Polycarp, run this again with its --port.` : "";
	return { ok: true, message: `${stopped.length ? `Stopped the Tailscale ${mode} for ${stopped.join(" and ")}.` : "Nothing of Polycarp's was published on Tailscale."}${leftAlone}` };
}

export function tailscaleTunnel(options: { port: number; public: boolean; off: boolean }): TunnelResult {
	const bin = process.platform === "win32" ? windowsTool("tailscale") : which("tailscale");
	if (!bin) return { ok: false, message: "Tailscale isn't installed. Install it from tailscale.com and sign in, then run this again." };
	const mode = options.public ? "funnel" : "serve";
	if (options.off) {
		return tailscaleOff(bin, mode, options.port);
	}
	const status = run(bin, ["status", "--json"]);
	let dns = "";
	try {
		dns = String((JSON.parse(status.out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "");
	} catch {
		/* reported below */
	}
	if (!dns) return { ok: false, message: "Tailscale isn't connected. Run tailscale up, then try again." };
	// Read the current serve config first and fail closed: changing serve without knowing
	// whether Funnel is on for :443 could make this path public by surprise.
	const statusRun = spawnSync(bin, ["serve", "status", "--json"], { encoding: "utf8", timeout: 30_000 });
	let status443: { AllowFunnel?: Record<string, boolean> } | undefined;
	try {
		if (statusRun.status === 0) status443 = JSON.parse(statusRun.stdout || "{}");
	} catch {
		status443 = undefined;
	}
	if (!status443 || typeof status443 !== "object") return { ok: false, message: "Couldn't read tailscale serve status, so nothing was changed." };
	if (!options.public && Object.entries(status443.AllowFunnel ?? {}).some(([hostPort, on]) => on && hostPort.endsWith(":443"))) {
		return {
			ok: false,
			message: `Funnel is on for port 443 on this machine, so ${SERVE_PATH} would be public, not tailnet-only. Nothing was changed. Use --public if that's what you want, or turn Funnel off for port 443 in Tailscale first.`,
		};
	}
	// Read what port 443 serves. The old path is ours only if it points at this serve; then it goes, so it can't stay behind, and
	// Funnel can't publish it. One pointing anywhere else is someone's, like any other path.
	const read = servedOn443(bin);
	if (!read && options.public) return { ok: false, message: "Couldn't read tailscale serve status; not turning on Funnel." };
	const handlers = read ?? [];
	const oldIsOurs = handlers.some(([path, h]) => path === OLD_SERVE_PATH && h.Proxy === `http://127.0.0.1:${options.port}`);
	if (options.public) {
		// Funnel opens a whole host:port to the internet, not one path: refuse if anything else is served there.
		const others = handlers.map(([path]) => path).filter((path) => path !== SERVE_PATH && !(path === OLD_SERVE_PATH && oldIsOurs));
		if (others.length) {
			return { ok: false, message: `Port 443 also serves ${others.join(", ")} on this machine. Funnel would make those public too, so it wasn't turned on.` };
		}
	}
	if (oldIsOurs) {
		const gone = run(bin, ["serve", "--https=443", `--set-path=${OLD_SERVE_PATH}`, "off"]);
		if (gone.code !== 0) return { ok: false, message: `Couldn't remove the old ${OLD_SERVE_PATH} path, so nothing else was changed: ${gone.out}` };
	}
	const r = run(bin, [mode, "--bg", "--yes", "--https=443", `--set-path=${SERVE_PATH}`, `http://127.0.0.1:${options.port}`]);
	if (r.code !== 0) return { ok: false, message: r.out };
	const url = `https://${dns}${SERVE_PATH}/mcp`;
	const reach = options.public ? "anyone on the internet who has a token" : "your own tailnet devices that have a token";
	return { ok: true, url, message: `MCP is reachable at ${url} by ${reach}. Run ${COMMAND_NAME} serve on port ${options.port}.` };
}

function cloudflaredPidFile(): string {
	return join(configDir(), "cloudflared.pid");
}

/** The cloudflared this command started, if it is still that process (not a reused PID); "unknown" when it can't be checked. */
export function ourCloudflared(platform: NodeJS.Platform = process.platform, exec = run): number | "unknown" | undefined {
	if (!existsSync(cloudflaredPidFile())) return undefined;
	const pid = Number(readFileSync(cloudflaredPidFile(), "utf8"));
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	if (platform === "win32") {
		// Windows has no ps; tasklist names the program, so a pid Windows has reused for something else reads as not running.
		const image = windowsProcessImage(pid, exec);
		return image === "unknown" ? image : image?.toLowerCase() === "cloudflared.exe" ? pid : undefined;
	}
	const ps = existsSync("/bin/ps") ? "/bin/ps" : "ps";
	const raw = spawnSync(ps, ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 10_000 });
	// Couldn't run ps at all: the process can't be checked, which is not the same as "not ours".
	if (raw.error || raw.status === null) return "unknown";
	const check = { code: raw.status, out: `${raw.stdout ?? ""}`.trim() };
	return /cloudflared/.test(check.out) && /tunnel/.test(check.out) && /--url http:\/\/127\.0\.0\.1:/.test(check.out) ? pid : undefined;
}

export async function cloudflareTunnel(options: { port: number; off: boolean; timeoutMs?: number }): Promise<TunnelResult> {
	if (options.off) {
		const pid = ourCloudflared();
		if (pid === "unknown") {
			return { ok: false, message: `Can't check which process ${cloudflaredPidFile()} names on this system. Stop cloudflared yourself, then delete that file.` };
		}
		rmSync(cloudflaredPidFile(), { force: true });
		if (pid === undefined) return { ok: true, message: "No Cloudflare tunnel started by Polycarp is running." };
		try {
			process.kill(pid);
		} catch {
			/* already gone */
		}
		return { ok: true, message: "Stopped the Cloudflare tunnel." };
	}
	if (ourCloudflared() !== undefined) return { ok: false, message: `A Cloudflare tunnel is already running. Run ${COMMAND_NAME} tunnel cloudflare --off first.` };
	const bin = process.platform === "win32" ? windowsTool("cloudflared") : which("cloudflared");
	if (!bin) {
		return {
			ok: false,
			message:
				"cloudflared isn't installed. Install it from Cloudflare (developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads), then run this again. A quick tunnel needs no account.",
		};
	}
	mkdirSync(configDir(), { recursive: true });
	const log = join(configDir(), "cloudflared.log");
	writeFileSync(log, "");
	const fd = openSync(log, "a");
	const child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${options.port}`], { detached: true, stdio: ["ignore", fd, fd] });
	child.unref();
	if (child.pid) writeFileSync(cloudflaredPidFile(), String(child.pid));
	const deadline = Date.now() + (options.timeoutMs ?? (Number(envVar("TUNNEL_TIMEOUT_MS")) || 30_000));
	while (Date.now() < deadline) {
		// The issued name, never api.trycloudflare.com from an error line.
		const m = /https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/.exec(readFileSync(log, "utf8"));
		if (m) return { ok: true, url: `${m[0]}/mcp`, message: `MCP is reachable at ${m[0]}/mcp by anyone who has a token. The URL changes each time; for a fixed name, set up a named tunnel in your own Cloudflare account.` };
		await new Promise((r) => setTimeout(r, 250));
	}
	// No URL in time: stop it, so nothing is left exposed without the user knowing the address.
	try {
		if (child.pid) process.kill(child.pid);
	} catch {
		/* already gone */
	}
	rmSync(cloudflaredPidFile(), { force: true });
	return { ok: false, message: `cloudflared printed no URL in time, so it was stopped. See ${log}.` };
}
