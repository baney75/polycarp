/**
 * Remote access through the person's own Cloudflare account: a named tunnel on a domain they already have there, so the
 * connector's address is theirs and stays the same. `remote setup --cloudflare <host>` runs the steps; this file is the
 * cloudflared part of it. Polycarp doesn't install cloudflared and never makes an account: `cloudflared tunnel login` is the
 * person signing in, in their own browser.
 *
 * A named tunnel needs a domain on the account (Cloudflare's rule). Without one, Tailscale is the route that needs none.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { which } from "./harness.ts";
import { configDir } from "./files.ts";
import { COMMAND_NAME } from "./self.ts";
import { removeService, runAsync, type ServiceSpec, writeAtomic } from "./service.ts";

/** cloudflared's own sign-in waits on the person. Five minutes, then it counts as not done. */
const LOGIN_TIMEOUT_MS = 300_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export const CLOUDFLARE_SERVICE: ServiceSpec = {
	label: "com.polycarp.cloudflared",
	unit: "polycarp-cloudflared.service",
	args: ["remote", "cloudflare", "run"],
	logName: "polycarp-cloudflared.log",
	description: "Polycarp's Cloudflare tunnel",
	off: `${COMMAND_NAME} remote off`,
	kept: "remote.json",
};

/** On PATH, or where the installers put it: a service's PATH is short. Tests set the applications folder, and stay on PATH alone. */
export function cloudflaredBinary(): string | undefined {
	return which("cloudflared") ?? ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find((path) => process.env.TABKYRA_APPLICATIONS_DIR === undefined && existsSync(path));
}

const cloudflaredDir = () => join(homedir(), ".cloudflared");
export const cloudflareConfigFile = () => join(configDir(), "cloudflared.yml");

/** The certificate `cloudflared tunnel login` leaves behind. Only its presence is read, never its contents. */
export function cloudflareSignedIn(): boolean {
	return existsSync(join(cloudflaredDir(), "cert.pem"));
}

const tunnelNameFile = () => join(configDir(), "cloudflare-tunnel-name");

/**
 * This computer's tunnel, kept once made. Macs often share a hostname (MacBook-Pro.local), and another computer's tunnel of the same
 * name has a key this one lacks, so the name carries a few random letters too.
 */
export function cloudflareTunnelName(machine = hostname()): string {
	if (existsSync(tunnelNameFile())) {
		const saved = readFileSync(tunnelNameFile(), "utf8").trim();
		if (/^polycarp-[a-z0-9-]{1,60}$/.test(saved)) return saved;
	}
	const slug = machine.toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	const name = `polycarp-${slug || "mac"}-${randomBytes(2).toString("hex")}`;
	writeAtomic(tunnelNameFile(), `${name}\n`, 0o600);
	return name;
}

/** A hostname someone typed, or a pasted address: lowercase, no scheme, no path. Undefined when it can't be one. */
export function normalizeCloudflareHost(raw: string): string | undefined {
	const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
	if (host.length > 253 || !host.includes(".")) return undefined;
	return host.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? host : undefined;
}

/** `cloudflared tunnel login`: opens the person's browser and waits for them. An earlier sign-in counts as done. */
export async function cloudflareLogin(): Promise<{ state: "ready" | "cloudflared_missing" | "problem"; message: string; code?: string }> {
	const bin = cloudflaredBinary();
	if (!bin) return { state: "cloudflared_missing", message: "cloudflared isn't installed." };
	if (cloudflareSignedIn()) return { state: "ready", message: "Already signed in to Cloudflare." };
	const r = await runAsync(bin, ["tunnel", "login"], LOGIN_TIMEOUT_MS);
	if (cloudflareSignedIn()) return { state: "ready", message: "Signed in to Cloudflare." };
	return { state: "problem", code: "cloudflare_login", message: r.code === 0 ? "Cloudflare didn't finish signing in. Try again." : `Signing in didn't finish: ${r.out.slice(-300)}` };
}

