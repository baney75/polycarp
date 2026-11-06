#!/usr/bin/env node
// Admin for Polycarp Connect. Needs two environment variables (never put them in a file in the repo):
//   POLYCARP_CONNECT_URL           https://<your worker>.workers.dev
//   POLYCARP_CONNECT_ADMIN_SECRET  the ADMIN_SECRET you set with `wrangler secret put`
// Commands:
//   invite create [--count N] [--reserve] [--note TEXT]   make single-use codes (printed once)
//   invite list                                            list codes (prefix only), who used one, who is revoked
//   invite revoke <id>                                     revoke an unused code
//   waitlist list                                          list waitlist emails
//   waitlist remove <id>                                   delete one waitlist entry
//   stats                                                  the account's live tunnel count and our devices
// Use `pass-cli run` or your shell to supply the secret; do not paste it into a command history you share.

const base = (process.env.POLYCARP_CONNECT_URL ?? "").replace(/\/+$/, "");
const secret = process.env.POLYCARP_CONNECT_ADMIN_SECRET ?? "";
const args = process.argv.slice(2);

function usage(code = 1) {
	console.error(`Usage: admin.mjs invite create [--count N] [--reserve] [--note TEXT] | invite list | invite revoke <id> | waitlist list | waitlist remove <id> | stats
Set POLYCARP_CONNECT_URL and POLYCARP_CONNECT_ADMIN_SECRET first.`);
	process.exit(code);
}
if (!base || !secret) usage();

async function call(method, path, body) {
	const res = await fetch(`${base}/v1/admin/${path}`, { method, headers: { "x-admin-secret": secret, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		console.error(`${res.status} ${data.status ?? ""} ${data.message ?? ""}`.trim());
		process.exit(1);
	}
	return data;
}
const when = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") : "-");
const flag = (name) => args.includes(name);
const option = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

const [area, action, arg] = args;
if (area === "invite" && action === "create") {
	const count = Number(option("--count") ?? 1);
	const out = await call("POST", "invites", { count, tier: flag("--reserve") ? "reserve" : "standard", note: option("--note") });
	console.log(`${out.codes.length} ${out.tier} invite code(s). They are shown once:`);
	for (const code of out.codes) console.log(`  ${code}`);
} else if (area === "invite" && action === "list") {
	const out = await call("GET", "invites");
	for (const i of out.invites) console.log(`${String(i.id).padStart(4)}  ${i.prefix}…  ${i.tier.padEnd(8)}  ${i.revoked_at ? "revoked" : i.used_at ? `used ${when(i.used_at)}` : "unused "}  ${i.note ?? ""}`);
	if (!out.invites.length) console.log("No invites.");
} else if (area === "invite" && action === "revoke" && /^\d+$/.test(arg ?? "")) {
	await call("DELETE", `invites/${arg}`);
	console.log(`Revoked invite ${arg}.`);
} else if (area === "waitlist" && action === "list") {
	const out = await call("GET", "waitlist");
	for (const w of out.waitlist) console.log(`${String(w.id).padStart(4)}  ${when(w.created_at)}  ${w.email}`);
	if (!out.waitlist.length) console.log("The waitlist is empty.");
} else if (area === "waitlist" && action === "remove" && /^\d+$/.test(arg ?? "")) {
	await call("DELETE", `waitlist/${arg}`);
	console.log(`Removed waitlist entry ${arg}.`);
} else if (area === "stats") {
	const s = await call("GET", "stats");
	console.log(`Account tunnels (live): ${s.accountTunnels}\nReserved since that read: ${s.reservedSinceRead}\nLimits: ${JSON.stringify(s.limits)}\nOur devices: ${s.devices.map((d) => `${d.n} ${d.status}`).join(", ") || "none"}`);
} else usage();
