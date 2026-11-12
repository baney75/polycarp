// The scorer's own line to the Mac helper, in connector mode (agent workspace and lent apps only): it reads
// windows back to check a computer task, and never acts.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

export class HandsClient {
	constructor(helper) {
		this.child = spawn(helper, ["mcp", "--connector"], { stdio: ["pipe", "pipe", "ignore"], env: { HOME: homedir(), PATH: process.env.PATH ?? "" } });
		this.next = 1;
		this.waiting = new Map();
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			let m;
			try {
				m = JSON.parse(line);
			} catch {
				return;
			}
			const w = this.waiting.get(m.id);
			if (!w) return;
			this.waiting.delete(m.id);
			w(m);
		});
		this.ready = this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "weak-model-scorer", version: "1" } });
	}

	rpc(method, params) {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
			this.waiting.set(id, (m) => {
				clearTimeout(timer);
				resolve(m);
			});
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	/** A read tool's parsed JSON answer ({ ok, data } or { ok:false, error }). */
	async call(name, args) {
		await this.ready;
		const m = await this.rpc("tools/call", { name, arguments: args });
		const text = (m.result?.content ?? []).map((c) => c.text ?? "").join("");
		try {
			return JSON.parse(text);
		} catch {
			return { ok: false, error: { message: text || m.error?.message } };
		}
	}

	close() {
		this.child.kill();
	}
}