export type CloudflareOpen = { ok: true; tunnel: string } | { ok: false; code: "cloudflare_tunnel" | "cloudflare_dns" | "cloudflare_zone"; message: string };

/**
 * The tunnel (made once, then reused), its DNS record and the config the service runs. Nothing here starts traffic.
 * The record is never overwritten: a name already in use belongs to whatever uses it.
 */
export async function prepareCloudflare(bin: string, host: string, port: number): Promise<CloudflareOpen> {
	const name = cloudflareTunnelName();
	const listed = await runAsync(bin, ["tunnel", "list", "--output", "json", "--name", name], 30_000);
	if (listed.code !== 0) return { ok: false, code: "cloudflare_tunnel", message: `cloudflared couldn't list your tunnels: ${listed.out.slice(-300)}` };
	let id = UUID.exec(listed.out)?.[0];
	if (id && !existsSync(join(cloudflaredDir(), `${id}.json`))) {
		return { ok: false, code: "cloudflare_tunnel", message: `Your account has a tunnel named ${name}, but its key isn't on this computer. Delete it with: cloudflared tunnel delete ${name}. Then try again.` };
	}
	if (!id) {
		const made = await runAsync(bin, ["tunnel", "create", name], 60_000);
		id = UUID.exec(made.out)?.[0];
		if (made.code !== 0 || !id) return { ok: false, code: "cloudflare_tunnel", message: `cloudflared couldn't make the tunnel: ${made.out.slice(-300)}` };
	}
	const route = await runAsync(bin, ["tunnel", "route", "dns", id, host], 60_000);
	if (route.code !== 0) return { ok: false, code: "cloudflare_dns", message: `Cloudflare wouldn't give this tunnel ${host}. If that name is already in use, pick another. Its words: ${route.out.slice(-300)}` };
	// A sign-in covers one domain. A name on another one gets that domain added to the end instead of failing.
	// The same when an earlier wrong try left that record: cloudflared then says it's already there, under the wrong name.
	const added = (/Added CNAME (\S+)/i.exec(route.out) ?? /(\S+) is already configured to route to your tunnel/i.exec(route.out))?.[1]?.replace(/\.$/, "").toLowerCase();
	if (added && added !== host) {
		return { ok: false, code: "cloudflare_zone", message: `Your Cloudflare sign-in is for a different domain, so Cloudflare made ${added} instead of ${host}. Remove that record, delete ${join(cloudflaredDir(), "cert.pem")}, and sign in again choosing the domain for ${host}.` };
	}
	writeAtomic(
		cloudflareConfigFile(),
		[
			`tunnel: ${id}`,
			`credentials-file: ${join(cloudflaredDir(), `${id}.json`)}`,
			"no-autoupdate: true",
			"ingress:",
			`  - hostname: ${host}`,
			`    service: http://127.0.0.1:${port}`,
			"  - service: http_status:404",
			"",
		].join("\n"),
		0o600,
	);
	return { ok: true, tunnel: name };
}

/** What the service runs: cloudflared in the foreground, so the service manager sees it stop. */
export function runCloudflareTunnel(): Promise<number> {
	const bin = cloudflaredBinary();
	if (!bin) {
		console.error("cloudflared isn't installed.");
		return Promise.resolve(1);
	}
	if (!existsSync(cloudflareConfigFile())) {
		console.error(`${cloudflareConfigFile()} is missing. Run ${COMMAND_NAME} remote setup --cloudflare <name> again.`);
		return Promise.resolve(1);
	}
	const child = spawn(bin, ["tunnel", "--config", cloudflareConfigFile(), "run"], { stdio: "inherit" });
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
	return new Promise((resolve) => {
		child.on("error", () => resolve(1));
		child.on("exit", (code) => resolve(code ?? 1));
	});
}

/** Stops the tunnel. The tunnel and its DNS record stay on the account, so turning this on again reuses them. */
export function closeCloudflare(): { ok: boolean; notes: string[]; failure?: string } {
	const service = removeService(CLOUDFLARE_SERVICE);
	if (service.ok) rmSync(cloudflareConfigFile(), { force: true });
	return service;
}
