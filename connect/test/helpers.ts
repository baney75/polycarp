import { env } from "cloudflare:workers";
import { createWorker } from "../src/index.ts";
import { signingText } from "../src/auth.ts";
import { type CfClient, CfError, type Deps, type Env } from "../src/types.ts";
import { b64urlEncode, sha256Hex } from "../src/util.ts";

export const TOKEN_PREFIX = "SECRET-TUNNEL-TOKEN-";

/** An in-memory Cloudflare account. `others` stands for tunnels that aren't ours. */
export class FakeCf implements CfClient {
	others = 0;
	tunnels = new Map<string, { name: string; ingress?: { hostname: string; port: number } }>();
	dns = new Set<string>();
	calls: string[] = [];
	failOn: string | undefined;
	failWith: CfError | undefined;
	countFails = false;
	private n = 0;
	private fail(step: string) {
		this.calls.push(step);
		if (this.failOn === step) throw this.failWith ?? new CfError(`fake ${step} failure`, 500);
	}
	async countTunnels() {
		this.calls.push("count");
		if (this.countFails) throw new CfError("fake count failure", 500);
		return this.others + this.tunnels.size;
	}
	async createTunnel(name: string) {
		this.fail("create");
		const id = `tun-${++this.n}`;
		this.tunnels.set(id, { name });
		return { id };
	}
	async putIngress(id: string, hostname: string, port: number) {
		this.fail("ingress");
		const t = this.tunnels.get(id);
		if (!t) throw new CfError("no tunnel", 404, false, true);
		t.ingress = { hostname, port };
	}
	async getToken(id: string) {
		this.calls.push("token");
		if (!this.tunnels.has(id)) throw new CfError("no tunnel", 404, false, true);
		return `${TOKEN_PREFIX}${id}`;
	}
	async createDns(hostname: string) {
		this.fail("dns");
		this.dns.add(hostname);
	}
	async deleteDns(hostname: string) {
		this.fail("deleteDns");
		this.dns.delete(hostname);
	}
	async deleteTunnel(id: string) {
		this.fail("deleteTunnel");
		if (!this.tunnels.delete(id)) throw new CfError("no tunnel", 404, false, true);
	}
}

export interface Clock {
	t: number;
}

export function setup(overrides: Partial<Env> = {}) {
	const cf = new FakeCf();
	const clock: Clock = { t: 1_800_000_000 };
	const deps: Deps = { cf: () => cf, now: () => clock.t };
	const worker = createWorker(deps);
	const e = { ...env, ...overrides } as unknown as Env;
	return {
		cf,
		clock,
		env: e,
		worker,
		deps,
		fetch: (request: Request) => worker.fetch(request, e),
	};
}

export async function clearDb() {
	for (const table of ["devices", "invites", "waitlist", "nonces", "rate", "meta"]) await env.DB.prepare(`DELETE FROM ${table}`).run();
}

let ipCounter = 0;
export interface Device {
	pub: string;
	ip: string;
	sign(text: string): Promise<string>;
}

export async function makeDevice(): Promise<Device> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const pub = b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
	ipCounter++;
	return { pub, ip: `203.0.113.${(ipCounter % 250) + 1}`, sign: async (text) => b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(text)))) };
}

let nonceCounter = 0;
export interface SignOptions {
	time?: number;
	nonce?: string;
	ip?: string;
	body?: unknown;
	signedBody?: string;
	badSig?: boolean;
}

export async function signedRequest(device: Device, clock: Clock, method: string, path: string, opts: SignOptions = {}): Promise<Request> {
	const text = opts.body === undefined ? "" : JSON.stringify(opts.body);
	const time = String(opts.time ?? clock.t);
	const nonce = opts.nonce ?? `n${(++nonceCounter).toString().padStart(15, "0")}${Math.random().toString(36).slice(2, 8)}`;
	let sig = await device.sign(signingText(method, path, time, nonce, await sha256Hex(opts.signedBody ?? text)));
	if (opts.badSig) sig = sig.slice(0, -4) + (sig.endsWith("AAAA") ? "BBBB" : "AAAA");
	return new Request(`https://connect.test${path}`, {
		method,
		headers: { "x-polycarp-key": device.pub, "x-polycarp-time": time, "x-polycarp-nonce": nonce, "x-polycarp-sig": sig, "cf-connecting-ip": opts.ip ?? device.ip, ...(text ? { "content-type": "application/json" } : {}) },
		...(text ? { body: text } : {}),
	});
}

export async function dump(): Promise<string> {
	const out: unknown[] = [];
	for (const table of ["devices", "invites", "waitlist", "nonces", "rate", "meta"]) out.push((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results);
	return JSON.stringify(out);
}
